/**
 * background.js —— 生参通用取数工具「调度层」
 *
 * 职责（对应需求与技术方案 V1 §5 / §6 / §7 / §8）：
 *   1. 单串行调度：同一时刻只允许一个任务在途（activeTaskKey + taskFlights 去重）
 *   2. 全部等待都由 chrome.alarms 驱动（不依赖 setTimeout，避免 MV3 服务工作线程被回收）
 *   3. 与页面通信：向目标标签页**不带 frameId** 广播 SR_* 消息（content.js 自动忽略非表单 frame）
 *   4. 下载接管：chrome.downloads.onDeterminingFilename 四重校验后才 suggest 重命名，且只 suggest 一次
 *   5. 断点：每完成/失败一个任务立刻落盘（按会话分片 + 索引，不做单 key 全量重写）
 *   6. 恢复三分支（onStartup）：等待下载中 → 只重挂超时；导航/执行中 → 重跑该任务；其他 → 调度下一项
 *   7. 失败：MAX_ATTEMPTS 上限 + core.nextBackoffMs 固定退避（**无任何随机数**），达上限置 failed_permanent
 *   8. 会话结束产出 session_manifest.json（含缺口清单）与 session_log.json，落到归档根
 *
 * 硬边界：
 *   - 权限只用 manifest 已声明的 storage / downloads / alarms / activeTab
 *   - 无网络请求、不读 Cookie / 凭证、不含反检测、不含随机化
 *   - 纯函数层（任务模型 / 状态机 / 闭合校验 / 归档路径 / 文件名归属）一律调用 core.js，本文件不重复实现
 */

'use strict';

importScripts('selectors.js', 'availability.js', 'core.js');

const core = globalThis.SRCore;
// ⚠️ 这里**必须用 var，不能用 const/let**（2026-09-13 实测）：
//    selectors.js 已在同一全局作用域用 `var SR` 声明（importScripts 共域），
//    若此处再出现全局 lexical 声明（const/let SR），Chrome 会直接
//    `SyntaxError: Identifier 'SR' has already been declared`
//    → **Service Worker 起不来**（扩展页显示「错误」+ Service Worker 无效）。
//    var 的重复声明是合法的，因此用 var 取别名。
var SR = globalThis.SR;

if (!core || !SR) {
  // 依赖缺失时宁可炸掉，也不拿一份臆想的页面知识继续跑
  throw new Error('[SR] selectors.js / core.js 未加载，background.js 无法启动');
}

/** 调度版本：与 popup 做握手；版本不一致时 popup 会禁用全部操作 */
const VERSION = chrome.runtime.getManifest().version;

// ==================================================================================
// 0. 常量（**全部为固定值，禁止随机化**）
// ==================================================================================

/** 存储键：会话索引与 schema 版本（分片键由 core.storageKeys 生成） */
const K_INDEX = core.storageKeys.sessionIndex;
const K_SCHEMA = core.storageKeys.version;

/** 闹钟名 */
const ALARM_TICK = 'sr-tick';                 // 调度下一项
const ALARM_TASK_TIMEOUT = 'sr-task-timeout'; // 单任务在途超时（等待结果视图 / 等待下载）

/** 下载归属的**时效窗**：3 分钟（对应技术方案 §8.1 第 2 条） */
const DOWNLOAD_WINDOW_MS = 3 * 60 * 1000;

/** 单任务在途超时兜底（毫秒）：任务自身可带 timeoutMs 覆盖 */
const DEFAULT_TASK_TIMEOUT_MS = 180000;

/** 页面消息重试：固定间隔、固定次数（约 8 秒窗口），无随机抖动 */
const PAGE_MESSAGE_TRIES = 10;
const PAGE_MESSAGE_INTERVAL_MS = 800;

/**
 * 等待「表单 frame 自报」的上限（毫秒）与轮询间隔。
 * 2026-09-13 实机根因：生参页主表单在**同源 iframe** 里，iframe 需要几秒才加载完；
 * 而只靠"广播 + 择优"在实机上不可靠（顶层外壳 frame 常常先应答，回调只交付第一个应答，
 * 调度层于是永远读不到表单 frame）。所以：**先等自报，拿不到才退化为广播**。
 * 固定值，无随机抖动。
 */
const FORM_FRAME_WAIT_MS = 15000;

/**
 * 「表单控件就绪」等待上限（2026-09-18 新增）。
 *
 * 为什么单独设一个：`FORM_FRAME_WAIT_MS` 只保证**表单 frame 挂上了**，不保证**里面的控件渲染完了**。
 * 实测症状（入库侧代跑期间记录、本会话复现）：新会话第 1 个任务报
 * 「数据粒度（「数据粒度」下没有选项「店铺」，可选：）」——frame 就绪但 数据粒度/数据维度/时间粒度
 * 三个必需单选组还没渲染出来；该任务被计一次失败，3 次后**永久留缺口**（真丢一期数据）。
 * 控件在 frame 挂上后通常 1~3 秒内渲染完，故上限取 8 秒；超时走"自愈刷新 + 再等一次"。
 */
const FORM_CONTROLS_WAIT_MS = 8000;
const FORM_FRAME_POLL_MS = 1000;

/**
 * 刷新取数页后等微应用重新挂载的固定静默期（毫秒）。固定值，无随机抖动。
 * 取值理由：刷新是整棵微前端重新拉包挂载，比首次等待更慢，确认框架已进入等待循环即可。
 */
const FORM_REVIVE_SETTLE_MS = 3000;
// SPA 偶尔完成导航但主壳仍是空白；有限重试，避免无限刷新和重复提交。
const BLANK_PAGE_RECOVERY_ATTEMPTS = 2;
const BLANK_PAGE_PROBE_MS = 2500;

/**
 * `SR_SAVE_JSON` 投递等待上限（毫秒）：页面侧只是建 Blob + 点 <a download>，很快。
 * 固定值，无随机抖动。
 */
const ARTIFACT_SAVE_TIMEOUT_MS = 8000;

/**
 * 页面通道（`<a download>`）的**验证窗**（毫秒）：点击后必须在这段时间内真的出现一个新的 .json 下载，
 * 否则判为"假成功"并回退 data: URL。固定值，无随机抖动。
 * 取值理由：本地 Blob 下载由 Chrome 立即登记，实测 1 秒内即可被 downloads.search 看到，
 * 6 秒足够覆盖页面卡顿，又不会让整体收尾多等太久。
 */
const PAGE_ROUTE_VERIFY_MS = 6000;

/** form frame 映射的存储键前缀（落盘以便 SW 被回收后仍可用） */
const K_FORM_FRAME_PREFIX = 'sr:formframe:';
const formFrameKey = (tabId) => `${K_FORM_FRAME_PREFIX}${Number(tabId)}`;

/**
 * 前置置前台后的稳定等待（毫秒）：激活标签页/聚焦窗口后，
 * 浏览器把可见性变更派发给页面 + CSS 动画恢复需要一个固定窗口。**固定值，无随机抖动。**
 */
const FOREGROUND_SETTLE_MS = 1500;

/** 可见性不满足时的重试次数：共尝试 2 次（首次 + 重试 1 次），**不计入 MAX_ATTEMPTS** */
const VISIBILITY_ATTEMPTS = 2;

/**
 * `SR_EXECUTE_TASK` 的响应等待上限（毫秒）——**默认值**。
 * 页面侧一次完整流程（填表 → 日历选日期 → 提交 → 等结果视图 → 点下载）实测要十几秒，
 * 因此绝不能用 chrome.tabs.sendMessage 的 Promise 形式（浏览器只等约 30 秒就会以
 * "message port closed before a response was received" 拒绝，表现为"页面跑完了但后台没拿到响应"）。
 * 这里用回调形式 + 自己的定时器，超时后**不立即判失败**，而是进入"等待下载对账"。
 *
 * 可按会话覆盖（opts.executeTimeoutMs），取值被夹在 [EXECUTE_TIMEOUT_MIN_MS, EXECUTE_TIMEOUT_MAX_MS]：
 * 生产环境不传即为 120 秒；集成测试用短值即可在秒级验证超时→对账链路。
 */
const EXECUTE_TASK_TIMEOUT_MS = 120000;
const EXECUTE_TIMEOUT_MIN_MS = 5000;
const EXECUTE_TIMEOUT_MAX_MS = 600000;

/** 解析会话级执行超时（固定值，无随机；越界即夹紧而不是报错，避免一个小配置把会话卡死） */
function resolveExecuteTimeoutMs(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return EXECUTE_TASK_TIMEOUT_MS;
  return Math.min(EXECUTE_TIMEOUT_MAX_MS, Math.max(EXECUTE_TIMEOUT_MIN_MS, Math.floor(num)));
}

/**
 * 对账观察窗（毫秒）：响应丢失/超时后，再等这么久看是否有归属成功的下载落地。
 * 只要这段时间内下载被认领（任务已被推到 done），该次出手就按成功处理。
 */
const RECONCILE_WAIT_MS = 15000;

/** 下载事件里的 tabId 字段名（不同 Chrome 版本字段名不同，逐个探测） */
const DOWNLOAD_TAB_ID_FIELDS = ['tabId', 'tab_id', 'initiatorTabId'];

/** 调度最小间隔（毫秒）：固定限速，可观测，不做随机抖动 */
const TICK_MIN_MS = 200;

/** 归档根（与 core.ARCHIVE_ROOT 一致，避免两处不一致） */
const ARCHIVE_ROOT = core.ARCHIVE_ROOT;

// ==================================================================================
// 1. 存储层：会话分片 + 索引（§7「状态存储分片」）
//    每完成/失败一个任务只重写**该任务所在的那一片**，不重写整个会话
// ==================================================================================

/** 并发写入串行化（避免 popup 操作与下载回调同时改同一片） */
let stateQueue = Promise.resolve();

function withStateLock(task) {
  const run = stateQueue.then(task, task);
  stateQueue = run.then(() => undefined, () => undefined);
  return run;
}

/** 会话 id：时间戳 + 序号，本地生成，无随机数 */
let sessionCounter = 0;
function makeSessionId() {
  sessionCounter += 1;
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `S${stamp}${String(sessionCounter).padStart(2, '0')}`;
}

/** 索引条目只存元信息，几十字节/会话 */
function indexEntryOf(meta) {
  return {
    sessionId: meta.sessionId,
    storeId: meta.storeId,
    storeName: meta.storeName,
    batch: meta.batch || null,
    status: meta.status,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    total: Number(meta.total || 0),
  };
}

/** 把一条会话记录压进索引（同 id 覆盖，只保留最近 50 条） */
async function upsertIndex(meta) {
  const stored = await chrome.storage.local.get(K_INDEX);
  const list = Array.isArray(stored[K_INDEX]) ? stored[K_INDEX].slice() : [];
  const entry = indexEntryOf(meta);
  const at = list.findIndex((item) => item && item.sessionId === entry.sessionId);
  if (at >= 0) list[at] = entry; else list.push(entry);
  const trimmed = list.slice(-50);
  await chrome.storage.local.set({ [K_INDEX]: trimmed });
}

/** 记住最近活跃会话 id（SW 重启后能找回当前会话） */
async function setActiveSessionId(sessionId) {
  const stored = await chrome.storage.local.get(K_SCHEMA);
  const schema = stored[K_SCHEMA] && typeof stored[K_SCHEMA] === 'object' ? stored[K_SCHEMA] : {};
  await chrome.storage.local.set({
    [K_SCHEMA]: { ...schema, schemaVersion: core.SCHEMA_VERSION, activeSessionId: sessionId || null, updatedAt: new Date().toISOString() },
  });
}

async function getActiveSessionId() {
  const stored = await chrome.storage.local.get(K_SCHEMA);
  const schema = stored[K_SCHEMA];
  return schema && schema.activeSessionId ? String(schema.activeSessionId) : null;
}

/** 读会话 meta（session 字段 = 除 tasks 外的全部内容 + activeTaskKey / expectedDownload） */
async function readSessionMeta(sessionId) {
  if (!sessionId) return null;
  const key = core.storageKeys.sessionMeta(sessionId);
  const stored = await chrome.storage.local.get(key);
  const meta = stored[key];
  return meta && typeof meta === 'object' ? meta : null;
}

/**
 * ❗ 存储配额卫生（2026-09-19 真机事故，成因与后果详见 core.SESSION_DETAIL_KEEP 的注释）。
 *    这里负责**真正删除**（唯一碰 chrome.storage 的地方）；"该删哪些键"的规则在 core 里（有单测）。
 */
async function pruneSessionDetails(opts) {
  const all = await chrome.storage.local.get(null);
  const picked = core.pickSessionDetailVictims(Object.keys(all), all[K_INDEX], opts || {});
  if (picked.victims.length) await chrome.storage.local.remove(picked.victims);
  return { removedKeys: picked.victims.length, keptSessions: picked.keepSet, kept: picked.keep };
}

/** 每个 SW 生命周期只做一次：删掉过老的会话详情、腾出配额（当前会话**绝不删**） */
let storagePruned = false;
async function ensureStoragePruned() {
  if (storagePruned) return null;
  storagePruned = true;
  try {
    const activeId = await getActiveSessionId();
    return await pruneSessionDetails({ skipSessionId: activeId });
  } catch (error) {
    return { error: String((error && error.message) || error) };   // 清理失败不影响主流程
  }
}

/** 写会话状态：撞配额 → 先清理（只留最近 1 个会话）再重试一次；仍失败就抛（**绝不静默**） */
async function setSessionStorage(payload, opts) {
  try {
    await chrome.storage.local.set(payload);
    return null;
  } catch (error) {
    if (!/quota/i.test(String((error && error.message) || error))) throw error;
    const pruned = await pruneSessionDetails({ keep: 1, skipSessionId: (opts || {}).skipSessionId });
    await chrome.storage.local.set(payload);
    return pruned;
  }
}

/** 写会话 meta（只写一个小 key） */
async function writeSessionMeta(meta) {
  const next = { ...meta, updatedAt: new Date().toISOString() };
  await setSessionStorage({ [core.storageKeys.sessionMeta(next.sessionId)]: next }, { skipSessionId: next.sessionId });
  await upsertIndex(next);
  return next;
}

/** 读全部任务分片并按 shard 顺序拼接 */
async function readSessionTasks(sessionId, shardCount) {
  const keys = [];
  const count = Math.max(1, Number(shardCount || 1));
  for (let shard = 0; shard < count; shard += 1) keys.push(core.storageKeys.sessionTasks(sessionId, shard));
  const stored = await chrome.storage.local.get(keys);
  const tasks = [];
  for (const key of keys) {
    const shard = stored[key];
    if (Array.isArray(shard)) tasks.push(...shard);
  }
  return tasks;
}

/** 整会话读取（meta + 全部分片） */
async function readSession(sessionId) {
  const meta = await readSessionMeta(sessionId);
  if (!meta) return null;
  return { ...meta, tasks: await readSessionTasks(sessionId, meta.shardCount) };
}

/** 恢复「当前活跃会话」；没有活跃会话时退回索引里最新的一条 */
async function readActiveSession() {
  const activeId = await getActiveSessionId();
  const session = await readSession(activeId);
  if (session) return session;
  const stored = await chrome.storage.local.get(K_INDEX);
  const list = Array.isArray(stored[K_INDEX]) ? stored[K_INDEX] : [];
  const last = list[list.length - 1];
  return last ? readSession(last.sessionId) : null;
}

/**
 * 只落盘**变更的那一片任务**（断点粒度 = 单任务；§7）。
 * @param {string} sessionId
 * @param {object[]} tasks 全量任务（仅用于定位分片，不会整会话重写）
 * @param {string[]} changedKeys 本次发生变化的 task.key
 */
async function writeTaskShards(sessionId, tasks, changedKeys) {
  const shardSize = core.TASK_SHARD_SIZE;
  const shards = new Set();
  for (const key of changedKeys) {
    const at = tasks.findIndex((task) => task && task.key === key);
    if (at < 0) continue;
    shards.add(Math.floor(at / shardSize));
  }
  if (shards.size === 0) return;
  const payload = {};
  for (const shard of shards) {
    payload[core.storageKeys.sessionTasks(sessionId, shard)] = tasks.slice(shard * shardSize, (shard + 1) * shardSize);
  }
  await setSessionStorage(payload, { skipSessionId: sessionId });
}

/** 只更新一个任务（返回新任务 + 是否真的变了） */
function replaceTaskIn(tasks, nextTask) {
  return tasks.map((task) => (task && task.key === nextTask.key ? nextTask : task));
}

/**
 * 会话状态迁移的统一入口：非法迁移直接抛错（core 的铁律，不静默修正）。
 * @param {object} meta 会话 meta
 * @param {string} action 语义动作（start / pause / resume / complete / fail / end）
 */
function metaWithSessionAction(meta, action, now) {
  const probe = { ...meta, tasks: [] };
  const next = core.setSessionStatus(probe, action, now);
  return { ...meta, status: next.status, updatedAt: next.updatedAt };
}

/** 错误一律写进会话 lastError（popup 可读） */
async function recordSessionError(sessionId, reason) {
  const meta = await readSessionMeta(sessionId);
  if (!meta) return null;
  return writeSessionMeta({ ...meta, lastError: reason ? String(reason) : null });
}

// ==================================================================================
// 2. 任务状态推进（全部经 core.advanceTaskTo / core.resolveRetry，不手写状态）
// ==================================================================================

/** 把任务推进到主链路目标态（已到达则原样返回） */
function advanceTask(task, target, error) {
  if (!task) throw new Error('任务不存在');
  if (task.status === target) return task;
  // 状态迁移一律交给 core（advanceTaskTo 线性补齐中间态、拒绝回退、非法即抛错）
  return core.advanceTaskTo(task, target, undefined, error);
}

/** 计入一次尝试（pending / retry_wait / error → navigating） */
function beginAttempt(task) {
  if (task.status === 'pending') return core.advanceTaskTo(task, 'navigating');
  if (task.status === 'retry_wait' || task.status === 'error') {
    const reset = core.transitionTask(task, 'pending');
    return core.advanceTaskTo(reset, 'navigating');
  }
  return task;
}

/** A distinct platform report name for every attempt, including resumed older sessions. */
function reportNameForAttempt(task, sessionId, attempt) {
  const shortDate = value => String(value || '').replace(/-/g, '').slice(2);
  const grain = SR.REPORT_NAME.timeGrainCode[task.timeGrain] || 'NA';
  const code = String(task.dimensionCode || 'DIM').slice(0, 6);
  const identity = `${sessionId}|${task.key}|${attempt}`;
  let hash = 2166136261;
  for (let i = 0; i < identity.length; i += 1) {
    hash = Math.imul(hash ^ identity.charCodeAt(i), 16777619) >>> 0;
  }
  const suffix = (hash % 2176782336).toString(36).padStart(6, '0');
  const name = `${code}_${grain}_${shortDate(task.startDate)}-${shortDate(task.endDate)}_${suffix}`;
  const valid = SR.REPORT_NAME.validate(name);
  if (!valid.ok) throw new Error(valid.reason);
  return name;
}

/**
 * 失败结算：未超限 → retry_wait（固定退避）；达 core.MAX_ATTEMPTS → failed_permanent（显式缺口）。
 *
 * ⚠️ 已知 core 缺陷与调度层兜底（**已记录，不改 core.js**）：
 *   core.resolveRetry 在"已耗尽尝试次数"的分支里直接做 transitionTask(task, 'failed_permanent')，
 *   但任务按主链路失败时通常停在 navigating，而 navigating 的合法迁移集里没有 failed_permanent
 *   （navigating → error → failed_permanent 才合法）→ 它会抛
 *   "任务 X 当前状态 navigating 无法进入 failed_permanent"，把任务永远卡在 navigating。
 *   本层按同一张迁移表显式补齐中间态：navigating → error → failed_permanent。
 *   两种写法在状态机语义上完全一致，且 attempts 不变（transitionTask 只在进入 navigating 时 +1）。
 */
function settleFailure(task, reason) {
  const message = String(reason || '未知失败');
  try {
    return core.resolveRetry(task, undefined, message);
  } catch (error) {
    const exhausted = Number(task.attempts || 0) >= core.MAX_ATTEMPTS;
    let next = task;
    // 先把任务放到一个允许走向重试/终态的位置
    if (next.status !== 'error' && core.canTransition(next.status, 'error')) {
      next = core.transitionTask(next, 'error', undefined, message);
    } else if (next.status === 'navigating') {
      next = core.transitionTask(next, 'retry_wait', undefined, message); // navigating 的直接退路
    }
    const target = exhausted ? 'failed_permanent' : 'retry_wait';
    if (!core.canTransition(next.status, target)) {
      throw error; // 兜底也走不通：如实抛出，绝不静默吞掉
    }
    return core.transitionTask(next, target, undefined, message);
  }
}

// ==================================================================================
// 3. 与页面通信（不带 frameId 广播；content.js 自动忽略非表单 frame）
// ==================================================================================

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// ----------------------------------------------------------------------------------
// 3.0 表单 frame 映射（tabId → frameId）
//
// 为什么必须有它（2026-09-13 实机根因，会话 S2026091313175501）：
//   `chrome.tabs.sendMessage(tabId, msg)` **不带 frameId 时只把第一个应答交付给回调**。
//   生参页的同源 iframe 里才是主表单，但**顶层外壳 frame 也有 content script 且常常先应答**
//   （content.js 判成「当前 frame 不是取数表单 frame」）→ 调度层永远读不到表单 frame 的应答。
//   该实机会话因此连续 3 轮预检全败、64 秒就收口、一个 xlsx 都没产出。
//   即便在响应里择优也救不了：候选集里根本没有表单 frame 的那一份。
//
// 解法：content.js 加载后主动自报 `SR_FORM_FRAME_HELLO`（带 sender.tab.id + sender.frameId），
// 调度层据此**定向发送**；拿到 frameId 之前先等，而不是立刻失败。
// ----------------------------------------------------------------------------------

/** 内存映射：tabId → { frameId, path, at }（权威副本同时落 storage，供 SW 被回收后恢复） */
const formFrames = new Map();

/** 从 sender 里取 tabId/frameId（只有扩展自身的 content script 才会带 sender.tab） */
function senderFrameInfo(sender) {
  const tabId = sender && sender.tab && sender.tab.id != null ? Number(sender.tab.id) : null;
  const frameId = sender && sender.frameId != null ? Number(sender.frameId) : null;
  return { tabId, frameId };
}

/**
 * 登记某个 tab 的表单 frame。返回登记结果。
 * 同时写内存 Map 与 storage（键 `sr:formframe:<tabId>`），并记一条诊断事件。
 */
async function registerFormFrame(tabId, frameId, path) {
  if (tabId == null || frameId == null) return null;
  const entry = { frameId: Number(frameId), path: path == null ? null : String(path), at: new Date().toISOString() };
  formFrames.set(Number(tabId), entry);
  const record = { [formFrameKey(tabId)]: entry };
  try {
    // ❗ 2026-09-19：这里以前直接 chrome.storage.local.set —— 撞配额时会静默失败（只记 trace），
    //    于是 SW 被回收再唤醒后**表单 frame 映射就找不回来**了（症状：所有命令都回
    //    「只有非表单 frame 应答（…path=未知）」，整批任务连锁失败）。
    //    改走 setSessionStorage：撞配额 → 清理旧会话详情 → 重试一次。
    await setSessionStorage(record);
  } catch (error) {
    trace('formFrame.persist-failed', { tabId, message: String(error && error.message || error) });
  }
  trace('formFrame.registered', { tabId, name: 'formFrame', frameId: entry.frameId, path: entry.path });
  // 诊断留证：自报是实机排障的关键事实
  const sessionId = await getActiveSessionId().catch(() => null);
  if (sessionId) {
    await recordDiagnostic(sessionId, DIAG.FORM_FRAME_REGISTERED, {
      tabId: Number(tabId), frameId: entry.frameId, path: entry.path,
      note: '表单 frame 自报，后续消息将按 frameId 定向发送',
    }, null).catch(() => undefined);
  }
  return entry;
}

/** 读取某个 tab 的表单 frame（先内存，再 storage 兜底） */
async function getFormFrame(tabId) {
  if (tabId == null) return null;
  const key = Number(tabId);
  const cached = formFrames.get(key);
  if (cached && cached.frameId != null) return cached;
  try {
    const stored = await chrome.storage.local.get(formFrameKey(key));
    const entry = stored[formFrameKey(key)];
    if (entry && entry.frameId != null) {
      formFrames.set(key, entry);
      return entry;
    }
  } catch (error) {
    trace('formFrame.read-failed', { tabId: key, message: String(error && error.message || error) });
  }
  return null;
}

/**
 * 清除某个 tab 的表单 frame 映射。
 * 导航时必须清：否则会拿旧 frameId 发消息（必然报错）。
 * 表单 frame 加载完会自己重新上报。
 *
 * ⚠️ 2026-09-14 收尾 ③ 补：**清映射 ≠ 忘掉这个 frameId**。
 *    点击「下载报表」后瓴羊 SPA 切到结果视图 → `tabs.onUpdated` 清掉映射，
 *    而结果视图**不会再自报 HELLO**（HELLO 只在脚本加载时发一次）→ 催单时永远解析不到 frame。
 *    实测证据（NUDGE5/NUDGE6 场次）：检查点在 +2 秒**准点触发**、任务状态正是 `platform_processing`，
 *    但 `waitForFormFrame` 卡满 15 秒超时（最后探测：`{frame:'other', ok:true}`，即外壳 frame 抢答）→
 *    催单从未发出，`nudges=0 / nudgeChecks=0`。
 *    → 现在把 frameId 留在 `lastFrameByTab` 里，解析失败时**直接定向探一次**（定向发送没有抢答问题）。
 */
const lastFrameByTab = new Map();

/** 「最后已知 frameId」的 storage 键：**必须持久化** ——
 *  实测（NUDGE7）：SW 会在任务等待期间被回收，内存 Map 随之丢失，
 *  于是"记住的 frameId"这条兜底路根本走不到。 */
function lastFrameKey(tabId) { return `sr:lastframe:${Number(tabId)}`; }

async function rememberLastFrame(tabId, entry) {
  const key = Number(tabId);
  if (!entry || entry.frameId == null) return;
  lastFrameByTab.set(key, entry);
  try {
    await chrome.storage.local.set({ [lastFrameKey(key)]: entry });
  } catch (error) { /* 忽略：仅影响兜底路径 */ }
}

async function getRememberedFrame(tabId) {
  const key = Number(tabId);
  const cached = lastFrameByTab.get(key);
  if (cached && cached.frameId != null) return cached;
  try {
    const stored = await chrome.storage.local.get(lastFrameKey(key));
    const entry = stored[lastFrameKey(key)];
    if (entry && entry.frameId != null) {
      lastFrameByTab.set(key, entry);
      return entry;
    }
  } catch (error) { /* 忽略 */ }
  return null;
}

async function clearFormFrame(tabId, reason) {
  if (tabId == null) return;
  const key = Number(tabId);
  let had = formFrames.has(key);
  let entry = formFrames.get(key) || null;
  if (!entry) {
    // SW 被回收后内存为空：先从 storage 读回来，否则"记住的 frameId"会丢（NUDGE7 实测）
    try {
      const stored = await chrome.storage.local.get(formFrameKey(key));
      entry = stored[formFrameKey(key)] || null;
      had = !!entry;
    } catch (error) { /* 忽略 */ }
  }
  if (entry) await rememberLastFrame(key, entry);
  formFrames.delete(key);
  try {
    await chrome.storage.local.remove(formFrameKey(key));
  } catch (error) {
    trace('formFrame.clear-failed', { tabId: key, message: String(error && error.message || error) });
  }
  if (had) trace('formFrame.cleared', { tabId: key, name: 'formFrame', reason: reason || '' });
}

/**
 * 自愈：刷新取数页以重新挂载瓴羊微应用。
 *
 * 实机教训（2026-09-13 场次 M1/M2）：页面只剩下生意参谋外壳 + 一个第三方 iframe
 * （`assets.diantoushi.com/page/io.html`），取数表单 iframe（`/lyone/auto_analysis/datafetch/create`）
 * **从未挂载**——此时"等 15 秒"永远等不到，连试 3 轮只会在 45 秒后收口、一个文件都不产出。
 * 有效动作只有一个：刷新页面让微应用重新挂载。
 *
 * ⚠️ 刻意用**去掉 `sr_*` 参数的干净 URL**：既重挂微应用，又不会再次触发深链接自动入口
 *    （否则刷新会再发一次 START，撞上"存在未结束的会话"）。
 *
 * @returns {Promise<{ok:boolean, url?:string, reason?:string}>}
 */
/**
 * 等「必需表单控件就绪」（2026-09-18 新增，取数侧修冷页面竞态）。
 *
 * 判据来自 content.js 的 `readFormState().readiness`：数据粒度 / 数据维度 / 时间粒度 三个单选组
 * **各自至少有一个选项**（另有"来源店铺"存在性作辅助信息）。轮询直到就绪或超时。
 * 返回 { ok, waitedMs, readiness, reason }。
 */
async function waitForFormControls(tabId, timeoutMs) {
  const t0 = Date.now();
  let last = null;
  let lastErr = '';
  while (Date.now() - t0 < timeoutMs) {
    const res = await sendToPage(tabId, { type: 'SR_STATE' }).catch((error) => {
      lastErr = String(error && error.message);
      return null;
    });
    const st = res && res.ok && res.state ? res.state : null;
    last = (st && st.readiness) || null;
    if (last && last.ready) return { ok: true, waitedMs: Date.now() - t0, readiness: last };
    await sleep(500);
  }
  return {
    ok: false,
    waitedMs: Date.now() - t0,
    readiness: last,
    reason: `必需表单控件在 ${timeoutMs} 毫秒内未渲染完成（读数：${JSON.stringify(last)}${lastErr ? '；最近错误：' + lastErr : ''}）`,
  };
}

async function probePageShell(tabId, timeoutMs = BLANK_PAGE_PROBE_MS) {
  const deadline = Date.now() + Math.max(0, Number(timeoutMs));
  let lastReason = '';
  while (Date.now() <= deadline) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (!tab || !core.isAllowedPageUrl(tab.url)) return { ok: false, reason: '页面已离开生参地址' };
      const res = await sendToPage(tabId, { type: 'SR_STATE' });
      if (res && res.ok && res.state) {
        return { ok: true, state: res.state, url: tab.url };
      }
      lastReason = (res && res.reason) || '页面主壳尚未响应';
    } catch (error) {
      lastReason = String(error && error.message || error);
    }
    await sleep(250);
  }
  return { ok: false, reason: lastReason || '页面主壳未渲染' };
}

async function reviveFormPage(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab || !core.isAllowedPageUrl(tab.url)) {
      return { ok: false, reason: `当前页面不在取数页白名单，拒绝刷新：${(tab && tab.url) || '未知 URL'}` };
    }
    let clean = tab.url;
    try {
      const u = new URL(tab.url);
      [...u.searchParams.keys()].forEach((k) => { if (/^sr_/i.test(k)) u.searchParams.delete(k); });
      clean = u.toString();
    } catch (error) { /* URL 解析失败就用原 URL 刷新 */ }
    // 必须清掉旧的 frameId：刷新后 frameId 会变，留着只会往旧 frame 发消息
    await clearFormFrame(tabId, '刷新取数页前清理');
    for (let attempt = 1; attempt <= BLANK_PAGE_RECOVERY_ATTEMPTS; attempt += 1) {
      trace('blankPage.refresh-started', { tabId, attempt, url: clean });
      if (attempt === 1) await chrome.tabs.update(tabId, { url: clean });
      else await chrome.tabs.reload(tabId);
      await sleep(FORM_REVIVE_SETTLE_MS);
      const shell = await probePageShell(tabId);
      if (shell.ok) {
        return { ok: true, url: clean, attempt, shell };
      }
      trace('blankPage.recovery-attempt-failed', { tabId, attempt, reason: shell.reason });
    }
    return { ok: false, reason: 'blank_page：页面刷新两次后仍无有效内容' };
  } catch (error) {
    return { ok: false, reason: String((error && error.message) || error) };
  }
}

/**
 * 等表单 frame 自报（或内容探测成功）。
 * @returns {Promise<{ok:boolean, frameId:(number|null), source:string, waitedMs:number, reason:string}>}
 */
/**
 * 向**指定 frameId** 发一次探活（SR_PING）。
 * 用途：映射被清掉后确认"记住的 frameId 是否还活着" —— 定向发送**没有抢答问题**，
 * 所以比广播探测可靠（结果视图里外壳 frame 会抢答，见 clearFormFrame 注释）。
 * 失败（frame 已不存在 / 无 content script）返回 null，绝不抛错。
 */
async function pingFrame(tabId, frameId) {
  if (tabId == null || frameId == null) return null;
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: 'SR_PING' }, { frameId: Number(frameId) });
    return res && res.ok ? res : null;
  } catch (error) {
    return null;
  }
}

async function waitForFormFrame(tabId, timeoutMs) {
  const deadline = Date.now() + Math.max(0, Number(timeoutMs == null ? FORM_FRAME_WAIT_MS : timeoutMs));
  const started = Date.now();
  // 已有登记：直接返回
  const known = await getFormFrame(tabId);
  if (known) return { ok: true, frameId: known.frameId, source: 'registered', waitedMs: 0, reason: '' };

  // ⚠️ 映射被清但 frameId 还记着 → **先定向探一次**（见 clearFormFrame 的注释：
  //    结果视图不会再自报 HELLO，而广播探测会被外壳 frame 抢答）。
  const remembered = await getRememberedFrame(tabId);
  if (remembered && remembered.frameId != null) {
    const alive = await pingFrame(tabId, remembered.frameId).catch(() => null);
    if (alive && alive.ok) {
      await registerFormFrame(tabId, remembered.frameId, (alive.state && alive.state.path) || remembered.path);
      return {
        ok: true, frameId: remembered.frameId, source: 'remembered-frameId',
        waitedMs: Date.now() - started, reason: '',
      };
    }
  }

  let lastProbe = null;
  let probeCount = 0;
  while (Date.now() <= deadline) {
    await sleep(FORM_FRAME_POLL_MS);
    const arrived = await getFormFrame(tabId);
    if (arrived) {
      return { ok: true, frameId: arrived.frameId, source: 'hello', waitedMs: Date.now() - started, reason: '' };
    }
    // 兜底 ②：still-nothing → 再试一次"记住的 frameId"（SPA 切换期间可能刚好不可用）
    const retryRemembered = await getRememberedFrame(tabId);
    if (retryRemembered && retryRemembered.frameId != null) {
      const alive = await pingFrame(tabId, retryRemembered.frameId).catch(() => null);
      if (alive && alive.ok) {
        await registerFormFrame(tabId, retryRemembered.frameId, (alive.state && alive.state.path) || retryRemembered.path);
        return { ok: true, frameId: retryRemembered.frameId, source: 'remembered-frameId', waitedMs: Date.now() - started, reason: '' };
      }
    }
    // 兜底 ③：自报可能因为"扩展刚重载 / content.js 版本旧"而没来，用广播探一次
    const probe = await sendToPageBroadcast(tabId, { type: 'SR_STATE' });
    probeCount += 1;
    lastProbe = probe;
    if (probe && probe.ok && probe.frameId != null) {
      // 退化路径也把拿到的 frameId 记下来（后续可定向）
      await registerFormFrame(tabId, probe.frameId, (probe.state && probe.state.path) || null);
      return { ok: true, frameId: probe.frameId, source: 'probe', waitedMs: Date.now() - started, reason: '' };
    }
  }
  return {
    ok: false,
    frameId: null,
    source: 'timeout',
    waitedMs: Date.now() - started,
    // 把最后一次探测的原始形状一起交出去（排障必需：只报"超时"等于什么都没有）
    rememberedFrameId: (await getRememberedFrame(tabId).catch(() => null) || {}).frameId || null,
    probeCount,
    lastProbe: lastProbe ? {
      ok: !!lastProbe.ok,
      frame: lastProbe.frame || null,
      transport: lastProbe.transport || null,
      reason: String(lastProbe.reason || '').slice(0, 160),
      frameId: lastProbe.frameId === undefined ? null : lastProbe.frameId,
    } : null,
    reason: `等待表单 frame 自报超时（${Math.max(0, Number(timeoutMs == null ? FORM_FRAME_WAIT_MS : timeoutMs))} 毫秒）：`
      + `表单 frame 可能未加载、扩展刚重载或页面需要刷新（最后一次探测：${(lastProbe && lastProbe.reason) || '无应答'}）`,
  };
}

/**
 * 向标签页广播一条 SR_* 消息（**不带 frameId**）。
 *
 * ⚠️ 广播只用于**退化路径**：`chrome.tabs.sendMessage` 不带 frameId 时只把**第一个**应答
 *    交付给回调，顶层外壳 frame 会抢占它 → 因此主路径是 `sendToPage` 的 frameId 定向发送。
 *    这里保留广播是为了"还没拿到自报"时的兜底探测。
 */
async function broadcastToPage(tabId, message) {
  const responses = await Promise.allSettled([
    chrome.tabs.sendMessage(tabId, message),
  ]);
  const list = [];
  for (const settled of responses) {
    if (settled.status === 'rejected') {
      list.push({ ok: false, reason: String(settled.reason && settled.reason.message || settled.reason), transport: 'rejected' });
      continue;
    }
    const value = settled.value;
    if (Array.isArray(value)) list.push(...value.filter(Boolean));
    else if (value) list.push(value);
  }
  return list;
}

/**
 * 从一组响应里挑出**表单 frame** 的响应。
 * 判定依据（按可靠度排序）：
 *   ① ok:true 的真实业务响应
 *   ② state.isFormFrame === true（content.js 的 readFormState 会带这个标记）
 *   ③ frame === 'form' / 带 state 的响应
 * 注意：绝不要把 frame === 'other' 的响应当成表单响应。
 */
function pickPageResponse(responses) {
  const list = Array.isArray(responses) ? responses : [];
  const ok = list.find((item) => item && item.ok === true);
  if (ok) return ok;
  const markedForm = list.find((item) => item && item.state && item.state.isFormFrame === true);
  if (markedForm) return markedForm;
  const formFrame = list.find((item) => item && item.frame === 'form');
  if (formFrame) return formFrame;
  const nonForm = list.find((item) => item && item.frame === 'other');
  if (nonForm) {
    // 只有非表单 frame 应答：如实报出来，避免把"没注入表单 frame"误诊成"没有响应"
    return {
      ok: false,
      frame: 'other',
      // path 一起报出来：排障时"到底是哪个 frame 抢答了"是决定性信息（NUDGE8 就是靠它定位）
      path: (nonForm.state && nonForm.state.path) || nonForm.path || null,
      reason: `只有非表单 frame 应答（${nonForm.reason || '无原因'}；path=${(nonForm.state && nonForm.state.path) || '未知'}）：表单 frame 可能未加载或扩展刚更新，请刷新取数页`,
    };
  }
  return list[0] || { ok: false, reason: '页面无响应（content script 未注入？请刷新取数页）' };
}

/** 目标标签页是否仍在允许的页面白名单内（core 的路径/主机白名单） */
async function assertAllowedTab(tabId) {
  let tab = null;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch (error) {
    throw new Error(`目标标签页已关闭（tabId=${tabId}）：请重新打开生参取数页并刷新`);
  }
  if (!tab || !core.isAllowedPageUrl(tab.url)) {
    throw new Error(`当前不是新建取数页，请进入「自助分析 → 取数报表 → 新建取数」，或点击「修复连接」从生参首页进入。当前地址：${tab ? tab.url : '(空)'}`);
  }
  return tab;
}

/**
 * 广播一次并择优（**退化路径**：未知 frameId 时用）。
 * 返回值会带上从响应里能读到的 frameId（若能读到）。
 */
async function sendToPageBroadcast(tabId, message) {
  const responses = await broadcastToPage(tabId, message);
  const picked = pickPageResponse(responses);
  if (picked && picked.frameId == null) {
    const fromPayload = responses.find((item) => item && item.frameId != null);
    if (fromPayload) return { ...picked, frameId: fromPayload.frameId };
  }
  return picked;
}

/**
 * 页面消息（带重试）。
 *
 * 发送策略（2026-09-13 按 frameId 定向改造）：
 *   ① **已知该 tab 的 form frameId** → `chrome.tabs.sendMessage(tabId, msg, { frameId })` 定向发送。
 *      这是主路径：广播模式下顶层外壳 frame 会抢占应答，调度层读不到表单 frame。
 *   ② 未知 frameId → 退化为"广播 + 择优 + 固定次数重试"，并在拿到 frameId 时登记下来。
 *
 * 可见性断言（stage:'visibility'）是确定性失败，**必须立刻上抛**，不在这里重试。
 * 固定间隔、固定次数，**不做随机抖动**。
 */
async function sendToPage(tabId, message) {
  const frame = await getFormFrame(tabId);
  if (frame && frame.frameId != null) {
    let last = { ok: false, reason: '表单 frame 无响应' };
    for (let attempt = 1; attempt <= PAGE_MESSAGE_TRIES; attempt += 1) {
      if (attempt > 1) await sleep(PAGE_MESSAGE_INTERVAL_MS);
      let picked = null;
      try {
        const value = await chrome.tabs.sendMessage(tabId, message, { frameId: frame.frameId });
        picked = value || { ok: false, reason: '表单 frame 返回空响应' };
      } catch (error) {
        // 定向发送失败常见于 frameId 已失效（导航后未重报）→ 清掉映射并退化为广播
        const reasonText = String(error && error.message || error);
        await clearFormFrame(tabId, `定向发送失败：${reasonText}`);
        picked = await sendToPageBroadcast(tabId, message);
        // 广播拿到了新 frameId → 记下来，下一轮回到定向
        if (picked && picked.ok && picked.frameId != null) {
          await registerFormFrame(tabId, picked.frameId, (picked.state && picked.state.path) || null);
        }
        if (!picked || !picked.ok) picked = { ok: false, reason: `定向发送失败（${reasonText}）且广播未拿到表单响应：${(picked && picked.reason) || '无应答'}` };
      }
      if (picked && picked.ok) return picked;
      if (isVisibilityStage(picked)) return picked;
      last = picked || last;
    }
    return last;
  }

  // ---- 退化路径：广播 + 择优
  let last = { ok: false, reason: '页面无响应' };
  for (let attempt = 1; attempt <= PAGE_MESSAGE_TRIES; attempt += 1) {
    if (attempt > 1) await sleep(PAGE_MESSAGE_INTERVAL_MS);
    const responses = await broadcastToPage(tabId, message);
    const picked = pickPageResponse(responses);
    if (picked && picked.ok) {
      if (picked.frameId != null) await registerFormFrame(tabId, picked.frameId, (picked.state && picked.state.path) || null);
      return picked;
    }
    // ⚠️ 可见性断言是**确定性失败**（页面明确说"我在后台"），重试同一个页面消息毫无意义：
    //    这里立刻上抛，交给上层做"置前台 → 等 1.5 秒 → 重试一次"的处理。
    if (isVisibilityStage(picked)) return picked;
    last = picked || last;
    // 退化路径上若能读到 frameId，立刻登记，后续即可定向
    const withFrame = responses.find((item) => item && item.frameId != null);
    if (withFrame) await registerFormFrame(tabId, withFrame.frameId, (withFrame.state && withFrame.state.path) || null);
  }
  return last;
}

/**
 * 把目标标签页**置于前台并聚焦其窗口**，等待页面真正变为可见。
 *
 * ✅ 实测硬约束（2026-09-13 真机定位到的根因）：
 *   后台标签里瓴羊（dt-oui）的日期面板会被浏览器暂停 CSS 动画，永久卡在
 *   `dt-oui-slide-up-enter-prepare`（computed opacity:0、animationPlayState:paused）：
 *     · 外部点击与 Escape 都关不掉该面板
 *     · 点「生成报表」会让页面主线程长时间阻塞（既不提交也不报错）
 *   同样的操作在**前台标签**里一切正常。
 *   因此每次出手前必须先激活标签页 + 聚焦窗口 —— 这是任务能否成功的前提，不是优化项。
 *
 * 返回 { ok, visibility, windowId, reason }
 */
async function ensureTabForeground(tabId) {
  let tab = null;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch (error) {
    return { ok: false, reason: `标签页不可用：${error && error.message}` };
  }
  let windowId = tab.windowId;
  // ① 激活标签页
  try {
    const updated = await chrome.tabs.update(tabId, { active: true });
    if (updated && updated.windowId != null) windowId = updated.windowId;
  } catch (error) {
    return { ok: false, windowId, reason: `激活标签页失败：${error && error.message}` };
  }
  // ② 聚焦窗口（标签页落在非聚焦窗口里仍可能被判成不可见）
  if (windowId != null) {
    try {
      // ⭐ 2026-09-18 补：**最小化的窗口必须先还原**（state='normal'）。
      //    实测证据（分月批次 28 期全废那次）：窗口最小化时，即使 `tab.active=true`、
      //    `windows.update({focused:true})` 看似成功，页面自报的 `document.visibilityState`
      //    仍是 `hidden`（最小化窗口里的页面按定义不可见）→ 任务连败 3 次并**显式留缺口**。
      //    而且本机同时开着**两个** Chrome 窗口时，光看"当前主窗口是否最小化"判断不出来
      //    （我因此误判过一轮，还错怪到"遮挡"上）。`focused:true` **不会**还原最小化窗口，
      //    所以这里显式判断并还原。
      let win = null;
      try {
        win = await chrome.windows.get(windowId);
      } catch (error) {
        win = null;
      }
      if (win && win.state === 'minimized') {
        try {
          await chrome.windows.update(windowId, { state: 'normal' });
        } catch (error) {
          liveInFlight = { ...(liveInFlight || {}), restoreError: String(error && error.message), at: new Date().toISOString() };
        }
      }
      await chrome.windows.update(windowId, { focused: true });
    } catch (error) {
      // 聚焦失败不直接判死：最终以页面自报的 visibilityState 为准
      liveInFlight = { ...(liveInFlight || {}), focusError: String(error && error.message), at: new Date().toISOString() };
    }
  }
  // ③ 等浏览器把可见性变更派发给页面，再回读断言
  await sleep(FOREGROUND_SETTLE_MS);

  // ---- 回读断言（两级依据，避免"页面没报字段"被误判成不可见）：
  //   ① 首选：页面自报的 visibilityState（content.js 的 readFormState 若提供就用它）
  //   ② 兜底：标签页 active + 所属窗口 focused（纯 chrome API，不依赖 content.js 版本）
  const probe = await sendToPage(tabId, { type: 'SR_STATE' });
  const state = (probe && probe.ok && probe.state) || null;
  const reported = state && state.visibilityState ? String(state.visibilityState) : 'unknown';

  let tabActive = false;
  try {
    tabActive = !!(await chrome.tabs.get(tabId)).active;
  } catch (error) {
    return { ok: false, visibility: reported, windowId, reason: `回读标签页状态失败：${error && error.message}` };
  }
  let windowFocused = null;
  if (windowId != null) {
    try {
      const win = await chrome.windows.get(windowId);
      if (win && typeof win.focused === 'boolean') windowFocused = win.focused;
    } catch (error) {
      windowFocused = null; // 拿不到窗口状态就不作为判据
    }
  }

  if (reported === 'visible') return { ok: true, visibility: reported, windowId };
  if (reported === 'unknown' && tabActive) {
    // 页面未报可见性时的兜底：**只要标签页是所在窗口的活动标签，它就是可见的**
    // —— 窗口是否聚焦不影响 CSS 动画是否播放；真实约束是"标签页 hidden"。
    // 2026-09-13 实机复现：此前要求 windowFocused !== false 过严，
    // 导致 window.focused=false 时任务被判"标签页不可见"而永久失败，
    // 而同一次运行里页面流程其实已经跑通、文件也成功下载了。
    return { ok: true, visibility: 'unknown(tab-active)', windowId, windowFocused };
  }
  return {
    ok: false,
    visibility: reported,
    windowId,
    reason: `标签页不可见（visibilityState=${reported}，tab.active=${tabActive}，window.focused=${windowFocused}）`,
  };
}

// ==================================================================================
// 4. 下载接管：四重校验 + suggest 只调用一次
// ==================================================================================

/** 归档相对路径（平台原始文件名拼在 core 给出的目录后） */
function archiveRelativeFile(task, platformFilename) {
  return core.archiveRelativePath(task) + String(platformFilename).split(/[\\/]/).pop();
}

/** 重新挂上任务超时（只挂闹钟，**绝不重复点击下载**） */
function armTaskTimeout(sessionId, taskKey, timeoutMs) {
  chrome.alarms.create(ALARM_TASK_TIMEOUT, {
    when: Date.now() + Number(timeoutMs || DEFAULT_TASK_TIMEOUT_MS),
  });
  if (sessionId && taskKey) {
    // 兜底：把在途上下文写进内存快照，供 SW 被回收后诊断
    liveInFlight = { sessionId, taskKey, at: new Date().toISOString() };
  }
}

// ---------------------------------------------------------------- 闹钟准点性探针（ALARM_PROBE）
/** 探针闹钟名（与业务闹钟分开，绝不影响调度） */
const ALARM_PROBE_NAME = 'SR_ALARM_PROBE';
/** 探针记录在 storage 里的键（SW 可能在两次调用之间被回收，不能只放内存） */
const ALARM_PROBE_KEY = 'sr_alarm_probe';
/** 任务超时/催单检查点闹钟的触发留痕（只保留最后一条，零噪音） */
const TASK_ALARM_PROBE_KEY = 'sr_task_alarm_fire';
/** 催单分支的执行轨迹（有界 40 条；用来定位"检查点进去了但没留下任何证据"的那种问题） */
const NUDGE_TRACE_KEY = 'sr_nudge_trace';

/** 往催单轨迹里记一条（零噪音：只写 storage、有界、不进会话事件流） */
async function traceNudge(stage, extra) {
  try {
    const bag = await chrome.storage.local.get(NUDGE_TRACE_KEY);
    const list = ((bag && bag[NUDGE_TRACE_KEY] && bag[NUDGE_TRACE_KEY].trace) || []).concat([{
      at: new Date(Date.now()).toISOString(), stage, ...(extra || {}),
    }]).slice(-40);
    await chrome.storage.local.set({ [NUDGE_TRACE_KEY]: { trace: list, updatedAt: new Date().toISOString() } });
  } catch (error) { /* 忽略 */ }
}

async function readNudgeTrace() {
  try {
    const bag = await chrome.storage.local.get(NUDGE_TRACE_KEY);
    return (bag && bag[NUDGE_TRACE_KEY] && bag[NUDGE_TRACE_KEY].trace) || [];
  } catch (error) {
    return [];
  }
}

async function readAlarmProbe() {
  try {
    const bag = await chrome.storage.local.get(ALARM_PROBE_KEY);
    return (bag && bag[ALARM_PROBE_KEY]) || null;
  } catch (error) {
    return null;
  }
}

async function writeAlarmProbe(record) {
  try {
    await chrome.storage.local.set({ [ALARM_PROBE_KEY]: record });
  } catch (error) {
    /* 写不进去不影响主流程，调用方会拿到内存里的值 */
  }
}

/**
 * ❗ 任务超时/催单检查点闹钟的**触发留痕**（2026-09-14 收尾 ③ 新增，零噪音设计）。
 *
 * 背景：把 `DOWNLOAD_NUDGE_AFTER_MS` 压到 2 秒专测"催单成功"分支时，四次都得到
 * `nudges=0 / nudgeChecks=0` —— 而这两个计数**只在检查点真的执行到那一步时才 +1**，
 * 所以"闹钟没触发"与"闹钟触发时任务已终态"两种原因在会话数据里**完全无法区分**。
 * 这里把"闹钟触发时刻 + 触发瞬间的任务状态"单独写进一个**只保留最后一条**的 storage 记录
 * （不进会话诊断事件流 → 不会有任何噪音），用 `ALARM_PROBE` 动作即可读回。
 */
async function recordTaskAlarmFire(alarm) {
  const record = {
    firedAt: new Date(Date.now()).toISOString(),
    scheduledTime: alarm && alarm.scheduledTime != null ? new Date(alarm.scheduledTime).toISOString() : null,
    deltaMs: alarm && alarm.scheduledTime != null ? Date.now() - Number(alarm.scheduledTime) : null,
  };
  try {
    const sessionId = await getActiveSessionId();
    record.sessionId = sessionId || null;
    if (sessionId) {
      const meta = await readSessionMeta(sessionId);
      record.activeTaskKey = (meta && meta.activeTaskKey) || null;
      record.sessionStatus = (meta && meta.status) || null;
      if (meta && meta.activeTaskKey) {
        const tasks = await readSessionTasks(sessionId, meta.shardCount);
        const task = tasks.find((item) => item.key === meta.activeTaskKey);
        record.taskStatus = task ? task.status : null;
        record.taskNudges = task ? Number(task.nudges || 0) : null;
        record.taskNudgeChecks = task ? Number(task.nudgeChecks || 0) : null;
      }
    }
  } catch (error) {
    record.readError = String((error && error.message) || error);
  }
  try {
    const previous = await readTaskAlarmFire();
    const fires = ((previous && previous.fires) || []).concat([record]).slice(-20);
    await chrome.storage.local.set({ [TASK_ALARM_PROBE_KEY]: { fires, updatedAt: new Date().toISOString() } });
  } catch (error) {
    /* 忽略：留痕失败不影响调度 */
  }
}

async function readTaskAlarmFire() {
  try {
    const bag = await chrome.storage.local.get(TASK_ALARM_PROBE_KEY);
    const stored = (bag && bag[TASK_ALARM_PROBE_KEY]) || null;
    if (!stored) return null;
    // 兼容两种形状：单条（旧）/ { fires: [...] }（现在）
    return Array.isArray(stored.fires) ? stored : { fires: [stored] };
  } catch (error) {
    return null;
  }
}

/** 在途上下文的内存快照（仅诊断用，权威状态永远在 storage） */
let liveInFlight = null;

// ----------------------------------------------------------------------------------
// 4.1 诊断事件（认领/拒绝/超时都要留痕，便于事后追溯）
// ----------------------------------------------------------------------------------

/** 诊断事件类型（字符串常量，便于 grep 与统计） */
const DIAG = Object.freeze({
  DOWNLOAD_CLAIMED: 'download_claimed',
  DOWNLOAD_REJECTED: 'download_rejected',
  EXECUTE_TIMEOUT: 'execute_timeout',
  RECONCILE_SUCCESS: 'reconcile_success',
  RECONCILE_FAILED: 'reconcile_failed',
  VISIBILITY_RETRY: 'visibility_retry',
  /** 会话产物（manifest/log）落盘文件名降级：不静默，必须留证 */
  ARTIFACT_DEGRADED: 'artifact_filename_degraded',
  /** 表单 frame 自报登记：定向发送的依据，实机排障关键事实 */
  FORM_FRAME_REGISTERED: 'form_frame_registered',
  /** 表单 frame 迟迟不出现 → 刷新取数页重挂微应用（自愈），留证 */
  FORM_FRAME_REVIVED: 'form_frame_revived',
  /** 页面残留上一次结果视图 → 刷新回表单视图（避免"提交成功"假阳性），留证 */
  STALE_RESULT_CLEARED: 'stale_result_view_cleared',
  /** JSON 产物已投递（含投递方式与最终路径观测） */
  ARTIFACT_DELIVERED: 'artifact_delivered',
  /** 页面上下文投递失败，回退 data: URL（不静默） */
  ARTIFACT_FALLBACK_DATA_URL: 'artifact_fallback_data_url',
  /** JSON 产物被下载接管重命名到归档路径 */
  ARTIFACT_RENAMED: 'artifact_renamed',
  /** 等下载期间对同一结果视图"催单"再点一次「下载报表」（平台导出异步） */
  DOWNLOAD_NUDGED: 'download_nudged',
  /** 到点该催单但没能催（页面不接受 / 次数用尽）——不静默，必须留证 */
  DOWNLOAD_NUDGE_SKIPPED: 'download_nudge_skipped',
  /**
   * ❗ 加固①（2026-09-14）：**同一任务的第二份产物**（催单/平台重试造成）在**落盘前**被丢弃。
   *    detail 必须含：`duplicateOfTaskKey`（属于哪个任务）+ `disposition`（走了哪条路：
   *    cancelled = 已在落盘前取消 / quarantined = 竞态已落盘但落进隔离目录 / cancel-requested = 已请求取消待收口）
   *    + 原始文件名 / 来源 url / 时间。**绝不静默，也绝不删除任何文件。**
   */
  DOWNLOAD_DUPLICATE_DISCARDED: 'download_duplicate_discarded',
  /**
   * ❗ 平台单次导出**行数上限 100,000**：平台自报行数达上限即判"疑为静默截断"
   *    （文件在、行数正常、平台不报错，但数据少了）。检出即留证 + 进会话缺口，绝不静默。
   */
  ROW_CAP_SUSPECTED: 'row_cap_truncation_suspected',
});

/** 会话诊断事件上限（超过后丢最旧的，避免 storage 无限增长） */
const DIAG_EVENT_LIMIT = 300;

/**
 * 可选内部追踪钩子：默认关闭，零开销。
 * 需要在 DevTools / 测试里看调度与下载归属的中间态时，设 `globalThis.__SR_TRACE = true`。
 * 不写入 storage，只 console.debug，因此在生产环境不会污染会话数据。
 */
function trace(label, payload) {
  if (typeof globalThis === 'undefined' || !globalThis.__SR_TRACE) return;
  try {
    console.debug(`[SR_TRACE] ${label}`, payload === undefined ? '' : payload);
  } catch (ignored) { /* 追踪失败不影响主流程 */ }
}

function normalizeDiagEvents(meta) {
  return Array.isArray(meta && meta.diagnosticEvents) ? meta.diagnosticEvents.slice(-DIAG_EVENT_LIMIT) : [];
}

/**
 * 写一条诊断事件到**该会话分片自己的 meta**（不整会话重写）。
 * @returns {Promise<object|null>} 追加事件后的任务记录（若给了 taskKey）
 */
async function recordDiagnostic(sessionId, type, detail, taskKey) {
  if (!sessionId) return null;
  return withStateLock(async () => {
    const meta = await readSessionMeta(sessionId);
    if (!meta) return null;
    const events = normalizeDiagEvents(meta).concat([{
      at: new Date().toISOString(),
      type,
      taskKey: taskKey || null,
      ...(detail || {}),
    }]).slice(-DIAG_EVENT_LIMIT);
    let touched = null;
    const tasks = await readSessionTasks(sessionId, meta.shardCount);
    if (taskKey) {
      const task = tasks.find((item) => item.key === taskKey);
      if (task) {
        // 事件同时挂到任务上，任务级归档（manifest 的 tasks[]）也能看到
        touched = { ...task, diagnosticEvents: normalizeDiagEvents(task).concat([events[events.length - 1]]).slice(-50) };
      }
    }
    const nextTasks = touched ? replaceTaskIn(tasks, touched) : null;
    if (nextTasks) await writeTaskShards(sessionId, nextTasks, [touched.key]);
    await writeSessionMeta({ ...meta, diagnosticEvents: events });
    return touched;
  });
}

// ----------------------------------------------------------------------------------
// 4.2 迟到的下载对账（reconciliation）
//
// 背景（2026-09-13 实机证据）：
//   会话 S2026091312191701 里，任务被判 failed_permanent（attempts=3，file=null、
//   exportEvidence=null），但同一时刻 Chrome 下载历史里、**同一个标签页**确实成功下载了
//   `000000_ZS_FD_260701-260731_20260913_73ff...xlsx`（27,750 B，state=complete）。
//   即：页面流程真的跑通了、文件也下来了，只是「响应丢失 → expectedDownload 归属没接上」，
//   文件于是停在下载根目录、用平台原名，任务却被判永久失败。
//
// 兜底归属（**不放松原有四重校验**，只在"当前没有被命中的在途归属"时启用）：
//   ① 文件名必须是 .xlsx
//   ② 文件名必须通过 core.matchesExpectedFile 与**本会话**某个未完成任务精确匹配
//      （reportName 前缀 + 导出日期 + 32 位 hash，判据与四重校验完全一致）
//   ③ 下载来源必须是本会话的 ownerTabId（拿不到 tab/url 信息时不因此放宽，见调用点注释）
//   ④ 认领不到 → **绝不 suggest**，只记诊断事件
// ----------------------------------------------------------------------------------

/**
 * 在会话的任务清单里找"这个文件名属于哪个未完成任务"。
 * 判据复用 core.matchesExpectedFile（不另写一套匹配规则）。
 */
function findTaskForDownload(meta, tasks, filename) {
  const list = Array.isArray(tasks) ? tasks : [];
  for (const task of list) {
    if (!task || core.isTerminalTaskState(task.status)) continue;
    if (core.matchesExpectedFile(task, filename)) return task;
  }
  // 已完成任务命中 → 明确报"已认领过"，便于区分"重复下载"与"不认识的文件"
  for (const task of list) {
    if (task && core.matchesExpectedFile(task, filename)) return { ...task, alreadyDone: true };
  }
  return null;
}

/** 取下载事件里的来源标签页 id（字段名跨版本探测） */
function downloadSourceTabId(item) {
  for (const field of DOWNLOAD_TAB_ID_FIELDS) {
    const value = item ? item[field] : null;
    if (value != null && Number.isFinite(Number(value))) return Number(value);
  }
  return null;
}

/**
 * 迟到的下载认领。返回：
 *   { claimed:true, taskKey, relativePath, reason } —— 可以 suggest 归档
 *   { claimed:false, reason }                        —— 绝不 suggest，只记诊断
 *
 * ⚠️ 只在「没有匹配的在途 expectedDownload」时由调用方启用。
 */
async function reconcileLateDownload(item, filename) {
  const sessionId = await getActiveSessionId();
  if (!sessionId) return { claimed: false, reason: '没有活跃会话' };
  const meta = await readSessionMeta(sessionId);
  if (!meta) return { claimed: false, reason: '会话 meta 缺失' };

  const tasks = await readSessionTasks(sessionId, meta.shardCount);
  const task = findTaskForDownload(meta, tasks, filename);
  if (!task) return { claimed: false, reason: '文件名与本次会话任何任务的 reportName 都不匹配' };
  if (task.alreadyDone) {
    return { claimed: false, reason: `该文件已被任务 ${task.key} 认领过（重复下载），不再重复归档` };
  }

  // ---- 来源校验：必须是本会话那个标签页
  const sourceTabId = downloadSourceTabId(item);
  const pageUrl = String(item && item.url || '');
  if (sourceTabId != null && Number(meta.ownerTabId) != null) {
    if (sourceTabId !== Number(meta.ownerTabId)) {
      return { claimed: false, reason: `下载来源标签页 ${sourceTabId} 不是本会话的 ${meta.ownerTabId}` };
    }
  } else if (pageUrl && !core.isAllowedPageUrl(pageUrl)) {
    // 拿不到 tabId 时退一步看 url：不是生参白名单页面就不认
    return { claimed: false, reason: `下载来源 url 不在生参白名单：${pageUrl}` };
  }

  // ---- 认领只推到 downloading；完成事件统一结算，不能提前算成功
  const claimed = await withStateLock(async () => {
    const latest = await readSessionMeta(sessionId);
    if (!latest) return null;
    const latestTasks = await readSessionTasks(sessionId, latest.shardCount);
    let current = latestTasks.find((entry) => entry.key === task.key);
    if (!current || core.isTerminalTaskState(current.status)) return null;
    // 重试/异常态不伪造为正在执行；由原有重试流程处理。
    if (!['navigating', 'ready', 'platform_processing', 'downloading'].includes(current.status)) return null;
    // 迟到文件不能抢占另一项任务的下载指针。
    if (latest.activeTaskKey && latest.activeTaskKey !== current.key) return null;
    if (latest.expectedDownload && latest.expectedDownload.downloadId !== item.id) return null;
    current = advanceTask(current, 'downloading');
    const headerCheck = compareHeaders(current, current.exportEvidence ? current.exportEvidence.headers : []);
    current = {
      ...current,
      reconciliation: {
        at: new Date().toISOString(),
        reason: '迟到下载对账认领（响应丢失，但文件确属本会话任务）',
        downloadId: item && item.id != null ? item.id : null,
        sourceTabId,
        sourceUrl: pageUrl || null,
      },
      validation: {
        fileExists: null,     // 此刻下载尚未 complete，落到 settleDownloadComplete 再补
        bytes: null,
        headerCheck,
        checkedAt: new Date().toISOString(),
        origin: 'reconcile-late-download',
      },
      file: {
        path: null,
        relative: archiveRelativeFile(current, filename),
        downloadId: item && item.id != null ? item.id : null,
        reconciled: true,
      },
    };
    const nextTasks = replaceTaskIn(latestTasks, current);
    await writeTaskShards(sessionId, nextTasks, [current.key]);
    await writeSessionMeta({ ...latest, activeTaskKey: current.key, expectedDownload: {
      taskKey: current.key, downloadId: item.id,
      armedAt: new Date().toISOString(),
      relativePath: archiveRelativeFile(current, filename),
    }, lastError: null });
    armTaskTimeout(sessionId, current.key, latest.taskTimeoutMs);
    return current;
  });

  if (!claimed) return { claimed: false, reason: '任务已在终态或已被认领（竞态）' };

  await recordDiagnostic(sessionId, DIAG.DOWNLOAD_CLAIMED, {
    filename, downloadId: item && item.id != null ? item.id : null,
    sourceTabId, sourceUrl: pageUrl || null,
    relativePath: archiveRelativeFile(claimed, filename),
    matchedBy: 'reportName + matchesExpectedFile（会话内未完成任务）',
  }, claimed.key);
  return { claimed: true, taskKey: claimed.key, relativePath: archiveRelativeFile(claimed, filename), reason: '' };
}

// ==================================================================================
// 5. 执行一个任务（置前台 → 预检 → 执行 → 等待下载完成）
// ==================================================================================

/** 在途去重：同一 (会话, 标签页, 任务, 尝试次数) 只允许一个 flight */
const taskFlights = new Set();

/** 单串行调度的核心：同一时刻只允许一个任务在途 */
let tickRunning = false;

/**
 * 执行一个任务。
 *
 * ⚠️ 第一件事必须是**把标签页置于前台并聚焦窗口**（见 ensureTabForeground 的实测证据：
 *    后台标签里 dt-oui 日期面板会卡在 enter-prepare，动画被暂停，面板关不掉、提交会阻塞主线程）。
 *
 * content.js 侧还有一道 `document.visibilityState !== 'visible'` 的硬断言，
 * 命中时返回 `{ ok:false, stage:'visibility' }`：本函数收到该 stage 会
 * **置前台 → 等 1.5 秒 → 重试一次**（不计入 MAX_ATTEMPTS），仍失败才判任务失败。
 */
async function executeTask(session, task) {
  const flightKey = `${session.sessionId}:${session.ownerTabId}:${task.key}:${task.attempts}`;
  if (taskFlights.has(flightKey)) return;
  taskFlights.add(flightKey);
  try {
    await assertAllowedTab(session.ownerTabId);

    // ---- ⓪ 置前台 + 聚焦窗口（每次出手前都做，这是硬前提）
    const foreground = await recoverForegroundBeforeTask(session, task);
    if (!foreground.ok) {
      await pauseForPageVisibility(
        session.sessionId,
        task.key,
        `标签页无法置于前台，任务未执行：${foreground.reason || '未知原因'}（前台标签是硬约束：后台标签会让日期面板卡死）`,
      );
      return;
    }

    // ---- ⓪ 等表单 frame 就位（**先等，不要立刻失败**）
    //   实机教训：iframe 需要几秒才加载完，而预检立刻开跑 → 连续 3 轮都以
    //   「只有非表单 frame 应答」告败、64 秒就收口、一个文件都没产出。
    //   正确做法：没有已知 form frameId 时轮询等待自报（上限 FORM_FRAME_WAIT_MS）。
    // ---- ⓪-b 自愈：表单 frame 迟迟不出现（典型：瓴羊微应用没挂上、页面只剩外壳）→ 刷新页面重挂再等一次
    let frameReady = await waitForFormFrame(session.ownerTabId, FORM_FRAME_WAIT_MS);
    if (!frameReady.ok) {
      const revived = await reviveFormPage(session.ownerTabId);
      if (revived.ok) {
        trace('formFrame.revive', { tabId: session.ownerTabId, url: revived.url });
        frameReady = await waitForFormFrame(session.ownerTabId, FORM_FRAME_WAIT_MS * 2);
        await recordDiagnostic(session.sessionId, DIAG.FORM_FRAME_REVIVED, {
          tabId: session.ownerTabId,
          refreshedUrl: revived.url,
          revived: frameReady.ok,
          waitedMs: frameReady.waitedMs,
          source: frameReady.source,
          note: frameReady.ok
            ? '表单 frame 未按时自报，刷新取数页后成功重挂'
            : '表单 frame 未按时自报，刷新取数页后仍未出现（页面可能确实没加载出取数表单）',
        }, task.key).catch(() => undefined);
        if (revived.attempt > 1) {
          await recordDiagnostic(session.sessionId, 'blank_page_recovered', { tabId: session.ownerTabId, attempt: revived.attempt }, task.key).catch(() => undefined);
        }
      } else {
        trace('formFrame.revive-skipped', { reason: revived.reason });
        frameReady = { ...frameReady, reason: revived.reason || frameReady.reason };
      }
    }

    if (!frameReady.ok) {
      if (String(frameReady.reason || '').includes('blank_page')) {
        await recordDiagnostic(session.sessionId, 'blank_page_recovery_failed', { tabId: session.ownerTabId, reason: frameReady.reason }, task.key).catch(() => undefined);
        await pauseForPageVisibility(session.sessionId, task.key, `页面白屏，已自动刷新 ${BLANK_PAGE_RECOVERY_ATTEMPTS} 次仍未恢复：${frameReady.reason}`);
        return;
      }
      await failTaskSoft(
        session.sessionId,
        task.key,
        `预检失败：${frameReady.reason}（已等待 ${frameReady.waitedMs} 毫秒）`,
      );
      return;
    }
    trace('formFrame.ready', { tabId: session.ownerTabId, source: frameReady.source, frameId: frameReady.frameId, waitedMs: frameReady.waitedMs });

    // ---- ⓪-c 预清场：页面还停在上一次的**结果视图**时必须先刷新回表单视图。
    //   实机根因（2026-09-13 场次 N1/P1/P2）：微应用重载后会恢复上一次的结果视图；
    //   此时表单控件不存在（填表得到"「数据粒度」下没有选项"，指标 0/117），
    //   而"提交成功"的判据是"结果视图出现" → 残留视图会直接命中判据，产出假阳性。
    //   ⚠️ 必须放在"确认 frame 就绪"**之后**：自愈刷新这条路同样会恢复结果视图，不能漏。
    const pageState = await sendToPage(session.ownerTabId, { type: 'SR_STATE' });
    if (pageState && pageState.ok && pageState.state && pageState.state.inResultView) {
      const cleaned = await reviveFormPage(session.ownerTabId);
      if (cleaned.ok) {
        frameReady = await waitForFormFrame(session.ownerTabId, FORM_FRAME_WAIT_MS * 2);
        await recordDiagnostic(session.sessionId, DIAG.STALE_RESULT_CLEARED, {
          tabId: session.ownerTabId,
          refreshedUrl: cleaned.url,
          formFrameBack: frameReady.ok,
          note: '页面仍停在上一次结果视图，已刷新取数页回到表单视图（避免提交假阳性）',
        }, task.key).catch(() => undefined);
        if (!frameReady.ok) {
          await failTaskSoft(session.sessionId, task.key, `预检失败：清场刷新后表单 frame 未回来（${frameReady.reason}）`);
          return;
        }
      } else {
        trace('staleResult.revive-skipped', { reason: cleaned.reason });
      }
    }

    // ---- ⓪-d 控件就绪（2026-09-18 新增，取数侧修）：**frame 在了 ≠ 控件渲染完了**。
    //   实测症状：新会话第 1 个任务报「数据粒度（「数据粒度」下没有选项「店铺」，可选：）」——
    //   ⓪ 的 waitForFormFrame 已通过（frame 在），但三个必需单选组还没渲染出来；
    //   任务被计一次失败，3 次后永久留缺口。这里把"控件就绪"补成显式闸门：不满足则自愈刷新再等一次。
    let controlsReady = await waitForFormControls(session.ownerTabId, FORM_CONTROLS_WAIT_MS);
    if (!controlsReady.ok) {
      const rv = await reviveFormPage(session.ownerTabId);
      if (rv.ok) {
        trace('formControls.revive', { tabId: session.ownerTabId, url: rv.url });
        controlsReady = await waitForFormControls(session.ownerTabId, FORM_CONTROLS_WAIT_MS * 2);
        await recordDiagnostic(session.sessionId, DIAG.FORM_FRAME_REVIVED, {
          tabId: session.ownerTabId,
          refreshedUrl: rv.url,
          revived: controlsReady.ok,
          waitedMs: controlsReady.waitedMs,
          readiness: controlsReady.readiness,
          note: controlsReady.ok
            ? '表单控件未按时渲染，刷新取数页后已就绪'
            : '表单控件未按时渲染，刷新后仍未就绪（页面可能确实没加载出取数表单）',
        }, task.key).catch(() => undefined);
        if (rv.attempt > 1) {
          await recordDiagnostic(session.sessionId, 'blank_page_recovered', { tabId: session.ownerTabId, attempt: rv.attempt }, task.key).catch(() => undefined);
        }
      } else {
        trace('formControls.revive-skipped', { reason: rv.reason });
        controlsReady = { ...controlsReady, reason: rv.reason || controlsReady.reason };
      }
    }
    // ⚠️ 留证走 background 侧通道：`steps` 是 **content.js** 的步骤数组（由 SR_EXECUTE_TASK 返回），
    //    background 的运行流程里没有它 —— 2026-09-18 我在这里误用 `steps.push(...)`，
    //    任务直接抛 `steps is not defined`、连败 3 次留缺口（COLD2 场次）。改回 trace + 诊断事件。
    const readyText = controlsReady.ok
      ? `等待 ${controlsReady.waitedMs} 毫秒就绪（数据粒度 ${controlsReady.readiness.granularityOptions} 项 / 数据维度 ${controlsReady.readiness.dimensionOptions} 项 / 时间粒度 ${controlsReady.readiness.timeGrainOptions} 项）`
      : controlsReady.reason;
    trace('formControls.ready', {
      tabId: session.ownerTabId,
      taskKey: task.key,
      ok: controlsReady.ok,
      waitedMs: controlsReady.waitedMs,
      readiness: controlsReady.readiness,
      text: readyText,
    });
    if (!controlsReady.ok) {
      if (String(controlsReady.reason || '').includes('blank_page')) {
        await recordDiagnostic(session.sessionId, 'blank_page_recovery_failed', { tabId: session.ownerTabId, reason: controlsReady.reason }, task.key).catch(() => undefined);
        await pauseForPageVisibility(session.sessionId, task.key, `页面白屏，已自动刷新 ${BLANK_PAGE_RECOVERY_ATTEMPTS} 次仍未恢复：${controlsReady.reason}`);
        return;
      }
      await failTaskSoft(session.sessionId, task.key, `表单控件未就绪：${controlsReady.reason}`);
      return;
    }

    // ---- ① 预检：登录/风控文案 + 必填项齐全
    const preflight = await sendToPage(session.ownerTabId, { type: 'SR_PREFLIGHT' });
    if (!preflight || !preflight.ok) {
      const gate = preflight && preflight.gate ? preflight.gate : null;
      const required = preflight && preflight.required ? preflight.required : null;
      const detail = gate && !gate.ok && gate.reason
        ? gate.reason
        : (required && !required.ok ? `必填项未齐：${required.missing.join('、')}` : (preflight && preflight.reason) || '预检失败');
      await failTaskSoft(session.sessionId, task.key, `预检失败：${detail}`);
      return;
    }

    // ---- ② 执行：把完整任务参数交给 content.js（它是唯一 DOM 操作者）
    //     允许一次"可见性"重试：置前台 → 固定等待 → 再来一次，不计入 MAX_ATTEMPTS
    const payload = {
      type: 'SR_EXECUTE_TASK',
      task: {
        key: task.key,
        reportName: task.reportName,
        storeId: task.storeId,
        storeName: task.storeName,
        granularity: task.granularity,
        dimension: task.dimension,
        dimensionCode: task.dimensionCode,
        timeGrain: task.timeGrain,
        startDate: task.startDate,
        endDate: task.endDate,
        expectedMetricCount: task.expectedMetricCount,
        extraFilters: task.extraFilters,
        // ⚠️ 必须随任务一起下发：只在 selectors 维度表里声明是不够的，引擎读的是**任务上**的覆盖值
        extraFilterValues: task.extraFilterValues || {},
        timeoutMs: Number(task.timeoutMs || DEFAULT_TASK_TIMEOUT_MS),
      },
    };

    let result = null;
    let transientReason = '';
    const executeTimeoutMs = resolveExecuteTimeoutMs(session.executeTimeoutMs);
    for (let attempt = 1; attempt <= VISIBILITY_ATTEMPTS; attempt += 1) {
      const call = await callPageWithTimeout(session.ownerTabId, payload, executeTimeoutMs, frameReady.frameId);
      if (!call.settled) {
        // 响应丢失/超时/通道错误：**不立即判失败**，先看是否已有归属成功的下载
        transientReason = call.timedOut
          ? `页面响应超时（${executeTimeoutMs} 毫秒）`
          : `页面响应未送达：${call.error}`;
        await recordDiagnostic(session.sessionId, DIAG.EXECUTE_TIMEOUT, {
          attempt,
          timedOut: !!call.timedOut,
          error: call.error || null,
          note: '进入迟到下载对账观察窗；不立刻判失败',
        }, task.key);
        const reconciled = await waitForReconciledDownload(session.sessionId, task.key, RECONCILE_WAIT_MS);
        if (reconciled.reconciled) {
          // 页面真的成功了：按 done 处理，绝不判 failed_permanent
          await recordDiagnostic(session.sessionId, DIAG.RECONCILE_SUCCESS, {
            reason: reconciled.reason,
            taskStatus: reconciled.task.status,
            relativePath: reconciled.task.file ? reconciled.task.file.relative : null,
          }, task.key);
          return;
        }
        await recordDiagnostic(session.sessionId, DIAG.RECONCILE_FAILED, {
          reason: reconciled.reason,
          waitMs: RECONCILE_WAIT_MS,
        }, task.key);
        // 对账失败 → 显式留缺口（不静默跳过），理由写全
        await failTaskSoft(
          session.sessionId,
          task.key,
          `${transientReason}；随后 ${RECONCILE_WAIT_MS} 毫秒对账窗内没有观察到归属成功的下载（${reconciled.reason}）`,
        );
        return;
      }

      result = call.value;
      if (result && result.popupBlocked) {
        await recordDiagnostic(session.sessionId, 'popup_blocked', { reason: result.reason }, task.key);
        await pauseForPageVisibility(session.sessionId, task.key, result.reason);
        return;
      }
      if (result && result.ok) break;
      if (isVisibilityStage(result)) {
        // 可见性断言：**不算任务失败**，重新置前台后再来一次
        await recordDiagnostic(session.sessionId, DIAG.VISIBILITY_RETRY, {
          attempt,
          reason: (result && result.reason) || null,
        }, task.key);
        if (attempt < VISIBILITY_ATTEMPTS) {
          const refocus = await ensureTabForeground(session.ownerTabId);
          if (refocus && refocus.reason) {
            await recordDiagnostic(session.sessionId, DIAG.VISIBILITY_RETRY, {
              attempt, phase: 'refocus', reason: refocus.reason,
            }, task.key);
          }
          continue;
        }
        await pauseForPageVisibility(
          session.sessionId,
          task.key,
          `标签页无法置于前台，任务未执行：${(result && result.reason) || '可见性断言未通过'}`
          + `（已重试 ${VISIBILITY_ATTEMPTS} 次，每次含 ${FOREGROUND_SETTLE_MS} 毫秒稳定等待）`,
        );
        return;
      }
      // ❗❗ 2026-09-20 新增（三批事故共同的放大器）：**日期步骤失败会把日期面板"卡死"**
      //    —— 面板停在错误月份、连翻月按钮都找不到，而表单实例在**同一会话内复用** ⇒
      //    后续每个任务的日期步骤都以同样方式失败（真正的失败只有头几期，剩下全是传染）。
      //    实测：SD11~SD15 五个退款维度会话 25/25 全废；用户机器上"客户/分日"150/150、
      //    "品类/分日"30/30、"商品/分日"2063/2064 全废（而同一批的"店铺/分日"429/579 正常）。
      //    修法：日期步骤失败后**立刻刷新取数页**，让下一个任务从干净表单开始。
      if (result && result.stage === 'date_range') {
        const rv = await reviveFormPage(session.ownerTabId).catch(() => ({ ok: false }));
        await recordDiagnostic(session.sessionId, DIAG.FORM_FRAME_REVIVED, {
          attempt,
          phase: 'after-date-range-failure',
          revived: !!rv.ok,
          note: '日期步骤失败后刷新取数页：防"面板卡死"传染后续任务（2026-09-20）',
        }, task.key).catch(() => undefined);
        if (rv.ok) await waitForFormFrame(session.ownerTabId, FORM_FRAME_WAIT_MS * 2);
      }
      if (result && result.stage === 'rename_required') {
        const refreshed = await reviveFormPage(session.ownerTabId);
        const frame = refreshed.ok
          ? await waitForFormFrame(session.ownerTabId, FORM_FRAME_WAIT_MS * 2)
          : { ok: false, reason: refreshed.reason };
        await recordDiagnostic(session.sessionId, 'report_name_conflict', {
          reportName: task.reportName,
          reason: result.reason,
          refreshed: refreshed.ok,
          formReady: frame.ok,
        }, task.key);
        if (!frame.ok) {
          await pauseForPageVisibility(session.sessionId, task.key,
            `平台要求重命名后无法恢复表单：${frame.reason}`);
          return;
        }
      }
      // 页面明确回报业务失败（非可见性、非超时）→ 直接结算，无需对账
      // ❗ 2026-09-15 补（Codex M1 强要求）：**失败也必须留现场证据**。
      //    此前这里只传 reason，`result.steps`（引擎已采集的步骤明细）被整个丢掉 →
      //    实测 5 个维度"分月切不动"时，任务记录的 `exportEvidence` 是空的，
      //    拿不到"失败瞬间页面到底长什么样"，导致根因无法定位。
      //    → 现在把 steps + 失败阶段 + 一份页面快照写进任务与诊断。
      await recordFailureEvidence(session.sessionId, task.key, result, attempt, {
        stage: 'business_failure', phase: 'executeTask',
        tabId: session.ownerTabId, frameId: frameReady.frameId,
      });
      await failTaskSoft(session.sessionId, task.key, (result && result.reason) || '页面执行失败');
      return;
    }

    if (!result || !result.ok) {
      await recordFailureEvidence(session.sessionId, task.key, result, attempt, {
        stage: 'retries_exhausted', phase: 'after-loop',
        tabId: session.ownerTabId, frameId: frameReady.frameId,
      });
      await failTaskSoft(
        session.sessionId,
        task.key,
        (result && result.reason) || transientReason || '页面执行失败',
      );
      return;
    }

    // ---- ③ 点击已发出：进入 platform_processing，等 chrome.downloads 回调
    // ❗ 平台 10 万行静默截断的**检出与留证**（2026-09-14）：
    //    文件在、行数正常、平台不报错，但数据可能被截断在 100,000 行（DET2 场次实证）。
    //    权威判据是结果视图的「共N条数据」文案（页面侧在读表头时一并取回）。
    const rowCap = core.assessRowCap({
      rowCount: result.rowCount,
      overCapWarning: result.overCapWarning,
      overCapWarningRaw: result.overCapWarningRaw,
      dimensionName: task.dimension,
      granularity: task.granularity,
      timeGrain: task.timeGrain,
      startDate: task.startDate,
      endDate: task.endDate,
    });
    await withStateLock(async () => {
      const meta = await readSessionMeta(session.sessionId);
      if (!meta || meta.activeTaskKey !== task.key) return;
      const tasks = await readSessionTasks(session.sessionId, meta.shardCount);
      let current = tasks.find((item) => item.key === task.key);
      if (!current || core.isTerminalTaskState(current.status)) return;
      current = advanceTask(current, 'platform_processing');
      current = {
        ...current,
        rowCap,
        exportEvidence: {
          headers: (Array.isArray(result.headers) ? result.headers : []).slice(),
          steps: result.steps || [],
          capturedAt: new Date().toISOString(),
          rowCount: rowCap.rowCount,
          rowCountRaw: result.rowCountRaw || null,
          overCapWarning: !!result.overCapWarning,
          overCapWarningRaw: result.overCapWarningRaw || null,
          rowCap,
        },
      };
      const nextTasks = replaceTaskIn(tasks, current);
      await writeTaskShards(session.sessionId, nextTasks, [current.key]);
      // 保持 expectedDownload（在调度器里已 armed）；只更新任务态与证据
      await writeSessionMeta({ ...meta, activeTaskKey: current.key });
    });
    // 截断嫌疑：**必须显式留证**（诊断事件 + 任务记录 + 会话缺口，三处都有，绝不静默）
    if (rowCap.suspect) {
      await recordDiagnostic(session.sessionId, DIAG.ROW_CAP_SUSPECTED, {
        rowCount: rowCap.rowCount,
        rowCountRaw: result.rowCountRaw || null,
        overCapWarning: !!rowCap.overCap,
        overCapWarningRaw: rowCap.overCapWarning || null,
        rowCap: rowCap.rowCap,
        dimension: task.dimension,
        timeGrain: task.timeGrain,
        range: `${task.startDate}~${task.endDate}`,
        hint: '平台判定本次导出超过 10 万行上限：文件已被截断，请按更细粒度分片重取（chunkUnit=week 或 day；深链接 sr_chunk=week）',
      }, task.key).catch(() => undefined);
    }
    // 首次检查提前到 60 秒（而非等满 taskTimeoutMs）：到点先走"下载催单"再点一次，
    // 催满 MAX_DOWNLOAD_NUDGES 次后才判超时。硬上限仍是 taskTimeoutMs。
    armTaskTimeout(
      session.sessionId,
      task.key,
      Math.min(Number(session.taskTimeoutMs || DEFAULT_TASK_TIMEOUT_MS), DOWNLOAD_NUDGE_AFTER_MS),
    );
  } finally {
    taskFlights.delete(flightKey);
  }
}

/**
 * ⏱ 长耗时页面调用：**必须用回调形式**。
 *
 * 2026-09-13 实机根因：`SR_EXECUTE_TASK` 的页面流程（填表 → 日历选日期 → 提交 →
 * 等结果视图 → 点下载）要跑十几秒。若用 promise 形式的 `chrome.tabs.sendMessage`，
 * 浏览器在消息通道超时后会以 "The message port closed before a response was received"
 * 之类的错误**拒绝**这次调用；而后台此时会重试，造成：
 *   · 页面明明跑通、文件也下载成功，后台却当成失败
 *   · expectedDownload 归属从未接上 → 文件停在下载根目录、用平台原名
 * 回调形式没有这个限制，超时完全由我们自己控制。
 *
 * ⚠️ 同时必须**按 frameId 定向**（除非确实不知道 frameId）：广播模式下顶层外壳 frame
 *    会抢走应答，表单 frame 的真实结果根本到不了这里。
 *
 * @returns {{ settled:boolean, value?:object, error?:string, timedOut?:boolean }}
 */
function callPageWithTimeout(tabId, message, timeoutMs, frameId) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      resolve({ settled: false, timedOut: true, error: `页面响应超时（${timeoutMs} 毫秒）：${message && message.type}` });
    }, timeoutMs);
    const finish = (outcome) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const options = frameId == null ? null : { frameId: Number(frameId) };
    try {
      const onResponse = (response) => {
        const lastError = chrome.runtime.lastError;
        if (lastError) {
          // 通道错误（页面重载 / 表单 frame 不在 / 端口关闭）→ 视为未结算，交给对账
          finish({ settled: false, error: lastError.message || String(lastError) });
          return;
        }
        finish({ settled: true, value: response || null });
      };
      if (options) chrome.tabs.sendMessage(tabId, message, options, onResponse);
      else chrome.tabs.sendMessage(tabId, message, onResponse);
    } catch (error) {
      finish({ settled: false, error: String(error && error.message || error) });
    }
  });
}

/**
 * 等待下载对账：响应丢失/超时后，观察任务是否被"迟到下载对账"推成 done。
 * 这是把"页面成功但响应丢失"变成**可恢复**的关键一步。
 *
 * @returns {Promise<{reconciled:boolean, task?:object, reason:string}>}
 */
async function waitForReconciledDownload(sessionId, taskKey, waitMs) {
  const deadline = Date.now() + Math.max(0, Number(waitMs || 0));
  while (Date.now() < deadline) {
    const meta = await readSessionMeta(sessionId);
    if (!meta) return { reconciled: false, reason: '会话 meta 缺失' };
    const tasks = await readSessionTasks(sessionId, meta.shardCount);
    const task = tasks.find((item) => item.key === taskKey);
    if (!task) return { reconciled: false, reason: '任务不存在' };
    // ① 对账路径成功
    if (task.reconciliation && task.status === 'done') {
      return { reconciled: true, task, reason: '迟到下载已对账认领并完成' };
    }
    // ② 正常归属路径成功：**响应丢失发生在下载完成之后**时才走得到这里
    //    （下载的 onDeterminingFilename 四重校验全过 → 已登进 downloading → complete → done）。
    //    此时任务已是 done 且带 validation 记录，同样是"页面真的成功了"，绝不能判失败。
    if (task.status === 'done' && task.validation) {
      return { reconciled: true, task, reason: '页面流程已完成且下载归属成功（响应晚于下载返回）' };
    }
    if (core.isTerminalTaskState(task.status)) {
      return { reconciled: false, task, reason: `任务已进入终态 ${task.status}（无成功归属记录）` };
    }
    await sleep(RECONCILE_POLL_MS);
  }
  return { reconciled: false, reason: `对账观察窗 ${waitMs} 毫秒内未见归属成功的下载` };
}

/** 对账轮询间隔（固定值，无随机） */
const RECONCILE_POLL_MS = 1000;

/** 页面回报的失败是否属于「标签页不可见」这一阶段（content.js 的 stage 标记） */
function isVisibilityStage(result) {
  if (!result) return false;
  if (result.stage === 'visibility') return true;
  // 兼容 stage 缺失但文案命中可见性断言的旧版 content.js
  return !result.ok && /visibilityState|不可见|置于前台/.test(String(result.reason || ''));
}

/** 任务失败结算（软失败：交给状态机决定重试还是永久失败） */
/**
 * ❗ 失败现场证据（2026-09-15 按 Codex M1 要求新增）。
 *
 * 目的：**门禁失败时也要留下可复现排障的现场**（此前失败路径把 `result.steps` 全丢了，
 * 导致 5 个维度"分月切不动"时任务记录里 `exportEvidence` 是空的、根因无法定位）。
 *
 * 记录内容（Codex 点名的几项）：页面/框架目标、任务 key、**操作先后**（steps 顺序）、
 * **单选状态**、**可见与隐藏的月份输入**、选择器命中情况、失败阶段与**失败瞬间快照**。
 * ⚠️ 只回答"发生了什么"，**不解释原因**（没有证据不下结论）。
 */
async function recordFailureEvidence(sessionId, taskKey, result, attempt, ctx) {
  const steps = (result && Array.isArray(result.steps)) ? result.steps : [];
  // ❗ 优先用**判据超时当场**抓的快照（content 侧随失败结果回传）——
  //    收尾再抓会被后续动作改动（实测拿到过"数据维度=经营投产比"的残留值），不足以定论。
  let snapshot = (result && result.failureSnapshotAtGate) || null;
  if (!snapshot) {
    try {
      const snap = await sendToPage(ctx.tabId, { type: 'SR_FAILURE_SNAPSHOT' });
      snapshot = (snap && snap.snapshot) || { probeError: (snap && snap.reason) || '快照探针无响应' };
    } catch (error) {
      snapshot = { probeError: String((error && error.message) || error) };
    }
  }
  const evidence = {
    capturedAt: new Date().toISOString(),
    snapshotTiming: (result && result.failureSnapshotAtGate) ? 'atGateTimeout（判据超时当场）' : 'atSettlement（收尾补抓，参考价值较低）',
    stage: ctx.stage, phase: ctx.phase, attempt,
    tabId: ctx.tabId != null ? Number(ctx.tabId) : null,
    frameId: ctx.frameId != null ? Number(ctx.frameId) : null,
    taskKey,
    engineStage: (result && result.stage) || null,
    reason: (result && result.reason) || null,
    gateDiagnostics: (result && result.gateDiagnostics) || null,
    stepCount: steps.length,
    steps: steps.slice(-40),
    failureSnapshot: snapshot,
    note: '失败现场证据；**只记录事实，不解释原因**（无证据不认定根因）',
  };
  try {
    await withStateLock(async () => {
      const meta = await readSessionMeta(sessionId);
      if (!meta) return;
      const tasks = await readSessionTasks(sessionId, meta.shardCount);
      const idx = tasks.findIndex((item) => item.key === taskKey);
      if (idx < 0) return;
      tasks[idx] = {
        ...tasks[idx],
        exportEvidence: { ...(tasks[idx].exportEvidence || {}), failureEvidence: evidence },
      };
      await writeTaskShards(sessionId, tasks, [taskKey]);
    });
  } catch (error) { /* 留证失败不得影响主流程 */ }
  try {
    await recordDiagnostic(sessionId, 'task_failure_evidence', {
      stage: evidence.stage, attempt, engineStage: evidence.engineStage,
      stepCount: evidence.stepCount, reason: evidence.reason,
      snapshotKeys: snapshot && typeof snapshot === 'object' ? Object.keys(snapshot).slice(0, 14) : null,
    }, taskKey);
  } catch (error) { /* 同上 */ }
}

// Only before submitting a report: one refresh, then require positive page visibility.
async function recoverForegroundBeforeTask(session, task) {
  const tabId = session.ownerTabId;
  const initial = await ensureTabForeground(tabId);
  if (initial.ok) return initial;
  await recordDiagnostic(session.sessionId, 'visibility_refresh_started', initial, task.key);
  try {
    await assertAllowedTab(tabId);
    await clearFormFrame(tabId, '页面不可见，刷新一次恢复连接');
    await chrome.tabs.reload(tabId);
    await sleep(FORM_REVIVE_SETTLE_MS);
    const ready = await waitForFormFrame(tabId, FORM_FRAME_WAIT_MS * 2);
    if (!ready.ok) throw new Error(`刷新后表单未就绪：${ready.reason}`);
    const visible = await ensureTabForeground(tabId);
    if (!visible.ok || visible.visibility !== 'visible') throw new Error(visible.reason || '刷新后未确认页面可见');
    const probe = await sendToPage(tabId, { type: 'SR_STATE' });
    const state = probe && probe.ok && probe.state;
    const storeName = state && (state.storeName || state.sourceStore);
    if (!storeName) throw new Error('刷新后无法确认店铺，已保留进度');
    core.assertSameContext({ storeId: session.storeId, storeName: session.storeName },
      { storeId: session.storeId, storeName });
    await recordDiagnostic(session.sessionId, 'visibility_refresh_recovered', { storeName }, task.key);
    return visible;
  } catch (error) {
    const reason = `自动刷新一次后未恢复：${error.message || error}`;
    await recordDiagnostic(session.sessionId, 'visibility_refresh_failed', { reason }, task.key);
    return { ok: false, reason };
  }
}

async function pauseForPageVisibility(sessionId, taskKey, reason) {
  return withStateLock(async () => {
    const meta = await readSessionMeta(sessionId);
    if (!meta) return;
    const tasks = await readSessionTasks(sessionId, meta.shardCount);
    const task = tasks.find(item => item.key === taskKey);
    if (!task || core.isTerminalTaskState(task.status)) return;
    // Visibility assertions occur before submission; do not spend a report attempt.
    const pending = { ...task, status: 'pending', attempts: Math.max(0, Number(task.attempts || 0) - 1),
      earliestNextAt: null, lastError: reason };
    await writeTaskShards(sessionId, replaceTaskIn(tasks, pending), [taskKey]);
    const paused = meta.status === 'paused' ? meta : metaWithSessionAction(meta, 'pause');
    await writeSessionMeta({ ...paused, activeTaskKey: null, expectedDownload: null, lastError: reason });
    const queue = await readQueue();
    await writeQueue({ ...queue, running: false, stoppedAt: new Date().toISOString(),
      lastError: reason, note: String(reason).includes('[弹窗阻挡]')
        ? '弹窗需人工处理，已暂停；处理后继续当前任务，再启动后续队列'
        : '页面恢复失败，已暂停；恢复浏览器后继续当前任务，再启动后续队列' });
    await chrome.alarms.clear(ALARM_TASK_TIMEOUT);
    await chrome.alarms.clear(ALARM_TICK);
  });
}

async function failTaskSoft(sessionId, taskKey, reason) {
  return withStateLock(async () => {
    const meta = await readSessionMeta(sessionId);
    if (!meta) return null;
    const tasks = await readSessionTasks(sessionId, meta.shardCount);
    const task = tasks.find((item) => item.key === taskKey);
    if (!task || core.isTerminalTaskState(task.status)) return null;
    let failed = settleFailure(task, reason);
    // 每轮尝试的错误史（2026-09-14 补）：manifest 原先只记**最终**错误，
    // 于是"第 2 次才成功"的场次里第 1 次为什么失败**无从查证**（R1 场次即如此，
    // 只看到 attempts=2、其余一片空白）。逐轮留证，不静默。
    const attemptHistory = Array.isArray(task.attemptHistory) ? task.attemptHistory.slice(-7) : [];
    attemptHistory.push({ at: new Date().toISOString(), attempt: Number(task.attempts || 0), error: String(reason) });
    failed = { ...failed, attemptHistory };
    // 固定退避：未超限时写清"最早可再出手"的时刻（core 的固定值，无随机成分）
    if (failed.status === 'retry_wait') {
      failed = { ...failed, earliestNextAt: new Date(Date.now() + core.nextBackoffMs(Number(failed.attempts || 1))).toISOString() };
    }
    const nextTasks = replaceTaskIn(tasks, failed);
    await writeTaskShards(sessionId, nextTasks, [taskKey]);
    const closed = await writeSessionMeta({ ...meta, lastError: String(reason), expectedDownload: null });
    if (closed.status === 'running') {
      // 达上限（failed_permanent）→ 按固定间隔继续调度下一项；未超限 → 退避到点再看
      if (failed.status === 'retry_wait') scheduleTick(Date.parse(failed.earliestNextAt) - Date.now());
      else if (core.isTerminalTaskState(failed.status)) scheduleTick(closed.taskIntervalMs);
      else scheduleTick(0);
    }
    return failed;
  });
}

// ==================================================================================
// 6. 会话生命周期
// ==================================================================================

/** 建会话（冻结任务清单；§4.2 冻结后只允许作废，不允许新增） */
/**
 * 由 config 生成会话 meta **与**冻结任务清单（**同一个来源，只构一次**）。
 *
 * ⚠️ 2026-09-14 修：此前 meta 与 tasks 是**分两处**各自调用 `core.buildTaskCatalog` 构出来的
 *    （`buildNewSession` 一次、`START` 分支再一次），参数集不同就会**漂移**——例如
 *    `extraFilterValues` 传给了 meta 那一份、没传给 START 那一份时，meta.total 与实际任务清单
 *    的长度/内容会不一致（总数来自上一份，真正落盘的是后一份）。现在统一为这一个函数。
 *
 * @returns {{meta:object, tasks:ReadonlyArray<object>}}
 */
function buildSessionPlan(config, ownerTabId) {
  const meta = buildNewSession(ownerTabId == null ? (config || {}) : { ...(config || {}), ownerTabId });
  const tasks = core.buildTaskCatalog({
    storeId: meta.storeId,
    storeName: meta.storeName,
    granularity: meta.granularity,
    timeGrain: meta.timeGrain,
    startDate: meta.startDate,
    endDate: meta.endDate,
    dimensionNames: meta.dimensions,
    batch: meta.batch || undefined,
    chunkUnit: meta.chunkUnit,
    extraFilterValues: meta.extraFilterValues,
  });
  return { meta, tasks };
}

function buildNewSession(config) {
  const storeId = String(config.storeId || '').trim();
  const storeName = String(config.storeName || '').trim();
  const timeGrain = String(config.timeGrain || '').trim();
  const dimensionNames = Array.isArray(config.dimensions) ? config.dimensions.slice() : [];

  const range = core.assertDateRange(config.startDate, config.endDate);
  const tasks = core.buildTaskCatalog({
    storeId,
    storeName,
    granularity: config.granularity || '店铺',
    timeGrain,
    startDate: range.start,
    endDate: range.end,
    dimensionNames,
    batch: config.batch,
    // ⚠️ 不传时**不要**在这里写默认值：默认分片单位是「维度 × 时间粒度」的函数
    //   （分周 → week；rowRisk:'high' 的明细维度分日 → week；其余 → month），
    //   由 core.autoChunkUnit 逐维度决定。写死一个默认值会把它整个盖掉（Z1 场次踩过同类坑）。
    chunkUnit: config.chunkUnit,
    // 额外筛选值的**显式覆盖**（维度 → 控件 → 值时）；未配置的控件沿用平台默认值。
    // 形状/合法性由 core.normalizeExtraFilterValues 校验，错配在**建会话前**就抛错（不静默忽略）。
    extraFilterValues: config.extraFilterValues,
  });

  const sessionId = makeSessionId();
  const now = new Date().toISOString();
  return {
    sessionId,
    schemaVersion: core.SCHEMA_VERSION,
    scheduleVersion: VERSION,
    status: core.SESSION_ACTIONS.ready, // 'ready'：会话已建、任务清单已冻结
    ownerTabId: Number(config.ownerTabId),
    storeId,
    storeName,
    granularity: config.granularity || '店铺',
    timeGrain,
    dimensions: dimensionNames.slice(),
    startDate: range.start,
    endDate: range.end,
    batch: config.batch || null,
    // null = 未显式指定 → 每个任务按「维度 × 时间粒度」自动选（见 core.autoChunkUnit）；
    // 任务记录里带各自的 chunkUnit，便于审计"这一片为什么这么切"
    chunkUnit: config.chunkUnit || null,
    // 额外筛选值的显式覆盖（维度 → 控件 → 值时）：进会话 meta 便于审计"这批数据到底筛了什么"
    extraFilterValues: (config.extraFilterValues && typeof config.extraFilterValues === 'object')
      ? JSON.parse(JSON.stringify(config.extraFilterValues)) : {},
    taskIntervalMs: Number(config.taskIntervalMs || core.MIN_TASK_INTERVAL_MS),
    taskTimeoutMs: Number(config.taskTimeoutMs || DEFAULT_TASK_TIMEOUT_MS),
    // 会话级执行超时（默认 120 秒；可按会话覆盖，取值被夹在固定上下限内）
    executeTimeoutMs: resolveExecuteTimeoutMs(config.executeTimeoutMs),
    total: tasks.length,
    shardCount: Math.max(1, Math.ceil(tasks.length / core.TASK_SHARD_SIZE)),
    activeTaskKey: null,
    expectedDownload: null,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    lastError: null,
    // 诊断事件（认领/拒绝/超时/可见性重试都留痕），上限见 DIAG_EVENT_LIMIT
    diagnosticEvents: [],
  };
}

/** 落盘会话（首次写入：meta + 全部任务分片 + 索引） */
async function persistNewSession(meta, tasks) {
  const shardSize = core.TASK_SHARD_SIZE;
  const payload = { [core.storageKeys.sessionMeta(meta.sessionId)]: meta };
  for (let shard = 0; shard < meta.shardCount; shard += 1) {
    payload[core.storageKeys.sessionTasks(meta.sessionId, shard)] = tasks.slice(shard * shardSize, (shard + 1) * shardSize);
  }
  // ❗ 新会话落盘前先做一次配额卫生：会话详情会逐轮累积（见 core.SESSION_DETAIL_KEEP 的注释），
  //    配额打满会让**本会话静默卡死**、连 END 都写不出。本轮新会话 id 一并跳过（刚建的，别删）。
  await pruneSessionDetails({ skipSessionId: meta.sessionId }).catch(() => undefined);
  await setSessionStorage(payload, { skipSessionId: meta.sessionId });
  await upsertIndex(meta);
  await setActiveSessionId(meta.sessionId);
}

// ==================================================================================
// 7. 调度器（chrome.alarms 驱动；不依赖 setTimeout 保命）
// ==================================================================================

function scheduleTick(delayMs) {
  const delay = Math.max(TICK_MIN_MS, Number(delayMs == null ? 0 : delayMs));
  chrome.alarms.create(ALARM_TICK, { when: Date.now() + delay });
}

/** 清掉两个调度闹钟 */
async function clearAlarms() {
  await chrome.alarms.clear(ALARM_TICK);
  await chrome.alarms.clear(ALARM_TASK_TIMEOUT);
}

/** 读取会话 + 任务清单（调度核心数据结构） */
async function loadRun(sessionId) {
  const meta = await readSessionMeta(sessionId);
  if (!meta) return null;
  const tasks = await readSessionTasks(sessionId, meta.shardCount);
  return { meta, tasks };
}

/**
 * 调度主循环：
 *   - session.status === 'running' 才继续
 *   - 优先重跑 retry_wait / error 且退避到期的任务
 *   - 其次取第一个 pending
 *   - 都不满足且存在非终态任务 → 等固定间隔再看一次
 *   - 全部达终态 → 收口（产 manifest + session_log）
 */
async function runTick() {
  if (tickRunning) return;
  tickRunning = true;
  try {
    let nextAllowedAt = 0; // 固定限速：下一次允许出手的时刻（无随机抖动）
    outerLoop:
    while (true) {
      const sessionId = await getActiveSessionId();
      if (!sessionId) return;
      const run = await loadRun(sessionId);
      if (!run) return;
      const { meta, tasks } = run;

      if (meta.status === 'paused') return;      // 暂停语义：当前任务做完后停，不在这里推进
      if (meta.status !== 'running') return;

      // 在途任务：只等回调，不重复出手
      // ⚠️ 顺序很重要：必须先处理"等下载"与"退避等待"，再处理限速等待，
      //    否则限速等待会被误当成在途等待，把调度永久卡住。
      const inFlight = tasks.find((task) => task.key === meta.activeTaskKey);
      if (inFlight && !core.isTerminalTaskState(inFlight.status)) {
        // ① 已在等待平台/下载：只挂超时看门狗（绝不重复点击下载）
        if (inFlight.status === 'downloading' || inFlight.status === 'platform_processing') {
          if (!(await chrome.alarms.get(ALARM_TASK_TIMEOUT))) {
            armTaskTimeout(sessionId, inFlight.key, meta.taskTimeoutMs);
          }
          return;
        }
        // ② 退避重排中的任务仍挂着 activeTaskKey：等退避到点，不重复出手
        if (inFlight.status === 'retry_wait') {
          const waitUntil = inFlight.earliestNextAt ? Date.parse(inFlight.earliestNextAt) : 0;
          if (waitUntil > Date.now()) {
            scheduleTick(waitUntil - Date.now());
            return;
          }
        }
        // ③ 中间态残留在 activeTaskKey 上（历史遗留）→ 从断点重跑该任务
        if (['navigating', 'ready', 'export_clicked'].includes(inFlight.status)) {
          const rewound = core.canTransition(inFlight.status, 'pending') ? core.transitionTask(inFlight.status, 'pending') : inFlight;
          const rewoundTasks = replaceTaskIn(tasks, rewound);
          await writeTaskShards(sessionId, rewoundTasks, [rewound.key]);
          await writeSessionMeta({ ...meta, activeTaskKey: rewound.status === 'pending' ? null : rewound.key, lastError: `任务停留在中间态 ${inFlight.status}，已从断点重跑` });
          continue outerLoop; // 让循环回到顶部重新读取（此时 activeTaskKey 已清空）
        }
      }

      // ④ 固定限速间隔：上一次出手之后必须等满 taskIntervalMs 才能再出手。
      //    这里睡到点后**继续**同一轮循环（而不是 return + 依赖下一个闹钟），
      //    否则 executeTask 期间被吞掉的闹钟会把调度永久卡在等待上。
      if (nextAllowedAt > Date.now()) {
        await sleep(nextAllowedAt - Date.now());
        continue outerLoop;
      }

      const now = Date.now();
      const unfinished = tasks.filter((task) => !core.isTerminalTaskState(task.status));
      const retryable = unfinished.filter((task) => {
        if (task.status !== 'retry_wait' && task.status !== 'error') return false;
        const waitUntil = task.earliestNextAt ? Date.parse(task.earliestNextAt) : 0;
        return waitUntil <= now;
      });
      const next = retryable[0] || unfinished.find((task) => task.status === 'pending');

      if (!next) {
        if (unfinished.length === 0) {
          await completeSession(sessionId);
          return;
        }
        scheduleTick(meta.taskIntervalMs); // 其余非终态都在退避窗口内
        return;
      }

      // 出手：进入 navigating（attempts +1）
      const attempted = beginAttempt(next);
      const started = { ...attempted,
        originalReportName: next.originalReportName || next.reportName,
        reportName: reportNameForAttempt(attempted, sessionId, attempted.attempts) };
      const nextTasks = replaceTaskIn(tasks, started);
      await writeTaskShards(sessionId, nextTasks, [started.key]);
      const armed = {
        taskKey: started.key,
        sessionId,
        ownerTabId: meta.ownerTabId,
        relativePath: archiveRelativeFile(started, `${started.reportName}_<平台导出日期>_<hash>.xlsx`),
        armedAt: new Date().toISOString(),
        downloadId: null,
        resumed: false,
      };
      const nextMeta = await writeSessionMeta({ ...meta, activeTaskKey: started.key, expectedDownload: armed });
      armTaskTimeout(sessionId, started.key, nextMeta.taskTimeoutMs);
      nextAllowedAt = Date.now() + Math.max(0, Number(meta.taskIntervalMs || core.MIN_TASK_INTERVAL_MS));

      // 真正执行（串行：一次 tick 只开一个任务；执行期间 tickRunning 挡住重入）
      // ⚠️ 必须在这里兜住异常：否则任务会永远停在 navigating（既不出文件也不报错）
      try {
        await executeTask(nextMeta, started);
      } catch (error) {
        await failTaskSoft(nextMeta.sessionId, started.key, `执行任务异常：${error && error.message}`);
      }
    }
  } finally {
    tickRunning = false;
  }
}

/**
 * 开一个会话（**唯一的会话启动入口**）。
 *
 * 2026-09-18 抽出：原先这段逻辑内联在 `case 'START'` 里；队列要"以完全相同的语义"起会话，
 * 所以抽成函数 —— **绝不复制一份**（复制必然漂移：本项目最贵的教训就是"同一份事实写两处"）。
 */
async function startSessionFromConfig(config, ownerTabId) {
  if (!ownerTabId) return { ok: false, error: '缺少目标标签页（请先在生参取数页打开本面板）' };
  await assertAllowedTab(ownerTabId);

  // 已有活跃会话时不允许直接覆盖（必须先结束）
  const activeId = await getActiveSessionId();
  const active = activeId ? await readSessionMeta(activeId) : null;
  if (active && !['completed', 'ended'].includes(active.status)) {
    return { ok: false, error: `存在未结束的会话（${active.sessionId} / ${active.status}），请先「结束会话」`, precondition: true };
  }

  // ✅ 区间门禁（2026-09-14 用户确认的平台口径）：**T+2 + 粒度对齐**。
  //    日/汇总：周期结束日 ≤ 今天−2；分周：该周最后一天 ≤ 今天−2；分月：该月月末 ≤ 今天−2。
  //    实机表现极具误导性：尚不可取的区间是"提交成功、点击下载成功，但永远没有文件产出"
  //    （N1/P1/P2 各白等约 4 分钟）→ 在创建会话之前就拒绝，给出明确原因。
  // ❗❗ 2026-09-20 用户要求改为**自动矫正**而不是直接失败（实况：12 项队列用同一区间
  //    2024-04-04~2026-09-17，分周 4 项 + 分月 4 项因"结束日期不是周日/月末"全部启动失败，
  //    白排队一场）。矫正规则集中在 core.normalizeExportableRange（纯函数、有单测）：
  //    分周→对齐到整周并压到"最近的已结算周日"；分月→对齐到整月并压到"最近的已结算月末"；
  //    分日→压到 T+2；三者都抬到平台下限（分日 2024-04-04 / 分月 2024-06-01）。
  //    ⚠️ 矫正**必须可见**：改动逐条记进会话 meta 的 rangeAdjustments（随清单落盘 + 界面显示）。
  const rangeFix = core.normalizeExportableRange(
    { timeGrain: config.timeGrain, startDate: config.startDate, endDate: config.endDate },
    new Date(),
  );
  if (!rangeFix.ok) return { ok: false, error: rangeFix.reason };
  // ❗ 2026-09-20：建清单可能**故意抛错**（如「分月」配了 sr_chunk=week ⇒ 会把同一个整月重复下载）。
  //    那种错必须在启动前变成**可读的回执**，而不是让消息处理器未捕获异常、回执缺失（看起来像"没反应"）。
  let plan = null;
  try {
    plan = buildSessionPlan(
      { ...config, startDate: rangeFix.startDate, endDate: rangeFix.endDate, ownerTabId },
      ownerTabId,
    );
  } catch (error) {
    return { ok: false, error: `无法构建任务清单：${(error && error.message) || error}`, precondition: false };
  }
  // 矫正后仍复核一次严格门禁：normalize 出问题就报错，绝不带着不合规区间去建会话
  const rangeGate = core.assertExportableRange(
    { timeGrain: plan.meta.timeGrain, startDate: plan.meta.startDate, endDate: plan.meta.endDate },
    new Date(),
  );
  if (!rangeGate.ok) return { ok: false, error: rangeGate.reason };
  // ⚠️ meta 与 tasks 必须来自**同一次**构建（见 buildSessionPlan 的注释：分两处构建会漂移）
  const runningMeta = rangeFix.adjustments.length
    ? { ...plan.meta, requestedRange: {startDate: config.startDate, endDate: config.endDate}, rangeAdjustments: rangeFix.adjustments }
    : plan.meta;
  const tasks = plan.tasks;
  const running = metaWithSessionAction({ ...runningMeta, total: tasks.length, shardCount: Math.max(1, Math.ceil(tasks.length / core.TASK_SHARD_SIZE)) }, 'start');
  // 新会话开始：清掉上一会话遗留的产物 arm（否则会去改名叫"本会话产物"的下载，且时效窗判定失真）
  expectedArtifacts.clear();
  await persistNewSession(running, tasks);
  await clearAlarms();
  scheduleTick(0);
  return { ok: true, sessionId: running.sessionId, total: tasks.length };
}

// ==================================================================================
// 取数队列（2026-09-18 新增）：队列项的增/减/调序 + 「会话结束后自动开下一项」的执行器
// ==================================================================================

/** 队列存储键（与会话存储同域：chrome.storage.local） */
const K_QUEUE = 'sr:queue';

async function readQueue() {
  const stored = await chrome.storage.local.get(K_QUEUE);
  const q = stored && stored[K_QUEUE];
  if (!q || typeof q !== 'object') return { running: false, items: [], updatedAt: null };
  return {
    running: !!q.running,
    items: Array.isArray(q.items) ? q.items : [],
    nextSeq: Number(q.nextSeq) > 0 ? Number(q.nextSeq) : null,
    updatedAt: q.updatedAt || null,
    lastError: q.lastError || null,
    stoppedAt: q.stoppedAt || null,
  };
}

function nextQueueSeq(q) {
  const existing = (q.items || []).map((item) => /^Q(\d+)-/.exec(String(item.id || '')))
    .filter(Boolean).map((match) => Number(match[1]));
  return Math.max(Number(q.nextSeq) || 1, ...existing.map((n) => n + 1), (q.items || []).length + 1);
}

async function writeQueue(next) {
  const q = { ...next, updatedAt: new Date().toISOString() };
  await chrome.storage.local.set({ [K_QUEUE]: q });
  trace('queue.write', { running: q.running, items: q.items.length, lastError: q.lastError || null });
  return q;
}

/** 读-改-写队列（所有单项修改都走它，避免并发丢更新） */
async function queueMutate(fn) {
  const q = await readQueue();
  const next = await fn({ ...q, items: q.items.slice() });
  const saved = await writeQueue(next);
  return { ok: true, queue: queueView(saved) };
}

/** 一次删除选中项；队列运行期间先停止，防止调度读到旧快照。 */
async function queueRemoveMany(itemIds) {
  if (!Array.isArray(itemIds) || !itemIds.length || itemIds.length > 10000) {
    return { ok: false, error: '请选择 1 至 10000 个队列项' };
  }
  const ids = itemIds.map((id) => String(id));
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length) {
    return { ok: false, error: '所选队列项 ID 不合法或重复' };
  }
  return withStateLock(async () => {
    const q = await readQueue();
    if (q.running) return { ok: false, error: '队列正在运行；请先点「停止队列」再删除。当前会话会继续执行。' };
    const byId = new Map(q.items.map((item) => [item.id, item]));
    const missing = ids.filter((id) => !byId.has(id));
    if (missing.length) return { ok: false, error: `队列已变化，${missing.length} 项已不存在；请刷新后重选` };
    if (ids.some((id) => byId.get(id).status === 'running')) {
      return { ok: false, error: '正在执行的队列项不能删除；请等当前会话结束' };
    }
    const selected = new Set(ids);
    const saved = await writeQueue({ ...q, items: q.items.filter((item) => !selected.has(item.id)) });
    return { ok: true, removedCount: ids.length, queue: queueView(saved) };
  });
}

/** 给 UI 的队列视图：附上"第几项 / 待执行数 / 完成数"等派生信息 */
function queueView(q) {
  const items = (q.items || []).map((x, i) => ({ ...x, seq: i + 1 }));
  return {
    running: !!q.running,
    updatedAt: q.updatedAt || null,
    lastError: q.lastError || null,
    stoppedAt: q.stoppedAt || null,
    counts: {
      total: items.length,
      pending: items.filter((x) => x.status === 'pending').length,
      running: items.filter((x) => x.status === 'running').length,
      done: items.filter((x) => x.status === 'done').length,
      failed: items.filter((x) => x.status === 'failed').length,
    },
    current: items.find((x) => x.status === 'running') || null,
    next: items.find((x) => x.status === 'pending') || null,
    items,
  };
}

/** 加入队列：只做**静态校验**（配置形状 + 计划可构建），不建会话、不碰页面 */
async function queueAdd(raw) {
  const result = await queueAddMany([raw]);
  return result.ok ? { ...result, item: result.items[0] } : result;
}

async function queueAddMany(rawItems) {
  if (!Array.isArray(rawItems) || !rawItems.length || rawItems.length > 128) {
    return { ok: false, error: '批量队列需要 1 至 128 个配置' };
  }
  // 先校验全部范围，再一次性写入，防止后半段错误留下半套计划。
  const prepared = [];
  for (const raw of rawItems) {
  if (!raw || typeof raw !== 'object') return { ok: false, error: '队列配置为空' };
  const config = raw.config || {};
  const ownerTabId = Number(raw.ownerTabId || config.ownerTabId || 0);
  const label = String(raw.label || '').trim();
  const shapes = ['storeId', 'storeName', 'granularity', 'timeGrain', 'startDate', 'endDate'];
  const missing = shapes.filter((k) => !String(config[k] == null ? '' : config[k]).trim());
  if (missing.length) return { ok: false, error: `队列项缺少必要字段：${missing.join('、')}` };
  if (!Array.isArray(config.dimensions) || !config.dimensions.length) {
    return { ok: false, error: '队列项至少要选一个数据维度' };
  }
  // 计划预览：能在这里就暴露的错误绝不留给执行期（例如非法时间粒度、报表名超长）
  let plan = null;
  try {
    const built = buildSessionPlan({ ...config, ownerTabId: ownerTabId || 1 }, ownerTabId || 1);
    plan = { taskCount: built.tasks.length, reportName: built.meta.reportName || null };
  } catch (error) {
    return { ok: false, error: `队列项无法构建任务清单：${error && error.message}` };
  }
  // ⚠️ ID 必须**确定性生成**：项目规矩禁止随机化（`Math.random` 会被 security_scan 拦下，也破坏可复现性）。
  //    用「队列内单调序号 + 毫秒时间戳」：序号保证同一毫秒内连加也不撞车，时间戳保证跨会话唯一。
  prepared.push({ config, label, plan });
  }
  return withStateLock(async () => {
  const qBefore = await readQueue();
  let seq = nextQueueSeq(qBefore);
  const items = prepared.map(({ config, label, plan }) => {
  const item = {
    id: `Q${String(seq).padStart(4, '0')}-${Date.now().toString(36)}`,
    createdAt: new Date().toISOString(),
    label: label || `${config.granularity}/${config.dimensions.join('+')}/${config.timeGrain} ${config.startDate}~${config.endDate}`,
    config,
    plan,
    status: 'pending',
    sessionId: null,
    startedAt: null,
    finishedAt: null,
    note: '',
  };
  seq += 1;
  return item;
  });
  // 复用前面读到的队列快照（别读两次：两次之间可能有别的写入，序号会漂）
  const saved = await writeQueue({ ...qBefore, nextSeq: seq, items: qBefore.items.concat(items) });
  return { ok: true, items, item: items[0], queue: queueView(saved) };
  });
}

/** 失败队列项重新入队：旧项与旧会话保留，新项使用新的任务预算。 */
async function queueRequeueFailed(itemId, ownerTabId) {
  return withStateLock(async () => {
    const q = await readQueue();
    if (q.running) return { ok: false, error: '队列正在运行；请等本轮结束后再重新加入失败项' };
    const old = q.items.find((item) => item.id === String(itemId));
    if (!old) return { ok: false, error: '失败项已不在队列中，请刷新页面' };
    if (old.status !== 'failed') return { ok: false, error: '只有失败的队列项可以重新加入' };
    if (old.requeuedAs && q.items.some((item) => item.id === old.requeuedAs)) {
      return { ok: false, error: '该失败项已经重新加入队列，请勿重复点击' };
    }
    const config = { ...(old.config || {}), ownerTabId: Number(ownerTabId) || Number(old.config && old.config.ownerTabId) || null };
    let built;
    try { built = buildSessionPlan({ ...config, ownerTabId: config.ownerTabId || 1 }, config.ownerTabId || 1); }
    catch (error) { return { ok: false, error: `原配置已无法构建任务清单：${error && error.message}` }; }
    const seq = nextQueueSeq(q);
    const now = new Date().toISOString();
    const item = {
      id: `Q${String(seq).padStart(4, '0')}-${Date.now().toString(36)}`,
      createdAt: now,
      label: old.label,
      config,
      plan: { taskCount: built.tasks.length, reportName: built.meta.reportName || null },
      status: 'pending', sessionId: null, startedAt: null, finishedAt: null,
      retryOf: old.id,
      note: `由失败项重新加入（原会话 ${old.sessionId || '未启动'}）`,
    };
    const items = q.items.map((existing) => existing.id === old.id
      ? { ...existing, requeuedAs: item.id } : existing).concat(item);
    const saved = await writeQueue({ ...q, nextSeq: seq + 1, items });
    return { ok: true, item, queue: queueView(saved) };
  });
}

/**
 * 会话进入终态后：把队列里正在跑的那一项结掉，并在队列仍开启时启动下一项。
 *
 * @param {object} meta  会话 meta（终态）
 * @param {object} closure 闭合结果（可空）
 */
async function onSessionFinished(meta, closure) {
  try {
    const q = await readQueue();
    if (!q.items.length) return null;
    let touched = false;
    const items = q.items.map((it) => {
      if (it.sessionId && it.sessionId === meta.sessionId && it.status === 'running') {
        touched = true;
        // “闭合”只说明任务均已记账，不能把失败全部记账后显示为下载完成。
        const okClosure = !!closure && !!closure.ok
          && Number(closure.failedPermanent || 0) === 0
          && Number(closure.pending || 0) === 0
          && Number(closure.ended || 0) === 0;
        const failed = closure && closure.failedPermanent ? closure.failedPermanent : 0;
        const blocking = closure && Array.isArray(closure.blockingGaps) ? closure.blockingGaps : [];
        const capped = blocking.filter((gap) => gap.kind === 'row_cap_truncation_suspected').length;
        const empty = blocking.filter((gap) => gap.kind === 'empty_result_unverified').length;
        const tiny = blocking.filter((gap) => gap.kind === 'tiny_export_unverified').length;
        const cause = capped ? `；平台 10 万行截断 ${capped} 片，需缩小切片`
          : empty ? `；平台报 0 行 ${empty} 片，需核实导出内容`
            : tiny ? `；异常小文件 ${tiny} 片，需核实工作表` : '';
        return {
          ...it,
          status: okClosure ? 'done' : 'failed',
          finishedAt: new Date().toISOString(),
          note: okClosure
            ? `完成（缺口 ${closure ? closure.gaps.length : 0} 个）`
            : `未闭合：完成 ${closure ? closure.done : '?'}／失败 ${failed}／待执行 ${closure ? closure.pending : '?'}${cause}`
              + `（会话 ${meta.sessionId}，状态 ${meta.status}）`,
        };
      }
      return it;
    });
    if (touched) await writeQueue({ ...q, items });
    return await maybeStartNextQueueItem('session-finished');
  } catch (error) {
    // 队列出问题绝不能影响会话本身（会话已经收口了）
    trace('queue.onSessionFinished-error', { message: String(error && error.message) });
    return null;
  }
}

/**
 * 启动队列里的下一项（若队列处于 running 且没有活跃会话）。
 * 返回启动结果或 null（= 没启动，原因记在队列 lastError 里）。
 */
async function maybeStartNextQueueItem(reason) {
  const q = await readQueue();
  if (!q.running) return null;
  const idx = q.items.findIndex((x) => x.status === 'pending');
  if (idx < 0) {
    await writeQueue({ ...q, running: false, note: '队列已跑完' });
    return null;
  }
  const item = q.items[idx];
  const ownerTabId = Number(item.config.ownerTabId || 0) || null;
  // 队列项没记标签页（加入时可能还没开取数页）→ 现找一个白名单内的生参取数页
  let tabId = ownerTabId;
  if (!tabId) {
    const tabs = await chrome.tabs.query({ url: core.PLATFORM ? core.PLATFORM.tabUrlPatterns : ['https://sycm.taobao.com/*'] });
    tabId = tabs && tabs.length ? tabs[0].id : null;
  }
  if (!tabId) {
    await writeQueue({ ...q, lastError: '队列等待中：找不到生参取数页（请打开取数页后点「开始队列」）' });
    return null;
  }
  const res = await startSessionFromConfig({ ...item.config, ownerTabId: tabId }, tabId);
  const items = q.items.slice();
  if (res.ok) {
    items[idx] = { ...item, status: 'running', sessionId: res.sessionId, startedAt: new Date().toISOString(), note: `任务数 ${res.total}` };
    await writeQueue({ ...q, items, lastError: null, note: null });
    trace('queue.started', { reason, itemId: item.id, sessionId: res.sessionId, total: res.total });
    return { itemId: item.id, sessionId: res.sessionId, total: res.total };
  }
  // 前置条件不满足（例如仍有未结束会话）→ **保持 pending**，等下一次机会（别把可恢复问题记成永久失败）
  if (res.precondition) {
    await writeQueue({ ...q, lastError: `队列等待中：${res.error}` });
    return null;
  }
  // 配置/区间等硬错误 → 记 failed 并**继续下一项**（失败不停队）
  items[idx] = { ...item, status: 'failed', finishedAt: new Date().toISOString(), note: `启动失败：${res.error}` };
  await writeQueue({ ...q, items, lastError: `队列项「${item.label}」启动失败：${res.error}` });
  return await maybeStartNextQueueItem('previous-item-failed-to-start');
}

/** 会话收口：闭合校验 → 产清单 → 置 completed（允许带缺口，但缺口必须显式） */
async function completeSession(sessionId) {
  const run = await loadRun(sessionId);
  if (!run) return null;
  const { meta, tasks } = run;
  // ✅ 幂等守卫（2026-09-14 补）：**只有 running 会话才允许收口**。
  //   原先没有这道守卫：任何一次"迟到的收尾"都会把早已 completed 的会话再收一次，
  //   于是旧的 manifest/log 被重新投递、落到下载根目录（实机出现过 `session_log (1).json`）。
  if (meta.status !== 'running') {
    trace('session.complete-skipped', { sessionId, status: meta.status });
    return null;
  }
  const closure = core.validateClosure({ ...meta, tasks });
  const finished = { ...meta, activeTaskKey: null, expectedDownload: null, completedAt: new Date().toISOString(), lastClosure: summarizeClosure(closure) };
  const withStatus = metaWithSessionAction(finished, 'complete');
  await writeSessionMeta(withStatus);
  await clearAlarms();
  try {
    // 带上 ownerTabId：JSON 产物优先走该标签页的页面上下文（<a download>）落盘
    await writeSessionArtifacts({ ...withStatus, tasks }, closure, { tabId: withStatus.ownerTabId });
  } catch (error) {
    await recordSessionError(sessionId, `清单落盘失败：${error && error.message}`);
  }
  // ⭐ 队列钩子：会话收口后结算队列项、并决定是否开下一项。
  //    放在产物落盘之后：队列项的成败判据要用闭合结果（closure），而产物是会话自己的事，
  //    两者互不阻塞 —— onSessionFinished 内部整体 try/catch，队列出问题绝不影响会话收口。
  await onSessionFinished(withStatus, closure);
  return withStatus;
}

/** 闭合结果压缩成适合落盘的形状 */
function summarizeClosure(closure) {
  return {
    ok: !!closure.ok,
    done: closure.done,
    failedPermanent: closure.failedPermanent,
    pending: closure.pending,
    ended: closure.ended,
    total: closure.total,
    counts: closure.summary ? closure.summary.counts : {},
    gaps: closure.gaps.map((gap) => ({
      kind: gap.kind,
      taskKey: gap.taskKey || null,
      dimension: gap.dimension || null,
      start: gap.start || null,
      end: gap.end || null,
      status: gap.status || null,
      attempts: gap.attempts == null ? null : gap.attempts,
      message: gap.message,
    })),
    blockingGaps: closure.blockingGaps.map((gap) => ({ kind: gap.kind, taskKey: gap.taskKey || null, message: gap.message })),
  };
}

// ==================================================================================
// 8. 会话产物：session_manifest.json / session_log.json（data: URL → chrome.downloads）
// ==================================================================================

/** Windows 保留设备名：出现在路径任一环节都会被 Downloads 拒绝，必须改写 */
const WINDOWS_RESERVED_SEGMENT = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * 把归档相对路径规范成 `chrome.downloads.download({filename})` 接受的形态。
 *
 * ⚠️ 2026-09-13 实机根因（曾经落盘成 `下载.json` / `下载 (1).json`）：
 *   `filename` 必须是**正斜杠分隔的相对路径**。此前这里把 `/` 换成了 `\`，
 *   Downloads 认为该文件名非法 → 整条 filename 被忽略 → 退回默认名「下载」
 *   （扩展名取自 data: URL 的 MIME `application/json`，于是成了 `下载.json`）。
 *   `/` 是给 Windows 用的正确分隔符，Chrome 会自己翻译成目录层级。
 */
function toDownloadPath(relative) {
  const segments = String(relative == null ? '' : relative)
    .replace(/\\/g, '/')          // 反斜杠一律归一成正斜杠（Downloads 只认正斜杠）
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment && segment !== '.' && segment !== '..'); // 去掉空段与路径穿越
  const safe = segments.map((segment) => (WINDOWS_RESERVED_SEGMENT.test(segment) ? `_${segment}` : segment));
  return safe.join('/');
}

/** 兜底用的扁平文件名（不含目录）：把路径里的非文件名部分压成后缀，保证仍然唯一可读 */
function flatArtifactName(relativePath) {
  const normalized = toDownloadPath(relativePath);
  const segments = normalized.split('/');
  const leaf = segments.pop() || 'session_artifact.json';
  const tail = (segments.pop() || '').replace(/[^0-9A-Za-z_-]/g, '');
  const dot = leaf.lastIndexOf('.');
  const stem = dot > 0 ? leaf.slice(0, dot) : leaf;
  const ext = dot > 0 ? leaf.slice(dot) : '';
  return tail ? `${stem}_${tail}${ext}` : leaf;
}

/**
 * Downloads 的扁平兜底落盘（filename 被拒时使用）。
 * 文件内容不因降级而改变，只改文件名。
 */
async function downloadJsonFlat(dataUrl, flatName) {
  const downloadId = await chrome.downloads.download({
    url: dataUrl,
    filename: flatName,
    conflictAction: 'overwrite',
    saveAs: false,
  });
  return downloadId == null ? null : downloadId;
}

/**
 * 用 data: URL 落盘一个 JSON（**不产生任何网络请求**）。
 *
 * ⚠️ 2026-09-13 实机教训：data: URL 的 `filename` 会被 Downloads **静默忽略**
 *    （不抛错、也不返回空 id），所以下面的"扁平名降级"分支在实机上**不会触发**，
 *    产物会落在下载根目录并命名成「下载 (N).json」。因此本函数**只作兜底**，
 *    主路径是 `deliverJsonArtifact` 的页面上下文投递。
 *
 * @param {(object|function(): object|string)} value 对象 / 返回对象的构建函数 / 已序列化的字符串
 * @returns {Promise<{downloadId:(number|null), filename:string, degraded:boolean, reason:string}>}
 */
async function downloadJson(relativePath, value, options) {
  const opts = options || {};
  const build = () => {
    if (typeof value === 'string') return value;
    return JSON.stringify(typeof value === 'function' ? value() : value, null, 2);
  };
  const toUrl = (text) => `data:application/json;charset=utf-8,${encodeURIComponent(text)}`;
  const primary = toDownloadPath(relativePath);
  const fallback = flatArtifactName(relativePath);

  const degrade = async (reason) => {
    if (!opts.onDegrade) return;
    try {
      await opts.onDegrade({ from: primary, to: fallback, reason });
    } catch (ignored) { /* 记录降级失败不影响落盘 */ }
  };

  if (primary) {
    try {
      const downloadId = await chrome.downloads.download({
        url: toUrl(build()),
        filename: primary,
        conflictAction: 'overwrite',
        saveAs: false,
      });
      // ⚠️ 拿到 id 也不代表 filename 被采纳（data: URL 会静默忽略）。如实标注不确定。
      if (downloadId != null) return { downloadId, filename: primary, degraded: false, reason: '' };
      await degrade('Downloads 未返回下载 id（filename 可能未被采纳）');
    } catch (error) {
      const reason = `正规路径被拒：${String(error && error.message || error)}`;
      await degrade(reason);
      const downloadId = await downloadJsonFlat(toUrl(build()), fallback);
      return { downloadId, filename: fallback, degraded: true, reason };
    }
  }

  if (!primary) await degrade('正规路径为空');
  const downloadId = await downloadJsonFlat(toUrl(build()), fallback);
  return { downloadId, filename: fallback, degraded: true, reason: primary ? 'Downloads 未返回下载 id' : '正规路径为空' };
}

/** 归档根目录：生参取数/<店铺名_店铺ID>/<批次或时间戳>/ */
function sessionArtifactRoot(session) {
  const storeSeg = `${core.sanitizePathSegment(session.storeName)}_${core.sanitizePathSegment(session.storeId)}`;
  const batchSeg = core.sanitizePathSegment(session.batch || session.sessionId.replace(/[^0-9A-Za-z]/g, ''), 'session');
  return `${ARCHIVE_ROOT}/${storeSeg}/${batchSeg}/`;
}

// ----------------------------------------------------------------------------------
// 8.1 JSON 产物投递：优先走页面上下文（<a download>），data: URL 只作兜底
//
// 2026-09-13 实机根因（会话 S2026091314340101）：
//   `chrome.downloads.download({ url: 'data:application/json;…', filename })` 会**静默忽略 filename**
//   —— 既不抛错、也不返回空 id。于是产物落在下载根目录、被命名成「下载 (4).json」/「下载 (5).json」，
//   而我原先写的"被拒则降级扁平名"分支**根本不会触发**；文件内容里的 artifact 自述块因此是错的
//   （声称 actualFilename 在归档目录、degraded:false，实际两者都不成立）。
//
// 现方案：把 JSON 交给**页面上下文**用 `<a download>` 落盘（名字会被 Chrome 采纳），
//   再由 `onDeterminingFilename` 把 basename 命中 expectedArtifact 的下载**重命名到归档相对路径**。
//   data: URL 仅在页面通道不可用时兜底，并且必须留下 artifact_fallback_data_url 诊断。
// ----------------------------------------------------------------------------------

/**
 * 在途 JSON 产物：**按 basename 索引的小 Map**（不是单槽）。
 *
 * ⚠️ 用单槽会踩竞态：manifest 与 log 是一个接一个投递的，前一个产物的下载可能在后一个
 *    arm 之后才到达 → 单槽会被后一个覆盖，前一个产物就再也认不回来（实机同理会丢 manifest）。
 *    因此这里按 basename 存多条，谁的名字命中就认领谁。
 */
const expectedArtifacts = new Map();

/** 会话里最多同时挂多少条产物 arm（远超实际用量，仅防无限增长） */
const ARTIFACT_ARM_LIMIT = 8;

/**
 * 由**扩展自己**发起的产物下载 id 名单（data: URL 兜底通道）。
 *
 * 为什么需要它：这条通道下 Chrome 会把文件名改成默认的「下载.json」，
 * 光看 basename 既认不出来也无法归档。downloadId 在 onDeterminingFilename 触发时
 * 就已经存在，所以"接管改名"和"onChanged 观测最终落点"可以用同一份精确名单。
 */
const artifactDownloadIds = new Set();

/**
 * 下载接管决策留痕（仅最近若干条，供 DOWNLOAD_PROBE / 排障读取）。
 * 唯一目的：回答"扩展自发的 data: URL 下载到底有没有触发 onDeterminingFilename"。
 */
const takeoverLog = [];
function logTakeover(entry) {
  takeoverLog.push(entry);
  while (takeoverLog.length > 60) takeoverLog.shift();
  return entry;
}

/** 从路径取 basename（同时抹掉 Windows 重名的 " (1)" 后缀） */
function basenameOf(p) {
  const leaf = String(p == null ? '' : p).replace(/\\/g, '/').split('/').pop() || '';
  return leaf.replace(/ \(\d+\)(?=\.\w+$)/, '');
}

// ----------------------------------------------------------------------------------
// 8.0 重复下载（催单产物）在**落盘前**丢弃 —— 加固① 2026-09-14
//
// 实机事实（HANDOFF §4）：等下载超时后对同一结果视图**再点一次「下载报表」**（催单），
//   平台会**再生成一份产物**；这份多余的过去落在下载根目录，只能事后人工移到 `_duplicates\`。
//
// 现在的处置（**两条腿，且绝不删文件**）：
//   ① 取消：`chrome.downloads.cancel(id)` —— 在文件落盘前掐掉（首选路径，下载目录不新增任何文件）；
//   ② 预置隔离落点：**先**把这份下载的落点 suggest 到
//      `生参取数/_duplicates/<会话id>_quarantine/<平台原文件名>` ——
//      万一取消没拦住（竞态），文件也只会落在隔离目录里，绝不会污染下载根目录；
//      （扩展没有文件系统权限，"事后移动"做不到；把落点**提前**指到隔离目录，等价且更早。）
//   两条路都写同一条诊断 `download_duplicate_discarded`（含 duplicateOfTaskKey + disposition + 原始文件名/URL/时间）。
//
// ⚠️ 判据全部在 `core.judgeDuplicateDownload`（纯函数、离线可测，**未知/歧义一律不取消**）；
//    本层只负责"执行 + 留证"，不自己另写一套匹配规则。
// ----------------------------------------------------------------------------------

/** 已发出取消、但尚未观测到终态的重复下载（downloadId → 证据），由 onChanged 收口 */
const duplicateDiscards = new Map();
/** 取消后回读实际状态前的固定等待（无随机抖动） */
const DUPLICATE_CANCEL_VERIFY_MS = 400;

/**
 * 丢弃一份"同一任务的第二份产物"。
 * @param {object} ctx { sessionId, item, filename, verdict, suggest }
 * @returns {Promise<string>} disposition（cancelled | quarantined | cancel-requested | unknown）
 */
async function discardDuplicateDownload(ctx) {
  const item = ctx.item || {};
  const downloadId = item.id == null ? null : Number(item.id);
  const verdict = ctx.verdict || {};
  const quarantineRelative = verdict.quarantineRelativePath
    || core.duplicateQuarantineRelativePath({ sessionId: ctx.sessionId, filename: ctx.filename });
  const evidence = {
    duplicateOfTaskKey: verdict.taskKey || null,
    reason: verdict.reason || '',
    judgedBy: 'core.judgeDuplicateDownload',
    rules: verdict.evidence || null,
    // 证据三件套：原始文件名 / URL / 时间（外加 downloadId）
    originalFilename: ctx.filename || String(item.filename || ''),
    sourceUrl: String(item.finalUrl || item.url || '') || null,
    sourceTabId: downloadSourceTabId(item),
    detectedAt: new Date().toISOString(),
    quarantineRelativePath: quarantineRelative,
    downloadId,
  };

  // ① 预置隔离落点（**先**做：即使下面取消无效，也绝不落到下载根目录）
  let suggested = false;
  if (typeof ctx.suggest === 'function') {
    try {
      ctx.suggest({ filename: toDownloadPath(quarantineRelative), conflictAction: 'overwrite' });
      suggested = true;
    } catch (error) {
      evidence.suggestError = String((error && error.message) || error);
    }
  }

  // ② 取消（落盘前掐掉）
  let cancelRequested = false;
  let cancelError = null;
  if (downloadId == null) {
    cancelError = '下载事件没有 downloadId，无法取消';
  } else if (typeof chrome.downloads.cancel !== 'function') {
    cancelError = 'chrome.downloads.cancel 在当前运行环境不可用';
  } else {
    try {
      await chrome.downloads.cancel(downloadId);
      cancelRequested = true;
    } catch (error) {
      cancelError = String((error && error.message) || error);
    }
  }

  // ③ 回读实际状态 → 判定"走了哪条路"（不猜）
  await new Promise((resolve) => setTimeout(resolve, DUPLICATE_CANCEL_VERIFY_MS));
  let observed = null;
  try {
    const found = downloadId == null ? [] : await chrome.downloads.search({ id: downloadId });
    observed = (found && found[0]) || null;
  } catch (error) {
    evidence.observeError = String((error && error.message) || error);
  }
  const observedState = observed ? String(observed.state || '') : null;
  let disposition = 'unknown';
  let finalPath = null;
  if (observedState === 'interrupted') disposition = 'cancelled';
  else if (observedState === 'complete') { disposition = 'quarantined'; finalPath = observed.filename || null; }
  else if (observedState === 'in_progress') disposition = 'cancel-requested';
  else if (observedState == null) disposition = cancelRequested ? 'cancel-requested' : 'unknown';

  // ④ 抹掉下载记录（erase **只删记录、不删文件**；removeFile 才是删文件，本项目禁用）
  if (disposition === 'cancel-requested') {
    duplicateDiscards.set(downloadId, { sessionId: ctx.sessionId, evidence, suggested });
  } else if (downloadId != null) {
    try { await chrome.downloads.erase({ id: downloadId }); } catch (error) {
      evidence.eraseError = String((error && error.message) || error);
    }
  }

  await recordDiagnostic(ctx.sessionId, DIAG.DOWNLOAD_DUPLICATE_DISCARDED, {
    ...evidence,
    disposition,
    suggestedQuarantine: suggested,
    cancelRequested,
    cancelError,
    observedState,
    observedError: observed ? (observed.error || null) : null,
    finalPath,
    note: disposition === 'cancelled'
      ? '✅ 在落盘前取消：下载目录**不会**出现多余文件（首份产物不受影响）'
      : (disposition === 'quarantined'
        ? '⚠️ 竞态：取消晚于落盘 → 文件已落在隔离目录 `_duplicates\\<会话id>_quarantine\\`（只隔离、绝不删除）'
        : '⚠️ 已请求取消但未在回读窗口内观测到终态 → 由 onChanged 收口（同一条诊断的 settle 记录）'),
  }, verdict.taskKey || null).catch(() => undefined);

  trace('download.duplicate-discarded', { downloadId, disposition, taskKey: verdict.taskKey || null });
  return disposition;
}

/** 是否是会话产物 JSON（manifest / log / diagnostics） */
function isArtifactJsonFilename(name) {
  const base = basenameOf(name);
  return /^(session_manifest|session_log|diagnostics_)/i.test(base) && /\.json$/i.test(base);
}

/**
 * arm 一个 JSON 产物：写产物前先登记，供 onDeterminingFilename 认领重命名。
 * 内存为主（下载事件与写产物在同一 SW 生命周期内），同时落进会话 meta 便于事后追溯。
 */
async function armExpectedArtifact(entry) {
  const armed = { ...entry, armedAt: new Date().toISOString() };
  expectedArtifacts.set(armed.filename, armed);
  // 只保留最近的若干条（固定上限，无随机）
  while (expectedArtifacts.size > ARTIFACT_ARM_LIMIT) {
    const oldest = expectedArtifacts.keys().next();
    if (oldest.done) break;
    expectedArtifacts.delete(oldest.value);
  }
  trace('artifact.armed', { kind: armed.kind, filename: armed.filename, relativePath: armed.relativePath });
  try {
    const sessionId = await getActiveSessionId();
    if (sessionId) {
      const meta = await readSessionMeta(sessionId);
      if (meta) await writeSessionMeta({ ...meta, expectedArtifacts: [...expectedArtifacts.values()] });
    }
  } catch (error) {
    trace('artifact.arm-persist-failed', { message: String(error && error.message || error) });
  }
  return armed;
}

/**
 * 取当前在途的产物 arm 列表：**只用内存那份**。
 * ⚠️ 刻意不读 storage：上一会话遗留的 arm 落到新会话上，会去改名叫"本会话产物"的下载（串味）。
 *    内存为空即表示当前没有产物在途——此时任何 .json 都不改名（宁可不动，保持既有纪律）。
 *    每条 arm 只在内存里存活于"投递 → 下载接管"这个很短的窗口内，足够覆盖实际时序。
 */
function currentArtifactArms() {
  return [...expectedArtifacts.values()];
}

/** 清掉某条产物 arm（已认领 / 已兜底 / 过期） */
async function clearExpectedArtifact(reason, filename) {
  if (filename != null) expectedArtifacts.delete(String(filename));
  else expectedArtifacts.clear();
  try {
    const sessionId = await getActiveSessionId();
    if (sessionId) {
      const meta = await readSessionMeta(sessionId);
      if (meta) await writeSessionMeta({ ...meta, expectedArtifacts: [...expectedArtifacts.values()], lastArtifactNote: reason || null });
    }
  } catch (error) {
    trace('artifact.clear-persist-failed', { message: String(error && error.message || error) });
  }
}

/**
 * 把 JSON 交给**页面上下文**落盘（content.js 的 SR_SAVE_JSON）。
 * 已知 form frameId 就定向，否则广播——content.js 在**任意 frame** 都会响应这条消息。
 * @returns {Promise<{ok:boolean, via:string, reason:string}>}
 */
async function sendSaveJsonToPage(tabId, filename, json, timeoutMs) {
  const message = { type: 'SR_SAVE_JSON', filename, json };
  const respond = (value) => {
    if (value && value.ok) return { ok: true, via: value.via || 'anchor-download', reason: '' };
    return { ok: false, via: '', reason: (value && value.reason) || '页面未确认落盘' };
  };
  // ✅ 2026-09-13 实机教训：**从嵌套 iframe 里发起下载会被 Chrome 拦掉**
  //    （当时发给表单 frame，结果两个 JSON 产物一个都没落盘）。
  //    顶层 frame 发起才被允许 → 这里固定发往 frameId 0（content.js 在任意 frame 都响应本消息）。
  try {
    const settled = await callPageWithTimeout(tabId, message, timeoutMs, 0);
    if (settled.settled && settled.value && settled.value.ok) return respond(settled.value);
    // 顶层 frame 没接住（例如页面刚导航）→ 退化为广播
    const broadcast = await callPageWithTimeout(tabId, message, timeoutMs, null);
    if (broadcast.settled) return respond(broadcast.value);
    return { ok: false, via: '', reason: broadcast.error || settled.error || '投递未结算' };
  } catch (error) {
    return { ok: false, via: '', reason: String((error && error.message) || error) };
  }
}

/**
 * 落盘一个 JSON 产物。**每个产物只落盘一次**：
 *   ① 优先 SR_SAVE_JSON（页面上下文 <a download>）→ deliveryMethod 'content-anchor'
 *   ② 失败才回退 data: URL（保留原扁平名降级逻辑）→ deliveryMethod 'data-url' + artifact_fallback_data_url 诊断
 *
 * ⚠️ 序列化在**投递方式确定之后**才做（contentBuilder 延迟调用），
 *    这样文件内容里的 `artifact.deliveryMethod` 才是真实值，而不是写盘前的占位。
 *
 * @param {object} opts { sessionId, kind, tabId, relativePath, contentBuilder }
 */
/**
 * 在 `sinceMs` 之后是否真的出现了一个 .json 下载？
 * 用来把"页面通道点击成功"与"下载真的发生"区分开——这是本次修复的核心依据。
 * 只查下载列表，**不读文件内容、不碰网络**，符合本插件的边界纪律。
 * @returns {Promise<{id:number, filename:string}|null>}
 */
async function waitForJsonDownloadSince(sinceMs, timeoutMs) {
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  // 首次立刻查一次（本地 Blob 往往同步就登记了），之后固定 400ms 轮询，不用随机抖动
  for (;;) {
    try {
      const found = await chrome.downloads.search({
        startedAfter: new Date(sinceMs).toISOString(),
        limit: 0,
      });
      const hit = (found || []).find((it) => /\.json$/i.test(String(it.filename || '')));
      if (hit) return { id: hit.id, filename: String(hit.filename || '') };
    } catch (error) {
      trace('artifact.verify-search-failed', { message: String((error && error.message) || error) });
    }
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
}

async function deliverJsonArtifact(opts) {
  const relativePath = String(opts.relativePath);
  const filename = basenameOf(relativePath);
  // 序列化在投递方式确定后（可能被调用两次：一次试探页面通道，一次兜底），
  // 保证文件内容里的 artifact.deliveryMethod 是**真实值**而不是占位。
  const buildText = (deliveryMethod) => {
    const content = typeof opts.contentBuilder === 'function' ? opts.contentBuilder(deliveryMethod) : (opts.content || {});
    return JSON.stringify(content, null, 2);
  };

  await armExpectedArtifact({ kind: opts.kind, filename, relativePath, deliveryMethod: 'pending' });

  // ---- ① 主路径：页面上下文（顶层 frame 的 <a download>）
  //    ✅ 这条路线才能给出**正确的文件名**，并由下载接管（onDeterminingFilename）重命名进归档目录。
  //    ⚠️ 2026-09-13 实测①：发给**嵌套 iframe** 时 Chrome 会拦掉下载（两个产物一个都没落盘）→
  //       故 sendSaveJsonToPage 固定发往 frameId 0（顶层 frame）。
  //    ⚠️ 2026-09-13 实测②：**顶层 frame 同样被拦**。根因是 Chrome 的"多文件自动下载"保护按**来源站**
  //       生效：同一站点（sycm.taobao.com）自动下载过 xlsx 之后，后续**无用户手势**的下载一律被丢弃，
  //       与 frame 层级无关。更坑的是 `<a download>` 的点击在 JS 层面**永远成功**，
  //       所以旧写法"页面通道 ok 就 return"会拿一个假成功一直掩盖真实丢失（L1 场次的产物消失即此因）。
  //       → 页面通道改为**先验证再算成功**：点击后短时间内必须真的出现一个新的 .json 下载。
  if (opts.tabId != null) {
    const startedAt = Date.now();
    const page = await sendSaveJsonToPage(opts.tabId, filename, buildText('content-anchor'), ARTIFACT_SAVE_TIMEOUT_MS);
    if (page.ok) {
      const landed = await waitForJsonDownloadSince(startedAt, PAGE_ROUTE_VERIFY_MS);
      if (landed) {
        await recordDiagnostic(opts.sessionId, DIAG.ARTIFACT_DELIVERED, {
          artifact: opts.kind, filename, relativePath,
          deliveryMethod: 'content-anchor',
          via: page.via,
          verifiedDownloadId: landed.id,
          verifiedFilename: landed.filename,
          note: '由顶层 frame 用 <a download> 落盘（已验证确实产生了下载）；归档位置由下载接管决定',
        }, null).catch(() => undefined);
        return { deliveryMethod: 'content-anchor', filename, relativePath, downloadId: landed.id, degraded: false, reason: '' };
      }
      await recordDiagnostic(opts.sessionId, DIAG.ARTIFACT_FALLBACK_DATA_URL, {
        artifact: opts.kind, filename, relativePath,
        reason: `页面通道报告已点击，但 ${PAGE_ROUTE_VERIFY_MS}ms 内没有出现新的 .json 下载（Chrome 多文件自动下载保护按来源站拦截）`,
        note: '页面通道属假成功，回退 data: URL（Chrome 会忽略 filename，落成默认名）',
      }, null).catch(() => undefined);
      trace('artifact.page-route-no-download', { kind: opts.kind });
    } else {
      await recordDiagnostic(opts.sessionId, DIAG.ARTIFACT_FALLBACK_DATA_URL, {
        artifact: opts.kind, filename, relativePath,
        reason: page.reason,
        note: '页面通道失败，回退 data: URL（可能被 Chrome 忽略 filename、落成默认名）',
      }, null).catch(() => undefined);
      trace('artifact.fallback-data-url', { kind: opts.kind, reason: page.reason });
    }
  }

  // ---- ② 兜底：data: URL（由 SW 发起，不受页面多下载保护限制；但 filename 会被 Chrome 忽略）
  let write = null;
  try {
    write = await downloadJson(relativePath, buildText('data-url'));
  } catch (error) {
    write = { downloadId: null, degraded: true, reason: String((error && error.message) || error) };
  }
  if (write && write.downloadId) {
    // ⚠️ 关键修正（2026-09-13）：**不要**在这里立刻清掉 arm。
    //    旧代码投递完就 clearExpectedArtifact，而下载接管（onDeterminingFilename）事件**晚于**投递到达
    //    → 事件到来时 arm 已被清空，"按 downloadId 认领并改名"这条路永远走不到。
    //    arm 只活在内存且受 DOWNLOAD_WINDOW_MS 约束，认领/观测/超时三条路都会清理，不会串味。
    artifactDownloadIds.add(write.downloadId);
    const armed = expectedArtifacts.get(filename);
    if (armed) expectedArtifacts.set(filename, { ...armed, downloadId: write.downloadId, deliveryMethod: 'data-url' });
    await recordDiagnostic(opts.sessionId, DIAG.ARTIFACT_DELIVERED, {
      artifact: opts.kind, filename, relativePath,
      deliveryMethod: 'data-url',
      downloadId: write.downloadId,
      degraded: !!write.degraded,
      requestedFilename: relativePath,
      actualRequestedFilename: write.filename || null,
      note: 'data: URL 兜底投递；真实落点由 onChanged 观测记录',
    }, null).catch(() => undefined);
    return {
      deliveryMethod: 'data-url',
      filename: write.degraded ? write.filename : filename,
      relativePath,
      downloadId: write.downloadId,
      degraded: !!write.degraded,
      reason: write.reason || '',
    };
  }

  await clearExpectedArtifact('无可用投递通道');
  return {
    deliveryMethod: null, filename, relativePath, downloadId: null, degraded: true,
    reason: (write && write.reason) || '投递失败',
  };
}

function taskRecord(task) {
  return {
    key: task.key,
    reportName: task.reportName,
    originalReportName: task.originalReportName || task.reportName,
    dimension: task.dimension,
    dimensionCode: task.dimensionCode,
    timeGrain: task.timeGrain,
    granularity: task.granularity,
    dateRange: { start: task.startDate, end: task.endDate },
    status: task.status,
    attempts: Number(task.attempts || 0),
    error: task.error || null,
    // 本任务已发出的"下载催单"次数与等待检查轮次（平台导出异步且慢，见 DOWNLOAD_NUDGE_AFTER_MS）
    nudges: Number(task.nudges || 0),
    nudgeChecks: Number(task.nudgeChecks || 0),
    expectedMetricCount: task.expectedMetricCount,
    // 额外筛选：维度声明的控件清单 + 本任务的**显式覆盖值**（维度 → 控件 → 值时）。
    // ⚠️ 2026-09-14 补：此前这两项都漏进 manifest，导致"这批数据到底筛了什么"事后无法从产物复核
    //    （EFV1 场次只能靠导出数据反推覆盖是否生效）。审计信息必须留档。
    extraFilters: Array.isArray(task.extraFilters) ? task.extraFilters.slice() : [],
    extraFilterValues: (task.extraFilterValues && typeof task.extraFilterValues === 'object')
      ? task.extraFilterValues : {},
    // 校验结果：文件是否存在、大小、表头、下载 id
    validation: task.validation || null,
    file: task.file || null,
    exportEvidence: task.exportEvidence || null,
    // ❗ 平台 10 万行截断的行数证据（平台自报行数 / 上限 / 是否疑为截断 / 建议的分片粒度）。
    //    进 manifest 是硬要求：文件看着正常，只有这一项能说明"这批数据可能不全"。
    rowCap: task.rowCap || (task.exportEvidence && task.exportEvidence.rowCap) || null,
    // 迟到下载对账记录 + 该任务的诊断事件（实机排障靠它定位"响应丢失但下载成功"）
    reconciliation: task.reconciliation || null,
    // 逐轮尝试的错误史：成功的场次也能看出前面几轮为什么失败（原先只有最终错误，查不到）
    attemptHistory: Array.isArray(task.attemptHistory) ? task.attemptHistory : [],
    diagnosticEvents: normalizeDiagEvents(task),
  };
}

async function writeSessionArtifacts(session, closure, opts) {
  const options = opts || {};
  const tabId = options.tabId != null ? Number(options.tabId) : (session.ownerTabId != null ? Number(session.ownerTabId) : null);

  // ✅ 幂等守卫（2026-09-14 补）：同一会话的产物**只投递一次**。
  //   实机问题：SW 重新加载/收尾被再次触发时，旧会话（早已 completed）会被再产一次清单，
  //   于是旧的 manifest/log 被重新下载到**下载根目录**（`session_log (1).json` 之类，
  //   内容属于旧会话）——不影响数据与归档，但会污染下载目录、让人误判。
  //   这里用会话级标记 `artifactsDeliveredAt` 一次性收口：已投递过就直接跳过。
  const latestMeta = await readSessionMeta(session.sessionId).catch(() => null);
  if (latestMeta && latestMeta.artifactsDeliveredAt) {
    trace('artifacts.skip-already-delivered', { sessionId: session.sessionId, at: latestMeta.artifactsDeliveredAt });
    return {
      skipped: true,
      reason: `本会话产物已于 ${latestMeta.artifactsDeliveredAt} 投递过，跳过重复投递`,
      root: sessionArtifactRoot(session),
    };
  }

  const root = sessionArtifactRoot(session);
  const manifest = {
    schemaVersion: core.SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    scheduleVersion: VERSION,
    sessionId: session.sessionId,
    storeId: session.storeId,
    storeName: session.storeName,
    granularity: session.granularity,
    timeGrain: session.timeGrain,
    dimensions: session.dimensions,
    startDate: session.startDate,
    endDate: session.endDate,
    requestedRange: session.requestedRange || { startDate: session.startDate, endDate: session.endDate },
    rangeAdjustments: session.rangeAdjustments || [],
    batch: session.batch || null,
    // 额外筛选值的显式覆盖（维度 → 控件 → 值时）：会话级留档，便于事后复核"这批数据到底筛了什么"
    // ⚠️ 2026-09-14 补：manifest 是**显式字段清单**（不是把 meta 整体拷过来），漏一个字段就查不到
    extraFilterValues: (session.extraFilterValues && typeof session.extraFilterValues === 'object')
      ? session.extraFilterValues : {},
    status: session.status,
    createdAt: session.createdAt,
    completedAt: session.completedAt || null,
    taskIntervalMs: session.taskIntervalMs,
    // 缺口清单：不静默跳过，直接落盘
    closure: summarizeClosure(closure),
    gapCount: closure.gaps.length,
    blockingGapCount: closure.blockingGaps.length,
    // 会话级诊断事件：迟到的下载认领/拒绝、响应超时、可见性重试都在这里
    diagnosticEvents: normalizeDiagEvents(session),
    taskDiagnostics: session.tasks
      .filter((task) => normalizeDiagEvents(task).length > 0 || task.reconciliation)
      .map((task) => ({
        key: task.key,
        reportName: task.reportName,
        status: task.status,
        reconciliation: task.reconciliation || null,
        events: normalizeDiagEvents(task),
      })),
    tasks: session.tasks.map(taskRecord),
  };
  // ---- artifact 自述块（**如实表述，不谎报最终路径**）
  // 文件内容在写盘前无法知道最终落在哪：`<a download>` 只决定文件名，子目录不生效；
  // 归档位置由 `onDeterminingFilename` 的下载接管决定。因此这里只声明**期望**路径，
  // 真实最终路径由 onChanged complete 的观测结果写入诊断事件与会话 meta。
  const artifactBlock = (kind, requestedFilename, deliveryMethod) => ({
    kind,
    expectedArchivePath: `${root}${requestedFilename}`,
    requestedFilename,
    deliveryMethod: deliveryMethod || null,   // 'content-anchor' | 'data-url'
    renamedBy: null,                          // 由下载接管完成后回填 'onDeterminingFilename'
    note: '最终路径由下载接管决定，见会话诊断事件/会话 meta 的 artifact 观测',
  });

  const manifestWrite = await deliverJsonArtifact({
    sessionId: session.sessionId,
    kind: 'session_manifest',
    tabId,
    relativePath: `${root}session_manifest.json`,
    contentBuilder: (deliveryMethod) => {
      manifest.artifact = artifactBlock('session_manifest', 'session_manifest.json', deliveryMethod);
      return manifest;
    },
  });

  const failures = session.tasks
    .filter((task) => task.error || task.status === 'failed_permanent' || task.status === 'error' || task.status === 'retry_wait')
    .map(taskRecord);
  const logWrite = await deliverJsonArtifact({
    sessionId: session.sessionId,
    kind: 'session_log',
    tabId,
    relativePath: `${root}session_log.json`,
    contentBuilder: (deliveryMethod) => ({
      schemaVersion: core.SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      sessionId: session.sessionId,
      storeId: session.storeId,
      storeName: session.storeName,
      status: session.status,
      lastError: session.lastError || null,
      counts: closure.summary ? closure.summary.counts : {},
      gapCount: closure.gaps.length,
      failures,
      artifact: artifactBlock('session_log', 'session_log.json', deliveryMethod),
    }),
  });
  // 标记"本会话产物已投递"（幂等守卫的落点）：必须在两次投递之后写，
  // 否则投递中途失败会被误判为"已投递"而永久不再补投。
  try {
    const after = await readSessionMeta(session.sessionId);
    if (after) await writeSessionMeta({ ...after, artifactsDeliveredAt: new Date().toISOString() });
  } catch (error) {
    trace('artifacts.mark-failed', { message: String((error && error.message) || error) });
  }
  return { root, manifestWrite, logWrite };
}

// ==================================================================================
// 9. 下载完成后的文件校验（存在 + 大小 > 0；表头来自页面结果视图，做口径比对）
// ==================================================================================

async function inspectDownloadedFile(downloadId) {
  if (downloadId == null) return { ok: false, reason: '缺少下载 id，无法校验文件' };
  const found = await chrome.downloads.search({ id: downloadId });
  const item = found && found[0];
  if (!item) return { ok: false, reason: `下载记录不存在（id=${downloadId}）` };
  if (item.state !== 'complete') return { ok: false, reason: `下载状态不是 complete：${item.state}` };
  if (item.exists === false) return { ok: false, reason: '下载文件已被删除或不再存在', filePath: item.filename || null };
  const size = Number(item.fileSize || item.totalBytes || 0);
  if (!(size > 0)) return { ok: false, reason: `文件大小异常：${size}`, filePath: item.filename || null };
  // 不申请额外权限去读文件系统：state === 'complete' + fileSize > 0 即为「文件存在且非空」的证据
  return { ok: true, filePath: item.filename || null, bytes: size, filename: item.filename || null };
}

/**
 * 口径比对：页面结果视图表头 vs 任务期望列数（**维度 × 时间粒度**实测值）。
 * ⚠️ 2026-09-14 W1：旧口径 `2 + 指标数` 对"有额外维度列"的维度不成立
 *   （实测 流量来源/分日 = 27，旧口径给 26 → 误报；整体/分日 子集 59 列 → 误报失败）。
 * 表头读不到 / 该组合未实测（unknown）→ **不判失败**（ok:null，只留证）；
 * 列数**少于**期望按"指标子集"处理（subset，不判失败）；只有**多于**期望才判失败。
 * 落地记录：补丁来源 `docs\W1_待办补丁_compareHeaders_20260914.md`，由 W4 于 2026-09-14 应用。
 */
function compareHeaders(task, headers) {
  const list = Array.isArray(headers) ? headers.filter(Boolean) : [];
  const verdict = core.checkColumnCount({
    dimensionName: task.dimension,
    granularity: task.granularity,
    timeGrain: task.timeGrain,
    extraFilterValues: task.extraFilterValues,
    actualColumns: list.length === 0 ? null : list.length,
  });
  if (list.length === 0) {
    return {
      ok: null,
      reason: '页面未读到表头，未做口径比对（留证）',
      expectedColumns: verdict.expectedColumns,
      actualColumns: null,
      kind: verdict.verdict,
    };
  }
  return {
    ok: verdict.ok,
    reason: verdict.reason,
    expectedColumns: verdict.expectedColumns,
    actualColumns: verdict.actualColumns,
    kind: verdict.verdict,
  };
}

// ==================================================================================
// 10. 恢复（onStartup 三分支；§7）
// ==================================================================================

async function recoverOnStartup() {
  const sessionId = await getActiveSessionId();
  if (!sessionId) return { branch: 'none' };
  const run = await loadRun(sessionId);
  if (!run) return { branch: 'none' };
  const { meta, tasks } = run;
  if (meta.status !== 'running' && meta.status !== 'paused') return { branch: 'inactive', status: meta.status };

  const task = tasks.find((item) => item.key === meta.activeTaskKey) || null;
  const expected = meta.expectedDownload;
  const armedAt = expected ? Date.parse(expected.armedAt) : Number.NaN;
  const fresh = Number.isFinite(armedAt) && Date.now() - armedAt < DOWNLOAD_WINDOW_MS;

  // 分支 ①：等待下载中 → 只重挂超时，绝不重复点击下载
  if (expected && task && (task.status === 'downloading' || task.status === 'platform_processing')) {
    if (fresh) {
      const probe = expected.downloadId == null ? null : await inspectDownloadedFile(expected.downloadId).catch(() => null);
      if (probe && probe.ok) {
        await settleDownloadComplete(sessionId, expected.downloadId, 'startup-probe');
        return { branch: 'download-completed' };
      }
      armTaskTimeout(sessionId, task.key, meta.taskTimeoutMs);
      return { branch: 'waiting-download' };
    }
    // 时效窗已过、又没有下载记录 → 该次出手没有产出文件，重跑该任务（不静默跳过）
    await failTaskSoft(sessionId, task.key, '浏览器重启后：等待下载超出时效窗且无下载记录，判定本次出手失败');
    return { branch: 'download-expired' };
  }

  // 分支 ②：导航/执行中 → 重跑该任务
  if (task && ['navigating', 'ready', 'export_clicked'].includes(task.status)) {
    // 该任务要重跑：旧的 expectedDownload 是上一次出手留下的，**必须清掉**，
    // 否则重跑时残留的归属信息会把这次下载错认成那一次（也会让时效窗判定失真）
    const rewound = core.canTransition(task.status, 'pending')
      ? core.transitionTask(task, 'pending')
      : settleFailure(task, '浏览器重启，任务被中断');
    const nextTasks = replaceTaskIn(tasks, rewound);
    await writeTaskShards(sessionId, nextTasks, [rewound.key]);
    await writeSessionMeta({
      ...meta,
      activeTaskKey: rewound.status === 'pending' ? null : rewound.key,
      expectedDownload: null,
      lastError: '浏览器重启，已从断点重跑该任务',
    });
    if (meta.status === 'running') scheduleTick(0);
    return { branch: 'rerun-task' };
  }

  // 分支 ③：其他 → 调度下一项
  await writeSessionMeta({ ...meta, expectedDownload: null, lastError: null });
  if (meta.status === 'running') scheduleTick(0);
  return { branch: 'schedule-next' };
}

/** 下载完成结算（onChanged complete 与启动探测共用） */
async function settleDownloadComplete(sessionId, downloadId, origin) {
  return withStateLock(async () => {
    const meta = await readSessionMeta(sessionId);
    if (!meta) return null;
    const expected = meta.expectedDownload;
    if (!expected) return null;
    if (downloadId != null && expected.downloadId != null && expected.downloadId !== downloadId) return null;
    const tasks = await readSessionTasks(sessionId, meta.shardCount);
    const task = tasks.find((item) => item.key === expected.taskKey);
    if (!task) return null;

    const inspection = await inspectDownloadedFile(downloadId == null ? expected.downloadId : downloadId);
    let next = task;
    if (!inspection.ok) {
      next = settleFailure(task, `下载完成但文件校验失败：${inspection.reason}`);
    } else {
      next = advanceTask(task, 'validating');
      const headers = task.exportEvidence ? task.exportEvidence.headers : [];
      const headerCheck = compareHeaders(task, headers);
      next = headerCheck.ok === false
        ? settleFailure(next, `表头校验失败：${headerCheck.reason}`)
        : advanceTask(next, 'done');
      next = {
        ...next,
        validation: {
          fileExists: true,
          bytes: inspection.bytes,
          headerCheck,
          checkedAt: new Date().toISOString(),
          origin,
        },
        file: {
          path: inspection.filePath,
          relative: expected.relativePath,
          downloadId: downloadId == null ? expected.downloadId : downloadId,
        },
      };
    }

    // 固定退避：未超限时用 core.nextBackoffMs(attempts) 算出可再次出手的时刻
    // （退避期内调度器本来也不会取它；写进任务里，落盘后 SW 被回收也不丢）
    if (next.status === 'retry_wait') {
      next = { ...next, earliestNextAt: new Date(Date.now() + core.nextBackoffMs(Number(next.attempts || 1))).toISOString() };
    }

    const nextTasks = replaceTaskIn(tasks, next);
    await writeTaskShards(sessionId, nextTasks, [next.key]);
    // 任务已到终态 → 清空 activeTaskKey（在途指针只指向"还没走完的那一个"）
    await writeSessionMeta({ ...meta, activeTaskKey: null, expectedDownload: null, lastError: next.error || meta.lastError });
    await chrome.alarms.clear(ALARM_TASK_TIMEOUT);

    if (meta.status === 'running' && !meta.pausedAfterTask) {
      if (next.status === 'retry_wait') scheduleTick(Date.parse(next.earliestNextAt) - Date.now());
      else if (core.isTerminalTaskState(next.status)) scheduleTick(meta.taskIntervalMs);
    }
    return next;
  });
}

// ==================================================================================
// 11. 事件注册
// ==================================================================================

/** 下载接管（四重校验 + suggest 只调一次 + 完成/中断结算） */
function registerDownloadListeners() {
  // ---------------------------------------------------------------- 下载接管（四重校验）
  chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
    // suggest 只允许调用一次
    let suggested = false;
    const suggestOnce = (options) => {
      if (suggested) return;
      suggested = true;
      try {
        if (options) suggest(options); else suggest();
      } catch (error) {
        // suggest 已失效（下载被取消）时忽略：不影响任务状态机
      }
    };

    // 接管决策留痕（不改变任何行为；只为排障时能确定"事件到底有没有触发"）
    const takeoverEntry = logTakeover({
      id: item.id,
      filename: String(item.filename || ''),
      scheme: String(item.url || '').split(':')[0],
      knownArtifact: artifactDownloadIds.has(item.id),
      at: new Date().toISOString(),
      decision: 'pending',
    });
    setTimeout(() => {
      if (takeoverEntry.decision === 'pending') takeoverEntry.decision = 'no-artifact-claim';
    }, 4000);

    (async () => {
      const sessionId = await getActiveSessionId();
      const meta = await readSessionMeta(sessionId);
      const expected = meta ? meta.expectedDownload : null;
      const tasks = meta ? await readSessionTasks(sessionId, meta.shardCount) : [];
      const task = expected ? tasks.find((entry) => entry.key === expected.taskKey) || null : null;
      const filename = String(item.filename || '');

      // ---------------------------------------------------------------- JSON 产物接管
      // 独立分支，放在 xlsx 四重校验**之前**（两者互不干扰）。
      // 背景：`<a download>` 只决定文件名、子目录不生效，所以归档位置必须在这里补上。
      // ⚠️ 只有**确实命中本产物**时才 suggest 并 return；
      //    不命中就**落到下面的 xlsx 路径**（绝不在这里 return，否则会把 xlsx 全部挡掉）。
      const arms = currentArtifactArms();
      const base = basenameOf(filename);
      const freshArms = arms.filter((a) => {
        const t = Date.parse(a && a.armedAt);
        return Number.isFinite(t) && Date.now() - t < DOWNLOAD_WINDOW_MS;
      });
      // 认领优先级（一定要精确，宁可漏认也不能认错，否则会把别的产物改名到错路径）：
      //   ① basename 精确命中 —— 页面通道（<a download>）的正常情况
      //   ② downloadId 精确命中 —— data: URL 兜底通道（文件名被 Chrome 换掉，只能靠 id）
      //   ③ Chrome 默认名（下载.json/download.json/unknown.json）且**只有一条**在途 arm（无歧义）
      const byName = arms.find((a) => a && a.filename === base) || null;
      const byId = arms.find((a) => a && a.downloadId != null && a.downloadId === item.id) || null;
      const defaultName = /^(下载|download|unknown|未确认)$/i.test(base.replace(/\.json$/i, ''));
      const armedArtifact = byName || byId || (defaultName && freshArms.length === 1 ? freshArms[0] : null);
      if (armedArtifact) {
        const armedAt = Date.parse(armedArtifact.armedAt);
        const fresh = Number.isFinite(armedAt) && Date.now() - armedAt < DOWNLOAD_WINDOW_MS;
        if (fresh) {
          takeoverEntry.decision = 'artifact-claimed';
          const claimedBy = byName ? 'basename' : (byId ? 'download-id' : 'chrome-default-name');
          suggestOnce({ filename: toDownloadPath(armedArtifact.relativePath), conflictAction: 'overwrite' });
          await recordDiagnostic(sessionId, DIAG.ARTIFACT_RENAMED, {
            artifact: armedArtifact.kind,
            observedFilename: filename,
            target: armedArtifact.relativePath,
            claimedBy,
            note: 'JSON 产物被下载接管重命名到归档路径',
          }, null).catch(() => undefined);
          await clearExpectedArtifact('已认领并重命名', armedArtifact.filename);
          return;
        }
        // 命中但已过时效窗 → 清掉这条 arm，交回浏览器默认命名（不静默）
        takeoverEntry.decision = 'artifact-stale';
        await clearExpectedArtifact('超出下载时效窗', armedArtifact.filename);
        await recordDiagnostic(sessionId, DIAG.ARTIFACT_DEGRADED, {
          artifact: armedArtifact.kind,
          observedFilename: filename,
          reason: `产物下载超出时效窗（armedAt=${armedArtifact.armedAt}）`,
        }, null).catch(() => undefined);
        suggestOnce();
        return;
      }

      // ① 存在在途 expectedDownload（且确属本任务）
      const check1 = !!(expected && task && expected.sessionId === sessionId);
      // ② 时效窗（3 分钟）
      const armedAt = expected ? Date.parse(expected.armedAt) : Number.NaN;
      const check2 = Number.isFinite(armedAt) && Date.now() - armedAt < DOWNLOAD_WINDOW_MS;
      // ③ 扩展名必须是 .xlsx（生参是 xlsx，不是 csv）
      const check3 = filename.toLowerCase().endsWith(SR.FILE.ext);
      // ④ 归属：用 core.matchesExpectedFile 确认（报表名称前缀 + 导出日期 + 32 位 hash）
      const check4 = check1 ? core.matchesExpectedFile(task, filename) : false;

      if (!(check1 && check2 && check3 && check4)) {
        // ---- 兜底归属（迟到的下载对账）：不放松上面四重校验，
        //      只在"存在在途 expectedDownload 但没命中"或"根本没有在途归属"时启用。
        //      先用"文件名是否以某个未完成任务的 reportName 开头"做一次廉价预筛，
        //      避免对平台上任何无关的 .xlsx 下载都去读一遍 storage（也避免诊断噪音）。
        if (check3) {
          const plausible = tasks.find((entry) => entry && !core.isTerminalTaskState(entry.status)
            && filename.startsWith(entry.reportName));
          if (plausible) {
            const miss = !check1
              ? '没有在途 expectedDownload'
              : (!check2 ? `在途归属超出时效窗（armedAt=${expected && expected.armedAt}）` : '文件名与在途任务不匹配');
            const reconciled = await reconcileLateDownload(item, filename);
            if (reconciled.claimed) {
              suggestOnce({ filename: toDownloadPath(reconciled.relativePath), conflictAction: 'uniquify' });
              return;
            }
            await recordDiagnostic(sessionId, DIAG.DOWNLOAD_REJECTED, {
              filename,
              downloadId: item && item.id != null ? item.id : null,
              reason: `${miss}；对账未认领：${reconciled.reason}`,
              checks: { hasExpected: check1, inWindow: check2, isXlsx: check3, matchesTask: check4 },
            }, expected ? expected.taskKey : null);
          } else {
            // ❗ 重复下载（加固① 2026-09-14）：文件名属于**本会话已完结（done）且已认领产物**的任务
            //    —— 典型来源是"催单"：实测 NUDGE9 场次 `nudges=5` → 平台多产出一份下载，
            //    而那时任务已 done、无人认领 → 文件以平台原名落在**下载根目录**。
            //    旧实现只记 `download_rejected` 并留给人工清理；现在改为**落盘前取消**，
            //    判据交给 `core.judgeDuplicateDownload`（纯函数，未知/歧义一律不取消）。
            const verdict = core.judgeDuplicateDownload({
              filename,
              tasks,
              sessionId,
              inFlightTaskKey: expected ? expected.taskKey : null,
              itemDownloadId: item && item.id != null ? item.id : null,
              sourceTabId: downloadSourceTabId(item),
              ownerTabId: meta ? meta.ownerTabId : null,
            });
            if (verdict.duplicate) {
              takeoverEntry.decision = 'duplicate-discarded';
              const disposition = await discardDuplicateDownload({
                sessionId, item, filename, verdict, suggest: suggestOnce,
              });
              trace('download.duplicate-handled-in-branch', { filename, disposition });
              return;   // 已取消（或已隔离落点）：不再 suggest 默认命名
            }
            // 未判为重复 → 只留证（绝不静默，也**绝不取消**别人的下载）
            if (check3 && verdict.evidence && verdict.evidence.candidateCount > 0) {
              await recordDiagnostic(sessionId, DIAG.DOWNLOAD_REJECTED, {
                filename,
                downloadId: item && item.id != null ? item.id : null,
                reason: `重复下载判定**未成立**（不取消）：${verdict.reason}`,
                duplicateOfTaskKey: null,
                candidateTaskKeys: verdict.evidence.candidateTaskKeys,
                note: '判据保守：任何未知/歧义一律不取消；文件按浏览器默认命名落盘，已留证',
              }, verdict.taskKey || null).catch(() => undefined);
            } else if (check1) {
              // 确实带着在途归属、但文件名既非本任务、也不像本会话任何任务 → 留证（不落 storage 诊断）
              trace('download.not-ours', { filename, expectedTaskKey: expected ? expected.taskKey : null });
            }
          }
        }
        // 任意一条不过 → 交回浏览器默认命名，绝不动别人的下载
        suggestOnce();
        return;
      }

      // ❗ 加固① 附加守卫（2026-09-14）：四重校验全过，但该任务**已经有一份成功认领的产物** ——
      //   说明这是同一任务的**第二份产物**（催单/平台重试），归档进去只会在归档目录里多出一个 `… (1).xlsx`。
      //   判据同 core.judgeDuplicateDownload，但**不看在途归属**（这里正是"在途归属也在指向同一任务"的场景）；
      //   只有"任务已 done + 已认领产物 fileExists=true + downloadId 不同"才成立，其余一律放行（不取消）。
      const alreadyClaimed = core.judgeDuplicateDownload({
        filename,
        tasks,
        sessionId,
        inFlightTaskKey: null,
        itemDownloadId: item && item.id != null ? item.id : null,
        sourceTabId: downloadSourceTabId(item),
        ownerTabId: meta ? meta.ownerTabId : null,
      });
      if (alreadyClaimed.duplicate) {
        takeoverEntry.decision = 'duplicate-discarded';
        const disposition = await discardDuplicateDownload({
          sessionId, item, filename, verdict: alreadyClaimed, suggest: suggestOnce,
        });
        trace('download.duplicate-handled-before-archive', { filename, disposition });
        return;
      }

      // 四条全过 → 归档重命名
      suggestOnce({ filename: toDownloadPath(archiveRelativeFile(task, filename)), conflictAction: 'uniquify' });

      // 记录 downloadId 并把任务推进到 downloading
      await withStateLock(async () => {
        const latest = await readSessionMeta(sessionId);
        if (!latest || !latest.expectedDownload || latest.expectedDownload.taskKey !== expected.taskKey) {
          return;
        }
        const latestTasks = await readSessionTasks(sessionId, latest.shardCount);
        let current = latestTasks.find((entry) => entry.key === expected.taskKey);
        if (!current || core.isTerminalTaskState(current.status)) {
          return;
        }
        // ⚠️ 2026-09-13 实机修复：**下载到了，就说明"点击下载"已经发出**。
        //    原实现只在 status ∈ {platform_processing, ready, export_clicked} 时才推进，
        //    但页面流程跑完（十几秒）后点击下载与 SR_EXECUTE_TASK 的响应返回是**并行**的：
        //    下载常常在任务还处于 navigating 时就到达。此时旧的守卫会直接跳过推进，
        //    任务永远停在 navigating → 下载完成回调也判不到它 → 任务被判永久失败，
        //    而文件其实已经落盘（正是实机 S20260913121701 的现象）。
        //    navigating 的合法迁移里本来就有 downloading（core.TASK_TRANSITIONS），所以这里直接推进。
        current = advanceTask(current, 'downloading');
        const nextTasks = replaceTaskIn(latestTasks, current);
        await writeTaskShards(sessionId, nextTasks, [current.key]);
        await writeSessionMeta({
          ...latest,
          expectedDownload: { ...latest.expectedDownload, downloadId: item.id, detectedAt: new Date().toISOString(), totalBytes: Number(item.totalBytes || 0) },
        });
      });
    })().catch(async (error) => {
      // 归属处理本身出错时，先把证据留下再交回浏览器默认命名（绝不吞掉）
      const message = String(error && error.message || error);
      try {
        const sessionId = await getActiveSessionId();
        await recordDiagnostic(sessionId, DIAG.DOWNLOAD_REJECTED, {
          phase: 'handler-error',
          filename: String(item && item.filename || ''),
          error: message,
        }, null);
      } catch (ignored) { /* 诊断失败不影响主流程 */ }
      suggestOnce();
    });

    return true; // 异步 suggest
  });

  // ---------------------------------------------------------------- 下载状态变化
  chrome.downloads.onChanged.addListener((delta) => {
    if (!delta || !delta.state) return;
    const state = delta.state.current;
    if (state !== 'complete' && state !== 'interrupted') return;
    (async () => {
      // ---- 加固①：重复下载（催单产物）的取消收口 —— 必须**放在最前**，且**不参与任务状态机**。
      //      被取消的下载会以 state='interrupted'（error=USER_CANCELED）报到，下面的分支会把
      //      interrupted 当成"本任务下载被中断 → 会话 paused"；而重复下载与任务无关（任务早已 done），
      //      因此这里先收口并 return，绝不污染任务/会话状态。
      const discarded = duplicateDiscards.get(delta.id) || null;
      if (discarded) {
        duplicateDiscards.delete(delta.id);
        const probe = await inspectDownloadedFile(delta.id).catch(() => null);
        const disposition = state === 'complete' ? 'quarantined' : (state === 'interrupted' ? 'cancelled' : 'unknown');
        try { await chrome.downloads.erase({ id: delta.id }); } catch (ignored) { /* 抹记录失败不影响留证 */ }
        await recordDiagnostic(discarded.sessionId, DIAG.DOWNLOAD_DUPLICATE_DISCARDED, {
          ...discarded.evidence,
          phase: 'settle',
          disposition,
          observedState: state,
          observedError: (delta.error && delta.error.current) || null,
          finalPath: (probe && probe.filePath) || null,
          bytes: probe ? probe.bytes : null,
          note: disposition === 'cancelled'
            ? '✅ 取消已在落盘前生效（onChanged 收口）：下载目录不会出现多余文件'
            : (disposition === 'quarantined'
              ? '⚠️ 竞态：取消晚于落盘 → 文件落在隔离目录 `_duplicates\\<会话id>_quarantine\\`（只隔离、绝不删除）'
              : `⚠️ 取消收口时状态异常：${state}`),
        }, discarded.evidence ? discarded.evidence.duplicateOfTaskKey : null).catch(() => undefined);
        return;
      }

      const sessionId = await getActiveSessionId();
      const meta = await readSessionMeta(sessionId);
      if (!meta) return;
      const tasks = await readSessionTasks(sessionId, meta.shardCount);

      // ---- JSON 产物：观测**真实最终路径**（写盘时无法知道，只能在这里落证据）
      if (state === 'complete') {
        const observed = await inspectDownloadedFile(delta.id).catch(() => null);
        const finalPath = (observed && observed.ok) ? observed.filePath : null;
        const finalBase = basenameOf(finalPath || '');
        const knownBase = [...expectedArtifacts.values()].map((a) => a && a.filename).filter(Boolean);
        // 扩展自发的 data: URL 下载会被 Chrome 换成默认名（下载.json），basename 认不出来 → 用 downloadId 认。
        const knownId = artifactDownloadIds.has(delta.id);
        const armForId = knownId
          ? ([...expectedArtifacts.values()].find((a) => a && a.downloadId === delta.id) || null)
          : null;
        const watched = knownId || (finalBase && (knownBase.includes(finalBase) || isArtifactJsonFilename(finalBase)));
        if (watched) {
          const inArchive = /(^|[\\/])生参取数[\\/]/.test(String(finalPath || ''));
          const kind = armForId
            ? armForId.kind
            : (isArtifactJsonFilename(finalBase) ? finalBase.replace(/\.json$/i, '') : 'artifact');
          await recordDiagnostic(sessionId, DIAG.ARTIFACT_DELIVERED, {
            phase: 'observed-final-path',
            artifact: kind,
            downloadId: delta.id,
            finalPath,
            bytes: observed ? observed.bytes : null,
            inArchiveRoot: inArchive,
            renamed: inArchive,
            determinedById: knownId,
            note: inArchive
              ? '产物已落在归档根下'
              : '产物未落在归档根下（Chrome 忽略了 data: URL 的 filename，落进了下载根目录）',
          }, null).catch(() => undefined);
          await withStateLock(async () => {
            const latest = await readSessionMeta(sessionId);
            if (!latest) return;
            await writeSessionMeta({
              ...latest,
              lastArtifactObservation: {
                at: new Date().toISOString(),
                artifact: kind,
                downloadId: delta.id,
                finalPath,
                bytes: observed ? observed.bytes : null,
                inArchiveRoot: inArchive,
                determinedById: knownId,
              },
            });
          });
          // 观测到最终落点即完成闭环：清掉 id 名单与对应 arm（后续同名下载不再被误认为本产物）
          if (knownId) {
            artifactDownloadIds.delete(delta.id);
            if (armForId) await clearExpectedArtifact('已观测到最终落点', armForId.filename).catch(() => undefined);
          }
        }
      }

      // ---- 迟到的下载对账认领过的任务：downloadId 不在 expectedDownload 上，
      //      但仍是本会话的文件。文件落盘完成后补齐"存在性 + 大小"与最终路径。
      if (state === 'complete' && !(meta.expectedDownload && meta.expectedDownload.downloadId === delta.id)) {
        const reconciledTask = tasks.find((entry) => entry.file && entry.file.reconciled && entry.file.downloadId === delta.id);
        if (reconciledTask) {
          const inspection = await inspectDownloadedFile(delta.id).catch(() => null);
          await withStateLock(async () => {
            const latest = await readSessionMeta(sessionId);
            if (!latest) return;
            const latestTasks = await readSessionTasks(sessionId, latest.shardCount);
            const current = latestTasks.find((entry) => entry.key === reconciledTask.key);
            if (!current || !current.file || !current.file.reconciled) return;
            const nextTasks = replaceTaskIn(latestTasks, {
              ...current,
              file: { ...current.file, path: (inspection && inspection.filePath) || current.file.path },
              validation: {
                ...(current.validation || {}),
                fileExists: !!(inspection && inspection.ok),
                bytes: inspection ? inspection.bytes : null,
                completedAt: new Date().toISOString(),
                origin: 'reconcile-download-complete',
              },
            });
            await writeTaskShards(sessionId, nextTasks, [current.key]);
            await writeSessionMeta({ ...latest });
          });
          await recordDiagnostic(sessionId, DIAG.DOWNLOAD_CLAIMED, {
            phase: 'complete-backfill',
            downloadId: delta.id,
            filePath: (inspection && inspection.filePath) || null,
            bytes: inspection ? inspection.bytes : null,
            ok: !!(inspection && inspection.ok),
          }, reconciledTask.key);
          return;
        }
      }

      if (!meta.expectedDownload) return;
      if (meta.expectedDownload.downloadId == null || meta.expectedDownload.downloadId !== delta.id) {
        return; // 不是本任务在途的那次下载（迟到回调 / 无关下载）
      }
      const task = tasks.find((entry) => entry.key === meta.expectedDownload.taskKey);
      if (!task || core.isTerminalTaskState(task.status)) return;

      if (state === 'complete') {
        // 只有 complete 才算 done，并且要校验文件存在 / 大小 > 0
        await settleDownloadComplete(sessionId, delta.id, 'downloads.onChanged');
        return;
      }

      // interrupted → 任务 error + 会话 paused（绝不静默跳过）
      await withStateLock(async () => {
        const latest = await readSessionMeta(sessionId);
        if (!latest || !latest.expectedDownload || latest.expectedDownload.downloadId !== delta.id) return;
        const latestTasks = await readSessionTasks(sessionId, latest.shardCount);
        const current = latestTasks.find((entry) => entry.key === latest.expectedDownload.taskKey);
        if (!current || core.isTerminalTaskState(current.status)) return;
        const reason = `下载被中断：${(delta.error && delta.error.current) || '未知原因'}`;
        const failed = settleFailure(current, reason);
        const nextTasks = replaceTaskIn(latestTasks, failed);
        await writeTaskShards(sessionId, nextTasks, [failed.key]);
        const paused = metaWithSessionAction({ ...latest, expectedDownload: null }, 'pause');
        await writeSessionMeta({ ...paused, activeTaskKey: null, lastError: reason });
        await chrome.alarms.clear(ALARM_TASK_TIMEOUT);
      });
    })().catch(() => undefined);
  });
}

/** 生命周期事件（闹钟 / 启动恢复 / 标签页加载） */
function registerLifecycleListeners() {
  // ---------------------------------------------------------------- 闹钟
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (!alarm) return;
    if (alarm.name === ALARM_TICK) {
      runTick().catch(async (error) => {
        const sessionId = await getActiveSessionId();
        if (sessionId) await recordSessionError(sessionId, `调度异常：${error && error.message}`);
      });
      return;
    }
    if (alarm.name === ALARM_TASK_TIMEOUT) {
      // 先留痕（零噪音：只保留最后一条，写 storage，不进会话事件流），再走原逻辑
      recordTaskAlarmFire(alarm).catch(() => undefined);
      timeoutCurrentTask().catch(() => undefined);
    }
    // 闹钟准点性探针：把"约定时刻 vs 实际触发时刻"落盘（SW 冷启动也能落）
    if (alarm.name === ALARM_PROBE_NAME) {
      (async () => {
        const now = Date.now();
        const prev = (await readAlarmProbe()) || {};
        const expected = prev.expectedAt ? Date.parse(prev.expectedAt) : null;
        await writeAlarmProbe({
          ...prev,
          firedAt: new Date(now).toISOString(),
          deltaMs: expected == null ? null : now - expected,
          firedScheduledTime: alarm.scheduledTime == null ? null : new Date(alarm.scheduledTime).toISOString(),
          note: '实际触发时刻与约定时刻的差 = deltaMs（正=晚触发）。这是判断"短延时闹钟是否可靠"的唯一硬证据。',
        });
      })().catch(() => undefined);
    }
  });

  // ---------------------------------------------------------------- 浏览器启动：恢复三分支
  chrome.runtime.onStartup.addListener(() => {
    recoverOnStartup().catch(async (error) => {
      const sessionId = await getActiveSessionId();
      if (sessionId) await recordSessionError(sessionId, `恢复失败：${error && error.message}`);
    });
  });

  // 服务工作线程被唤醒（安装/更新/调试）时也做一次温和恢复：只补闹钟，不重复出手
  chrome.runtime.onInstalled.addListener(() => {
    rearmTimersIfNeeded().catch(() => undefined);
  });

  // 标签页加载状态变化：
  //   · status === 'loading' 或 URL 变化 → **必须清除表单 frame 映射**
  //     （否则会拿旧 frameId 发消息，必然报错；表单 frame 加载完会自己重新上报 HELLO）
  //   · status === 'complete' → 若当前任务卡在导航/执行中，补一次派发（flight 去重保证不重复执行）
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (!changeInfo) return;
    if (changeInfo.status === 'loading' || changeInfo.url) {
      clearFormFrame(tabId, changeInfo.status === 'loading' ? 'status=loading' : 'url-changed').catch(() => undefined);
    }
    if (changeInfo.status !== 'complete') return;
    redispatchIfPending(tabId).catch(() => undefined);
  });
}

/**
 * 下载催单 / 自适应等待参数（2026-09-14 抓包与实测后定稿，固定值、无随机抖动）。
 *
 * 平台导出是异步且**慢**：点「下载报表」→ `download.json` 提交 → 页面轮询 `queryDownloadUrl.json`
 * → 返回**跨域 OSS 链接** → 页面再下载一次；链路常常要几十秒甚至更久，最后一步还时成时不成。
 * 等待策略：每 60 秒检查一次——能催就催（最多 2 次），页面暂时不接受（平台正在生成）就算一轮检查，
 * 最多 5 轮，之后判失败。总等待 ≈ 60 秒 ×6 ≈ 6 分钟，**有界，绝不无限等**。
 *
 * ✅ 2026-09-14 收尾 ③：把检查点临时压到 2 秒后，这条分支**已在实机跑通**
 *    （NUDGE9 场次：`download_nudged` ×5、任务 `done`、产物 5,560,631 B）。
 *    生产参数（60 秒）保持不变的理由：检查点只是"到点看看文件到没到"，
 *    而"平台生成 + OSS 落盘"通常只要十几秒 → 60 秒的检查点平时根本不会被用到；
 *    2 秒是"人为把检查点塞进等待窗口"的**验证手段**，不是更优的生产取值。
 */
// ⚠️ 生产参数（收尾 ③ 验证用的临时值 2000/5/30 已恢复，留档见 README「收尾 ③」）
const DOWNLOAD_NUDGE_AFTER_MS = 60000;
const MAX_DOWNLOAD_NUDGES = 2;
const MAX_NUDGE_CHECKS = 5;

/** 超时：任务 error（重试或永久失败），会话 retry_wait → 调度下一项 */
async function timeoutCurrentTask() {
  const sessionId = await getActiveSessionId();
  if (!sessionId) return null;
  const run = await loadRun(sessionId);
  if (!run) return null;
  const { meta, tasks } = run;
  const task = tasks.find((item) => item.key === meta.activeTaskKey);
  if (!task || core.isTerminalTaskState(task.status)) return null;
  // 只有"等平台/等下载"阶段才允许判超时：
  // navigating 阶段本身还在跑（页面消息最长重试约 12 秒），乱判会把在途任务打成失败
  if (!['platform_processing', 'downloading'].includes(task.status)) {
    await traceNudge('early-return-status', { status: task.status, taskKey: task.key });
    return null;
  }
  await traceNudge('checkpoint-enter', { status: task.status, taskKey: task.key, nudges: Number(task.nudges || 0), checks: Number(task.nudgeChecks || 0), ownerTabId: meta.ownerTabId });

  // ---- 下载催单（2026-09-14 抓包实证后新增）
  //   平台导出是**异步**的：点「下载报表」→ download.json 提交 → 页面轮询 queryDownloadUrl.json
  //   → 拿到**跨域 OSS 链接** → 页面还要再下载一次，而这一步**时成时不成**
  //   （S1 场次第 1 轮卡在此处，白等满 180 秒 → 整轮判失败重跑，代价极高）。
  //   收敛手段：表单与结果视图都还在，**再点一次「下载报表」**即可，不必重跑整轮。
  //   总时长仍以 taskTimeoutMs 为硬上限：催单次数用尽就必须判失败（绝不无限等）。
  //   ⚠️ 状态判定必须**两种等待态都覆盖**：首轮实测（V1/V2/V3）催单始终没触发，
  //      根因就是超时到达时任务已不在 `platform_processing`（被下载事件推进成了 `downloading`），
  //      于是整个催单分支被跳过一次都不执行 → 直接判超时。催单与状态无关，只与"文件还没到"有关。
  if (['platform_processing', 'downloading'].includes(task.status)) {
    const nudges = Number(task.nudges || 0);
    const checks = Number(task.nudgeChecks || 0);
    const ownerTabId = Number(meta.ownerTabId);
    // 自适应等待：每次检查要么"催单成功"（nudges+1），要么"页面正忙/不在结果视图"（checks+1）。
    // 两条路都**再等一轮**，直到总量用尽才判超时 —— 这不是无限等：
    // 总等待 = DOWNLOAD_NUDGE_AFTER_MS ×(MAX_NUDGE_CHECKS + 1)，默认约 6 分钟。
    // 实机依据（V1–V5）：平台导出链路很慢（download.json → 轮询 queryDownloadUrl → OSS 链接就绪
    // 常常要几十秒甚至更久），180 秒硬上限会误判失败；而这些"失败"场次的文件**最终都到齐并被归档**
    // （U1/V1/V2/V3/V4/V5 六个 xlsx 都在归档目录里）——说明该等，而不是该判失败。
    if (ownerTabId && checks < MAX_NUDGE_CHECKS) {
      // ⚠️ 催单前必须**重新解析表单 frame**：瓴羊 SPA 在"表单视图 → 结果视图"切换时会改 iframe URL，
      //    `tabs.onUpdated` 因此清掉 frameId 映射 → 直接发消息只会广播到外壳 frame，
      //    得到"只有非表单 frame 应答"（W2 场次实证）。重新等一次自报即可拿到新的 frameId。
      await traceNudge('before-wait-frame', {});
      const frameReady = await waitForFormFrame(ownerTabId, FORM_FRAME_WAIT_MS).catch(() => ({ ok: false, reason: '等待表单 frame 异常' }));
      await traceNudge('after-wait-frame', { ok: !!frameReady.ok, waitedMs: frameReady.waitedMs, source: frameReady.source, reason: frameReady.reason || '', lastProbe: frameReady.lastProbe || null, rememberedFrameId: frameReady.rememberedFrameId || null, probeCount: frameReady.probeCount === undefined ? null : frameReady.probeCount });
      const res = frameReady.ok
        ? await sendToPage(ownerTabId, { type: 'SR_NUDGE_DOWNLOAD' }).catch((error) => ({ ok: false, reason: `催单消息异常：${String((error && error.message) || error)}` }))
        : null;
      await traceNudge('after-send-nudge', { ok: !!(res && res.ok), reason: (res && res.reason) || '', clickedAt: (res && res.clickedAt) || null });
      if (res && res.ok && nudges < MAX_DOWNLOAD_NUDGES) {
        await withStateLock(async () => {
          const latest = await readSessionMeta(sessionId);
          if (!latest) return;
          const latestTasks = await readSessionTasks(sessionId, latest.shardCount);
          const current = latestTasks.find((item) => item.key === task.key);
          if (!current || core.isTerminalTaskState(current.status)) return;
          await writeTaskShards(sessionId, replaceTaskIn(latestTasks, { ...current, nudges: nudges + 1, nudgeChecks: checks + 1 }), [task.key]);
        });
        await recordDiagnostic(sessionId, DIAG.DOWNLOAD_NUDGED, {
          nudge: nudges + 1,
          check: checks + 1,
          tabId: ownerTabId,
          note: '等下载期间对同一结果视图再点一次「下载报表」（平台导出异步、最后一步时成时不成）',
        }, task.key).catch(() => undefined);
        armTaskTimeout(sessionId, task.key, DOWNLOAD_NUDGE_AFTER_MS);
        return task;
      }
      // 页面侧拒绝（多数是"当前不在结果视图"：刚点完下载、平台正在生成，按钮态在变）
      // → 不算失败，计入检查次数后**再等一轮**（这就是自适应延长等待）
      await withStateLock(async () => {
        const latest = await readSessionMeta(sessionId);
        if (!latest) return;
        const latestTasks = await readSessionTasks(sessionId, latest.shardCount);
        const current = latestTasks.find((item) => item.key === task.key);
        if (!current || core.isTerminalTaskState(current.status)) return;
        await writeTaskShards(sessionId, replaceTaskIn(latestTasks, { ...current, nudgeChecks: checks + 1 }), [task.key]);
      });
      await recordDiagnostic(sessionId, DIAG.DOWNLOAD_NUDGE_SKIPPED, {
        check: checks + 1,
        taskStatus: task.status,
        tabId: ownerTabId,
        reason: (res && res.reason)
          || (frameReady && frameReady.ok ? (res ? '页面应答 ok=false' : '页面无应答') : `表单 frame 未就绪：${(frameReady && frameReady.reason) || '未知'}`),
        note: '页面侧暂时不接受催单（平台仍在生成/按钮态变化），本轮不催，再等一轮后重试',
      }, task.key).catch(() => undefined);
      armTaskTimeout(sessionId, task.key, DOWNLOAD_NUDGE_AFTER_MS);
      return task;
    }
    await recordDiagnostic(sessionId, DIAG.DOWNLOAD_NUDGE_SKIPPED, {
      check: checks,
      nudges,
      taskStatus: task.status,
      reason: ownerTabId ? `等待轮次已用尽（${checks}/${MAX_NUDGE_CHECKS}）` : '缺少 ownerTabId',
      note: '未再延长等待，按超时阈值判失败',
    }, task.key).catch(() => undefined);
  }

  return failTaskSoft(sessionId, task.key, `等待平台下载超过自适应上限（检查 ${Number(task.nudgeChecks || 0)} 轮 / 催单 ${Number(task.nudges || 0)} 次；超时时任务状态=${task.status}）`);
}

/** SW 被唤醒后只补闹钟（不重复点击下载） */
async function rearmTimersIfNeeded() {
  const sessionId = await getActiveSessionId();
  if (!sessionId) return;
  const run = await loadRun(sessionId);
  if (!run) return;
  const { meta, tasks } = run;
  if (meta.status !== 'running') return;
  const task = tasks.find((item) => item.key === meta.activeTaskKey);
  if (meta.expectedDownload && task && ['downloading', 'platform_processing'].includes(task.status)) {
    if (!(await chrome.alarms.get(ALARM_TASK_TIMEOUT))) armTaskTimeout(sessionId, task.key, meta.taskTimeoutMs);
    return;
  }
  if (!(await chrome.alarms.get(ALARM_TICK))) scheduleTick(meta.taskIntervalMs);
}

/** 页面加载完成后补派发（仅在任务确实卡在导航/执行中时） */
async function redispatchIfPending(tabId) {
  const sessionId = await getActiveSessionId();
  if (!sessionId) return;
  const run = await loadRun(sessionId);
  if (!run) return;
  const { meta, tasks } = run;
  if (meta.status !== 'running' || meta.ownerTabId !== tabId) return;
  const task = tasks.find((item) => item.key === meta.activeTaskKey);
  if (!task || core.isTerminalTaskState(task.status)) return;
  if (!['navigating', 'ready', 'export_clicked'].includes(task.status)) return;
  await executeTask(meta, task);
}

// ==================================================================================
// 12. 消息接口（popup 用 SRUI_*；content 只上报 SR_* 心跳，无需后台应答）
// ==================================================================================
/** popup 读状态用的精简视图 */
/**
 * ⭐ 2026-09-22：**活跃会话**的扁平摘要（供 `QUEUE_STATE` 回执供外部消费者读）。
 *
 * 为什么单独做（Codex 复核提出的真问题）：外部（脚本 / 桥 / 另一个 agent）**读不到**
 * chrome.storage；而磁盘上的 `session_manifest.json` 只能证明**某个历史会话结束了**，
 * 证明不了"**此刻**没有会话在跑"（之后可能又启动了一个）。所以必须由**服务端**（本 SW）
 * 现场给出：有没有活跃会话、什么状态、跑到哪。
 *
 * 只出标量/计数：它最终要塞进 `data-sr-autorun`（硬上限 900 字符）的扁平块里，
 * 嵌套对象会被摘要器压成 `"[depth]"`。
 */
function activeSessionBrief(meta, tasks) {
  if (!meta) return null;
  let counts = {};
  try {
    counts = core.summarizeTasks(tasks || []).counts || {};
  } catch (error) {
    counts = {};
  }
  return {
    sessionId: meta.sessionId || null,
    status: meta.status || null,
    total: Array.isArray(tasks) ? tasks.length : 0,
    counts: {
      done: Number(counts.done || 0),
      failed_permanent: Number(counts.failed_permanent || 0),
      pending: Number(counts.pending || 0),
      ended: Number(counts.ended || 0),
    },
    storeId: meta.storeId || null,
    storeName: meta.storeName || null,
    batch: meta.batch || null,
    startedAt: meta.createdAt || null,
    updatedAt: meta.updatedAt || null,
  };
}

function sessionView(meta, tasks) {  if (!meta) return null;
  const summary = core.summarizeTasks(tasks || []);
  const closure = (() => {
    try {
      return summarizeClosure(core.validateClosure({ ...meta, tasks: tasks || [] }));
    } catch (error) {
      return { ok: false, gaps: [], blockingGaps: [], message: String(error && error.message) };
    }
  })();
  return {
    sessionId: meta.sessionId,
    status: meta.status,
    storeId: meta.storeId,
    storeName: meta.storeName,
    granularity: meta.granularity,
    timeGrain: meta.timeGrain,
    dimensions: meta.dimensions,
    startDate: meta.startDate,
    endDate: meta.endDate,
    batch: meta.batch,
    total: summary.total,
    counts: summary.counts,
    activeTaskKey: meta.activeTaskKey,
    activeTask: meta.activeTaskKey ? (tasks || []).find((task) => task.key === meta.activeTaskKey) || null : null,
    lastError: meta.lastError || null,
    gapCount: closure.gaps ? closure.gaps.length : 0,
    blockingGapCount: closure.blockingGaps ? closure.blockingGaps.length : 0,
    gaps: closure.gaps || [],
    closureOk: !!closure.ok,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    completedAt: meta.completedAt || null,
    taskIntervalMs: meta.taskIntervalMs,
    taskTimeoutMs: meta.taskTimeoutMs,
  };
}

async function handleUiMessage(message) {
  const action = String(message.action || '');
  // 每次 SW 唤醒（安装/重载/事件）后的第一条消息：先做一次配额卫生 —— 老会话详情不清会撞满
  // chrome.storage.local 配额，届时写不进（任务静默卡死）且 END 也写不出（会话永远 running）。
  await ensureStoragePruned();
  switch (action) {
    case 'PING':
      return { ok: true };

    case 'STATE': {
      const sessionId = await getActiveSessionId();
      const run = sessionId ? await loadRun(sessionId) : null;
      const lastTab = await chrome.storage.local.get('sr:lastTabId');
      return {
        ok: true,
        session: run ? sessionView(run.meta, run.tasks) : null,
        index: (await chrome.storage.local.get(K_INDEX))[K_INDEX] || [],
        lastTabId: lastTab['sr:lastTabId'] || null,
        inFlight: liveInFlight,
        // ⭐ 队列视图（2026-09-18）：工作台每秒轮询 STATE 就能实时显示队列，不必另开命令
        queue: queueView(await readQueue()),
      };
    }

    case 'SET_TAB': {
      await chrome.storage.local.set({ 'sr:lastTabId': Number(message.tabId) || null });
      return { ok: true };
    }

    case 'PAGE_PING': {
      // 同 PREFLIGHT：允许深链接用 `config.ownerTabId` 指定标签页（便于远程诊断）
      const tabId = Number(message.tabId || (message.config && message.config.ownerTabId));
      if (!tabId) return { ok: false, error: '缺少标签页' };
      let tab = null;
      try {
        tab = await chrome.tabs.get(tabId);
      } catch (error) {
        return { ok: false, error: `标签页不可用：${error && error.message}` };
      }
      if (!core.isAllowedPageUrl(tab.url)) {
        return { ok: false, error: `当前不是新建取数页，请先进入「自助分析 → 取数报表 → 新建取数」，或点击「修复连接」进入取数页。当前地址：${tab.url}`, tabUrl: tab.url };
      }
      const ping = await sendToPage(tabId, { type: 'SR_PING' });
      const state = await sendToPage(tabId, { type: 'SR_STATE' });
      const pageState = (state && state.ok && state.state) || (ping && ping.state) || null;
      const required = null;
      return { ok: !!(ping && ping.ok), tabUrl: tab.url, page: pageState, required, reason: (ping && ping.reason) || '' };
    }

    case 'RECONNECT_PAGE': {
      const tabId = Number(message.tabId);
      if (!tabId) return { ok: false, error: '缺少目标标签页' };
      const tab = await chrome.tabs.get(tabId);
      const url = new URL(tab.url || 'about:blank');
      const isHome = url.origin === `https://${SR.PAGE.host}` && url.pathname === '/portal/home.htm';
      if (!isHome && !core.isAllowedPageUrl(tab.url)) {
        return { ok: false, error: '目标不是生参首页或取数页，请手动进入生参「自助分析 → 取数报表 → 新建取数」。' };
      }
      const activeId = await getActiveSessionId();
      const active = activeId ? await readSessionMeta(activeId) : null;
      const queue = await readQueue();
      if (queue.running || (active && (active.status === 'running' || active.activeTaskKey || active.expectedDownload))) {
        return { ok: false, error: '取数或下载尚在运行，请先停止队列并等待当前任务结束，再修复连接。' };
      }
      await clearFormFrame(tabId, '用户请求修复页面连接');
      if (isHome) {
        await chrome.tabs.update(tabId, { url: `https://${SR.PAGE.host}${SR.PAGE.shellPath}datafetch/create` });
        return { ok: true, note: '已从生参首页进入新建取数页。加载完成后再核验、预检；尚未开始下载。' };
      }
      await chrome.tabs.reload(tabId);
      return { ok: true, note: '已刷新目标生参页。页面加载完成后，请再点「核验当前页」及「预检」。' };
    }

    // ⭐ 只读枚举探针（2026-09-15 新增）：实采某个「数据粒度」下平台真实提供什么
    //    （有哪些维度、每个维度的指标总数、每个维度的合法时间粒度）。
    //    · **不提交任何任务**、不建会话、不下载产物；跑完把原粒度/维度还原。
    //    · 为什么必须由 background 发起：表单在**跨域 iframe** 里，外部注入的代码
    //      既拿不到跨域 frame 的引擎对象、也不知道扩展 ID（实测两条路都堵），
    //      只有 background 能定向发消息给表单 frame。
    //    · 结果可能很长（17 维度 × 多个粒度）→ 回执里只给摘要，全量由页面写 JSON 落盘。
    case 'ENUMERATE': {
      const tabId = Number(message.tabId || (message.config && message.config.ownerTabId));
      if (!tabId) return { ok: false, error: '缺少标签页' };
      await assertAllowedTab(tabId);
      const granularity = String((message.config && message.config.granularity) || '商品');
      const dimensionLimit = Number((message.config && message.config.dimensionLimit) || 0);
      const mode = String((message.config && message.config.mode) || 'dimensions');
      const onlyDimension = (message.config && message.config.onlyDimension) || '';
      await ensureTabForeground(tabId);
      const r = await sendToPage(tabId, {
        type: 'SR_ENUMERATE', granularity, dimensionLimit, mode, onlyDimension,
      });
      const dims = (r && r.dimensions) || [];
      // ⚠️ 全量结果**必须落盘**：回执属性有 900 字符硬上限（见 core.AUTORUN_RECEIPT），
      //    17 个维度的明细一定超。所以回执只给紧凑摘要，全量写 <批次>/enumeration_<粒度>_<时刻>.json。
      const stamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
      let saved = null;
      try {
        const payload = JSON.stringify(r || {}, null, 1);
        saved = await chrome.tabs.sendMessage(tabId, {
          type: 'SR_SAVE_JSON',
          filename: `enumeration_${granularity}_${stamp}.json`,
          json: payload,
        }, { frameId: (await getFormFrame(tabId) || {}).frameId });
      } catch (error) {
        saved = { ok: false, reason: String(error && error.message || error) };
      }
      return {
        ok: !!(r && r.ok),
        probe: 'ENUMERATE',
        granularityRequested: granularity,
        granularityBefore: (r && r.granularityBefore) || null,
        granularityAfter: (r && r.granularityAfter) || null,
        granularityOptions: (r && r.granularityOptions) || [],
        dimensionCount: ((r && r.dimensionOptions) || []).length,
        dimensionOptions: ((r && r.dimensionOptions) || []).slice(0, 20),
        // 每维度的指标总数（紧凑：名:数）——这是二期最需要的实测值
        metricCounts: dims.reduce((acc, d) => { acc[d.name] = d.metricCount; return acc; }, {}),
        // 每维度合法时间粒度（紧凑：名:粒度列表）
        timeGrains: dims.reduce((acc, d) => {
          acc[d.name] = (d.timeGrains || []).filter((g) => g.ok).map((g) => g.grain);
          return acc;
        }, {}),
        notes: ((r && r.notes) || []).slice(0, 5),
        fullSavedAs: (saved && saved.filename) || null,
        saveOk: !!(saved && saved.ok),
        reason: (r && r.reason) || '',
      };
    }

    // ⭐⭐ 2026-09-17（Codex《0140矩阵复核与最终缺口》第 3 节第 2 条）：**提交前验证（DRYRUN）**。
    //
    // 与 START 的**唯一区别**：任务带 `dryRun: true` → content 侧跑完全部提交前门禁后**在 submit() 之前停止**。
    //   · 复用 `core.buildTaskCatalog`（**同一份任务构建代码**）→ 验证的就是真任务身份/真 extraFilters/真报表名；
    //   · **不建会话**（不调 buildSessionPlan、不写 session_manifest）、不提交、不导出、不点下载；
    //   · 全量证据落盘（回执只有 900 字符），文件名 `dryrun_<时刻>.json`。
    // 用途：既能在"不产生重复任务"的前提下证明某格的控件/指标/任务身份，也能在被怀疑失败前先验证一遍配置。
    case 'DRYRUN': {
      const tabId = Number(message.tabId || (message.config && message.config.ownerTabId));
      if (!tabId) return { ok: false, error: '缺少标签页' };
      await assertAllowedTab(tabId);
      const cfg = message.config || {};
      let tasks;
      try {
        // 与建会话用**同一个入口**（故意不复制一份参数拼装，避免两侧漂移）
        tasks = core.buildTaskCatalog({
          storeId: String(cfg.storeId || '').trim(),
          storeName: String(cfg.storeName || '').trim(),
          granularity: cfg.granularity || '店铺',
          timeGrain: String(cfg.timeGrain || '').trim(),
          startDate: cfg.startDate,
          endDate: cfg.endDate,
          dimensionNames: Array.isArray(cfg.dimensions) ? cfg.dimensions.slice() : [],
          batch: cfg.batch,
          chunkUnit: cfg.chunkUnit,
          extraFilterValues: cfg.extraFilterValues,
        });
      } catch (error) {
        return { ok: false, error: String(error && error.message || error), stages: 'build_task_catalog' };
      }
      if (tasks.length !== 1) {
        return {
          ok: false,
          error: `DRYRUN 只支持一次验证 1 个任务（本次构出 ${tasks.length} 个：请把区间收窄到单分片或只给 1 个维度）`,
          taskCount: tasks.length,
        };
      }
      await ensureTabForeground(tabId);
      const one = Object.assign({}, tasks[0], { dryRun: true, timeoutMs: Number(cfg.dryRunTimeoutMs || 90000) });
      const r = await sendToPage(tabId, { type: 'SR_EXECUTE_TASK', task: one });
      const stamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
      let saved = null;
      try {
        saved = await chrome.tabs.sendMessage(tabId, {
          type: 'SR_SAVE_JSON',
          filename: `dryrun_${stamp}.json`,
          json: JSON.stringify(r || {}, null, 1),
        }, { frameId: (await getFormFrame(tabId) || {}).frameId });
      } catch (error) {
        saved = { ok: false, reason: String(error && error.message || error) };
      }
      const dr = (r && r.dryRun) || null;
      return {
        ok: !!(r && r.ok) && !!(dr && dr.stage !== 'failed'),
        probe: 'DRYRUN',
        stage: (r && r.stage) || null,
        reason: (r && r.reason) || '',
        note: dr ? dr.note : null,
        taskKey: dr && dr.task ? dr.task.key : one.key,
        stoppedBeforeSubmit: !!(r && r.stage === 'dry_run_stopped_before_submit'),
        metricTotal: dr && dr.page && dr.page.metrics ? dr.page.metrics.total : null,
        metricSelected: dr && dr.page && dr.page.metrics ? dr.page.metrics.selected : null,
        expectedMetricCount: one.expectedMetricCount == null ? null : Number(one.expectedMetricCount),
        terminalTypeApplicable: dr && dr.page && dr.page.terminalType ? dr.page.terminalType.applicable : null,
        extraFiltersOnPage: dr && dr.page ? Object.keys(dr.page.extraFiltersOnPage || {}) : [],
        gatesPassed: dr ? (dr.gatesPassedBeforeStop || []).length : null,
        gateFailures: dr ? (dr.gateFailuresBeforeStop || []) : null,
        fullSavedAs: (saved && saved.filename) || null,
        saveOk: !!(saved && saved.ok),
      };
    }

    // ⭐ 2026-09-17（UI 改版）：打开整页工作台。用途：
    //   ① 用户从任何地方一键进入（可收藏 `…&sr_action=WORKSPACE&sr_page=history`）；
    //   ② **自动化验证**：`chrome-extension://` 页面**不能**被其它扩展/网页导航打开
    //      （实测 "Cannot access a chrome-extension:// URL of different extension"），
    //      所以只能用"扩展自己开自己"这条路 —— 有了它，桥才能把工作台摆在屏幕上让人（或截图）复核。
    //   `sr_page` 可选：new（默认）/ progress / history，非法值忽略。
    case 'WORKSPACE': {
      const wanted = String((message.config && message.config.page) || '').trim();
      const page = ['new', 'progress', 'history'].includes(wanted) ? wanted : 'new';
      const url = chrome.runtime.getURL(`app.html${page === 'new' ? '' : `?page=${page}`}`);
      const existing = await chrome.tabs.query({ url: chrome.runtime.getURL('app.html*') });
      if (existing && existing.length) {
        await chrome.tabs.update(existing[0].id, { active: true, url });
        return { ok: true, reused: true, tabId: existing[0].id, page };
      }
      const tab = await chrome.tabs.create({ url });
      return { ok: true, reused: false, tabId: tab && tab.id, page };
    }

    // ⭐ 只读证据探针（2026-09-15，Codex r4 的 P1）：读当前页面的终端类型与各维度额外筛选控件的
    //    **当前值 + 可见选项**，并留证（pageUrl / capturedAt / evidenceSource）。
    //    **只读**：不提交任务、不建采集会话、不下载产物；结果落 JSON（回执有 900 字符硬上限）。
    case 'READONLY_FILTERS': {
      const tabId = Number(message.tabId || (message.config && message.config.ownerTabId));
      if (!tabId) return { ok: false, error: '缺少标签页' };
      await assertAllowedTab(tabId);
      const cfg = message.config || {};
      const granularity = String(cfg.granularity || '店铺');
      await ensureTabForeground(tabId);
      const r = await sendToPage(tabId, {
        type: 'SR_READONLY_FILTERS', granularity, dimensions: cfg.dimensions || null,
        grain: cfg.grain || null,   // 2026-09-16：可选，指定时间粒度后再读控件
        // ⭐ 2026-09-17：可选**逐时间粒度**读（`sr_grains=分日,分周,分月,汇总`）
        grains: Array.isArray(cfg.grains) && cfg.grains.length ? cfg.grains : null,
      });
      const stamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
      let saved = null;
      try {
        saved = await chrome.tabs.sendMessage(tabId, {
          type: 'SR_SAVE_JSON',
          filename: `readonly_filters_${granularity}_${stamp}.json`,
          json: JSON.stringify(r || {}, null, 1),
        }, { frameId: (await getFormFrame(tabId) || {}).frameId });
      } catch (error) {
        saved = { ok: false, reason: String(error && error.message || error) };
      }
      const dims = Object.keys((r && r.extraFilters) || {});
      return {
        ok: !!(r && r.ok),
        probe: 'READONLY_FILTERS',
        capturedAt: (r && r.capturedAt) || null,
        pageUrl: (r && r.pageUrl) || null,
        evidenceSource: (r && r.evidenceSource) || null,
        scopesHonesty: (r && r.scopesHonesty) || null,
        terminalType: (r && r.terminalType) || null,
        radios: (r && r.radios) || {},
        dimensionsRead: dims.length,
        // ⭐ 2026-09-17：读数有效性必须报到回执里（回执有 900 字符上限，只报摘要）
        grainsRequested: (r && r.grainsRequested) || null,
        readValid: !!(r && r.readValid),
        readValidityNote: (r && r.readValidityNote) || null,
        entriesValid: r && r.entriesValid,
        entriesTotal: r && r.entriesTotal,
        perDimensionValidity: dims.map((d) => {
          const e = (r.extraFilters || {})[d] || {};
          // 紧凑：`{ 分日: '终端类型,类目', 汇总: '(无)' }`（回执只有 900 字符，细节在落盘 JSON 里）
          const byGrain = {};
          for (const [g, rec] of Object.entries(e.grainReadings || {})) {
            byGrain[g] = (rec.controlsFound || []).join(',') || '(无)';
          }
          return { dimension: d, readValid: !!e.readValid, grains: byGrain };
        }),
        fullSavedAs: (saved && saved.filename) || null,
        saveOk: !!(saved && saved.ok),
        notes: ((r && r.notes) || []).slice(0, 5),
      };
    }

    // ⭐ 只读形态探针（2026-09-15 M1 排障）：报告「商品 × 指定粒度」下时间周期控件的真实形态。
    //    只读：不提交、不建会话、不下载；结果落 JSON。
    case 'GRAIN_SHAPE': {
      const tabId = Number(message.tabId || (message.config && message.config.ownerTabId));
      if (!tabId) return { ok: false, error: '缺少标签页' };
      await assertAllowedTab(tabId);
      const cfg = message.config || {};
      await ensureTabForeground(tabId);
      const r = await sendToPage(tabId, {
        type: 'SR_GRAIN_SHAPE',
        granularity: cfg.granularity || '商品',
        dimension: cfg.dimension || 'SKU',
        grain: cfg.grain || '分月',
      });
      const stamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
      let saved = null;
      try {
        saved = await chrome.tabs.sendMessage(tabId, {
          type: 'SR_SAVE_JSON',
          filename: `grain_shape_${cfg.granularity || '商品'}_${stamp}.json`,
          json: JSON.stringify(r || {}, null, 1),
        }, { frameId: (await getFormFrame(tabId) || {}).frameId });
      } catch (error) {
        saved = { ok: false, reason: String(error && error.message || error) };
      }
      const af = (r && r.afterGrain) || {};
      return {
        ok: !!(r && r.ok),
        probe: 'GRAIN_SHAPE',
        granularity: cfg.granularity || '商品', dimension: cfg.dimension || 'SKU', grain: cfg.grain || '分月',
        grainRadioCurrentAfter: af.grainRadioCurrent,
        placeholders: af.placeholders,
        expectedMonthPlaceholder: af.expectedMonthPlaceholder,
        monthCellSamples: af.monthCells,
        dayCellCount: af.dayCells,
        fullSavedAs: (saved && saved.filename) || null,
        saveOk: !!(saved && saved.ok),
        stepsCount: ((r && r.steps) || []).length,
        notes: ((r && r.notes) || []).slice(0, 4),
      };
    }

    case 'PREFLIGHT': {
      // 深链接入口（content.js）只带 `config.ownerTabId`，不带 `tabId`；
      // 这里必须接受两者，否则**无法远程做预检诊断**（实机排障时踩到过：返回"缺少标签页"）。
      const tabId = Number(message.tabId || (message.config && message.config.ownerTabId));
      if (!tabId) return { ok: false, error: '缺少标签页' };
      await assertAllowedTab(tabId);
      const result = await sendToPage(tabId, { type: 'SR_PREFLIGHT' });
      return {
        ok: !!(result && result.ok),
        gate: (result && result.gate) || null,
        required: (result && result.required) || null,
        page: (result && result.state) || null,
        reason: (result && result.reason) || '',
      };
    }

    case 'START': {
      return await startSessionFromConfig(message.config || {}, Number((message.config || {}).ownerTabId || message.tabId));
    }

    // ================================================================
    // ⭐ 2026-09-18 新增：**取数队列**（用户需求："在界面上新建多个任务，按新建顺序排队执行"）
    //
    // 为什么要它：引擎本来就能在一个会话内跑很多任务（勾多个维度 × 时间分片），但那是**一份配置**；
    // 用户要的是"建好几条不同配置的任务，排成队依次跑"。
    // 队列项 = 一份完整的 START 配置 + 加入时的计划预览（留证）；执行顺序 = 队列数组顺序（= 加入顺序，可手动调序）。
    //
    // 设计要点（每条都有踩坑理由）：
    //   ① 队列项**不预建会话**：真正开跑时才走 startSessionFromConfig（与会话语义完全一致，不搞第二套）。
    //   ② 引擎同一时刻只允许一个会话 → 执行器只在"当前会话进入终态"后启动下一项。
    //   ③ **失败不停队**：单项永久失败记 status='failed' + 原因，继续下一项；
    //      只有"前置条件不满足"（如仍存在未结束会话）才等待重试，免得把可恢复问题当永久失败丢掉。
    //   ④ **必须显式开跑**（QUEUE_RUN），不做"加入即自动跑"——安静跑批是事故来源。
    // ================================================================
    case 'QUEUE_ADD': {
      return await queueAdd(message.item || {});
    }
    case 'QUEUE_ADD_MANY': {
      return await queueAddMany(message.items);
    }
    case 'QUEUE_REQUEUE_FAILED': {
      return await queueRequeueFailed(message.itemId, message.ownerTabId);
    }
    case 'QUEUE_REMOVE': {
      return await queueRemoveMany([message.itemId]);
    }
    case 'QUEUE_REMOVE_MANY': {
      return await queueRemoveMany(message.itemIds);
    }
    case 'QUEUE_MOVE': {
      const dir = message.dir === 'up' ? -1 : 1;
      return await queueMutate((q) => {
        const i = q.items.findIndex((x) => x.id === message.itemId);
        const j = i + dir;
        if (i < 0 || j < 0 || j >= q.items.length) return q;
        const items = q.items.slice();
        const tmp = items[i];
        items[i] = items[j];
        items[j] = tmp;
        q.items = items;
        return q;
      });
    }
    case 'QUEUE_CLEAR_FINISHED': {
      return await withStateLock(async () => {
        const q = await readQueue();
        if (q.running) return { ok: false, error: '请先停止后续队列，再清理成功记录' };
        const saved = await writeQueue({ ...q, items: q.items.filter((x) => x.status !== 'done') });
        return { ok: true, queue: queueView(saved) };
      });
    }
    case 'QUEUE_RUN': {
      const q = await readQueue();
      if (!q.items.some((x) => x.status === 'pending')) {
        return { ok: false, error: '队列里没有待执行的任务（先「加入队列」）' };
      }
      await writeQueue({ ...q, running: true, lastError: null, stoppedAt: null });
      const started = await maybeStartNextQueueItem('manual-run');
      return { ok: true, started: started || null, running: true };
    }
    case 'QUEUE_STATE': {
      // 只回队列（**轻量**）：STATE 的响应含 50 条会话索引、回执会被压成极简兜底而丢掉队列字段；
      // 外部（脚本/桥）要看队列就用这个动作。UI 仍走 STATE（它已经带 queue）。
      // ❗ 2026-09-22 追加 `activeSession`（Codex 复核提出的真问题）：外部没法读 chrome.storage，
      //    而磁盘上的旧 `session_manifest.json` **只能证明某个历史会话结束了**，
      //    证明不了"**此刻**没有会话在跑"（之后可能又启动了一个）。本动作是轻量通道，
      //    响应小 ⇒ 回执装得下，所以"活跃会话"摘要放这里（回执里会平铺成 `activeSession`）。
      const activeId = await getActiveSessionId();
      const activeRun = activeId ? await loadRun(activeId) : null;
      return {
        ok: true,
        // 头部标量也带上会话 id（回执里 `sessionId`/`sessionStatus` 就来自这里，外部一眼可判）
        sessionId: activeId || null,
        queue: queueView(await readQueue()),
        activeSession: activeRun ? activeSessionBrief(activeRun.meta, activeRun.tasks) : null,
      };
    }
    case 'QUEUE_STOP': {
      const q = await readQueue();
      await writeQueue({ ...q, running: false, stoppedAt: new Date().toISOString() });
      // 只停队列：**当前会话继续跑**（不擅自 END；要用 PAUSE/END 由用户自己决定）
      return { ok: true, running: false, note: '已停止队列：当前会话继续执行，其结束后不再自动开下一项' };
    }

    case 'PAUSE': {
      const sessionId = await getActiveSessionId();
      const run = sessionId ? await loadRun(sessionId) : null;
      if (!run) return { ok: false, error: '没有可暂停的会话' };
      const paused = metaWithSessionAction(run.meta, 'pause');
      await writeSessionMeta(paused);
      await chrome.alarms.clear(ALARM_TICK); // 当前任务做完后自然停下（在途任务不受影响）
      return { ok: true, status: paused.status, note: '将在当前任务完成后暂停' };
    }

    case 'RESUME': {
      const sessionId = await getActiveSessionId();
      const run = sessionId ? await loadRun(sessionId) : null;
      if (!run) return { ok: false, error: '没有可继续的会话' };
      if (run.meta.status !== 'paused') return { ok: false, error: `会话当前为 ${run.meta.status}，不能继续` };
      // 继续前校验店铺一致（页面店铺标识与冻结清单一致才允许续跑）
      const tabId = Number(message.tabId || run.meta.ownerTabId);
      try {
        await assertAllowedTab(tabId);
      } catch (error) {
        return { ok: false, error: `继续前校验失败：${error && error.message}` };
      }
      const ping = await sendToPage(tabId, { type: 'SR_PING' });
      if (!ping || !ping.ok) {
        return { ok: false, error: `继续前校验失败：取数表单 frame 无响应（${(ping && ping.reason) || '未知'}），请刷新页面` };
      }
      const pageState = ping.state || {};
      const pageStore = pageState.storeName || pageState.sourceStore || null;
      if (pageStore) {
        try {
          core.assertSameContext({ storeId: run.meta.storeId, storeName: run.meta.storeName }, { storeId: run.meta.storeId, storeName: pageStore });
        } catch (error) {
          return { ok: false, error: `继续前校验失败：${error && error.message}` };
        }
      }
      const resumed = metaWithSessionAction({ ...run.meta, ownerTabId: tabId }, 'resume');
      await writeSessionMeta(resumed);
      scheduleTick(0);
      return { ok: true, status: resumed.status, pageStoreVerified: !!pageStore };
    }

    case 'END': {
      const sessionId = await getActiveSessionId();
      const run = sessionId ? await loadRun(sessionId) : null;
      if (!run) return { ok: false, error: '没有可结束的会话' };
      // end 会把所有可作废任务置 ended（core 负责，本层不手写状态）
      const endedMeta = metaWithSessionAction(run.meta, 'end');
      const { tasks } = run;
      const endedTasks = tasks.map((task) => (core.canTransition(task.status, 'ended') ? core.transitionTask(task, 'ended') : task));
      const changed = endedTasks.filter((task, index) => task !== tasks[index]).map((task) => task.key);
      await writeTaskShards(sessionId, endedTasks, changed);
      const closure = core.validateClosure({ ...endedMeta, tasks: endedTasks });
      const finalMeta = await writeSessionMeta({ ...endedMeta, activeTaskKey: null, expectedDownload: null, lastClosure: summarizeClosure(closure) });
      await clearAlarms();
      let artifactRoot = null;
      let artifactDegraded = false;
      try {
        const artifacts = await writeSessionArtifacts({ ...finalMeta, tasks: endedTasks }, closure, { tabId: finalMeta.ownerTabId });
        artifactRoot = artifacts.root;
        artifactDegraded = !!(artifacts.manifestWrite.degraded || artifacts.logWrite.degraded);
      } catch (error) {
        await recordSessionError(sessionId, `清单落盘失败：${error && error.message}`);
      }
      // ⭐ 队列钩子：手动「结束会话」也是会话终态 → 一样要结算队列项并决定是否开下一项
      await onSessionFinished(finalMeta, closure);
      return { ok: true, status: finalMeta.status, gapCount: closure.gaps.length, artifactRoot, artifactDegraded };
    }

    case 'RETRY_FAILED': {
      const sessionId = await getActiveSessionId();
      const run = sessionId ? await loadRun(sessionId) : null;
      if (!run) return { ok: false, error: '没有可重试的会话' };
      const { meta, tasks } = run;
      if (['completed', 'ended'].includes(meta.status)) return { ok: false, error: `会话已 ${meta.status}，不能再重试` };
      const activeTask = tasks.find(task => task.key === meta.activeTaskKey);
      if (!['paused', 'error'].includes(meta.status) || (activeTask &&
          ['navigating', 'ready', 'export_clicked', 'platform_processing', 'downloading', 'validating'].includes(activeTask.status))) {
        return { ok: false, error: '请先暂停并等待当前报表结束，再重试失败报表' };
      }
      // failed_permanent 是终态：重试需要**显式重建尝试预算**，这里单独放行并记录
      const retryable = tasks.filter((task) => task.status === 'failed_permanent' || task.status === 'error' || task.status === 'retry_wait' || task.status === 'delayed');
      if (retryable.length === 0) return { ok: false, error: '没有失败项需要重试' };
      const nextTasks = tasks.map((task) => {
        if (!retryable.includes(task)) return task;
        if (task.status === 'failed_permanent' || task.status === 'delayed') {
          // 显式复活：清空 attempts 预算，回到 pending（用户主动决定，不是静默跳过）
          return { ...task, status: 'pending', attempts: 0, error: null, earliestNextAt: null, retriedAt: new Date().toISOString() };
        }
        return core.canTransition(task.status, 'pending') ? core.transitionTask(task, 'pending') : task;
      });
      const changed = nextTasks.filter((task, index) => task !== tasks[index]).map((task) => task.key);
      await writeTaskShards(sessionId, nextTasks, changed);
      const revived = { ...meta, status: meta.status === 'error' ? 'running' : meta.status, lastError: null };
      const promotable = meta.status === 'error' ? metaWithSessionAction(meta, 'start') : revived;
      await writeSessionMeta({ ...promotable, activeTaskKey: null, expectedDownload: null });
      if (promotable.status === 'running') scheduleTick(0);
      return { ok: true, retried: changed.length, status: promotable.status };
    }

    case 'EXPORT_DIAGNOSTICS': {
      const sessionId = await getActiveSessionId();
      const run = sessionId ? await loadRun(sessionId) : null;
      const view = run ? sessionView(run.meta, run.tasks) : null;
      const diagnostics = {
        generatedAt: new Date().toISOString(),
        scheduleVersion: VERSION,
        extension: { name: chrome.runtime.getManifest().name, version: VERSION },
        selectors: {
          host: SR.PAGE.host,
          shellPath: SR.PAGE.shellPath,
          formFramePath: SR.PAGE.formFramePath,
          dimensionCount: SR.DIMENSIONS_STORE.length,
          timeGrainByGranularity: SR.TIME_GRAIN_BY_GRANULARITY,
        },
        constants: {
          maxAttempts: core.MAX_ATTEMPTS,
          retryBaseDelayMs: core.RETRY_BASE_DELAY_MS,
          retryMaxDelayMs: core.RETRY_MAX_DELAY_MS,
          minTaskIntervalMs: core.MIN_TASK_INTERVAL_MS,
          downloadWindowMs: DOWNLOAD_WINDOW_MS,
        },
        session: view,
        tasks: run ? run.tasks.map(taskRecord) : [],
      };
      const rel = run
        ? `${sessionArtifactRoot(run.meta)}diagnostics_${run.meta.sessionId}.json`
        : `${ARCHIVE_ROOT}/diagnostics/diagnostics_${Date.now()}.json`;
      // 与 manifest/log 同一条投递路径：优先页面上下文，失败才 data: URL 兜底（只落一次）
      const write = await deliverJsonArtifact({
        sessionId: run ? run.meta.sessionId : null,
        kind: 'diagnostics',
        tabId: run && run.meta.ownerTabId != null ? Number(run.meta.ownerTabId) : (message.tabId != null ? Number(message.tabId) : null),
        relativePath: rel,
        contentBuilder: (deliveryMethod) => {
          diagnostics.artifact = {
            kind: 'diagnostics',
            expectedArchivePath: rel,
            requestedFilename: basenameOf(rel),
            deliveryMethod: deliveryMethod || null,
            renamedBy: null,
            note: '最终路径由下载接管决定，见会话诊断事件/会话 meta 的 artifact 观测',
          };
          return diagnostics;
        },
      });
      return {
        ok: true,
        downloadId: write.downloadId,
        path: write.relativePath,
        requestedPath: rel,
        deliveryMethod: write.deliveryMethod,
        degraded: !!write.degraded,
      };
    }

    // 排障探针：直接回答两个只能靠实机确认的问题——
    //   ① 扩展自发的 data: URL 下载，Chrome 到底采不采纳 `filename`？
    //   ② 这种下载到底会不会触发 onDeterminingFilename（决定能否自动重命名进归档）？
    // 只写一个探针文件并**立即清理**，不触碰任何业务数据、不产生网络请求。
    case 'DOWNLOAD_PROBE': {
      const probeRelative = `${ARCHIVE_ROOT}/_probe/download_probe.json`;
      const target = toDownloadPath(probeRelative);
      const probeUrl = `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify({
        probe: 'download-route',
        at: new Date().toISOString(),
        version: VERSION,
      }, null, 2))}`;
      let probeId = null;
      let probeError = null;
      // 先把探针登记成"在途产物"，这样下载接管里"Chrome 默认名 + 唯一在途 arm → 认领改名"
      // 这条新逻辑会被真实走一遍（否则探针只能证明文件名被忽略，证明不了改名有效）。
      await armExpectedArtifact({
        kind: 'download_probe',
        filename: 'download_probe.json',
        relativePath: probeRelative,
        deliveryMethod: 'probe',
      });
      try {
        probeId = await chrome.downloads.download({ url: probeUrl, filename: target, conflictAction: 'overwrite', saveAs: false });
      } catch (error) {
        probeError = String((error && error.message) || error);
      }
      if (probeId != null) artifactDownloadIds.add(probeId);
      // 固定等待：留出接管事件 + 文件落盘的时间（无随机抖动）
      await new Promise((resolve) => setTimeout(resolve, 2500));
      let item = null;
      try {
        const found = probeId == null ? [] : await chrome.downloads.search({ id: probeId });
        item = (found && found[0]) || null;
      } catch (error) {
        probeError = probeError || String((error && error.message) || error);
      }
      const observation = item ? {
        id: item.id,
        state: item.state,
        filename: item.filename,
        bytes: item.bytesReceived,
        scheme: String(item.finalUrl || item.url || '').split(':')[0],
        error: item.error || null,
      } : null;
      const takeover = takeoverLog.filter((entry) => entry.id === probeId)
        .map((entry) => ({ filename: entry.filename, scheme: entry.scheme, decision: entry.decision }));
      // 清理：删文件 + 抹掉下载记录，探针不留痕
      if (item) {
        try { await chrome.downloads.removeFile(probeId); } catch (ignored) { /* 文件可能尚未落盘 */ }
        try { await chrome.downloads.erase({ id: probeId }); } catch (ignored) { /* 忽略 */ }
      }
      artifactDownloadIds.delete(probeId);
      await clearExpectedArtifact('探针结束', 'download_probe.json').catch(() => undefined);
      return {
        ok: true,
        probe: {
          requestedUrlScheme: 'data',
          requestedFilename: target,
          downloadId: probeId,
          error: probeError,
          observation,
          takeover,
          takeoverFired: takeover.length > 0,
          honoredFilename: !!(observation && basenameOf(observation.filename) === basenameOf(target)),
          recentTakeover: takeoverLog.slice(-6).map((entry) => ({
            id: entry.id, filename: entry.filename, scheme: entry.scheme, decision: entry.decision,
          })),
        },
      };
    }

    // 排障探针：立即对当前结果视图发一次"下载催单"，用来**随时验证催单通路**
    // （催单只在"等下载超过 60 秒"时才会自动触发，平时难以观察到）。
    // 只点一次「下载报表」，不碰任何数据、不重复提交。
    case 'NUDGE_PROBE': {
      const tabId = Number(message.tabId || (message.config && message.config.ownerTabId));
      if (!tabId) return { ok: false, error: '缺少标签页' };
      // 必须先等表单 frame 自报（与任务路径一致）：深链接刚打开的新页面里，
      // 表单 frame 往往还没就绪，直接发消息只会得到"只有非表单 frame 应答"（实测踩到过）。
      const ready = await waitForFormFrame(tabId, FORM_FRAME_WAIT_MS);
      if (!ready.ok) return { ok: false, error: `表单 frame 未就绪：${ready.reason}`, waitedMs: ready.waitedMs };
      const res = await sendToPage(tabId, { type: 'SR_NUDGE_DOWNLOAD' });
      return {
        ok: !!(res && res.ok),
        frameId: ready.frameId,
        waitedMs: ready.waitedMs,
        nudge: (res && res.ok) ? { clickedAt: res.clickedAt || null } : { reason: (res && res.reason) || '页面无应答' },
        tabId,
      };
    }

    // 排障探针：**显式再收尾一次当前会话**，用来确定地验证"收尾幂等"是否生效。
    // 期望：已 completed 的会话被守卫拦下（skipped），不再重复投递 manifest/log。
    case 'COMPLETE_PROBE': {
      const sessionId = await getActiveSessionId();
      if (!sessionId) return { ok: false, error: '没有活跃会话' };
      const before = await readSessionMeta(sessionId);
      const result = await completeSession(sessionId);
      return {
        ok: true,
        sessionId,
        statusBefore: before ? before.status : null,
        artifactsDeliveredAt: before ? (before.artifactsDeliveredAt || null) : null,
        completedAgain: !!result,
        note: result
          ? '⚠️ 收尾被再次执行（幂等守卫未生效，会重复投递产物）'
          : '✅ 收尾被幂等守卫拦下（未重复投递产物）',
      };
    }

    // 排障探针：**测量 chrome.alarms 的实际触发时刻**。
    //
    // 为什么需要（HANDOFF §3 第 12 条，2026-09-14 未定论）：
    //   下载催单的检查点由 `chrome.alarms` 挂 `when: now + DOWNLOAD_NUDGE_AFTER_MS` 驱动；
    //   把阈值临时压到 1~8 秒做催单验证时，四次专测都是 `nudges=0 / nudgeChecks=0`，
    //   但**这两个数字无法区分**"闹钟没按点触发"与"闹钟触发时任务已完成（文件已落盘）"。
    //   本探针把"约定时刻 / 实际触发时刻 / 偏差"三者直接写下来，一次调用就能分辨。
    //
    // 用法：`…datafetch/create?sr_autorun=1&sr_action=ALARM_PROBE&sr_delay=2000`
    //   第一次调用 → 挂钟并返回 armed=true；再次调用 → 返回实际触发时刻与偏差 deltaMs。
    //   记录写进 chrome.storage.local（SW 可能在两次调用之间被回收，不能只放内存）。
    case 'ALARM_PROBE': {
      const requested = Number(message.probeDelayMs || (message.config && message.config.probeDelayMs) || 2000);
      const delayMs = Math.max(0, Number.isFinite(requested) ? requested : 2000);
      const lastTaskAlarm = await readTaskAlarmFire();
      const nudgeTrace = await readNudgeTrace();
      const previous = await readAlarmProbe();
      if (previous && previous.firedAt) {
        return {
          ok: true,
          done: true,
          ...previous,
          lastTaskAlarmFire: lastTaskAlarm,
          nudgeTrace,
          note: '上一次探针的实测结果（再次调用此动作不会重新挂钟，可反复读）',
        };
      }
      const armedAt = Date.now();
      const record = {
        delayMs,
        armedAt: new Date(armedAt).toISOString(),
        expectedAt: new Date(armedAt + delayMs).toISOString(),
        firedAt: null,
        deltaMs: null,
        firedScheduledTime: null,
        version: VERSION,
      };
      await writeAlarmProbe(record);
      chrome.alarms.create(ALARM_PROBE_NAME, { when: armedAt + delayMs });
      return {
        ok: true,
        armed: true,
        done: false,
        ...record,
        lastTaskAlarmFire: lastTaskAlarm,
        note: `已挂 ${delayMs} 毫秒后触发的闹钟；再次调用本动作（同一深链接）即可读回实际触发时刻与偏差`,
      };
    }

    // 排障探针：只回**催单分支的执行轨迹**（末 6 条，字段压缩）。
    // 为什么单独一个动作：深链接结果属性有 900 字符上限，混在大响应里会被截断（实测）。
    case 'NUDGE_TRACE': {
      const trace = await readNudgeTrace();
      const fires = await readTaskAlarmFire();
      // 深链接结果属性只有 900 字符：只回"阶段时间线 + 最后一条全文"，其余一律压缩
      const stages = trace.slice(-6).map((t) => `${String(t.at || '').slice(11, 19)} ${t.stage}`
        + (t.ok === undefined || t.ok === null ? '' : (t.ok ? '(ok)' : '(fail)'))
        + (t.status ? `[${t.status}]` : ''));
      const withProbe = trace.slice().reverse().find((t) => t.lastProbe || t.rememberedFrameId) || null;
      const last = trace[trace.length - 1] || null;
      return {
        ok: true,
        total: trace.length,
        stages,
        last: last ? {
          at: String(last.at || '').slice(11, 19),
          stage: last.stage,
          ok: last.ok === undefined ? null : last.ok,
          waitedMs: last.waitedMs === undefined ? null : last.waitedMs,
          source: last.source || null,
          reason: String(last.reason || '').slice(0, 120) || null,
          lastProbe: withProbe ? withProbe.lastProbe : null,
          rememberedFrameId: withProbe && withProbe.rememberedFrameId !== undefined ? withProbe.rememberedFrameId : null,
          probeCount: withProbe && withProbe.probeCount !== undefined ? withProbe.probeCount : null,
        } : null,
        lastFires: ((fires && fires.fires) || []).slice(-1).map((f) => ({
          at: String(f.firedAt || '').slice(11, 19), deltaMs: f.deltaMs, sessionStatus: f.sessionStatus, taskStatus: f.taskStatus || null,
        })),
      };
    }

    // 自动化/开发迭代用：让扩展重新从磁盘加载（等价于点扩展页的「重新加载」）。
    // 仅在显式 sr_action=RELOAD 时触发（见 content.js 的深链接入口）；
    // reload 会断开消息通道，因此先回包、再延时重载。
    case 'RELOAD': {
      setTimeout(() => { try { chrome.runtime.reload(); } catch (error) { /* 忽略 */ } }, 300);
      return { ok: true, reloading: true, version: VERSION };
    }

    default:
      return { ok: false, error: `未知操作：${action}` };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return false;

  if (message.type === 'SR_CHECK_SHELL_POPUPS') {
    (async () => {
      const sessionId = await getActiveSessionId();
      const meta = sessionId && await readSessionMeta(sessionId);
      const tabId = sender && sender.tab && sender.tab.id;
      if (!meta || tabId !== meta.ownerTabId || !meta.activeTaskKey) {
        return { ok: false, reason: '[弹窗阻挡]当前页面不属于执行中的任务' };
      }
      const result = await chrome.tabs.sendMessage(tabId, { type: 'SR_DISMISS_NOTICES' }, { frameId: 0 });
      const titles = [...(Array.isArray(message.localClosed) ? message.localClosed : []),
        ...(result && Array.isArray(result.closed) ? result.closed : [])].slice(0, 20);
      if (titles.length) {
        await recordDiagnostic(sessionId, 'notice_popup_dismissed', { titles }, meta.activeTaskKey);
      }
      return result;
    })().then(sendResponse).catch(error => sendResponse({ ok: false, popupBlocked: true,
      reason: `[弹窗阻挡]无法检查外层页面：${error.message}` }));
    return true;
  }

  // 表单 frame 自报（content.js 加载后主动上报）。
  // ⚠️ 必须放在 SRUI_COMMAND 分支**之前**，且**不受版本校验影响**：
  //    它是调度层能定向发送的唯一依据，被版本校验拦掉就等于退回"广播抢不过外壳 frame"的老问题。
  if (message.type === 'SR_FORM_FRAME_HELLO') {
    const { tabId, frameId } = senderFrameInfo(sender);
    if (tabId == null || frameId == null) {
      sendResponse({ ok: false, registered: false, error: '自报缺少 sender.tab.id / frameId' });
      return false;
    }
    registerFormFrame(tabId, frameId, message.path)
      .then(() => sendResponse({ ok: true, registered: true, tabId, frameId, version: VERSION }))
      .catch((error) => sendResponse({ ok: false, registered: false, error: String(error && error.message || error) }));
    return true; // 异步响应
  }

  // 自动化/深链接入口用：让页面侧拿到自己的 tabId。
  // 只回给扩展自身的 content script（sender.tab 存在），不对外暴露任何数据。
  if (message.type === 'SR_TAB_ID') {
    sendResponse({
      ok: true,
      tabId: sender && sender.tab ? sender.tab.id : null,
      frameId: sender ? sender.frameId : null,
      version: VERSION,
    });
    return false;
  }

  if (message.type !== 'SRUI_COMMAND') return false; // content.js 的 SR_* 消息与本层无关
  const clientVersion = message.clientVersion || null;
  if (clientVersion && clientVersion !== VERSION) {
    sendResponse({
      ok: false,
      version: VERSION,
      versionMismatch: true,
      error: `版本不一致：面板 ${clientVersion}，后台 ${VERSION}。请在扩展程序页重新加载扩展后重开面板`,
    });
    return false;
  }
  handleUiMessage(message)
    .then((payload) => sendResponse({ ...payload, version: VERSION }))
    .catch(async (error) => {
      const reason = String(error && error.message || error);
      try {
        const sessionId = await getActiveSessionId();
        if (sessionId) await recordSessionError(sessionId, reason);
      } catch (ignored) { /* 记录失败不影响回包 */ }
      sendResponse({ ok: false, version: VERSION, error: reason });
    });
  return true; // 异步响应
});

// ==================================================================================
// 13. 启动：注册事件监听（必须在顶层同步注册，否则 SW 冷启动后收不到事件）
// ==================================================================================

registerDownloadListeners();
registerLifecycleListeners();

// 冷启动时做一次温和恢复：只补闹钟，绝不重复点击下载
rearmTimersIfNeeded().catch(() => undefined);
