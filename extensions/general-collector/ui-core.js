/**
 * ui-core.js —— 面板(popup) 与 工作台(app) **共用**的 UI 逻辑层。
 *
 * 为什么要有这一层（2026-09-17 改版）：
 *   新版 UI 分成了「扩展图标 → 极简入口」和「整页工作台」两个界面。如果各自复制一份
 *   维度联动/计划预览/参数校验/后台调用，两侧必然漂移 —— 本项目最贵的一课就是
 *   「同一份事实写两处，最后不知道哪份是真的」。所以**唯一来源**是：
 *     · 页面知识（维度/指标数/合法粒度/列数）→ `selectors.js` + `core.js`（本文件只调用，不复制）
 *     · 与后台通信/参数装配/校验 → **本文件**（popup.js 与 app.js 都只调用，不再各写一份）
 *
 * 安全边界（`scripts/security_scan.ps1` 会静态扫描本文件）：
 *   不发任何网络请求、不读 Cookie/凭证、不用动态代码求值、不做反检测、不用随机化、不碰 CDP 调试。
 *   ⚠️ 连**注释里**也不要出现那几条被禁的写法：扫描器是"按行正则"，**不区分注释与代码** ——
 *      本文件第一版就是因为在注释里写了被禁函数名被扫出一条命中（实测踩到）。
 */
'use strict';

(function () {
  const core = globalThis.SRCore;
  const SR = globalThis.SR;

  /** UI 侧版本：取自页面 `<meta name="sr-version">`，与 manifest.json 的 version 三处对齐校验（见 run_tests.ps1） */
  const VERSION = ((document.querySelector('meta[name="sr-version"]') || {}).content || '').trim();

  /** 单次后台调用的超时兜底（毫秒） */
  const CALL_TIMEOUT_MS = 20000;
  /** 生参取数页的匹配前缀（用于在工作台里找目标标签页；host_permissions 已覆盖该域） */
  const SYCM_TAB_PATTERN = 'https://sycm.taobao.com/*';

  const SESSION_STATUS_TEXT = {
    ready: '已就绪（未开始）',
    discovering: '探测中',
    running: '运行中',
    paused: '已暂停',
    completed: '已完成',
    error: '出错（可继续或结束）',
    ended: '已结束',
  };

  /** 分片单位的中文口径（只显示；语义在 core.CHUNK_UNITS） */
  const CHUNK_UNIT_TEXT = { month: '按自然月', week: '按周', day: '按天', none: '不切' };

  // ==================================================================================
  // 1. 与 background 通信（统一 SRUI_COMMAND + 版本握手）
  // ==================================================================================

  /** 握手状态；不一致时调用方必须**禁用全部操作**（防"改了没生效却当成 bug"） */
  const handshake = { ok: false, reason: '尚未握手', backgroundVersion: null };
  const handshakeListeners = [];

  function onHandshake(cb) {
    if (typeof cb === 'function') handshakeListeners.push(cb);
  }

  function emitHandshake() {
    for (const cb of handshakeListeners) {
      try { cb({ ...handshake }); } catch (error) { /* 监听方自己吞错，不影响通信 */ }
    }
  }

  function callBackground(action, payload) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        if (value && !value.ok && /Receiving end does not exist|Could not establish connection|Extension context invalidated/i.test(value.error || value.reason || '')) {
          value = { ...value, error: '未连接到生参页面脚本（不是标签页数量问题）。扩展重新加载后，旧生参页不会自动重新挂载脚本。请点击「修复连接」刷新目标页，加载完成后再核验；若仍失败，请检查此扩展的生参网站访问权限。', reason: value.error || value.reason };
        }
        resolve(value);
      };
      setTimeout(() => finish({ ok: false, error: `后台无响应（超过 ${CALL_TIMEOUT_MS / 1000} 秒）` }), CALL_TIMEOUT_MS);
      try {
        chrome.runtime.sendMessage(
          { type: 'SRUI_COMMAND', action, clientVersion: VERSION, ...(payload || {}) },
          (response) => {
            const lastErr = chrome.runtime.lastError;
            if (lastErr) { finish({ ok: false, error: `后台不可达：${lastErr.message}` }); return; }
            finish(response || { ok: false, error: '后台返回空响应' });
          },
        );
      } catch (error) {
        finish({ ok: false, error: `调用后台失败：${error && error.message}` });
      }
    });
  }

  /** 统一入口：任何后台响应都要过版本握手 */
  async function call(action, payload) {
    const response = await callBackground(action, payload);
    const bgVersion = response && response.version ? String(response.version) : null;
    if (bgVersion && bgVersion !== VERSION) {
      handshake.ok = false;
      handshake.backgroundVersion = bgVersion;
      handshake.reason = `版本不一致：界面 ${VERSION}，后台 ${bgVersion}`;
      emitHandshake();
      return { ok: false, error: `${handshake.reason}。请在扩展程序页重新加载扩展后重开界面` };
    }
    if (response && response.versionMismatch) {
      handshake.ok = false;
      handshake.backgroundVersion = bgVersion;
      handshake.reason = response.error || '版本不一致';
      emitHandshake();
      return response;
    }
    if (bgVersion && bgVersion === VERSION) {
      handshake.ok = true;
      handshake.backgroundVersion = bgVersion;
      handshake.reason = '';
      emitHandshake();
    }
    return response;
  }

  // ==================================================================================
  // 2. 页面知识（维度 / 合法粒度 / 指标数）——**全部来自 core，不复制一份**
  // ==================================================================================

  /** 该「数据粒度」下的维度名（未实采 → []，由 UI 禁用并说明） */
  function dimensionNamesFor(granularity) {
    if (granularity === '全部') return granularities().flatMap(g => dimensionNamesFor(g).map(n => `${g} / ${n}`));
    try {
      const list = core.dimensionTable(granularity);
      return Array.isArray(list) ? list.map((item) => item.name) : [];
    } catch (error) {
      return [];
    }
  }

  /** 该粒度的合法时间粒度 = **各维度并集**（时间粒度是逐维度的，不是逐粒度的） */
  function legalGrainsFor(granularity) {
    if (granularity === '全部') return ['分日', '分月', '分周', '汇总'];
    const set = [];
    for (const name of dimensionNamesFor(granularity)) {
      let grains = [];
      try { grains = core.legalTimeGrains(name, granularity) || []; } catch (error) { grains = []; }
      for (const g of grains) if (!set.includes(g)) set.push(g);
    }
    const order = ['分小时', '分日', '分周', '分月', '汇总'];
    if (set.length) return set.slice().sort((a, b) => order.indexOf(a) - order.indexOf(b));
    return ((SR.TIME_GRAIN_BY_GRANULARITY || {})[granularity] || []).slice();
  }

  /**
   * 维度行（供列表渲染）：每行带「该维度自己的合法粒度」与「当前粒度下能不能选」。
   *   `usable=false` → 界面上禁用并标注「仅 分周」这类说明（与原型一致）。
   */
  function dimensionRows(granularity, grainNow) {
    if (granularity === '全部') return granularities().flatMap(g => dimensionRows(g, grainNow).map(row => ({ ...row, name: `${g} / ${row.name}` })));
    return dimensionNamesFor(granularity).map((name) => {
      let grains = [];
      try { grains = core.legalTimeGrains(name, granularity) || []; } catch (error) { grains = []; }
      let metricCount = null;
      try { metricCount = core.expectedMetricCount(name, granularity, grainNow); } catch (error) { metricCount = null; }
      return {
        name,
        grains,
        usable: !grainNow || (grainNow === 'TTL' ? ['分日', '分周', '分月'].some(g => grains.includes(g)) : grains.includes(grainNow)),
        metricCount,
        metricKnown: metricCount != null,
      };
    });
  }

  /** 维度清单里出现的「数据粒度」全集（唯一来源：SR.CONST.granularity） */
  function granularities() {
    return Object.values(SR.CONST.granularity);
  }

  // ==================================================================================
  // 3. 额外筛选值：解析 + 用 core 校验（错配在点开始之前就说清楚）
  // ==================================================================================

  /**
   * 解析 `维度.控件=值` 文本 → core 的 extraFilterValues 形状。
   * 多条用 `；` / `;` / 换行分隔；多选取值用 `+` 连接；`*.控件=值` = 对所有维度生效。
   * ⚠️ 这里**只做语法解析**：维度/控件是否合法交给 `core.normalizeExtraFilterValues`（唯一来源）。
   */
  function parseExtraFilterValues(text) {
    const out = {};
    const errors = [];
    const chunks = String(text || '').split(/[;\n；]/).map((s) => s.trim()).filter(Boolean);
    for (const chunk of chunks) {
      const eq = chunk.indexOf('=');
      if (eq <= 0) { errors.push(`缺少「=」：${chunk}`); continue; }
      const left = chunk.slice(0, eq).trim();
      const values = chunk.slice(eq + 1).split('+').map((v) => v.trim()).filter(Boolean);
      const dot = left.indexOf('.');
      if (dot <= 0 || dot === left.length - 1) { errors.push(`缺少「维度.控件」：${chunk}`); continue; }
      if (values.length === 0) { errors.push(`没有取值：${chunk}`); continue; }
      const dimKey = left.slice(0, dot).trim() === '*' ? '默认' : left.slice(0, dot).trim();
      const ctrl = left.slice(dot + 1).trim();
      if (!out[dimKey]) out[dimKey] = {};
      out[dimKey][ctrl] = (out[dimKey][ctrl] || []).concat(values);
    }
    return { ok: errors.length === 0, value: out, errors };
  }

  /** 用 core 的校验器预检额外筛选值 → { ok, reason }（ok 时 reason 是人话摘要） */
  function validateExtraFilterValues(raw, dimensions, granularity, timeGrain) {
    const names = Array.isArray(dimensions) && dimensions.length ? dimensions : ['整体'];
    const summary = [];
    try {
      for (const name of names) {
        const dimension = core.findDimension(name, granularity);
        // ⚠️ 必须传 timeGrain：控件**按时间粒度**解析（实测 品类/整体 汇总只剩「类目」）
        const values = core.normalizeExtraFilterValues(raw || {}, dimension, timeGrain);
        const keys = Object.keys(values);
        if (keys.length > 0) summary.push(`${dimension.name}: ${keys.map((k) => `${k}=${values[k].join('+')}`).join('、')}`);
      }
    } catch (error) {
      return { ok: false, reason: String((error && error.message) || error) };
    }
    return { ok: true, reason: summary.join('；') };
  }

  // ==================================================================================
  // 4. 配置装配 + 计划预览（与 background 共用 core.buildTaskCatalog 的同一套规则）
  // ==================================================================================

  function toInt(value, fallback) {
    const num = Number(value);
    return Number.isFinite(num) && num > 0 ? Math.floor(num) : fallback;
  }

  /**
   * ⭐ 2026-09-20：**切片单位与时间粒度口径的一致性**（与 `core.buildTaskCatalog` 的硬门禁同源）。
   *
   * 为什么需要它：界面上「分片单位」是一个下拉框，用户完全可能给「分月」选"按周"、给「分周」选"按天"。
   *   · 分月 + 周 ⇒ 平台在分月口径下**只按整月返回** ⇒ 每个周切片都返回同一个整月 ⇒ 同一个月被下载 4~5 次
   *     （2026-09-19 实证：`流量来源详情/分月` 曾产出 118 份 = 27 月 × 4~5，已整体隔离重采）。
   *   · 分周 + 月/天 ⇒ 周控件只表达整周，切出"半个周"就是口径错配（Y1/Z1 场次实证）。
   * core 层对这两种组合**直接抛错**（深链接/脚本拼参必须在启动前暴露错配）；界面层则**改成合法单位并把改动说出来**
   * （`chunkAdjustments`），因为用户是在下拉框里选的、看得见提示就能自己改 —— 但不能"偷偷改"。
   */
  const CHUNK_GUARD_BY_GRAIN = {
    分月: { forbid: ['week', 'day'], legal: 'month', legalText: '按自然月', why: '平台在分月口径下只按整月返回（按周切会把同一个整月重复下载 4~5 次）' },
    分周: { forbid: ['month', 'day'], legal: 'week', legalText: '按周（周一~周日）', why: '平台周控件只表达整周（切出"半个周"就是口径错配）' },
  };

  /** @returns {{unit:string, note:string|null}} unit 为空串 = 自动（沿用 core 的逐维度规则） */
  function reconcileChunkUnit(timeGrain, chunkUnit) {
    const unit = String(chunkUnit == null ? '' : chunkUnit).trim();
    const guard = CHUNK_GUARD_BY_GRAIN[String(timeGrain)];
    if (!guard || !unit || unit === 'none' || !guard.forbid.includes(unit)) return { unit, note: null };
    const nameOf = { week: '按周', day: '按天', month: '按自然月' };
    return {
      unit: guard.legal,
      note: `「${timeGrain}」不支持${nameOf[unit] || unit}切片：${guard.why} → 已改为${guard.legalText}`,
    };
  }

  /**
   * 由**界面字段**装配后台 config。
   * @param {object} f { storeId, storeName, batch, granularity, timeGrain, startDate, endDate,
   *                     dimensions[], efvRaw, chunkUnit, taskIntervalMs, taskTimeoutSec, ownerTabId }
   */
  function buildConfig(f) {
    const fields = f || {};
    const efv = parseExtraFilterValues(fields.efvRaw);
    const timeGrain = String(fields.timeGrain || '分日');
    // ❗ 切片单位先与粒度口径对齐（不合法就改成合法值；改动由 plan/界面负责"说出来"）
    const chunk = reconcileChunkUnit(timeGrain, fields.chunkUnit).unit;
    return {
      storeId: String(fields.storeId || '').trim(),
      storeName: String(fields.storeName || '').trim(),
      batch: String(fields.batch || '').trim() || undefined,
      granularity: String(fields.granularity || '店铺'),
      timeGrain,
      startDate: String(fields.startDate || ''),
      endDate: String(fields.endDate || ''),
      dimensions: Array.isArray(fields.dimensions) ? fields.dimensions.slice() : [],
      // 空 = **自动**（逐「维度×时间粒度」决定）；绝不能写死 month，否则会把"高行数维度自动按周切"盖掉
      ...(chunk ? { chunkUnit: chunk } : {}),
      ...(Object.keys(efv.value).length ? { extraFilterValues: efv.value } : {}),
      taskIntervalMs: toInt(fields.taskIntervalMs, core.MIN_TASK_INTERVAL_MS),
      taskTimeoutMs: toInt(fields.taskTimeoutSec, 180) * 1000,
      ownerTabId: fields.ownerTabId,
    };
  }

  /**
   * 计划预览：用 core 构一遍任务清单（**和后台同一套规则**），把"点开始之后会发生什么"提前说清。
   * @returns {{ok:boolean, error?:string, taskCount?:number, unitsText?:string, efvText?:string,
   *            reportName?:string, reportNameLength?:number, reportNameOk?:boolean, shards?:number}}
   */
  function plan(config) {
    if (config.granularity === '全部' || config.timeGrain === 'TTL') return allScopePlan(config);
    if (!config.storeId) return { ok: false, error: '请先填写 / 读取店铺 ID' };
    if (!config.storeName) return { ok: false, error: '请先点「读取当前店铺」拿到店铺名' };
    if (!config.dimensions.length) return { ok: false, error: '请至少选择一个数据维度' };
    const efvCheck = validateExtraFilterValues(
      config.extraFilterValues || {}, config.dimensions, config.granularity, config.timeGrain,
    );
    if (!efvCheck.ok) return { ok: false, error: `额外筛选值不可用：${efvCheck.reason}` };
    // ❗ 2026-09-20：区间**先自动矫正**再构建计划 —— 用户选的边界不合规时不再直接失败，
    //    而是按平台规则取到"最佳可取区间"，并把改动逐条回传（界面显示，不偷偷改）。
    const rangeFix = core.normalizeExportableRange(
      { timeGrain: config.timeGrain, startDate: config.startDate, endDate: config.endDate },
      new Date(),
    );
    if (!rangeFix.ok) return { ok: false, error: rangeFix.reason };
    // 切片单位与粒度口径对齐（config 若来自队列回放/外部调用，可能没经过 buildConfig）
    const chunkRec = reconcileChunkUnit(config.timeGrain, config.chunkUnit);
    let tasks = [];
    try {
      tasks = core.buildTaskCatalog({
        storeId: config.storeId,
        storeName: config.storeName,
        granularity: config.granularity,
        timeGrain: config.timeGrain,
        startDate: rangeFix.startDate,
        endDate: rangeFix.endDate,
        dimensionNames: config.dimensions,
        batch: config.batch,
        // '' = 自动（core 把 '' 与 undefined 同等对待；这里显式传 undefined 更明确）
        chunkUnit: chunkRec.unit || undefined,
        extraFilterValues: config.extraFilterValues,
      });
    } catch (error) {
      return { ok: false, error: String((error && error.message) || error) };
    }
    const units = Array.from(new Set(tasks.map((t) => t.chunkUnit || 'month')));
    const first = tasks[0] || {};
    const name = String(first.reportName || '');
    return {
      ok: true,
      taskCount: tasks.length,
      unitsText: units.map((u) => CHUNK_UNIT_TEXT[u] || u).join('/'),
      efvText: efvCheck.reason,
      reportName: name,
      reportNameLength: name.length,
      // 报表名 >30 会被平台**静默拒绝**（实测），这里提前亮红
      reportNameOk: name.length > 0 && name.length <= Number(SR.REPORT_NAME.maxLength || 30),
      dimensions: tasks.length,
      // 实际生效的区间 + 自动矫正说明（给界面显示）
      rangeStart: rangeFix.startDate,
      rangeEnd: rangeFix.endDate,
      rangeAdjustments: rangeFix.adjustments,
      // 切片单位被对齐过 ⇒ 必须显示出来（不许偷偷改口径）
      chunkAdjustments: chunkRec.note ? [chunkRec.note] : [],
    };
  }

  // ==================================================================================
  // 5. 会话视图（进度/计数/缺口）+ 目标标签页
  // ==================================================================================

  function sessionControls(session) {
    const status = session && session.status;
    const task = session && session.activeTask;
    const draining = status === 'paused' && !!task &&
      ['navigating', 'ready', 'export_clicked', 'platform_processing', 'downloading', 'validating'].includes(task.status);
    return {
      canPause: status === 'running',
      canResume: status === 'paused',
      statusText: status === 'paused' ? (draining ? '暂停中（当前报表完成后停）' : '已暂停') :
        (SESSION_STATUS_TEXT[status] || status || '无会话'),
    };
  }

  function sessionView(session) {
    if (!session) {
      return { exists: false, active: false, statusText: '无会话', done: 0, failed: 0, pending: 0, gap: 0, total: 0, percent: 0 };
    }
    const counts = session.counts || {};
    const done = Number(counts.done || 0);
    const failed = Number(counts.failed_permanent || 0);
    const ended = Number(counts.ended || 0);
    const total = Number(session.total || 0);
    const status = String(session.status || '');
    return {
      exists: true,
      sessionId: session.sessionId,
      storeId: session.storeId,
      storeName: session.storeName,
      granularity: session.granularity,
      timeGrain: session.timeGrain,
      startDate: session.startDate,
      endDate: session.endDate,
      batch: session.batch,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      status,
      statusText: sessionControls(session).statusText,
      done,
      failed,
      retryable: ['failed_permanent', 'error', 'retry_wait', 'delayed'].reduce((sum, key) => sum + Number(counts[key] || 0), 0),
      ended,
      total,
      pending: Math.max(0, total - done - failed - ended),
      gap: Number(session.gapCount || 0),
      percent: total > 0 ? Math.round((done / total) * 100) : 0,
      active: !!status && status !== 'completed' && status !== 'ended',
      activeTask: session.activeTask || null,
      activeTaskKey: session.activeTaskKey || null,
      lastError: session.lastError || null,
      gaps: Array.isArray(session.gaps) ? session.gaps : [],
    };
  }

  /** 找生参取数页标签页（工作台**不能**用"当前活动标签页"——那就是工作台自己） */
  async function findSycmTabs() {
    try {
      const tabs = await chrome.tabs.query({ url: SYCM_TAB_PATTERN });
      return (tabs || []).filter((t) => t && typeof t.id === 'number');
    } catch (error) {
      return [];
    }
  }

  /** 面板（popup）专用：弹出面板时**活动标签页**就是用户正在看的生参页 */
  async function activeTab() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return (tabs && tabs[0]) || null;
  }

  async function setTargetTab(tabId) {
    const id = Number(tabId) || null;
    await call('SET_TAB', { tabId: id });
    return id;
  }

  // ==================================================================================
  // 5.5 取数队列（2026-09-18 新增）
  //
  // 用户需求："在界面上新建多个任务，按新建顺序排队执行"。
  // 这里放**纯逻辑**（可 Node 单测）+ 存储/命令包装；执行器在 background（见 onSessionFinished）。
  // 顺序语义：**队列数组顺序 = 加入顺序**，可用"上移/下移"改；这就是用户说的"按新建时间排序"。
  // ==================================================================================

  const QUEUE_STATUS_TEXT = {
    pending: '待执行',
    running: '执行中',
    done: '已完成',
    failed: '失败',
    skipped: '已跳过',
  };

  function queueItemLabel(item) {
    if (!item) return '';
    if (item.label) return String(item.label);
    const c = item.config || {};
    return [c.granularity, (c.dimensions || []).join('+'), c.timeGrain, `${c.startDate}~${c.endDate}`]
      .filter(Boolean).join(' / ');
  }

  /** 汇总计数（纯函数，UI 与测试共用） */
  function queueCountsOf(items) {
    const list = Array.isArray(items) ? items : [];
    const counts = { total: list.length, pending: 0, running: 0, done: 0, failed: 0, skipped: 0 };
    for (const it of list) {
      const st = (it && it.status) || 'pending';
      if (counts[st] == null) counts[st] = 0;
      counts[st] += 1;
    }
    return counts;
  }

  /** 换位（纯函数）：返回新数组；越界则原样返回（不改原数组） */
  function queueMoveIn(items, itemId, dir) {
    const list = Array.isArray(items) ? items.slice() : [];
    const i = list.findIndex((x) => x && x.id === itemId);
    const j = i + (dir === 'up' ? -1 : 1);
    if (i < 0 || j < 0 || j >= list.length) return list;
    const tmp = list[i];
    list[i] = list[j];
    list[j] = tmp;
    return list;
  }

  function queueRemoveFrom(items, itemId) {
    return (Array.isArray(items) ? items : []).filter((x) => !x || x.id !== itemId);
  }

  /** 下一项待执行（纯函数）：按数组顺序取第一个 pending */
  function queuePickNext(items) {
    return (Array.isArray(items) ? items : []).find((x) => x && x.status === 'pending') || null;
  }

  /** 把后台返回的队列视图规整成 UI 好用的形状（后台已算好 counts/current/next，这里只做防御性兜底） */
  function queueView(raw) {
    const q = raw && typeof raw === 'object' ? raw : {};
    const items = Array.isArray(q.items) ? q.items : [];
    const counts = q.counts || queueCountsOf(items);
    return {
      running: !!q.running,
      items,
      counts,
      current: q.current || items.find((x) => x && x.status === 'running') || null,
      next: q.next || queuePickNext(items) || null,
      lastError: q.lastError || null,
      stoppedAt: q.stoppedAt || null,
      summaryText: queueSummaryText({ ...q, items, counts }),
    };
  }

  function queueSummaryText(view) {
    const v = view || {};
    const c = v.counts || queueCountsOf(v.items);
    if (!c.total) return '队列为空：先配置取数范围，再加入队列';
    const bits = [`共 ${c.total} 项计划`, `待执行 ${c.pending || 0}`, `完成 ${c.done || 0}`];
    if (c.failed) bits.push(`失败 ${c.failed}`);
    if (c.running) bits.push(`进行中 ${c.running}`);
    const state = v.running ? '队列运行中' : c.running ? '当前计划进行中，后续未启动' :
      c.pending ? '待启动' : c.failed ? '执行结束，有失败计划' : '队列执行完毕';
    return `${state}：${bits.join('，')}`;
  }

  function queueControls(queue, session, connected, busy) {
    const q = queueView(queue);
    const enabled = !!connected && !busy;
    return {
      canRun: enabled && !q.running && q.counts.pending > 0 && !(session && session.status === 'paused'),
      canStop: enabled && q.running,
      canClear: enabled && !q.running && q.counts.done > 0,
    };
  }

  async function queueAdd(item) {
    if (item.config && (item.config.granularity === '全部' || item.config.timeGrain === 'TTL')) {
      const p = allScopePlan(item.config);
      if (!p.ok) return p;
      return call('QUEUE_ADD_MANY', { items: p.configs.map(config => ({ ...item, config,
        label: `全部 · ${config.granularity} / ${config.timeGrain} ${config.startDate}~${config.endDate}` })) });
    }
    return call('QUEUE_ADD', { item });
  }

  /** 人工校验时间表驱动的整年计划。分周按 ISO 周年计算。 */
  function annualPlan(year, base) {
    if (![2024, 2025].includes(Number(year))) return { ok: false, error: '只支持 2024 或 2025 年' };
    const table = globalThis.SR_AVAILABILITY || {};
    const isoMonday = (y) => {
      const d = new Date(Date.UTC(y, 0, 4));
      d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
      return d;
    };
    const fmt = (d) => d.toISOString().slice(0, 10);
    const nextWeek = isoMonday(Number(year) + 1);
    const weekEnd = fmt(new Date(nextWeek.getTime() - 86400000));
    const configs = [];
    let taskCount = 0;
    for (const [key, earliest] of Object.entries(table).sort(([a], [b]) => a.localeCompare(b, 'zh-CN'))) {
      const [granularity, dimension, timeGrain] = key.split('|');
      const yearStart = timeGrain === '分周' ? fmt(isoMonday(Number(year))) : `${year}-01-01`;
      const endDate = timeGrain === '分周' ? weekEnd : `${year}-12-31`;
      const startDate = earliest > yearStart ? earliest : yearStart;
      if (startDate > endDate) continue;
      const config = { ...base, granularity, timeGrain, dimensions: [dimension], startDate, endDate,
        batch: `${year}`, ownerTabId: base.ownerTabId };
      delete config.chunkUnit;
      delete config.extraFilterValues;
      const result = plan(config);
      if (!result.ok || !result.reportNameOk) return { ok: false, error: `${key}：${result.error || '报表名超长'}` };
      configs.push(config);
      taskCount += result.taskCount;
    }
    return configs.length ? { ok: true, configs, taskCount } : { ok: false, error: `${year} 年没有可取组合` };
  }

  async function queueAddAnnual(year, base) {
    const p = annualPlan(year, base);
    if (!p.ok) return p;
    return call('QUEUE_ADD_MANY', { items: p.configs.map((config) => ({
      config, ownerTabId: config.ownerTabId,
      label: `${year} 全年 · ${config.granularity}/${config.dimensions[0]}/${config.timeGrain} ${config.startDate}~${config.endDate}`,
    })) });
  }

  async function queueRequeueFailed(itemId, ownerTabId) {
    return call('QUEUE_REQUEUE_FAILED', { itemId, ownerTabId });
  }

  // “全部”沿用各范围的原有计划及执行规则；不将不支持的粒度偷换成另一种。
  function allScopePlan(config) {
    const configs = [];
    const excluded = [];
    const plans = [];
    const chunkNotes = [];
    const scopes = config.granularity === '全部' ? granularities() : [config.granularity];
    const grains = config.timeGrain === 'TTL' ? ['分日', '分周', '分月'] : [config.timeGrain];
    for (const timeGrain of grains) {
    for (const granularity of scopes) {
      // ❗ 2026-09-20：**尊重用户勾选**。「全部」模式下勾选项的名字带粒度前缀（形如 `店铺 / 整体`，
      //    见 dimensionNamesFor）；旧写法在全部模式里无条件放行所有行 → 用户取消勾选也没用
      //    （用户实况：只想补跑失败的那几项，做不到）。
      //    ⚠️ 兼容：`dimensions` 为空 ⇒ 仍视为"全部维度"（保留"一键全量"这条便捷路径）。
      //       界面在勾选为空时会**拦住**加入队列/开始，所以不会出现"想清空却变成全下"。
      const rows = dimensionRows(granularity, timeGrain).filter((r) => {
        if (config.granularity !== '全部') return config.dimensions.includes(r.name);
        if (!config.dimensions.length) return true;
        return config.dimensions.includes(`${granularity} / ${r.name}`);
      });
      const dimensions = rows.filter(r => r.usable).map(r => r.name);
      excluded.push(...rows.filter(r => !r.usable).map(r => `${granularity}/${r.name}/${timeGrain}（仅${r.grains.join('/')}）`));
      if (!dimensions.length) continue;
      const child = { ...config, granularity, timeGrain, dimensions };
      // ❗ 2026-09-20：子计划的切片单位必须按**该子计划自己的时间粒度**对齐。
      //    实况：用户给「分片单位」选了"按周"（或历史上"按天"），再点「全部 + TTL」时，
      //    4 个分月子项会带着 week 下去 ⇒ 每周切片各返回同一个整月 ⇒ 重复下载（2026-09-19 实证的事故路径）。
      const chunkRec = reconcileChunkUnit(timeGrain, config.chunkUnit);
      if (chunkRec.unit) child.chunkUnit = chunkRec.unit; else delete child.chunkUnit;
      if (chunkRec.note) chunkNotes.push(chunkRec.note);
      const p = plan(child);
      if (!p.ok) return { ok: false, error: `${granularity}：${p.error}` };
      if (!p.reportNameOk) return { ok: false, error: `${granularity}：报表名超过上限` };
      configs.push(child);
      plans.push(p);
    }
    }
    if (!configs.length) return { ok: false, error: '当前时间粒度无可用维度' };
    return { ok: true, configs, excluded, taskCount: plans.reduce((n, p) => n + p.taskCount, 0),
      unitsText: [...new Set(plans.map(p => p.unitsText))].join('/'),
      reportName: plans[0].reportName, reportNameLength: plans[0].reportNameLength,
      reportNameOk: true, efvText: plans.map(p => p.efvText).filter(Boolean).join('；'),
      // 切片单位对齐说明（同一句只留一条；子计划自己的说明也汇总上来）
      chunkAdjustments: [...new Set([...chunkNotes, ...plans.flatMap(p => p.chunkAdjustments || [])])] };
  }

  async function queueRemove(itemId) {
    return call('QUEUE_REMOVE', { itemId });
  }

  async function queueRemoveMany(itemIds) {
    return call('QUEUE_REMOVE_MANY', { itemIds });
  }

  async function queueMove(itemId, dir) {
    return call('QUEUE_MOVE', { itemId, dir });
  }

  async function queueRun() {
    return call('QUEUE_RUN', {});
  }

  async function queueStop() {
    return call('QUEUE_STOP', {});
  }

  async function queueClearFinished() {
    return call('QUEUE_CLEAR_FINISHED', {});
  }

  // ==================================================================================
  // 6. 动作（返回 { ok, error?, ... }；**不直接操作 DOM**，由调用方决定怎么显示）
  // ==================================================================================

  async function readStore(tabId) {
    const response = await call('PAGE_PING', { tabId });
    if (!response.ok) return { ok: false, error: `读取店铺失败：${response.error || response.reason || '未知原因'}` };
    const page = response.page || {};
    return {
      ok: true,
      page,
      storeName: page.storeName || page.sourceStore || '',
      // ❗ 2026-09-20：店铺 ID **从页面读**（见 core.pickStoreIdFromCheckboxValues 的实测注释）；
      //    读不到就是 null —— 由调用方回退到手填并**如实标注来源**，绝不把历史值说成"来自当前页面"。
      storeId: page.storeId || null,
      storeIdSource: page.storeIdSource || null,
      storeCheckedCount: page.storeCheckedCount == null ? null : page.storeCheckedCount,
      granularity: page.granularity || null,
    };
  }

  async function preflight(tabId) {
    const response = await call('PREFLIGHT', { tabId });
    const gate = response.gate || {};
    const required = response.required || {};
    if (!response.ok) {
      const hits = [].concat(gate.login || [], gate.risk || []);
      if (hits.length) return { ok: false, error: `已停止：页面出现「${hits.join('、')}」文案。请人工处理后刷新页面。` };
      if (required.missing && required.missing.length) return { ok: false, error: `必填项未齐：${required.missing.join('、')}。请在页面上补齐后再预检。` };
      return { ok: false, error: `预检未通过：${response.reason || response.error || '未知原因'}` };
    }
    return { ok: true, page: response.page || {} };
  }

  async function start(config, tabId) {
    const response = await call('START', { config: { ...config, ownerTabId: tabId }, tabId });
    if (!response.ok) return { ok: false, error: response.error || '启动失败' };
    return { ok: true, sessionId: response.sessionId, total: response.total };
  }

  async function pause() {
    const response = await call('PAUSE');
    return response.ok ? { ok: true, note: response.note || '将在当前任务完成后暂停' } : { ok: false, error: response.error || '暂停失败' };
  }

  async function resume(tabId) {
    const response = await call('RESUME', { tabId: tabId == null ? null : tabId });
    if (!response.ok) return { ok: false, error: response.error || '继续失败' };
    return { ok: true, verified: !!response.pageStoreVerified };
  }

  async function end() {
    const response = await call('END');
    if (!response.ok) return { ok: false, error: response.error || '结束失败' };
    const root = String(response.artifactRoot || '').split('/').join('\\');
    return { ok: true, gapCount: response.gapCount, artifactRoot: root, degraded: !!response.artifactDegraded };
  }

  async function retryFailed() {
    const response = await call('RETRY_FAILED');
    if (!response.ok) return { ok: false, error: response.error || '重试失败' };
    return { ok: true, retried: response.retried, status: response.status };
  }

  async function exportDiagnostics() {
    const response = await call('EXPORT_DIAGNOSTICS');
    if (!response.ok) return { ok: false, error: response.error || '导出诊断失败' };
    return { ok: true, path: response.path };
  }

  async function state() {
    return call('STATE');
  }

  /** 打开生参取数页（新标签页） */
  async function openFetchPage() {
    const url = `https://${SR.PAGE.host}${SR.PAGE.shellPath}datafetch/create`;
    await chrome.tabs.create({ url });
    return url;
  }

  /** 打开工作台；已开着就聚焦那个标签页（不重复开） */
  async function openWorkspace() {
    const url = chrome.runtime.getURL('app.html');
    const existed = await chrome.tabs.query({ url: chrome.runtime.getURL('app.html') });
    if (existed && existed.length) {
      await chrome.tabs.update(existed[0].id, { active: true });
      return { ok: true, reused: true, tabId: existed[0].id };
    }
    const tab = await chrome.tabs.create({ url });
    return { ok: true, reused: false, tabId: tab && tab.id };
  }

  // ==================================================================================
  // 7. 日期快捷（确定性计算：只看本地日期，不用随机）
  // ==================================================================================

  function fmt(date) { return core.formatDate(date); }

  /** 上个自然月的首尾 */
  function lastMonthRange() {
    const now = new Date();
    const firstOfThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastMonthEnd = new Date(firstOfThisMonth.getTime() - 86400000);
    const lastMonthStart = new Date(lastMonthEnd.getFullYear(), lastMonthEnd.getMonth(), 1);
    return { start: fmt(lastMonthStart), end: fmt(lastMonthEnd) };
  }

  function yesterdayRange() {
    const now = new Date();
    const y = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    return { start: fmt(y), end: fmt(y) };
  }

  function availableDayRange(now = new Date()) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 2);
    return { start: fmt(day), end: fmt(day) };
  }

  function last7DaysRange(now = new Date()) {
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 2);
    const start = new Date(end.getFullYear(), end.getMonth(), end.getDate() - 6);
    return { start: fmt(start), end: fmt(end) };
  }

  globalThis.SRUI = {
    VERSION,
    call,
    onHandshake,
    handshake,
    // 页面知识
    granularities,
    dimensionNamesFor,
    legalGrainsFor,
    dimensionRows,
    // 参数与计划
    parseExtraFilterValues,
    validateExtraFilterValues,
    buildConfig,
    plan,
    toInt,
    CHUNK_UNIT_TEXT,
    // 会话
    sessionView,
    sessionControls,
    SESSION_STATUS_TEXT,
    findSycmTabs,
    activeTab,
    setTargetTab,
    // 动作
    readStore,
    preflight,
    start,
    pause,
    resume,
    end,
    retryFailed,
    exportDiagnostics,
    state,
    openFetchPage,
    openWorkspace,
    // 日期
    lastMonthRange,
    yesterdayRange,
    availableDayRange,
    last7DaysRange,
    // 队列（2026-09-18 新增）：纯逻辑放这一层，才能进 Node 单测（见 tests/ui_core.test.js）
    QUEUE_STATUS_TEXT,
    queueItemLabel,
    queueSummaryText,
    queueCountsOf,
    queueMoveIn,
    queueRemoveFrom,
    queuePickNext,
    queueView,
    queueControls,
    queueAdd,
    annualPlan,
    queueAddAnnual,
    queueRequeueFailed,
    queueRemove,
    queueRemoveMany,
    queueMove,
    queueRun,
    queueStop,
    queueClearFinished,
  };
})();
