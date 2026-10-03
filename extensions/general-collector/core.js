/**
 * core.js —— 生参通用取数工具「纯函数核心层」
 *
 * 设计铁律（见需求与技术方案 V1 §11.1 / §10）：
 *   1. 本文件**不碰 DOM、不调 chrome.* API、不发网络请求、无副作用**，可在 Node 里直接 require 跑单测。
 *   2. **页面知识只有一份**：维度名/指标数/时间粒度矩阵/文件命名规则全部从 `selectors.js`（全局 `SR`）读取，
 *      本文件**不得再硬编码一份**。平台改版只改 selectors.js。
 *   3. **不静默跳过**：非法组合、非法迁移、覆盖率空洞一律 `throw`，由调用方决定如何呈现。
 *   4. **不做随机化**：重试退避是固定值（`nextBackoffMs`），项目硬边界，避免"随机化=规避"的解释空间。
 *
 * 双出口（沿用两款参考插件的 UMD 写法）：
 *   - 浏览器：content script / service worker（importScripts）里挂 `globalThis.SRCore`
 *   - Node：  `require('./core.js')` 返回同一套 API
 */

(function initSrCore(root, factory) {
  'use strict';
  const api = factory(root);
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  if (root) root.SRCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createSrCore(root) {
  'use strict';

  // ==================================================================================
  // 0. 依赖解析：浏览器读全局 SR，Node require('./selectors.js') 兜底
  // ==================================================================================

  let cachedSr = null;

  /**
   * 取页面知识表（selectors.js 的 SR）。
   * 浏览器：content script 里 selectors.js 先加载，挂成全局 `SR`。
   * Node：   require('./selectors.js')——该文件末尾已有 module.exports 出口。
   * 两边都没有 → 直接抛错（宁可报错，也不能拿一份臆想的维度表继续跑）。
   */
  function getSelectors() {
    if (cachedSr) return cachedSr;
    const fromGlobal = root && root.SR ? root.SR : (typeof SR !== 'undefined' ? SR : null);
    if (fromGlobal) {
      cachedSr = fromGlobal;
      return cachedSr;
    }
    if (typeof require === 'function') {
      try {
        // eslint-disable-next-line global-require
        cachedSr = require('./selectors.js');
        return cachedSr;
      } catch (error) {
        throw new Error(`无法载入页面知识表 selectors.js：${error && error.message}`);
      }
    }
    throw new Error('无法载入页面知识表 selectors.js（浏览器需先加载 selectors.js，Node 需与本文件同目录）');
  }

  function availabilityTable() {
    if (root && root.SR_AVAILABILITY) return root.SR_AVAILABILITY;
    if (typeof require === 'function') return require('./availability.js');
    throw new Error('缺少人工校验的可取日期表 availability.js');
  }

  // ==================================================================================
  // 1. 常量：存储 schema / 重试 / 目录结构
  // ==================================================================================

  /** 会话数据结构版本。结构变化时必须 +1，并在迁移层处理旧版本。 */
  const SCHEMA_VERSION = 1;

  /**
   * 存储布局：**会话分片 + 索引**（红猫是单 key 全量重写，任务上千时会爆 ≥8MB）。
   *   sr:sessions:index                  会话索引（只存元信息，几十字节/会话）
   *   sr:session:<sid>:meta              会话元信息 + 状态 + 区间
   *   sr:session:<sid>:tasks:<NNNN>      任务分片（每片 TASK_SHARD_SIZE 个任务）
   *   sr:session:<sid>:evidence:<taskKey> 单任务 exportEvidence（§8.2 的 task.json 内容）
   */
  const storageKeys = Object.freeze({
    prefix: 'sr',
    sessionIndex: 'sr:sessions:index',
    sessionMeta: (sessionId) => `sr:session:${sessionId}:meta`,
    sessionTasks: (sessionId, shard) => `sr:session:${sessionId}:tasks:${String(shard).padStart(4, '0')}`,
    sessionEvidence: (sessionId, taskKey) => `sr:session:${sessionId}:evidence:${taskKey}`,
    /** 会话级 schema 版本键（例如 "sr:version"），用于整体升级判定 */
    version: 'sr:version',
  });

  /** 每个任务分片默认容纳的任务数（分日 × 16 维度 × 多月的清单会很长）。 */
  const TASK_SHARD_SIZE = 200;

  /**
   * ❗ 存储配额卫生（2026-09-19 真机事故）：会话详情（`meta` + `tasks` 分片 + 单任务 `evidence`）都写在
   *    `chrome.storage.local`，而**单会话就可能 350 KB ~ 1.1 MB**（磁盘上的同类清单实测：SM06 1.1 MB /
   *    SM01 454 KB / KFM1 426 KB）。索引只保留 50 条，**会话详情却从不清理** → 攒到 ~20 个会话就撞满
   *    10 MB 配额（manifest 未申请 unlimitedStorage）。实测后果：① 写不进 → 任务**静默卡死**
   *    （分小时/分日 前 4 分钟出了 9 份，之后 95 分钟零产物）；② 连 `END` 都写不出
   *    （回执 `Resource::kQuotaBytes quota exceeded`）→ 会话永远停在 running → 之后**所有** START
   *    被「存在未结束的会话」挡住（当晚 14 个会话全废）。
   *    下面两个纯函数只回答"该删哪些键"；真正的删除在 background.js（唯一碰 chrome.storage 的地方）。
   */
  const SESSION_DETAIL_KEEP = 4;   // 保留最近 N 个会话的详情（固定值，无随机化）

  /** 会话详情键 → sessionId；**不是**详情键（索引 / schema / 队列 / formFrame…）一律返回 null */
  function sessionIdOfDetailKey(key) {
    const m = /^sr:session:(.+?):(?:meta|tasks:|evidence:)/.exec(String(key == null ? '' : key));
    return m ? m[1] : null;
  }

  /**
   * 选出应当删除的详情键：保留**索引里最后 N 个会话**（索引是"旧的在前"：upsertIndex 用 push + slice(-50)）
   * 以及显式 `skipSessionId`（当前会话，绝不删）；其余详情键全删。
   * ⚠️ 非详情键永不入选 —— 防误删索引 / schema / 队列 / formFrame 映射。
   */
  function pickSessionDetailVictims(allKeys, indexEntries, opts) {
    const o = opts || {};
    const keep = Math.max(1, Math.floor(Number(o.keep == null ? SESSION_DETAIL_KEEP : o.keep)));
    const skip = o.skipSessionId == null ? null : String(o.skipSessionId);
    const ordered = (Array.isArray(indexEntries) ? indexEntries : [])
      .map((e) => (e && e.sessionId ? String(e.sessionId) : null))
      .filter(Boolean);
    const keepSet = new Set(ordered.slice(-keep));
    if (skip) keepSet.add(skip);
    const victims = (Array.isArray(allKeys) ? allKeys : []).filter((k) => {
      const sid = sessionIdOfDetailKey(k);
      return sid !== null && !keepSet.has(sid);
    });
    return { victims, keepSet: [...keepSet], keep };
  }

  /** 归档根目录名（§8.2）。 */
  const ARCHIVE_ROOT = '生参取数';

  /** 单任务最大尝试次数：达上限置 failed_permanent，显式留缺口，不静默跳过。 */
  const MAX_ATTEMPTS = 3;

  /** 固定退避基准（毫秒）。**纯固定值，禁止随机化**。 */
  const RETRY_BASE_DELAY_MS = 5000;
  /** 固定退避上限（毫秒）。 */
  const RETRY_MAX_DELAY_MS = 60000;
  /** 会话默认固定限速间隔（毫秒）——串行 + 固定间隔，不做随机化。 */
  const MIN_TASK_INTERVAL_MS = 3000;

  /**
   * 分片单位（区间切分粒度）。
   *   month = 按自然月切；week = 按周（周一~周日）切；day = 按天切；none = 整段一片。
   * `day` 是 2026-09-14 为"平台 10 万行静默截断"新增的**更细分片能力**（见 PLATFORM.rowCap / assessRowCap）：
   * 明细/来源类维度整月导出会被截断在 100,000 行，需要按周或按天分片取数。
   */
  const CHUNK_UNITS = Object.freeze(['month', 'week', 'day', 'none']);

  // ==================================================================================
  // 2. 日期工具（全部按"本地日期字符串"处理，绝不用 Date 的 UTC/本地混用）
  // ==================================================================================

  const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
  const DATE_TOKEN_RE = /^(\d{4})(\d{2})(\d{2})$/;

  function pad2(value) {
    return String(value).padStart(2, '0');
  }

  function isValidYmd(year, month, day) {
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year
      && date.getUTCMonth() === month - 1
      && date.getUTCDate() === day;
  }

  /**
   * 把 Date | 'YYYY-MM-DD' | 'YYYYMMDD' 统一格式化为 'YYYY-MM-DD'。
   * Date 入参按**本地日期**取年月日（用户看到的日期就是本地日期），
   * 后续所有运算都在 UTC 轴上做，避免跨时区/夏令时把日期算偏一天。
   */
  function formatDate(value) {
    if (value instanceof Date) {
      if (Number.isNaN(value.getTime())) throw new Error('formatDate 收到非法 Date');
      return `${value.getFullYear()}-${pad2(value.getMonth() + 1)}-${pad2(value.getDate())}`;
    }
    const text = String(value == null ? '' : value).trim();
    const dashed = text.match(DATE_RE);
    if (dashed) {
      const [year, month, day] = [Number(dashed[1]), Number(dashed[2]), Number(dashed[3])];
      if (!isValidYmd(year, month, day)) throw new Error(`非法日期：${text}`);
      return `${dashed[1]}-${dashed[2]}-${dashed[3]}`;
    }
    const compact = text.match(DATE_TOKEN_RE);
    if (compact) {
      const [year, month, day] = [Number(compact[1]), Number(compact[2]), Number(compact[3])];
      if (!isValidYmd(year, month, day)) throw new Error(`非法日期：${text}`);
      return `${compact[1]}-${compact[2]}-${compact[3]}`;
    }
    throw new Error(`日期格式必须为 YYYY-MM-DD（或 YYYYMMDD）：${text}`);
  }

  /** 日期 → UTC 毫秒（仅用于纯日期运算，不参与展示）。 */
  function toUtcMs(ymd) {
    const [year, month, day] = ymd.split('-').map(Number);
    return Date.UTC(year, month - 1, day);
  }

  /** 日期 → 'YYYYMMDD'（文件名/报表名/归档目录用）。 */
  function compactDate(value) {
    return formatDate(value).replace(/-/g, '');
  }

  /** 日期 ±n 天，返回 'YYYY-MM-DD'。 */
  function addDays(value, delta) {
    const ymd = formatDate(value);
    const days = Number(delta);
    if (!Number.isInteger(days)) throw new Error(`addDays 的增量必须是整数：${delta}`);
    const next = new Date(toUtcMs(ymd) + days * 86400000);
    return `${next.getUTCFullYear()}-${pad2(next.getUTCMonth() + 1)}-${pad2(next.getUTCDate())}`;
  }

  /** 两个日期之间的**整天数**（end - start）。同一天 = 0；含首含尾的天数 = daysBetween + 1。 */
  function daysBetween(start, end) {
    return Math.round((toUtcMs(formatDate(end)) - toUtcMs(formatDate(start))) / 86400000);
  }

  /** 日期比较，便于排序。返回 -1 / 0 / 1（不返回毫秒差，避免调用方误当"相差天数"）。 */
  function compareDates(left, right) {
    const delta = toUtcMs(formatDate(left)) - toUtcMs(formatDate(right));
    return delta < 0 ? -1 : delta > 0 ? 1 : 0;
  }

  /** 校验 ':start' 与 ':end' 都是合法且 start <= end 的区间。 */
  function assertDateRange(start, end) {
    const from = formatDate(start);
    const to = formatDate(end);
    if (toUtcMs(from) > toUtcMs(to)) throw new Error(`起始日期不能晚于结束日期：${from} ~ ${to}`);
    return { start: from, end: to };
  }

  /**
   * 把 [start, end] 按**自然月**切分（对齐日历月边界）。
   * 保证：首片 start === 入参 start、末片 end === 入参 end、
   *       前一片 end + 1 天 === 后一片 start（无缝、无空洞、无重叠）。
   * 例：2025-12-25 ~ 2026-02-03
   *   → 2025-12-25~2025-12-31 / 2026-01-01~2026-01-31 / 2026-02-01~2026-02-03
   */
  function monthChunks(start, end) {
    const range = assertDateRange(start, end);
    const chunks = [];
    let cursor = range.start;
    while (toUtcMs(cursor) <= toUtcMs(range.end)) {
      const [year, month] = cursor.split('-').map(Number);
      // 该自然月最后一天 = 下个月 0 号（UTC 轴上取，不受本地时区影响）
      const lastDayOfMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
      const monthEnd = `${year}-${pad2(month)}-${pad2(lastDayOfMonth)}`;
      const chunkEnd = toUtcMs(monthEnd) < toUtcMs(range.end) ? monthEnd : range.end;
      chunks.push({ start: cursor, end: chunkEnd });
      cursor = addDays(chunkEnd, 1);
    }
    return chunks;
  }

  /**
   * 把 [start, end] 按**周（周一~周日）**切分。
   *
   * 为什么需要：**分周**取数的日期控件是"周"（实测值形如 `2026-35周`），平台按周出数；
   * 若仍按自然月切分，跨月的周会被切成两个"半个周"的任务（实机 X1 场次：8/31~9/6 被切成 2 个任务），
   * 那样的区间在周控件里根本无法表达。
   * 要求 start 为周一、end 为周日（区间门禁已强制结束日为周日）。
   * 保证：首片 start === 入参 start、末片 end === 入参 end、相邻片无缝无重叠。
   */
  function weekChunks(start, end) {
    const range = assertDateRange(start, end);
    const chunks = [];
    let cursor = range.start;
    while (toUtcMs(cursor) <= toUtcMs(range.end)) {
      const weekEnd = addDays(cursor, 6);              // 周一 + 6 天 = 周日
      const chunkEnd = toUtcMs(weekEnd) < toUtcMs(range.end) ? weekEnd : range.end;
      chunks.push({ start: cursor, end: chunkEnd });
      cursor = addDays(chunkEnd, 1);
    }
    return chunks;
  }

  /**
   * 把 [start, end] 按**天**切分（最细一档，用于撞上平台 10 万行上限的明细类维度）。
   * 保证：首片 start === 入参 start、末片 end === 入参 end、相邻片无缝无重叠。
   */
  function dayChunks(start, end) {
    const range = assertDateRange(start, end);
    const chunks = [];
    let cursor = range.start;
    while (toUtcMs(cursor) <= toUtcMs(range.end)) {
      chunks.push({ start: cursor, end: cursor });
      cursor = addDays(cursor, 1);
    }
    return chunks;
  }

  /** 把 [start, end] 按 chunkUnit 切分。'none' = 整段一片；'month' = 自然月；'week' = 周；'day' = 天。 */
  function chunkRange(start, end, chunkUnit) {
    const unit = chunkUnit == null ? 'month' : String(chunkUnit);
    if (!CHUNK_UNITS.includes(unit)) {
      throw new Error(`不支持的 chunkUnit：${unit}（合法值：${CHUNK_UNITS.join(' / ')}）`);
    }
    if (unit === 'none') return [assertDateRange(start, end)];
    if (unit === 'day') return dayChunks(start, end);
    if (unit === 'week') return weekChunks(start, end);
    return monthChunks(start, end);
  }

  // ==================================================================================
  // 3. 维度与指标口径（唯一来源：SR.DIMENSIONS_STORE）
  // ==================================================================================

  /**
   * ⭐ **数据粒度 → 维度表** 的唯一映射（2026-09-15 二期「商品」粒度落地时新增）。
   *
   * 为什么必须有它（**这是本次发现的一个真实缺陷**）：
   *   列数实测表 `COLUMN_LAYOUT_BY_DIMENSION_GRAIN` 是**按维度名索引**的，而
   *   **商品粒度与店铺粒度有 12 个同名维度**（整体 / 流量来源 / 流量来源详情 / 已完结退款 …）。
   *   旧实现把 `granularity` 直接丢掉、只按维度名查表 → 商品粒度的列数判定会**误用店铺粒度的期望值**
   *   （例如「流量来源 分日」是 27 列 vs 商品粒度的 22 个指标）。判据一旦用错，就会产生
   *   假 mismatch 或**漏报警**（这正是本仓最忌讳的"静默口径错配"）。
   *   → 修法：**维度定义按粒度分表**；列数表只对**已实测过列数的粒度**生效，其余一律返回 null。
   */
  const DIMENSION_TABLE_BY_GRANULARITY = {
    店铺: 'DIMENSIONS_STORE',
    商品: 'DIMENSIONS_ITEM',
    // ⭐ 2026-09-16 二期粒度开闸（客户 / 品类）：维度清单与指标总数均由**只读枚举探针实测**
    //    （enumeration_客户_2026-09-16T1437.json / enumeration_品类_2026-09-16T1438.json），
    //    额外筛选控件由只读探针实读（readonly_filters_客户/品类_2026-09-16T14*.json，readValid=true）。
    客户: 'DIMENSIONS_CUSTOMER',
    品类: 'DIMENSIONS_CATEGORY',
  };

  /** 指标总数表：粒度 → selectors 里的表名（未实采的粒度没有表 → 一律 null）。 */
  const METRIC_TABLE_BY_GRANULARITY = {
    店铺: 'METRIC_COUNT_BY_GRAIN',
    商品: 'METRIC_COUNT_ITEM_BY_GRAIN',
    // ⭐ 2026-09-16：客户/品类的指标总数由只读枚举探针逐（维度 × 时间粒度）实测
    客户: 'METRIC_COUNT_CUSTOMER_BY_GRAIN',
    品类: 'METRIC_COUNT_CATEGORY_BY_GRAIN',
  };

  /** 列布局实测表：粒度 → selectors 里的表名（**按粒度分表**，避免同名维度串用）。 */
  const COLUMN_LAYOUT_TABLE_BY_GRANULARITY = {
    店铺: 'COLUMN_LAYOUT_BY_DIMENSION_GRAIN',
    商品: 'COLUMN_LAYOUT_ITEM_BY_DIMENSION_GRAIN',
    // ⭐ 2026-09-16：客户/品类**尚未实测导出列数** → 表为 null
    //    ⇒ `checkColumnCount` 会**跳过**列数校验（未实测就不假装能判），待真实产物跑出来再填。
    客户: 'COLUMN_LAYOUT_CUSTOMER_BY_DIMENSION_GRANULARITY',
    品类: 'COLUMN_LAYOUT_CATEGORY_BY_DIMENSION_GRANULARITY',
  };

  /**
   * 已实测**导出列数**的粒度。
   * ⚠️ 客户/品类**故意不在列**：它们只有"指标总数"实测，**没有**列数实测 →
   *    列数校验必须跳过（否则会拿 null 去比，等于假装判过）。
   */
  const COLUMN_MEASURED_GRANULARITIES = ['店铺', '商品', '客户', '品类'];

  /**
   * 该「数据粒度」的维度表（**已实采**返回数组；**未实采返回 null**，调用方据此禁用 UI）。
   * 2026-09-15 新增：面板/编排层需要"这个粒度到底有没有实采"这个事实，而不是自己去翻 selectors。
   */
  function dimensionTable(granularity) {
    const SR = getSelectors();
    const grain = granularity == null ? '店铺' : String(granularity);
    const tableName = DIMENSION_TABLE_BY_GRANULARITY[grain];
    if (!tableName) return null;
    const table = SR[tableName];
    return Array.isArray(table) ? table : null;
  }

  /** 按维度名或维度 code 查维度定义；查不到**抛错**（不静默跳过）。 */
  function findDimension(dimensionName, granularity) {
    const SR = getSelectors();
    const grain = granularity == null ? '店铺' : String(granularity);
    const tableName = DIMENSION_TABLE_BY_GRANULARITY[grain];
    if (!tableName) {
      throw new Error(`数据粒度「${grain}」的维度清单尚未实采（已实采：${Object.keys(DIMENSION_TABLE_BY_GRANULARITY).join(' / ')}）`);
    }
    const table = SR[tableName];
    if (!Array.isArray(table) || !table.length) {
      throw new Error(`selectors.js 缺维度表 ${tableName}（数据粒度「${grain}」）`);
    }
    const wanted = String(dimensionName == null ? '' : dimensionName).trim();
    if (!wanted) throw new Error('数据维度不能为空');
    const dimension = table.find((item) => item.name === wanted || item.code === wanted);
    if (!dimension) {
      throw new Error(`未知数据维度：${wanted}（数据粒度「${grain}」的合法维度见 selectors.js 的 ${tableName}，共 ${table.length} 项）`);
    }
    return dimension;
  }

  /**
   * 某维度**合法的时间粒度**（页面知识唯一来源：`selectors.js`）。
   *
   * ⚠️ 2026-09-14 收尾 ④ 实机更正：时间粒度是**逐维度**的，不是逐「数据粒度」的 ——
   *   「关键词 / 人群分类」只有 分日+汇总（**没有分周 / 分月**）；「分小时」只有分日；
   *   「流量核心指标 / 流量来源(新版) …」没有汇总。旧实现按「数据粒度」校验，会放行
   *   平台根本不提供的组合（如 关键词+分周），到页面上才点不动 → 白跑一轮。
   * 优先按维度查 `TIME_GRAIN_BY_DIMENSION`；该表没有该维度时退回「数据粒度」矩阵（不猜上限）。
   */
  function legalTimeGrains(dimensionName, granularity) {
    const SR = getSelectors();
    const grain = granularity == null ? '店铺' : String(granularity);
    const wanted = String(dimensionName == null ? '' : dimensionName).trim();
    // ⭐ 二期优先：维度定义里自带 `timeGrains`（商品粒度实采时逐维度读到并落库）→ 直接用，不再猜。
    if (wanted) {
      try {
        const dimension = findDimension(wanted, grain);
        if (Array.isArray(dimension.timeGrains) && dimension.timeGrains.length) return dimension.timeGrains.slice();
      } catch (error) {
        if (!(error && /尚未实采|未知数据维度|缺维度表/.test(String(error.message)))) throw error;
        /* 粒度/维度还没实采 → 退回按名或按粒度查表（不猜上限） */
      }
    }
    const byDim = (SR && SR.TIME_GRAIN_BY_DIMENSION) || {};
    let name = wanted;
    if (wanted) {
      try {
        name = findDimension(wanted, grain).name;
      } catch (error) {
        name = wanted;
      }
    }
    if (byDim[name] && Array.isArray(byDim[name])) return byDim[name].slice();
    const byGranularity = (SR && SR.TIME_GRAIN_BY_GRANULARITY) || {};
    const fallback = byGranularity[grain];
    return Array.isArray(fallback) ? fallback.slice() : [];
  }

  /**
   * 指标总数随**「维度 × 时间粒度」**变化的实采值。
   * ⚠️ 该表是**页面知识**，唯一来源在 `selectors.js` 的 `METRIC_COUNT_BY_GRAIN`
   *    （16 个维度 × 各自合法粒度全部实采；未列出的组合返回 null，**绝不猜**）。
   */
  function metricCountByGrainTable(granularity) {
    const SR = getSelectors();
    const grain = granularity == null ? '店铺' : String(granularity);
    const tableName = METRIC_TABLE_BY_GRANULARITY[grain];
    // 未实采的粒度没有表 → 返回空表（调用方得到 null = 跳过严格比对，**不猜**）
    return (tableName && SR && SR[tableName]) || {};
  }

  /**
   * 该维度应有的指标总数（= 页面上「选择 N/M」里的 M）。
   *
   * ⚠️ 两条实机约束（都踩过）：
   *   ① 117 只对「整体」成立，其他维度是 5～24 → 必须是**维度的函数**；
   *   ② 总数**还随「时间粒度」变化**（整体 分日=117、分周=100）→ 必须是**维度 × 粒度的函数**。
   *      旧实现只按维度取值，导致分周/分月"页面 100，预期 117"必然卡在指标全选。
   * 未采集到的组合返回 **null**：引擎侧 `ensureMetrics(null)` 会跳过严格比对，
   * 并把页面实测总数写进任务证据（明确未知 ≠ 拿分日的数字冒充）。
   */
  function expectedMetricCount(dimensionName, granularity, timeGrain) {
    const dimension = findDimension(dimensionName, granularity);
    const grain = String(timeGrain == null ? '分日' : timeGrain);
    const table = metricCountByGrainTable(granularity)[dimension.name];
    if (table && table[grain] != null) return table[grain];
    return grain === '分日' ? dimension.metricCount : null;
  }

  /**
   * ⚠️ **仅保留向后兼容的旧口径**（`= 2 + 指标数`），它**对多数维度是错的**，不要再用于校验。
   *
   * 旧口径只对「表里只有 2 个非指标列」的维度成立（整体 / 分小时 / 人群分类 / 退款 5 维度…）。
   * 实测反例（2026-09-14 W1，归档既有产物）：
   *   · 关键词      分日 = 11 列，不是 2+9=11 …真巧，但结构是 `2 + 2 维度列 + 7 指标列`；
   *   · 流量来源    分日 = **27** 列（旧口径给 2+24=26 → 误判"列数异常"）；
   *   · 流量来源详情 分日 = 22 列 = `2 + 3 维度列 + 17 指标列`（旧口径给 2+20=22，凑巧相等但拆解错）；
   *   · 已完结退款  分日 = 10 列 = `2 + 2 维度列 + 6 指标列`（旧口径给 2+8=10，同样凑巧）。
   * → 校验请一律用 `expectedColumnsFor()`（实测表优先 + 未知返回 null）。
   */
  function expectedColumnCount(dimensionName, granularity, timeGrain) {
    const metrics = expectedMetricCount(dimensionName, granularity, timeGrain);
    return metrics == null ? null : 2 + metrics;
  }

  // ==================================================================================
  // 3b. 导出列数口径（维度 × 时间粒度；显式实测表优先，未知一律 null）
  // ==================================================================================
  /** 列布局实测表（页面知识，唯一来源在 selectors.js）。 */
  function columnLayoutTable() {
    const SR = getSelectors();
    return (SR && SR.COLUMN_LAYOUT_BY_DIMENSION_GRAIN) || {};
  }

  /** 列布局实测表（**按数据粒度分表**）—— 2026-09-15 新增，修掉"同名维度跨粒度串用"的缺陷。 */
  function columnLayoutTableByGranularity(granularity) {
    const SR = getSelectors();
    const grain = granularity == null ? '店铺' : String(granularity);
    const tableName = COLUMN_LAYOUT_TABLE_BY_GRANULARITY[grain];
    return (tableName && SR && SR[tableName]) || {};
  }

  /** 维度列偏移量表（交叉复核用，**不是权威值**；见 selectors.js 的规则说明）。 */
  function columnOffsetTable() {
    const SR = getSelectors();
    return (SR && SR.COLUMN_DIMENSION_OFFSET_BY_DIMENSION_GRAIN) || {};
  }

  /**
   * 该维度应当导出的**列数**（= 表头单元格个数）。
   *
   * 口径来源：`selectors.js` 的 `COLUMN_LAYOUT_BY_DIMENSION_GRAIN`（归档既有产物的实测值）。
   * 规则（实测成立，用于复核）：`列数 = 2（统计日期 + 店铺名称）+ 维度列数 + 指标列数`
   *   —— 旧口径 `2 + 指标数` 漏掉了「关键词 / 退款 / 流量来源系列」导出时多出来的**维度列**。
   *
   * ⚠️ **未知组合一律返回 `null`**（调用方必须「跳过严格比对 + 留证」，不许判失败，**绝不许猜数字**）。
   *   以下是会返回 `null` 的三种已知情形，都要如实标"未知"而不是硬编一个数：
   *     ① 该「维度 × 时间粒度」组合**没有实测列数** —— 判据是实测表里**查不到这一格**
   *        （`selectors.js` 的 `COLUMN_LAYOUT_BY_DIMENSION_GRAIN`）。**这里不点名具体组合**：
   *        该表会随实测推进而补录/新增，任何写死的"未实测举例"都会过期（示例一律以表为准）；
   *     ② 传入了 `extraFilterValues`（额外筛选值会改变导出的维度列，实测样本里没有这种产物）；
   *     ③ 维度未知（查不到）—— 未知维度是配置错误，`findDimension` 会**抛错**（不静默）。
   *
   * @param {string} dimensionName 维度名或维度 code
   * @param {string} [granularity] 数据粒度（一期只有「店铺」）
   * @param {string} [timeGrain]   时间粒度（分日/分周/分月/汇总）；缺省按「分日」查
   * @param {object} [extraFilterValues] 额外筛选值（非空即视为未知，见上 ②）
   * @returns {number|null} 实测列数；未知返回 null
   */
  function expectedColumnsFor(dimensionName, granularity, timeGrain, extraFilterValues) {
    return expectedColumnsDetail(dimensionName, granularity, timeGrain, extraFilterValues).expectedColumns;
  }

  /**
   * 与 `expectedColumnsFor` 同源，但把「为什么是未知」也一并给出（供留证/报告使用）。
   * @returns {{known:boolean, expectedColumns:number|null, dimensionName:string,
   *            timeGrain:string, reason:string}}
   */
  function expectedColumnsDetail(dimensionName, granularity, timeGrain, extraFilterValues) {
    const dimension = findDimension(dimensionName, granularity);
    const grain = String(timeGrain == null || timeGrain === '' ? '分日' : timeGrain);
    const known = (value) => ({
      known: true, expectedColumns: value, dimensionName: dimension.name, timeGrain: grain, reason: '',
    });
    const unknown = (reason) => ({
      known: false, expectedColumns: null, dimensionName: dimension.name, timeGrain: grain, reason,
    });
    const extras = normalizeExtraFilterValues(extraFilterValues, dimension);
    if (Object.keys(extras).length > 0) {
      // 额外筛选值会改变导出的维度列（实测样本里没有这种产物）→ 未知，不猜
      return unknown(`带额外筛选值（${Object.keys(extras).join('、')}）的组合没有实测列数`);
    }
    // ❗❗ 列数实测表**按维度名索引**，而不同粒度有大量**同名维度**（整体/流量来源/…）→
    //    必须显式限定"只在已实测列数的粒度上查表"，否则商品粒度会误用店铺粒度的期望值
    //    （2026-09-15 实测发现：商品粒度 12 个维度与店铺粒度同名）。
    const grainKey = granularity == null ? '店铺' : String(granularity);
    if (!COLUMN_MEASURED_GRANULARITIES.includes(grainKey)) {
      return unknown(`数据粒度「${grainKey}」的导出列数**尚未实测**（已实测：${COLUMN_MEASURED_GRANULARITIES.join(' / ')}）`);
    }
    const table = columnLayoutTableByGranularity(grainKey)[dimension.name];
    const row = table && typeof table === 'object' ? table : null;
    const value = row ? row[grain] : undefined;
    if (value == null) return unknown(`「${dimension.name} / ${grain}」没有实测列数（未采集）`);
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`列布局实测表里的值非法：${dimension.name} / ${grain} = ${value}（应为正整数或 null）`);
    }
    return known(value);
  }

  /**
   * 把一个 (维度 × 时间粒度) 的**实测列数**拆成结构证据：
   * `实测列数 = 2 基础列 + 偏移量 + 平台指标计数`（交叉复核，不参与判定）。
   *
   * 偏移量的实测含义：导出的维度列里**多出来的那一列**（实测只有 0 / 1 两种）。
   * 例：`流量来源 分日` = 2 + 1 + 24 = 27（多出来的是组级来源列 `一级流量来源`）。
   *
   * ⚠️ 这不是"从计数推算列数"的公式 —— 实测 `关键词 分日` 的平台计数 9 与表头里的
   *   7 个指标列并不相等（表头另有 `关键词`、`关键词类型` 两列，且计数器与导出列的定义不同）。
   *   因此**列数一律以实测表为准**，本函数只回答"这个实测值是怎么来的"。
   *
   * @returns {{base:number, offset:number|null, metricCount:number|null, total:number|null,
   *            sum:number|null, consistent:boolean|null}}
   */
  function decomposeMeasuredColumns(dimensionName, granularity, timeGrain) {
    const detail = expectedColumnsDetail(dimensionName, granularity, timeGrain, null);
    const base = 2;
    const empty = { base, offset: null, metricCount: null, total: null, sum: null, consistent: null };
    if (detail.expectedColumns == null) return empty;
    const table = columnOffsetTable()[detail.dimensionName];
    const offsetRaw = table ? table[detail.timeGrain] : undefined;
    const offset = offsetRaw == null ? null : offsetRaw;
    let metricCount = null;
    try {
      metricCount = expectedMetricCount(detail.dimensionName, granularity, detail.timeGrain);
    } catch (error) {
      metricCount = null;
    }
    if (metricCount == null) {
      return {
        base, offset, metricCount: null, total: detail.expectedColumns, sum: null, consistent: null,
      };
    }
    const sum = base + (offset == null ? 0 : offset) + metricCount;
    return {
      base,
      offset,
      metricCount,
      total: detail.expectedColumns,
      sum,
      consistent: (offset == null ? null : sum === detail.expectedColumns),
    };
  }

  /**
   * 生成"期望结构"文案（给 mismatch / subset 的留证用）：
   * `2 基础列 + <偏移量> 维度列 + <平台计数> 指标列`（实测值，不是推算）。
   */
  function structureText(dimensionName, granularity, timeGrain) {
    const parts = decomposeMeasuredColumns(dimensionName, granularity, timeGrain);
    if (parts.offset == null || parts.metricCount == null) return '';
    return `（期望结构：2 基础列 + ${parts.offset} 维度列偏移 + ${parts.metricCount} 平台指标计数 = ${parts.total}）`;
  }

  /**
   * 列数判定：`ok` / `subset` / `mismatch` / `unknown`。
   *
   * ⚠️ 两条铁律（违反任何一条都会把**正确的产物判成失败**）：
   *   ① `expectedColumns == null`（未知）→ 必须 `unknown` + `ok:null`：
   *      "未知"**不等于**"失败"，调用方只跳过严格比对并把页面实测列数写进证据。
   *      （反面教材：把未知硬编成某个数字 → 正确的产物被判"列数异常"。）
   *   ② `实际列数 < 期望列数` 只能是 **`subset`（未知/跳过）**，不能判 mismatch：
   *      导出的指标是**用户勾选的子集**，少列是合法情形。实测证据：归档里有 11 份
   *      `整体/分日` 只有 59 列（PC/无线端拆分口径的子集选择），它们全部 `verdict: ok`、
   *      31 行日期完整 —— 若判 mismatch，就会"把完整产物判成失败"（本波明令禁止）。
   *      用户的真实损失是"漏了指标"，而不是"这批数据不可解读"，因此报 mismatch 是错的假警报。
   *   ③ `实际列数 > 期望列数` 才是真的可疑（页面上出现了期望之外的新列）→ `mismatch`。
   *
   * @param {{dimensionName:string, granularity?:string, timeGrain?:string,
   *          extraFilterValues?:object, actualColumns:number}} input
   * @returns {{ok:boolean|null, verdict:'ok'|'subset'|'mismatch'|'unknown', expectedColumns:number|null,
   *            actualColumns:number|null, reason:string}}
   */
  function checkColumnCount(input) {
    const opts = input || {};
    const detail = expectedColumnsDetail(
      opts.dimensionName, opts.granularity, opts.timeGrain, opts.extraFilterValues);
    const raw = opts.actualColumns;
    const actual = raw == null || raw === '' ? null : Number(raw);
    const actualColumns = Number.isFinite(actual) ? actual : null;
    if (detail.expectedColumns == null) {
      return {
        ok: null, verdict: 'unknown', expectedColumns: null, actualColumns,
        reason: `列数未知，跳过严格比对并留证：${detail.reason}（页面实测 ${actualColumns == null ? '未读到' : actualColumns} 列）`,
      };
    }
    if (actualColumns == null) {
      return {
        ok: null, verdict: 'unknown', expectedColumns: detail.expectedColumns, actualColumns: null,
        reason: '页面未读到表头，未做列数比对',
      };
    }
    if (actualColumns < detail.expectedColumns) {
      const shape = structureText(detail.dimensionName, opts.granularity, detail.timeGrain);
      return {
        ok: null, verdict: 'subset', expectedColumns: detail.expectedColumns, actualColumns,
        reason: `列数少于期望（页面 ${actualColumns} < 期望 ${detail.expectedColumns}）：**按指标子集处理，不判失败**`
          + `（勾选的指标是用户子集，少列合法）；${detail.dimensionName} / ${detail.timeGrain} 实测值${shape}`,
      };
    }
    if (actualColumns > detail.expectedColumns) {
      const shape = structureText(detail.dimensionName, opts.granularity, detail.timeGrain);
      return {
        ok: false, verdict: 'mismatch', expectedColumns: detail.expectedColumns, actualColumns,
        reason: `列数不符：页面 ${actualColumns} 多于期望 ${detail.expectedColumns}`
          + `（维度「${detail.dimensionName}」/ ${detail.timeGrain} 实测值）${shape}`
          + ' —— 期望之外多出了列，需人工确认是否平台口径变化',
      };
    }
    return {
      ok: true, verdict: 'ok', expectedColumns: detail.expectedColumns, actualColumns, reason: '',
    };
  }

  /**
   * 用**分组前缀规则**从表头重建「指标列数」（用于复核实测表，不用于判定）。
   * 规则见 `selectors.js` 的 `HEADER_GROUP_PATTERN`：前缀只认 `·` 与 `|`，不认 `-`。
   * @returns {{total:number, ungrouped:number, groups:object, metricColumns:number}}
   */
  function countMetricColumnsFromHeader(headers) {
    const SR = getSelectors();
    const list = Array.isArray(headers) ? headers : [];
    const metrics = list.slice(2); // 前 2 列固定为「统计日期 / 店铺名称」
    const parse = (SR && SR.parseHeaderGroups) || (() => ({}));
    const groups = parse(metrics);
    const ungrouped = groups.__ungrouped__ || 0;
    const grouped = Object.keys(groups).reduce((sum, k) => sum + (k === '__ungrouped__' ? 0 : groups[k]), 0);
    return { total: metrics.length, ungrouped, groups, metricColumns: grouped + ungrouped };
  }

  // ==================================================================================
  // 3c. 平台 10 万行静默截断：**检出 + 留证 + 更细分片**（2026-09-14 新增）
  // ==================================================================================
  /**
   * 默认分片单位（按「维度 × 时间粒度」自动选）。
   *
   * 规则与依据（全部来自实机，不猜）：
   *   ① `分周` → 'week'：周控件只能表达整周，按月切会切出"半个周"⇒ 口径错配（Y1/Z1 场次实证）。
   *   ② `rowRisk:'high'` 的维度在 分日/分小时 下 → 'week'：
   *      实测该维度分日整月导出 = 100,001 行（含表头）⇒ 撞上平台 10 万行上限、**静默截断**（DET2 场次）。
   *      按周切后单片约 2.3 万行，安全；对"更细粒度分片"的要求可用 chunkUnit:'day' 显式满足。
   *   ③ 其余 → 'month'（保持历史行为，避免无证据地改变其它维度的产出形态）。
   *   ④ ⭐ 2026-09-20 新增：`分月` **一律 'month'**（提前于 ②rowRisk 判断，高行数维度也不例外）。
   *      依据（2026-09-19 实证 + 已处置事故）：平台在**分月口径下只按整月返回** —— 按周切片时每个切片
   *      都会返回**同一个整月**的数据，于是同一个月被下载 4~5 次；而这些重复份的**文件字节各不相同**
   *      ⇒ 入库侧的文件级 sha256 兜不住 → 该维度分月被重复计数。当时 `流量来源详情/分月` 就是这么
   *      产出 118 份（= 27 个月 × 4~5）并被整体隔离重采的。
   *      ⚠️ 推论：分月撞上 10 万行上限时**没有**"更细时间分片"这条退路（平台不接受半个自然月），
   *      只能改按更细维度/额外筛选拆分，或明确记录该月缺口 —— 见 detectRowCap 的分月专用文案。
   */
  function autoChunkUnit(dimensionName, granularity, timeGrain) {
    const grain = String(timeGrain == null ? '分日' : timeGrain);
    // 分月必须整月切片：**放在 rowRisk 判断之前**，否则商品粒度高行数维度会被切成周 → 重复下载整月
    if (grain === '分月') return 'month';
    if (grain === '分周') return 'week';
    const SR = getSelectors();
    const dimension = findDimension(dimensionName, granularity);
    // ⭐ 2026-09-15 二期默认：**商品粒度的行数风险天生更高**（一行 = 一个商品/SKU/来源层级，
    //    而店铺粒度一行 = 一天）。店铺粒度整月才 31~235 行，商品粒度**一天就可能上千行**，
    //    撞上平台 10 万行静默截断的概率远大于店铺粒度 → 未显式声明 rowRisk 的商品维度
    //    一律按 'high' 处理（分日 → 按周/按天切），**宁可多跑几次，也不要静默丢数据**。
    const grainKey = granularity == null ? '店铺' : String(granularity);
    // 2024 全年实测：以下商品分日维度按周下载的每个切片均触发 10 万行上限。
    // 后续年度默认按日切；单日若仍超限，闭合校验继续显式报缺口。
    if (grainKey === '商品' && grain === '分日' && [
      '流量来源', '流量来源分人群(新版)', '流量来源分人群', '流量来源详情',
    ].includes(dimension.name)) return 'day';
    const rowRisk = dimension.rowRisk || (grainKey === '商品' ? 'high' : 'normal');
    if (rowRisk === 'high') {
      const finest = SR && SR.PLATFORM && SR.PLATFORM.finestChunkUnitForRowRisk;
      return finest === 'day' ? 'day' : 'week';
    }
    return 'month';
  }

  /**
   * 从**结果视图文案**里解析平台认定的导出总行数。
   * 判据文案（实机原文）：`共31条数据，预览最多显示前30条数据`
   * → 预览表只挂前 30 行，**数 DOM 行数会永远得到 ≤30**，只有这段文字是权威。
   * @returns {number|null} 解析不到返回 null（未知，不猜）
   */
  function parseRowCountText(text) {
    const SR = getSelectors();
    const re = (SR && SR.PLATFORM && SR.PLATFORM.rowCountText) || /共\s*([\d,]+)\s*条数据/;
    const m = re.exec(String(text == null ? '' : text));
    if (!m) return null;
    const n = Number(String(m[1]).replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  }

  /**
   * 解析**超限警告**（平台在原位给的另一句文案）。
   *
   * 实机原文（2026-09-14 TRUNC1 场次现场直读）：
   *   `当前数据量已超过单次最大可下载数据量10万条。建议通过减少时间范围、下载指标等控制文件大小`
   * ⚠️ 关键事实：**超限时平台不再显示**「共N条数据」，只显示这句 → 只认①会漏判（第一版就漏了）。
   * @returns {{overCap:boolean, declaredCap:number|null, raw:string|null}}
   */
  function parseRowCapWarning(text) {
    const SR = getSelectors();
    const re = (SR && SR.PLATFORM && SR.PLATFORM.rowCapWarningText)
      || /已超过单次最大可下载数据量\s*([\d.]+)\s*万条/;
    const m = re.exec(String(text == null ? '' : text));
    if (!m) return { overCap: false, declaredCap: null, raw: null };
    const wan = Number(m[1]);
    const declaredCap = Number.isFinite(wan) ? Math.round(wan * 10000) : null;
    return { overCap: true, declaredCap, raw: m[0] };
  }

  /**
   * 判定"这一次导出是否**疑为被平台截断**"。
   *
   * 判据（只有一条，够硬）：**平台自报的总行数 ≥ 单次导出行上限**。
   * 达到上限几乎不可能是巧合 —— 实测那次正好是 100,000 行且日期列提前中断。
   * 未取到行数（rowCount == null）→ `suspect:false` 但 `known:false`，**在证据里明确标"未取到"**，
   * 不用"未知"冒充"安全"。
   *
   * @returns {{known:boolean, suspect:boolean, rowCount:number|null, rowCap:number,
   *            kind:string, recommendedChunkUnit:string, message:string}}
   */
  function assessRowCap(input) {
    const opts = input || {};
    const SR = getSelectors();
    const rowCap = Number((SR && SR.PLATFORM && SR.PLATFORM.rowCap) || 100000);
    const raw = opts.rowCount;
    const rowCount = raw == null || raw === '' ? null : Number(raw);
    let known = Number.isFinite(rowCount);
    // 判据②：平台的明示超限警告（超限时**没有**「共N条数据」文案 → 必须单独认这一条）
    const overCap = !!opts.overCapWarning;
    if (!known && overCap) {
      // 警告只说"超过 10 万条"，不给确切行数：**不伪造具体数字**，只记录它的下界语义
      known = false;
    }
    const suspect = overCap || (known && rowCount >= rowCap);
    const dimension = opts.dimensionName == null ? '' : String(opts.dimensionName);
    const grain = opts.timeGrain == null ? '' : String(opts.timeGrain);
    const range = `${opts.startDate || '?'}~${opts.endDate || '?'}`;
    let recommendedChunkUnit = null;
    // ⭐ 2026-09-20：`分月`/`分周` 撞上限时**不能**建议"更细时间分片"——
    //    分月只按整月返回（按周切 = 整月重复下载 4~5 次，2026-09-19 实证）；
    //    分周只表达整周（切到日/月 = 口径错配，Y1/Z1 场次实证）。
    //    这两种粒度给"chunkUnit=day"这条建议本身就是错的 ⇒ 单独给可行退路。
    const noTimeSliceRemedy = suspect && (grain === '分月' || grain === '分周');
    if (suspect && !noTimeSliceRemedy) {
      try {
        recommendedChunkUnit = autoChunkUnit(dimension, opts.granularity, grain);
      } catch (error) {
        // 维度未知（配置错）不该在这里炸：给最保守的建议并留证
        recommendedChunkUnit = 'week';
      }
    }
    const remedy = noTimeSliceRemedy
      ? (grain === '分月'
        ? '**分月口径没有"更细时间分片"这条退路**（平台只按整月返回，按周切会把同一个整月重复下载 4~5 次，'
          + '2026-09-19 已实证并隔离过 118 份重复产物）⇒ 只能改按**更细维度/额外筛选拆分**重取，或明确记录该月缺口。'
        : '**分周口径没有"更细时间分片"这条退路**（周控件只表达整周，切到日/月就是口径错配，Y1/Z1 场次实证）'
          + '⇒ 只能改按**更细维度/额外筛选拆分**重取，或明确记录该周缺口。')
      : `**需按更细粒度分片重取**（建议 chunkUnit=${recommendedChunkUnit}，或 'day'）。`;
    const warningRaw = opts.overCapWarningRaw || null;
    const message = suspect
      ? (overCap && !known
        ? `⚠️ **平台明示超过单次下载上限**：维度「${dimension}」${grain} ${range} 结果视图提示「${warningRaw || '已超过单次最大可下载数据量10万条'}」，`
          + `导出的文件**必然已被截断**（实测同场景：日期列提前中断、平台不报错）。${remedy}`
        : `⚠️ 疑为平台静默截断：维度「${dimension}」${grain} ${range} 平台自报 **${rowCount}** 行，已达单次导出上限 ${rowCap} 行`
          + `（实测该上限处日期会提前中断）。${remedy}`)
      : (known
        ? `行数证据：平台自报 ${rowCount} 行 < 上限 ${rowCap} 行（未触发截断判据）`
        : '行数证据：结果视图既没有「共N条数据」也没有超限警告 —— **未知**（既不能判截断，也不能当安全）');
    return {
      known,
      suspect,
      overCap: overCap,
      overCapWarning: warningRaw,
      rowCount: known ? rowCount : null,
      rowCap,
      kind: 'row_cap_truncation_suspected',
      recommendedChunkUnit,
      message,
    };
  }

  // ==================================================================================
  // 3b. 额外筛选值的**显式覆盖**（2026-09-14 新增）
  // ==================================================================================
  /**
   * 背景：带额外筛选控件的维度（如「关键词」的分词类型），平台**自己给了默认选中值**
   *      （分词类型默认"搜索词+长尾词"），因此首版只校验"至少选了一项"并留证。
   *      要精确控制（例如"只要长尾词"）就必须能**显式覆盖**某个筛选控件的取值。
   *
   * 配置形状（background / popup / 深链接共用同一份，纯函数层负责解析与校验）：
   *   {
   *     关键词: { 分词类型: ['长尾词'] },                    // 精确到"维度 → 控件 → 值时"
   *     流量来源: { 来源类型: '商品流量' },                   // 单值也接受字符串
   *     默认:     { 分词类型: ['长尾词'] },                    // 维度键为「默认」= 对调用方未指定值的维度兜底
   *   }
   *
   * 三条纪律（与全项目一致）：
   *   ① **只认维度声明的控件**：key 不在该维度的 `extraFilters` 里 → 抛错（错配绝不静默忽略）；
   *   ② **值不能为空**：空数组 / 空串 → 抛错（"覆盖成空"会退化成无筛选查询，产出无法判定的数据）；
   *   ③ **顺序确定**：值数组去重后按字典序排序，返回的对象按控件名字典序 —— 保证任务 key 可复现
   *      （同一个语义配置永远得到同一个任务 key，断点续跑与缓存判定才可靠）。
   *
   * @param {*} raw            原始 extraFilterValues（可为 undefined/null → 返回 {}）
   * @param {object} dimension 该维度的定义（含 extraFilters）
   * @returns {object} 冻结的 { 控件名: 冻结的值数组 }
   */
  /**
   * ⭐⭐ 2026-09-17（Codex《客户品类首轮验收意见》第 4/5 条重做后）：
   *   **同一维度的额外筛选控件会随「时间粒度」变化**，而且**控件冲突必须按"当前粒度/维度稳定后的有效读数"收口**，
   *   不能按"哪次跑通了"或"哪次看起来更合理"来选。
   *
   * 实测（只读控件探针，**每个维度一次全新页面加载**，读数须满足
   *   `dimensionPanelProven`（面板归属本维度）+ 粒度单选回读一致 + 连续 3 次一致 + 距切换 ≥1200ms）：
   *     · `品类 / 整体`：分日/分周/分月 = `终端类型 + 类目`；**汇总 = 只有 `类目`**
   *       —— 判据是**读那一刻「选择指标」计数 = 13/13**（汇总专属的缩小指标集合），
   *          且 `controlsDisappeared = ['终端类型']`（切换前有、切换后没了 ⇒ 面板确实换了）。
   *     · `品类 / 流量来源`：只有 分月，该粒度控件 = **`转化效果归属`**（无 `终端类型`、无 `类目`）
   *     · `品类 / 流量来源详情`：只有 分月，该粒度控件 = **`转化效果归属`**
   *
   * ❗❗ 这里必须留一条"我们错过一次"的记录（否则后来人会照着错的注释再错一次）：
   *   旧注释（2026-09-16 版）曾写「`品类/流量来源` **分月** 是 `终端类型 + 类目`」，
   *   依据是 `readonly_filters_品类_2026-09-16T1523.json` 自报 `filterPanelSettled=true`。
   *   那次读数是**上一个维度（整体）的面板残留**——旧"稳定"判据只有 17 位"控件存在性签名"，
   *   锁在旧面板上照样"连续两次一致"（假稳定）。同理 `T1440/T1447` 报的"`终端类型`+`转化效果归属`"
   *   也是整体那只 `终端类型` 的残留。
   *   → 结论：**控件冲突一律以"面板归属已证明 + 逐粒度有效读数"为准**；
   *     收口记录见 `docs/codex_handoff/控件冲突与收口.json`，探针判据见 content.js 的 `formPanelFingerprint`。
   *   → 另外把"控件按粒度"这条能力留下来：维度可声明 `extraFiltersByGrain: { 粒度: [控件…] }`，
   *     本函数**按当前时间粒度**取（`品类/整体` 是全项目第一个真正用到它的维度）。
   *     只声明一份"按维度"的 `extraFilters` 会让引擎在某个粒度上**空等一个不存在的控件**
   *     （实测：3 个任务 `failed_permanent`，错误是"额外筛选控件未渲染出来：等待超时"）。
   *
   * 兜底规则（宁可少等，也不空等）：该粒度没在 `extraFiltersByGrain` 里列出时，
   *   · 若维度级 `extraFilters` 非空 → 用它（视为"与粒度无关"）；
   *   · 否则 → 返回 `[]`（不等待任何控件；**不猜**）。
   *
   * @param {object} dimension   维度定义
   * @param {string} timeGrain   当前时间粒度（分日/分周/分月/汇总）
   */
  function resolveExtraFilters(dimension, timeGrain) {
    const dim = dimension || {};
    const grain = String(timeGrain == null ? '' : timeGrain);
    const byGrain = dim.extraFiltersByGrain;
    if (byGrain && typeof byGrain === 'object' && Array.isArray(byGrain[grain])) {
      return byGrain[grain].slice();
    }
    return Array.isArray(dim.extraFilters) ? dim.extraFilters.slice() : [];
  }

  function normalizeExtraFilterValues(raw, dimension) {
    if (!dimension || typeof dimension !== 'object') throw new Error('normalizeExtraFilterValues 需要维度定义');
    if (raw == null) return Object.freeze({});
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`extraFilterValues 必须是对象（形如 { 维度: { 控件: [值] } }），实际收到 ${Array.isArray(raw) ? 'Array' : typeof raw}`);
    }
    // ⭐ 2026-09-16：声明集必须**按粒度**取（同一维度不同粒度控件可能不同）；
    //   可选参数 timeGrain 由调用方给出（不给则退回维度级声明，与旧行为一致）。
    const declared = resolveExtraFilters(dimension, arguments.length > 2 ? arguments[2] : null);

    // 取该维度自己的配置：优先维度名，其次维度 code；两者都没有再看「默认」
    const pick = (key) => (Object.prototype.hasOwnProperty.call(raw, key) ? raw[key] : undefined);
    let mine = pick(dimension.name);
    if (mine === undefined && dimension.code) mine = pick(dimension.code);
    if (mine === undefined) mine = pick('默认');
    if (mine == null) return Object.freeze({});
    if (typeof mine !== 'object' || Array.isArray(mine)) {
      throw new Error(`extraFilterValues.${dimension.name} 必须是对象（形如 { ${declared[0] || '控件名'}: [值] }）`);
    }

    const out = {};
    for (const label of Object.keys(mine).sort()) {
      const value = mine[label];
      if (!label || !String(label).trim()) throw new Error(`extraFilterValues.${dimension.name} 存在空控件名`);
      if (!declared.includes(label)) {
        throw new Error(`额外筛选控件「${label}」不属于维度「${dimension.name}」（该维度声明的控件：${declared.length ? declared.join(' / ') : '无'}）`);
      }
      const list = (Array.isArray(value) ? value : [value])
        .map((v) => (v == null ? '' : String(v).trim()))
        .filter((v) => v !== '');
      if (list.length === 0) {
        throw new Error(`额外筛选值不能为空：维度「${dimension.name}」的「${label}」（"覆盖成空"会退化成无筛选查询）`);
      }
      // ⭐ 2026-09-14 收尾 ②：值是否在该控件的**实采选项全集**里 —— 建会话前就拒绝（不等到页面上才发现）
      //   只在"该维度 × 该控件"确实采集过选项时才校验：没采集过就不猜（留给页面侧 applyOptionValues 报错）。
      const knownOptions = knownFilterOptions(dimension.name, label);
      if (knownOptions) {
        const bad = list.filter((v) => !knownOptions.includes(v));
        if (bad.length > 0) {
          throw new Error(`额外筛选值不在平台可选范围内：维度「${dimension.name}」的「${label}」不存在「${bad.join('/')}」`
            + `（实采可选值：${knownOptions.join(' / ')}）`);
        }
      }
      const unique = Array.from(new Set(list)).sort();
      out[label] = Object.freeze(unique);
    }
    return Object.freeze(out);
  }

  /**
   * 查「维度 × 控件」的**实采选项全集**（来自 selectors.js 的 `DIMENSION_FILTER_CHOICES` /
   * `EXTRA_FILTER_CHOICES`）。采集不到 → 返回 null（**不猜**，调用方据此跳过校验）。
   */
  function knownFilterOptions(dimensionName, controlLabel) {
    const SR = getSelectors();
    const perDim = (SR && SR.DIMENSION_FILTER_CHOICES) || {};
    const byCtrl = (SR && SR.EXTRA_FILTER_CHOICES) || {};
    const dim = perDim[String(dimensionName == null ? '' : dimensionName)];
    // ⚠️ 同名控件在不同维度下选项可能不同（实测：人群类型 / 转化效果归属）→ 优先按「维度 × 控件」查
    if (dim && Array.isArray(dim[controlLabel])) return dim[controlLabel].slice();
    const entry = byCtrl[String(controlLabel == null ? '' : controlLabel)];
    return entry && Array.isArray(entry.options) ? entry.options.slice() : null;
  }

  /** 额外筛选值的稳定指纹（进任务 key；无配置时为空串，保持与旧 key 完全一致）。 */
  function extraFilterFingerprint(values) {
    if (!values || typeof values !== 'object') return '';
    const keys = Object.keys(values).sort();
    if (keys.length === 0) return '';
    return keys.map((k) => `${k}=${values[k].join('+')}`).join('&');
  }

  // ==================================================================================
  // 4. 任务清单（冻结后只允许减少，不允许新增）
  // ==================================================================================

  /**
   * 生成**冻结的任务清单**。
   *
   * @param {object} opts
   * @param {string|number} opts.storeId       店铺 ID（动态识别，进 key / 归档路径）
   * @param {string} opts.storeName            店铺名（归档路径）
   * @param {string} [opts.granularity]        数据粒度，默认 '店铺'（一期固定；函数能处理二期粒度，但只校验矩阵合法性）
   * @param {string} opts.timeGrain            时间粒度（分日 / 分周 / 分月 / 汇总）
   * @param {string} opts.startDate            区间起（含）
   * @param {string} opts.endDate              区间止（含）
   * @param {string[]} opts.dimensionNames     维度名或 code 数组（一期必须来自 SR.DIMENSIONS_STORE）
   * @param {string} [opts.batch]              批次号（进 reportName；避免与历史批次重名）
   * @param {string} [opts.chunkUnit]          'month'（默认，自然月）| 'none'（整段一片）
   * @param {object} [opts.extraFilterValues]  额外筛选值的**显式覆盖**（维度 → 控件 → 值时；见 normalizeExtraFilterValues）
   * @returns {ReadonlyArray<object>} 冻结任务数组
   */
  function buildTaskCatalog(opts) {
    const SR = getSelectors();
    const options = opts || {};
    const granularity = options.granularity == null ? '店铺' : String(options.granularity);
    const timeGrain = options.timeGrain == null ? '' : String(options.timeGrain);
    const storeId = options.storeId == null ? '' : String(options.storeId).trim();
    const storeName = String(options.storeName == null ? '' : options.storeName).trim();
    const batch = options.batch == null ? '' : String(options.batch).trim();

    // ---- 数据粒度合法性（合法值只有一份：SR.CONST.granularity）
    const legalGranularities = Object.values(SR.CONST.granularity);
    if (!legalGranularities.includes(granularity)) {
      throw new Error(`未知数据粒度：${granularity}（合法值：${legalGranularities.join(' / ')}）`);
    }
    // ⭐ 2026-09-15：**「商品」粒度已开放**（维度清单/逐格指标总数已实采，见 selectors.js 的 DIMENSIONS_ITEM）。
    //    「客户 / 品类」仍**故意挡在这里** —— 它们的维度清单与指标总数**一个字都没实采**，
    //    放行就等于闭着眼睛提交（历史教训：`流量来源详情` 把 20 写成 24 → 生效判据恒不满足、三连失败）。
    //    开放方式：照商品粒度的做法先跑只读枚举探针（`sr_action=ENUMERATE&sr_granularity=客户|品类`），
    //    把实测值补进 selectors.js 后再在 DIMENSION_TABLE_BY_GRANULARITY 里加一行。
    if (!DIMENSION_TABLE_BY_GRANULARITY[granularity]) {
      throw new Error(`数据粒度「${granularity}」尚未实采维度清单，未开放（已开放：${Object.keys(DIMENSION_TABLE_BY_GRANULARITY).join(' / ')}）`);
    }

    // ---- 时间粒度必须按 SR.TIME_GRAIN_BY_GRANULARITY 校验：非法组合**抛错**，不静默跳过
    const legalGrains = SR.TIME_GRAIN_BY_GRANULARITY[granularity];
    if (!Array.isArray(legalGrains)) {
      throw new Error(`selectors.js 缺少粒度 ${granularity} 的时间粒度矩阵`);
    }
    if (!timeGrain) throw new Error('时间粒度不能为空');
    // ⭐ 2026-09-15 顺序修正：**维度级的合法粒度优先于粒度级矩阵**。
    //    反例（商品粒度实采）：矩阵写的是 `商品: ['分日']`（那是从维度清单"看到的"粒度），
    //    但实测「连带」只有 分周、「SKU」还有 分月/汇总 → 若先按矩阵拒绝，合法组合会被误挡。
    //    所以：**先按维度校验（有实测值就是权威）**，矩阵只在该粒度没有维度级实测时才当判据。
    const hasDimensionLevelGrains = Array.isArray(options.dimensionNames) && options.dimensionNames.some((raw) => {
      try {
        return legalTimeGrains(findDimension(raw, granularity).name, granularity).length > 0;
      } catch (error) {
        return false;
      }
    });
    if (!hasDimensionLevelGrains && !legalGrains.includes(timeGrain)) {
      throw new Error(`非法时间粒度组合：数据粒度「${granularity}」不支持时间粒度「${timeGrain}」（合法值：${legalGrains.join(' / ')}）`);
    }
    // ⚠️ 逐维度再校验一次（2026-09-14 收尾 ④）：时间粒度实际是**按维度**给的
    //    （如「关键词」只有 分日+汇总），必须在建会话前就拒绝，不能等到页面上点不动。
    if (Array.isArray(options.dimensionNames)) {
      for (const raw of options.dimensionNames) {
        let dimName = raw;
        try {
          dimName = findDimension(raw, granularity).name;
        } catch (error) {
          // 未知维度交给后面的维度解析去报错（保持原有的报错口径）
          continue;
        }
        const dimGrains = legalTimeGrains(dimName, granularity);
        if (dimGrains.length && !dimGrains.includes(timeGrain)) {
          throw new Error(`非法时间粒度组合：维度「${dimName}」不提供时间粒度「${timeGrain}」`
            + `（该维度实测可用：${dimGrains.join(' / ')}；实测表见 selectors.js 的 TIME_GRAIN_BY_DIMENSION）`);
        }
      }
    }

    // ---- 店铺标识
    if (!storeId) throw new Error('缺少店铺 ID，任务 key 无法唯一');
    if (!storeName) throw new Error('缺少店铺名，归档路径无法生成');

    // ---- 维度
    const dimensionNames = options.dimensionNames;
    if (!Array.isArray(dimensionNames) || dimensionNames.length === 0) {
      throw new Error('dimensionNames 必须是非空数组');
    }
    const seenNames = new Set();
    const dimensions = dimensionNames.map((name) => {
      const dimension = findDimension(name, granularity);
      if (seenNames.has(dimension.name)) throw new Error(`维度重复：${dimension.name}`);
      seenNames.add(dimension.name);
      return dimension;
    });

    const availability = availabilityTable();
    for (const dimension of dimensions) {
      const key = `${granularity}|${dimension.name}|${timeGrain}`;
      const earliest = availability[key];
      if (earliest && compareDates(options.startDate, earliest) < 0) {
        throw new Error(`${granularity}/${dimension.name}/${timeGrain} 最早可取 ${earliest}（取数维度及时间表）；当前开始日期 ${options.startDate} 过早`);
      }
    }

    // ---- 区间与分片
    const range = assertDateRange(options.startDate, options.endDate);
    // 分片单位：
    //   · 显式传入 chunkUnit → 用它（含 'day'：撞上平台 10 万行上限时的最细分片手段）
    //   · 未传 → 按「维度 × 时间粒度」自动选（见 autoChunkUnit），**逐维度**计算：
    //     同一会话里可能混着"明细类高行数维度"（需按周/按天）与"普通维度"（按月即可）。
    // ⚠️ '' 与 undefined 一样都表示"**自动**"（界面下拉框的空值就是空串；不能因为它是"有值"就报错）
    const explicitChunkUnit = options.chunkUnit == null || options.chunkUnit === ''
      ? null : String(options.chunkUnit);
    if (explicitChunkUnit != null && !CHUNK_UNITS.includes(String(explicitChunkUnit))) {
      throw new Error(`不支持的 chunkUnit：${explicitChunkUnit}（合法值：${CHUNK_UNITS.join(' / ')}）`);
    }
    // ❗❗ 2026-09-20 硬门禁：**切片单位必须与时间粒度的口径一致**（表驱动，直接抛错，不静默改写）。
    //    · 分月 + week/day ⇒ 平台在分月口径下**只按整月返回**，于是每个周切片都返回同一个整月
    //      → 同一个月被下载 4~5 次；且各份文件字节不同 ⇒ 入库侧文件级 sha256 兜不住 ⇒ 重复计数。
    //      （2026-09-19 实证：`流量来源详情/分月` 曾产出 118 份 = 27 月 × 4~5，已整体隔离重采。）
    //    · 分周 + month/day ⇒ 平台周控件只表达整周，切出"半个周"就是**口径错配**（Y1/Z1 场次实证）。
    //    显式传入多半来自深链接/脚本拼参（`sr_chunk=`），属于调用方错配 ⇒ 必须**启动前**报错，
    //    而不是跑完几百个任务、产出一堆重复/错口径文件之后才发现。
    //    'none' 一律放行（整段一片：切片边界仍是合法口径，平台按粒度返回，不会重复）。
    const GRAIN_CHUNK_GUARD = {
      分月: { forbid: ['week', 'day'], why: '平台在分月口径下只按整月返回，会造成同一个月被重复下载（2026-09-19 实证，已隔离过 118 份重复产物）', allow: 'chunkUnit=month（或不传，走自动）' },
      分周: { forbid: ['month', 'day'], why: '平台周控件只表达整周，切出"半个周"就是口径错配（Y1/Z1 场次实证）', allow: 'chunkUnit=week（或不传，走自动）' },
    };
    const guard = GRAIN_CHUNK_GUARD[String(options.timeGrain)];
    if (guard && explicitChunkUnit != null && guard.forbid.includes(String(explicitChunkUnit))) {
      const nameOf = { week: '周', day: '日', month: '月' };
      throw new Error(`「${options.timeGrain}」不能按${nameOf[String(explicitChunkUnit)] || explicitChunkUnit}切片：`
        + `${guard.why}；请用 ${guard.allow}`);
    }

    // ---- 生成任务（按维度 → 分片顺序，保证清单顺序稳定、可复现）
    const tasks = [];
    const keys = new Set();
    for (const dimension of dimensions) {
      // 额外筛选的显式覆盖：解析 + 校验（只认该维度声明的控件、值不得为空）——**建会话前**就拒绝错配
      const extraFilterValues = normalizeExtraFilterValues(options.extraFilterValues, dimension);
      const efFp = extraFilterFingerprint(extraFilterValues);
      const dimensionChunkUnit = explicitChunkUnit == null
        ? autoChunkUnit(dimension.name, granularity, timeGrain)
        : String(explicitChunkUnit);
      const chunks = chunkRange(range.start, range.end, dimensionChunkUnit);
      for (const chunk of chunks) {
        const key = `${storeId}:${dimension.code}:${timeGrain}:${chunk.start}:${chunk.end}`
          + (efFp ? `|${efFp}` : '');
        if (keys.has(key)) throw new Error(`任务 key 重复：${key}`);
        keys.add(key);
        tasks.push({
          key,
          storeId,
          storeName,
          granularity,
          dimension: dimension.name,
          dimensionCode: dimension.code,
          timeGrain,
          chunkUnit: dimensionChunkUnit,
          rowRisk: dimension.rowRisk || 'normal',
          startDate: chunk.start,
          endDate: chunk.end,
          dateRange: { start: chunk.start, end: chunk.end },
          batch: batch || null,
          // 指标总数必须按「维度 × 时间粒度」取值（整体 分日=117、分周=100）；未采集的粒度返回 null（未知）
          expectedMetricCount: expectedMetricCount(dimension.name, granularity, timeGrain),
          // ⭐ 2026-09-16：按**当前时间粒度**解析额外筛选控件（同一维度不同粒度可能完全不同，实测品类/流量来源）
          extraFilters: resolveExtraFilters(dimension, timeGrain),
          // 未在 extraFilterValues 里指定的控件 → 空对象 → 引擎沿用平台默认值（只校验"至少选了一项"）
          extraFilterValues,
          reportName: SR.REPORT_NAME.build(storeId, granularity, dimension.code, timeGrain, chunk.start, chunk.end, batch),
          status: 'pending',
          attempts: 0,
          error: null,
          download: null,
          evidence: null,
        });
      }
    }

    // 冻结：调用方拿到的是深冻结对象，执行期间**只允许作废（置 ended），不允许新增/改写**
    return Object.freeze(tasks.map((task) => deepFreeze(task)));
  }

  /** 递归冻结（纯函数层不持有可变共享状态）。 */
  function deepFreeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      Object.getOwnPropertyNames(value).forEach((name) => deepFreeze(value[name]));
      Object.freeze(value);
    }
    return value;
  }

  /** 按维度分组统计任务数，用于执行前展示"预计任务数"。 */
  function summarizeTasks(tasks) {
    const counts = {};
    let total = 0;
    for (const task of Array.isArray(tasks) ? tasks : []) {
      const status = task && task.status ? task.status : 'unknown';
      counts[status] = (counts[status] || 0) + 1;
      total += 1;
    }
    return { total, counts: Object.freeze(counts) };
  }

  function findTask(tasks, taskKey) {
    return (Array.isArray(tasks) ? tasks : []).find((task) => task && task.key === taskKey) || null;
  }

  // ==================================================================================
  // 5. 任务状态机
  // ==================================================================================

  const TASK_STATES = Object.freeze({
    PENDING: 'pending',
    NAVIGATING: 'navigating',
    READY: 'ready',
    EXPORT_CLICKED: 'export_clicked',
    PLATFORM_PROCESSING: 'platform_processing',
    DOWNLOADING: 'downloading',
    VALIDATING: 'validating',
    DONE: 'done',
    ERROR: 'error',
    RETRY_WAIT: 'retry_wait',
    DELAYED: 'delayed',
    ENDED: 'ended',
    /** 新插件**必须新增**的终态（红猫 1.0.24 缺失）：达重试上限，显式留缺口。 */
    FAILED_PERMANENT: 'failed_permanent',
  });

  /** 线性主链路（advanceTaskTo 按这个顺序补齐中间态）。 */
  const TASK_LINEAR_FLOW = Object.freeze([
    'pending', 'navigating', 'ready', 'export_clicked',
    'platform_processing', 'downloading', 'validating', 'done',
  ]);

  const TASK_TRANSITIONS = Object.freeze({
    // ⚠️ 2026-09-13 修正：**任何非终态都必须能进入 failed_permanent**。
    //    原表不允许 navigating → failed_permanent，导致「尝试次数耗尽时任务正停在 navigating」
    //    这一最常见情形无法判定永久失败（会把任务永久卡在 navigating）。语义上，
    //    永久失败是任何进行态的合法归宿；done/ended 才是真正的终态。
    pending: Object.freeze(['navigating', 'failed_permanent', 'ended']),
    navigating: Object.freeze(['ready', 'retry_wait', 'delayed', 'error', 'failed_permanent', 'ended']),
    ready: Object.freeze(['export_clicked', 'done', 'error', 'failed_permanent', 'ended']),
    export_clicked: Object.freeze(['platform_processing', 'error', 'failed_permanent', 'ended']),
    platform_processing: Object.freeze(['downloading', 'retry_wait', 'delayed', 'error', 'failed_permanent', 'ended']),
    downloading: Object.freeze(['validating', 'retry_wait', 'error', 'failed_permanent', 'ended']),
    validating: Object.freeze(['done', 'retry_wait', 'error', 'failed_permanent', 'ended']),
    // 失败/等待态：可以回到 pending 重试，也可以判定永久失败或作废
    retry_wait: Object.freeze(['pending', 'failed_permanent', 'error', 'ended']),
    delayed: Object.freeze(['pending', 'error', 'failed_permanent', 'ended']),
    error: Object.freeze(['pending', 'retry_wait', 'failed_permanent', 'ended']),
    // 终态：不可再迁移
    done: Object.freeze([]),
    failed_permanent: Object.freeze([]),
    ended: Object.freeze([]),
  });

  function canTransition(from, to) {
    const allowed = TASK_TRANSITIONS[from];
    return Array.isArray(allowed) && allowed.includes(to);
  }

  function isTerminalTaskState(state) {
    return state === 'done' || state === 'failed_permanent' || state === 'ended';
  }

  /**
   * 平台数据延迟（天）：日/周/月三种粒度的天数数据都要等 **T+2** 才可取。
   * 2026-09-14 用户确认的口径。
   */
  const DATA_DELAY_DAYS = 2;

  /** 某日期所在周的**最后一天**（周一为一周开始 → 周日）。纯 UTC 轴运算，不受时区影响。 */
  function weekEndOf(value) {
    const ymd = formatDate(value);
    const weekday = new Date(toUtcMs(ymd)).getUTCDay(); // 0 = 周日
    return addDays(ymd, weekday === 0 ? 0 : 7 - weekday);
  }

  /** 某日期所在自然月的**最后一天**。 */
  function monthEndOf(value) {
    const ymd = formatDate(value);
    const [year, month] = ymd.split('-').map(Number);
    return `${year}-${pad2(month)}-${pad2(new Date(Date.UTC(year, month, 0)).getUTCDate())}`;
  }

  /**
   * 在给定的"今天"下，某时间粒度**最晚可取的周期结束日**（'YYYY-MM-DD'）。
   *
   * 平台口径（2026-09-14 用户确认）：
   *   · 日 / 汇总：T+2 —— 9/14 最多取到 **9/12**；
   *   · 周：以"周"为单位选择数据、同样要等结算 → 该周**最后一天**须 ≤ 今天−2
   *          → 9/14 最多取到 **9/6 当周**（9/6 是最近的、已结算的周日）；
   *   · 月：同 T+2 —— 9 月的数据 **10/2** 起可取（9/30 + 2 天）。
   * 三者统一为一条规则：**粒度周期的最后一天 ≤ 今天 − 2**。
   */
  function latestExportableEnd(timeGrain, now) {
    // ⚠️ 入参既可能是 Date 也可能是 'YYYY-MM-DD' 字符串：字符串必须按日期用**不能**退化成 new Date()，
    //    否则传入历史/未来日期时会被当成"真实今天"（测试传入 10-02 却被按 09-13 计算过）。
    const today = formatDate(now == null ? new Date() : now);
    const limit = addDays(today, -DATA_DELAY_DAYS);
    const grain = String(timeGrain || '分日');
    if (grain === '分周') {
      const weekend = weekEndOf(limit);
      // weekEndOf 给的是 limit 所在周的周日（可能晚于 limit）→ 晚于 limit 就退回上一周
      return compareDates(weekend, limit) <= 0 ? weekend : addDays(weekend, -7);
    }
    if (grain === '分月') {
      const monthEnd = monthEndOf(limit);
      // 该月已整月结算（月末 ≤ limit）就用它，否则退回上个月末
      if (compareDates(monthEnd, limit) <= 0) return monthEnd;
      return monthEndOf(addDays(`${monthEnd.slice(0, 7)}-01`, -1));
    }
    return limit; // 分日 / 汇总
  }

  /**
   * ❗❗ 2026-09-20 新增（用户需求）：把用户选的区间**自动矫正到"平台可取的最佳区间"**，而不是直接失败。
   *
   * 背景（用户实跑 12 项队列的截图）：12 项用同一个区间 `2024-04-04 ~ 2026-09-17`，
   *   · 分周 4 项 + 分月 4 项 **全部"启动失败"** —— 理由只是"结束日期必须是周日 / 月末"；
   *   · 用户的原话是"即使用户选的时间范围，取最佳时间范围取数" —— 边界该由工具算，不该丢回给用户。
   *
   * 矫正规则（全部来自实测硬约束，见 `assertExportableRange` / `latestExportableEnd`）：
   *   · 分日：开始日抬到平台下限 `2024-04-04`；结束日压到 **T+2** 之内（超了就用 T+2）。
   *   · 分周：开始日**回到所在周的周一**；结束日**取到所在周的周日**，再压到"最近的已结算周日"。
   *   · 分月：开始日**对齐到整月 1 号**（若不是 1 号 → 取下一个整月 1 号）；结束日**取到所在月月末**，
   *           再压到"最近的已结算月末"；下限用 `2024-06-01`（**2024-05 平台已知无数据**，取它只是白跑）。
   *   · 汇总：与分日同一规则（T+2，不做对齐）。
   *
   * 返回 `{ ok, startDate, endDate, adjustments, reason }`：`adjustments` 逐条说明改了什么（可显示给用户，
   * 保证"自动改"是**可见**的而不是偷偷改）；矫正后为空区间（start > end）→ `ok:false` + `reason`。
   * 纯字符串/UTC 轴运算，不碰 DOM、不做时区换算。
   */
  function normalizeExportableRange(range, now) {
    const grain = String((range && range.timeGrain) || '分日');
    let start;
    let end;
    try {
      start = formatDate(range && range.startDate);
      end = formatDate(range && range.endDate);
    } catch (error) {
      return { ok: false, reason: `日期区间不合法：${String((error && error.message) || error)}`, adjustments: [] };
    }
    if (compareDates(start, end) > 0) return { ok: false, reason: `结束日期早于开始日期：${start} ~ ${end}`, adjustments: [] };
    const adjustments = [];
    // ⚠️ 下限**必须保持粒度对齐**：分周的下限要落到周一（2024-04-04 是周四，直接当下限会把整周语义搞坏）；
    //    分月的下限落到 1 号；分日/汇总不限对齐。分月用 2024-06（**2024-05 平台已知无数据**，取它只是白跑）。
    const floor = ({ 分日: '2024-04-04', 分周: '2024-04-08', 分月: '2024-06-01', 汇总: '2024-04-04' })[grain] || '2024-04-04';

    // ① 开始日：按粒度对齐 + 抬到平台下限
    let s2 = start;
    if (grain === '分周') {
      s2 = addDays(weekEndOf(start), -6);
      if (compareDates(s2, start) < 0) s2 = addDays(s2, 7);   // 区间内首个完整周
    } else if (grain === '分月') {
      s2 = /-01$/.test(start) ? start : addDays(monthEndOf(start), 1);   // 不是 1 号 → 下一个整月 1 号
    }
    if (compareDates(s2, floor) < 0) s2 = floor;
    if (s2 !== start) adjustments.push(`开始日期 ${start} → ${s2}`);

    // ② 结束日：先按粒度对齐，再压到平台可取的最晚结束日
    let e2 = end;
    if (grain === '分周') e2 = weekEndOf(end) === end ? end : addDays(weekEndOf(end), -7);
    else if (grain === '分月') e2 = monthEndOf(end) === end ? end : addDays(end.slice(0, 7) + '-01', -1);
    const latest = latestExportableEnd(grain, now == null ? new Date() : now);
    if (compareDates(e2, latest) > 0) e2 = latest;
    if (e2 !== end) adjustments.push(`结束日期 ${end} → ${e2}`);

    if (compareDates(s2, e2) > 0) {
      return {
        ok: false,
        adjustments,
        reason: `按平台规则矫正后已无区间可取（${s2} ~ ${e2}）：${grain}最多只能取到 ${latest}，而开始日期至少要 ${s2}`,
      };
    }
    return { ok: true, startDate: s2, endDate: e2, adjustments, reason: '' };
  }

  /**
   * 日期区间是否**现在可取**。
   *
   * 除了 T+2（见 `latestExportableEnd`），还要求粒度对齐：
   *   · 分周 → 结束日必须是周日（平台按"周"选择数据）；
   *   · 分月 → 结束日必须是月末（平台按"月"选择数据）。
   *
   * 为什么要在**创建会话之前**拒绝：平台对尚不可取的区间表现极具误导性——
   * "提交成功、点击下载成功，但永远没有文件产出"（实机场次 N1/P1/P2 各白等约 4 分钟、重试 3 次）。
   * 纯字符串/UTC 轴运算，不做时区换算。
   */
  function assertExportableRange(range, now) {
    const grain = String((range && range.timeGrain) || '分日');
    let start;
    let end;
    try {
      start = formatDate(range && range.startDate);
      end = formatDate(range && range.endDate);
    } catch (error) {
      return { ok: false, reason: `日期区间不合法：${String((error && error.message) || error)}` };
    }
    if (compareDates(start, end) > 0) {
      return { ok: false, reason: `结束日期早于开始日期：${start} ~ ${end}` };
    }
    if (grain === '分周' && weekEndOf(end) !== end) {
      return { ok: false, reason: `分周区间的结束日期必须是周日（平台按"周"选择数据）：${end} 不是周日（该周为 ${addDays(weekEndOf(end), -6)} ~ ${weekEndOf(end)}）` };
    }
    if (grain === '分月' && monthEndOf(end) !== end) {
      return { ok: false, reason: `分月区间的结束日期必须是月末（平台按"月"选择数据）：${end} 不是月末（该月月末为 ${monthEndOf(end)}）` };
    }
    const today = formatDate(now instanceof Date ? now : new Date());
    const latest = latestExportableEnd(grain, today);
    if (compareDates(end, latest) > 0) {
      return {
        ok: false,
        reason: `${grain}数据需 T+${DATA_DELAY_DAYS}（今天 ${today}）：`
          + (grain === '分周'
            ? `最多只能取到 ${latest} 当周（该周最后一天须 ≤ ${addDays(today, -DATA_DELAY_DAYS)}）`
            : grain === '分月'
              ? `最多只能取到 ${latest.slice(0, 7)} 月；你请求的 ${end.slice(0, 7)} 月数据要到 ${addDays(monthEndOf(end), DATA_DELAY_DAYS)} 起才可取`
              : `最多只能取到 ${latest}`)
          + `。请把结束日期改到 ${latest} 或更早。`,
      };
    }
    return { ok: true, reason: '' };
  }

  /**
   * 单步迁移。非法迁移**抛错**（不静默修正）。
   * attempts 在进入 navigating 时 +1（真正的"出手次数"）。
   * 重试上限：进入 navigating 前若 attempts 已达 MAX_ATTEMPTS，抛错——调用方应改判 failed_permanent。
   */
  function transitionTask(task, nextStatus, now, error) {
    if (!task || typeof task !== 'object') throw new Error('任务不能为空');
    const from = task.status;
    if (!Object.prototype.hasOwnProperty.call(TASK_TRANSITIONS, from)) {
      throw new Error(`任务当前状态无效：${from}`);
    }
    if (!canTransition(from, nextStatus)) {
      throw new Error(`非法状态迁移：${from} → ${nextStatus}`);
    }
    const attempts = nextStatus === TASK_STATES.NAVIGATING ? Number(task.attempts || 0) + 1 : Number(task.attempts || 0);
    if (nextStatus === TASK_STATES.NAVIGATING && attempts > MAX_ATTEMPTS) {
      throw new Error(`任务 ${task.key} 已达最大尝试次数 ${MAX_ATTEMPTS}，应判定 failed_permanent`);
    }
    const nextError = nextStatus === TASK_STATES.PENDING
      ? null
      : (error === undefined ? (task.error == null ? null : task.error) : error);
    return {
      ...task,
      status: nextStatus,
      attempts,
      error: nextError,
      updatedAt: new Date(now === undefined ? Date.now() : now).toISOString(),
    };
  }

  /**
   * 推进到目标状态：沿主链路**线性补齐中间态**，并**拒绝回退**。
   * 目标状态可以是链路上的任意状态，也可以是异常态（error / failed_permanent / ended 等，走合法迁移）。
   */
  function advanceTaskTo(task, targetStatus, now, error) {
    if (!task || typeof task !== 'object') throw new Error('任务不能为空');
    const from = TASK_LINEAR_FLOW.indexOf(task.status);
    const to = TASK_LINEAR_FLOW.indexOf(targetStatus);
    if (to < 0) {
      // 目标不在主链路上（异常态/终态）：只允许一步合法迁移，避免掩盖真实流程
      return transitionTask(task, targetStatus, now, error);
    }
    if (from < 0) {
      throw new Error(`不能从 ${task && task.status} 推进任务状态到 ${targetStatus}`);
    }
    if (to < from) {
      throw new Error(`不能推进任务状态（禁止回退）：${task.status} → ${targetStatus}`);
    }
    let next = task;
    for (let index = from + 1; index <= to; index += 1) {
      next = transitionTask(next, TASK_LINEAR_FLOW[index], now, index === to ? error : undefined);
    }
    return next;
  }

  /**
   * 按尝试次数决定"再来一次"还是"永久失败"：
   *   attempts < MAX_ATTEMPTS → retry_wait（等固定退避后再回 pending）
   *   否则                    → failed_permanent（终态 + 必须进缺口清单）
   * 这是"不静默跳过"的落地点。
   */
  function resolveRetry(task, now, error) {
    if (!task || typeof task !== 'object') throw new Error('任务不能为空');
    const attempts = Number(task.attempts || 0);
    const exhausted = attempts >= MAX_ATTEMPTS;
    const target = exhausted ? TASK_STATES.FAILED_PERMANENT : TASK_STATES.RETRY_WAIT;

    // 目标状态在本态是否直达；不能直达就先进入 error（error 可走向 retry_wait 与 failed_permanent）
    if (canTransition(task.status, target)) {
      return transitionTask(task, target, now, error);
    }
    if (canTransition(task.status, TASK_STATES.ERROR)) {
      const inError = transitionTask(task, TASK_STATES.ERROR, now, error);
      return transitionTask(inError, target, now, error);
    }
    // 到这里说明当前状态既不能直达目标、也不能进入 error（理论上不该发生；表已放宽到所有非终态）
    throw new Error(`任务 ${task.key} 当前状态 ${task.status} 无法进入 ${target}`);
  }

  /** 固定退避（第 attempt 次失败的等待毫秒数）。**禁止使用随机数**。 */
  function nextBackoffMs(attempt) {
    const n = Number(attempt);
    if (!Number.isFinite(n) || n < 1) throw new Error(`nextBackoffMs 的 attempt 必须是 >=1 的数字：${attempt}`);
    return Math.min(RETRY_BASE_DELAY_MS * Math.floor(n), RETRY_MAX_DELAY_MS);
  }

  // ==================================================================================
  // 6. 会话状态机
  // ==================================================================================

  const SESSION_STATES = Object.freeze(['ready', 'discovering', 'running', 'paused', 'completed', 'error', 'ended']);

  const SESSION_TRANSITIONS = Object.freeze({
    ready: Object.freeze(['discovering', 'running', 'ended']),
    discovering: Object.freeze(['running', 'paused', 'error', 'ended']),
    running: Object.freeze(['paused', 'completed', 'error', 'ended']),
    paused: Object.freeze(['running', 'completed', 'ended']),
    // 失败/结束态：允许重新开跑（断点续跑）或作废
    error: Object.freeze(['running', 'ended']),
    completed: Object.freeze([]),
    ended: Object.freeze([]),
  });

  /** action → 目标状态。语义化入口，避免调用方到处写裸字符串。 */
  const SESSION_ACTIONS = Object.freeze({
    start: 'running',
    discover: 'discovering',
    pause: 'paused',
    resume: 'running',
    complete: 'completed',
    fail: 'error',
    end: 'ended',
    ready: 'ready',
  });

  /** 每个动作**允许的起始状态**（比迁移表更严：语义动作不该在任意状态生效）。 */
  const SESSION_ACTION_FROM = Object.freeze({
    start: Object.freeze(['ready', 'error']),
    discover: Object.freeze(['ready']),
    pause: Object.freeze(['running', 'discovering']),
    resume: Object.freeze(['paused']),
    complete: Object.freeze(['running', 'paused']),
    fail: Object.freeze(['discovering', 'running']),
    end: Object.freeze(['ready', 'discovering', 'running', 'paused', 'error']),
    ready: Object.freeze(['ready', 'error']),
  });

  function canTransitionSession(from, to) {
    const allowed = SESSION_TRANSITIONS[from];
    return Array.isArray(allowed) && allowed.includes(to);
  }

  function transitionSession(session, nextStatus, now) {
    if (!session || typeof session !== 'object') throw new Error('会话不能为空');
    if (!SESSION_STATES.includes(nextStatus)) throw new Error(`未知会话状态：${nextStatus}`);
    if (!canTransitionSession(session.status, nextStatus)) {
      throw new Error(`非法会话迁移：${session.status} → ${nextStatus}`);
    }
    return { ...session, status: nextStatus, updatedAt: new Date(now === undefined ? Date.now() : now).toISOString() };
  }

  /**
   * 会话状态流转入口。
   * 兼容两种签名：
   *   setSessionStatus(session, action, now)  ← 参考实现的写法（推荐）
   *   setSessionStatus(state,   action)       ← 只算状态字符串的纯函数写法
   * action 可以是语义动作（pause/resume/end/start/complete/fail）或直接是目标状态名。
   * `end` 会把所有任务按合法迁移置为 ended（作废），不允许作废的任务保持原状。
   */
  function setSessionStatus(sessionOrStatus, action, now) {
    const resolved = SESSION_ACTIONS[action] || (SESSION_STATES.includes(action) ? action : null);
    if (!resolved) {
      throw new Error(`未知会话动作：${action}（可用动作：${Object.keys(SESSION_ACTIONS).join(' / ')}）`);
    }
    const fromStates = SESSION_ACTION_FROM[action];
    const checkAction = (from) => {
      if (Array.isArray(fromStates) && !fromStates.includes(from)) {
        throw new Error(`会话状态 ${from} 不允许执行 ${action}`);
      }
      if (!canTransitionSession(from, resolved)) {
        throw new Error(`非法会话迁移：${from} → ${resolved}`);
      }
    };
    if (typeof sessionOrStatus === 'string') {
      const from = sessionOrStatus;
      if (!SESSION_STATES.includes(from)) throw new Error(`未知会话状态：${from}`);
      checkAction(from);
      return resolved;
    }
    const session = sessionOrStatus;
    if (!session || typeof session !== 'object') throw new Error('会话不能为空');
    if (!SESSION_STATES.includes(session.status)) throw new Error(`未知会话状态：${session.status}`);
    checkAction(session.status);
    const next = transitionSession(session, resolved, now);
    if (resolved !== 'ended' || !Array.isArray(session.tasks)) return next;
    const tasks = session.tasks.map((task) => (
      canTransition(task.status, TASK_STATES.ENDED) ? transitionTask(task, TASK_STATES.ENDED, now) : task
    ));
    return { ...next, tasks };
  }

  /** 断点续跑前的账户/店铺一致性校验（不一致即拒绝继续）。 */
  function assertSameContext(frozen, current) {
    const a = frozen || {};
    const b = current || {};
    if (String(a.storeId) !== String(b.storeId)) {
      throw new Error(`店铺不一致，拒绝续跑：冻结清单为 ${a.storeId}，当前页面为 ${b.storeId}`);
    }
    if (String(a.storeName || '') !== String(b.storeName || '')) {
      throw new Error(`店铺名不一致，拒绝续跑：冻结清单为 ${a.storeName}，当前页面为 ${b.storeName}`);
    }
    return true;
  }

  // ==================================================================================
  // 7. 闭合校验（允许"带缺口闭合"，但必须显式列出缺口）
  // ==================================================================================

  /** 按维度把任务区间分组（不做任何裁剪，保持原始顺序）。 */
  function groupIntervalsByDimension(tasks) {
    const groups = new Map();
    for (const task of Array.isArray(tasks) ? tasks : []) {
      const dimension = task && task.dimension ? String(task.dimension) : '(未知维度)';
      if (!groups.has(dimension)) groups.set(dimension, []);
      groups.get(dimension).push(task);
    }
    return groups;
  }

  /**
   * 日期覆盖校验：按维度检查所有任务区间是否**无缝覆盖**会话区间。
   * ⚠️ 覆盖校验**只看区间，不看任务状态**——任务失败/作废时它的区间仍然"被认领"，
   *    该缺口由 validateClosure 的 task_failed_permanent / task_ended 缺口项表达；
   *    覆盖校验只负责回答"冻结清单本身有没有把会话区间切漏/切重"。
   * 报三类问题：
   *   coverage_hole      前一片 end + 1 天 ≠ 后一片 start（有空洞）
   *   coverage_overlap   分片区间相互重叠（重复取数）
   *   coverage_boundary  整体边界与会话区间不一致
   */
  function validateDateCoverage(tasks, sessionStart, sessionEnd, dimensions) {
    const holes = [];
    const overlaps = [];
    const expectedStart = sessionStart == null ? null : formatDate(sessionStart);
    const expectedEnd = sessionEnd == null ? null : formatDate(sessionEnd);
    const groups = groupIntervalsByDimension(tasks);
    const dimensionNames = Array.isArray(dimensions) && dimensions.length
      ? dimensions.slice()
      : Array.from(groups.keys());

    for (const dimension of dimensionNames) {
      const list = (groups.get(dimension) || [])
        .map((task) => ({
          task,
          start: formatDate(task.dateRange ? task.dateRange.start : task.startDate),
          end: formatDate(task.dateRange ? task.dateRange.end : task.endDate),
        }))
        .sort((left, right) => (left.start === right.start
          ? (left.end < right.end ? -1 : left.end > right.end ? 1 : 0)
          : (left.start < right.start ? -1 : 1)));

      if (list.length === 0) {
        holes.push({
          kind: 'coverage_hole',
          dimension,
          start: expectedStart,
          end: expectedEnd,
          message: `维度「${dimension}」没有任何任务分片`,
        });
        continue;
      }
      if (expectedStart && list[0].start !== expectedStart) {
        holes.push({
          kind: 'coverage_boundary',
          dimension,
          start: expectedStart,
          end: addDays(list[0].start, -1),
          message: `维度「${dimension}」首片起始 ${list[0].start} 与会话起始 ${expectedStart} 不一致`,
        });
      }
      for (let index = 1; index < list.length; index += 1) {
        const prev = list[index - 1];
        const cur = list[index];
        if (cur.start <= prev.end) {
          overlaps.push({
            kind: 'coverage_overlap',
            dimension,
            start: cur.start,
            end: prev.end < cur.end ? prev.end : cur.end,
            message: `维度「${dimension}」分片重叠：${prev.start}~${prev.end} 与 ${cur.start}~${cur.end}`,
          });
          continue;
        }
        if (addDays(prev.end, 1) !== cur.start) {
          holes.push({
            kind: 'coverage_hole',
            dimension,
            start: addDays(prev.end, 1),
            end: addDays(cur.start, -1),
            message: `维度「${dimension}」分片空洞：${addDays(prev.end, 1)} ~ ${addDays(cur.start, -1)} 未被任何任务覆盖`,
          });
        }
      }
      const last = list[list.length - 1];
      if (expectedEnd && last.end !== expectedEnd) {
        holes.push({
          kind: 'coverage_boundary',
          dimension,
          start: addDays(last.end, 1),
          end: expectedEnd,
          message: `维度「${dimension}」末片结束 ${last.end} 与会话结束 ${expectedEnd} 不一致`,
        });
      }
    }
    return { holes, overlaps };
  }

  /**
   * 带缺口闭合的判定规则（**与红猫的关键差异**）：
   *   - 允许"已完成 + 已知永久失败清单"放行（不要求 100% 才产出）；
   *   - 除此之外的任何缺口（未达终态 / 作废任务 / 覆盖空洞 / 覆盖重叠 / 边界不符）都不放行。
   * 即：ok = 所有缺口都只是 task_failed_permanent。
   */
  function evaluateClosure(gaps) {
    const list = Array.isArray(gaps) ? gaps : [];
    const blocking = list.filter((gap) => gap.kind !== 'task_failed_permanent');
    return { ok: blocking.length === 0, blockingGaps: blocking };
  }

  /**
   * 会话闭合校验。**允许"已完成 + 已知失败清单"的带缺口闭合**（不要求 100% 才放行），
   * 但必须把缺口显式列出来——归档 manifest 直接用它，不做静默通过。
   *
   * @returns {{ok:boolean, done:number, failedPermanent:number, pending:number,
   *            gaps:Array<object>, blockingGaps:Array<object>, ended:number, total:number, summary:object}}
   */
  function validateClosure(session) {
    if (!session || !Array.isArray(session.tasks)) throw new Error('会话任务无效');
    const tasks = session.tasks;
    const summary = summarizeTasks(tasks);
    const done = summary.counts[TASK_STATES.DONE] || 0;
    const failedPermanent = summary.counts[TASK_STATES.FAILED_PERMANENT] || 0;
    const ended = summary.counts[TASK_STATES.ENDED] || 0;
    const pending = tasks.length - done - failedPermanent - ended;

    const gaps = [];
    for (const task of tasks) {
      if (isTerminalTaskState(task.status)) continue;
      gaps.push({
        kind: 'task_incomplete',
        taskKey: task.key,
        dimension: task.dimension,
        status: task.status,
        attempts: Number(task.attempts || 0),
        message: `任务未达终态（当前 ${task.status}，已尝试 ${Number(task.attempts || 0)} 次）：${task.key}`,
      });
    }
    for (const task of tasks) {
      if (task.status !== TASK_STATES.FAILED_PERMANENT) continue;
      gaps.push({
        kind: 'task_failed_permanent',
        taskKey: task.key,
        dimension: task.dimension,
        status: task.status,
        attempts: Number(task.attempts || 0),
        message: `任务永久失败，显式留缺口：${task.key}${task.error ? `（${task.error}）` : ''}`,
      });
    }
    for (const task of tasks) {
      if (task.status !== TASK_STATES.ENDED) continue;
      gaps.push({
        kind: 'task_ended',
        taskKey: task.key,
        dimension: task.dimension,
        status: task.status,
        message: `任务已作废，不计入产出：${task.key}`,
      });
    }

    // ❗ 平台 10 万行静默截断：文件在、行数正常、平台不报错，但数据**少了**。
    //    因此这里把它当成**显式缺口**列出来（blocking：不允许静默当成功）。
    //
    //    2026-09-14 补强（实锤：归档里 09:45 那份 `…流量来源详情/分日/20260801-20260831/…` 就是 100,000 行、
    //    日期只覆盖 08-13~08-31，而当时**没有任何缺口记录**）：
    //    缺口里必须带上"下游解读这批数据需要知道的全部坐标"——
    //      维度 / 时间粒度 / 名义区间 / 平台自报行数 / 上限 / 额外筛选值 / 建议分片单位 / 需重跑标记。
    //    ⚠️ **实际覆盖区间**只能在**离线**复核里得到（页面结果视图只挂前 30 行，看不到全量日期范围），
    //       所以这里显式写 `coverageVerifiedOffline:false` 并指向 `check_export.py` / `audit_archive.py`，
    //       绝不假装已经核过覆盖。
    for (const task of tasks) {
      const rowCap = task.rowCap || (task.exportEvidence && task.exportEvidence.rowCap) || null;
      if (!rowCap || !rowCap.suspect) continue;
      const evidence = rowCap.overCap
        ? `平台明示「${rowCap.overCapWarning || '已超过单次最大可下载数据量10万条'}」`
        : `平台自报 ${rowCap.rowCount} 行 ≥ 上限 ${rowCap.rowCap} 行`;
      const efv = (task.extraFilterValues && Object.keys(task.extraFilterValues).length)
        ? Object.keys(task.extraFilterValues).sort()
          .map((k) => `${k}=${task.extraFilterValues[k].join('+')}`).join('&')
        : '（无，沿用平台默认值）';
      gaps.push({
        kind: 'row_cap_truncation_suspected',
        taskKey: task.key,
        dimension: task.dimension,
        timeGrain: task.timeGrain,
        nominalRange: { start: task.startDate, end: task.endDate },
        rowCount: rowCap.rowCount == null ? null : rowCap.rowCount,
        overCap: !!rowCap.overCap,
        rowCap: rowCap.rowCap,
        extraFilters: Array.isArray(task.extraFilters) ? task.extraFilters.slice() : [],
        extraFilterValuesText: efv,
        recommendedChunkUnit: rowCap.recommendedChunkUnit || null,
        // 需重跑 & 覆盖未核：两个标记让下游/脚本不必自己推断
        needsRerun: true,
        coverageVerifiedOffline: false,
        coverageNote: '实际覆盖区间需离线复核：python scripts\\check_export.py <xlsx>（或 scripts\\audit_archive.py）',
        message: `疑为平台截断（数据不完整，需按更细粒度分片重取）：${task.key}`
          + `（${evidence}；维度=${task.dimension} 粒度=${task.timeGrain} 名义区间=${task.startDate}~${task.endDate}`
          + ` 额外筛选=${efv}；建议 ${task.timeGrain === '分月'
            ? 'chunkUnit=month（分月无「更细时间分片」退路，只能按更细维度/额外筛选拆分重取）'
            : `chunkUnit=${rowCap.recommendedChunkUnit || 'week'}`}；**该批次需重跑**）`,
      });
    }

    // 页面明确报 0 行时，平台可能仍导出一行全 NULL 的占位 Excel。
    // 文件存在只证明下载完成；空结果应留缺口待核，避免队列显示“完整成功”。
    for (const task of tasks) {
      const reported = task.rowCap && task.rowCap.rowCount != null
        ? task.rowCap.rowCount : task.exportEvidence && task.exportEvidence.rowCount;
      if (task.status !== TASK_STATES.DONE || reported !== 0) continue;
      gaps.push({
        kind: 'empty_result_unverified',
        taskKey: task.key,
        dimension: task.dimension,
        message: `平台报 0 行，导出文件可能仅含 NULL 占位行：${task.key}；需核实页面口径或实际工作簿内容`,
      });
    }
    // 2024-07-24 实际产物仅 2,761 字节，XLSX 容器内没有任何工作表，
    // 但浏览器下载成功且任务被标 done。极小文件先留待核缺口，避免静默当完整数据。
    for (const task of tasks) {
      const validation = task.validation || {};
      const bytes = Number(validation.bytes);
      if (task.status !== TASK_STATES.DONE || validation.fileExists !== true
        || !Number.isFinite(bytes) || bytes <= 0 || bytes >= 3000) continue;
      gaps.push({
        kind: 'tiny_export_unverified',
        taskKey: task.key,
        dimension: task.dimension,
        message: `导出文件仅 ${bytes} 字节，可能没有工作表或有效数据：${task.key}；需离线核实`,
      });
    }

    // 日期覆盖校验：优先用会话区间；缺失时用任务区间并集推断出的最外边界
    const sessionStart = session.startDate || session.dateRange && session.dateRange.start || null;
    const sessionEnd = session.endDate || session.dateRange && session.dateRange.end || null;
    if (sessionStart && sessionEnd) {
      const coverage = validateDateCoverage(tasks, sessionStart, sessionEnd, session.dimensions);
      gaps.push(...coverage.holes, ...coverage.overlaps);
    }

    const verdict = evaluateClosure(gaps);
    // ❗ 会话级"需重跑"标记（2026-09-14 收尾 ① 补强）：
    //   截断是"看起来成功、其实数据少了"的那一类，光有 gaps 还不够 ——
    //   下游/脚本需要一眼看出**这批产物不能直接按任务区间使用、必须重取**。
    const rerunGaps = gaps.filter((gap) => gap.kind === 'row_cap_truncation_suspected');
    return {
      ok: verdict.ok,
      blockingGaps: verdict.blockingGaps,
      done,
      failedPermanent,
      pending,
      ended,
      total: tasks.length,
      gaps,
      summary,
      needsRerun: rerunGaps.length > 0,
      rerunTasks: rerunGaps.map((gap) => ({
        taskKey: gap.taskKey,
        dimension: gap.dimension,
        timeGrain: gap.timeGrain,
        nominalRange: gap.nominalRange,
        rowCount: gap.rowCount,
        recommendedChunkUnit: gap.recommendedChunkUnit,
        extraFilterValuesText: gap.extraFilterValuesText,
        coverageVerifiedOffline: false,
      })),
    };
  }

  // ==================================================================================
  // 8. 归档路径与文件名归属（§8.2 / §2.4）
  // ==================================================================================

  /**
   * 清洗单个路径片段：去掉 Windows 非法字符、去尾部的点与空格、限长。
   * 纯字符串处理，不接触文件系统。
   */
  function sanitizePathSegment(value, fallback) {
    const text = String(value == null ? '' : value)
      .replace(/\s+/g, ' ')
      .trim()
      // Windows 路径非法字符 + 控制字符
      .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
      // 尾部的点/空格在 Windows 上会被吞掉，必须去掉
      .replace(/[. ]+$/g, '');
    const sliced = text.slice(0, 80);
    return sliced || (fallback === undefined ? '未命名' : fallback);
  }

  /**
   * 归档相对路径（§8.2）：
   *   生参取数/<店铺名_店铺ID>/<数据粒度>/<数据维度>/<时间粒度>/<起YYYYMMDD>-<止YYYYMMDD>/
   * 返回带结尾斜杠的目录相对路径；调用方拼平台原始文件名。
   */
  function archiveRelativePath(task, context) {
    if (!task || typeof task !== 'object') throw new Error('任务不能为空');
    const ctx = context || {};
    const storeName = ctx.storeName || task.storeName;
    const storeId = ctx.storeId || task.storeId;
    const dimension = ctx.dimension || task.dimension;
    if (!storeName || !storeId) throw new Error(`任务 ${task.key} 缺少店铺信息，无法生成归档路径`);
    if (!dimension) throw new Error(`任务 ${task.key} 缺少数据维度，无法生成归档路径`);
    const start = compactDate(task.dateRange ? task.dateRange.start : task.startDate);
    const end = compactDate(task.dateRange ? task.dateRange.end : task.endDate);
    const segments = [
      ARCHIVE_ROOT,
      `${sanitizePathSegment(storeName)}_${sanitizePathSegment(storeId)}`,
      sanitizePathSegment(task.granularity, '店铺'),
      sanitizePathSegment(dimension),
      sanitizePathSegment(task.timeGrain, '分日'),
      `${start}-${end}`,
    ];
    return segments.join('/') + '/';
  }

  /**
   * 解析平台导出的文件名（✅ 实测规则）：
   *   <报表名称>_<导出日期YYYYMMDD>_<32位hash>.xlsx        （允许尾部 " (1)" 去重后缀）
   *
   * ⚠️⚠️ **文件名里的日期是「导出日期」，不是数据日期**：
   *    - 它只是"这份文件是什么时候导出的"，与任务区间**无关**；
   *    - 绝不能拿它当数据区间、做区间校验或写进归档目录名；
   *    - 真正的数据区间只能从「报表名称」编码段或文件内「统计日期」列读取。
   */
  function parsePlatformFilename(filename) {
    if (typeof filename !== 'string' || !filename) {
      return { ok: false, reason: '文件名不是非空字符串' };
    }
    const SR = getSelectors();
    const leaf = filename.split(/[\\/]/).pop();
    // Windows 重名自动加的 " (1)" 后缀先剥掉，避免误判归属
    const stripped = leaf.replace(/ \(\d+\)(?=\.xlsx$)/i, '');
    const pattern = SR.FILE.namePattern;
    const match = pattern.exec(stripped);
    if (!match) {
      return { ok: false, reason: `文件名不符合平台规则：${SR.FILE.namePattern} → ${leaf}` };
    }
    const groups = match.groups || {};
    return {
      ok: true,
      raw: leaf,
      stripped,
      report: groups.report,
      // ⚠️ 导出日期 ≠ 数据日期
      exportDate: groups.exportDate,
      hash: groups.hash,
      ext: '.xlsx',
    };
  }

  /**
   * 判断下载到的文件是否属于该任务。
   * ① 扩展名必须是 .xlsx（生参是 xlsx，不是红猫的 csv）
   * ② 能按平台规则解析出 report/exportDate/hash
   * ③ 解析出的 report 段**必须以本任务的 reportName 开头**
   *    （报表名称是我们自己填的，这是本场景下最可靠的归属证据）
   * 注意：**绝不比较导出日期与任务区间**——见 parsePlatformFilename 的警告。
   */
  function matchesExpectedFile(task, filename) {
    if (!task || typeof task !== 'object' || !task.reportName) return false;
    const parsed = parsePlatformFilename(filename);
    if (!parsed.ok) return false;
    // 手工再断言一次扩展名与 hash，防止 selectors.js 的正则被改坏后静默放行
    if (!parsed.stripped.toLowerCase().endsWith('.xlsx')) return false;
    if (!/^[0-9a-f]{32}$/.test(parsed.hash)) return false;
    if (!/^\d{8}$/.test(parsed.exportDate)) return false;
    // 平台在报表名称带下划线时可能额外拼接（如 " (1)"、"副本"），故用"前缀"而非"相等"
    return String(parsed.report).startsWith(String(task.reportName));
  }

  // ==================================================================================
  // 8.1 重复下载判定（2026-09-14 加固①：催单产物的第二次下载）
  // ==================================================================================
  //
  // 背景（实机事实，见 HANDOFF §4「催单成功会产生重复下载」）：
  //   等下载超时后对同一结果视图**再点一次「下载报表」**（催单），平台会**再生成一份产物**；
  //   这份多余的过去只是被记成 `download_rejected` 并事后人工移到 `_duplicates\`。
  //   现在要在**它落盘之前**掐掉（`chrome.downloads.cancel`），并保留完整证据。
  //
  // 纪律（**判据必须保守：宁可漏取消，也绝不误取消**）：
  //   · 只有"**同一会话、同一任务、且该任务已有一份成功认领的产物**"才算重复；
  //   · 任何未知/歧义（文件名不匹配、命中多个任务、任务未完成、产物未确认存在、
  //     来源标签页不是本会话、就是那份已认领产物本身）→ **一律不取消**（返回 duplicate:false 并给出原因）。
  //   · 本函数是**纯函数**（不碰 DOM / chrome.*），放在 core 里就是为了离线跑单测。

  /** 该任务是否已有"**成功认领的产物**"（落点 + downloadId + fileExists===true 三者齐备）。 */
  function claimedArtifactOf(task) {
    const file = task && task.file;
    const validation = task && task.validation;
    if (!file || typeof file !== 'object') return null;
    const downloadId = file.downloadId == null || file.downloadId === '' ? null : Number(file.downloadId);
    const hasLocation = !!(file.path || file.relative);
    // ⚠️ `fileExists` 必须**显式 true**：null（尚未复核）/false（校验失败）/缺失 都视为"未知" → 不取消
    const existsConfirmed = !!(validation && validation.fileExists === true);
    if (downloadId == null || !Number.isFinite(downloadId) || !hasLocation || !existsConfirmed) return null;
    return {
      downloadId,
      path: file.path || null,
      relative: file.relative || null,
      bytes: validation && validation.bytes != null ? Number(validation.bytes) : null,
    };
  }

  /**
   * 重复下载判定。
   *
   * @param {object} input
   *   · filename          下载事件里的文件名（可含路径，也可带 Chrome 的 " (1)" 后缀）
   *   · tasks             **本会话**的任务数组（调用方从会话分片读出，不传别的会话）
   *   · sessionId         本会话 id（仅留证用）
   *   · inFlightTaskKey   当前在途归属（expectedDownload.taskKey），没有就传 null
   *   · itemDownloadId    本次下载事件的 downloadId（可空）
   *   · sourceTabId       下载来源标签页 id（拿不到就传 null；不因此放宽其它判据）
   *   · ownerTabId        本会话的 ownerTabId（拿不到就传 null）
   * @returns {{duplicate:boolean, taskKey:(string|null), reason:string, filename:(string|null),
   *            evidence:object, quarantineRelativePath:(string|null)}}
   */
  function judgeDuplicateDownload(input) {
    const opts = input || {};
    const filename = typeof opts.filename === 'string' ? opts.filename : '';
    const tasks = Array.isArray(opts.tasks) ? opts.tasks : [];
    const evidence = {
      sessionId: opts.sessionId || null,
      filename: filename || null,
      itemDownloadId: opts.itemDownloadId == null ? null : Number(opts.itemDownloadId),
      inFlightTaskKey: opts.inFlightTaskKey || null,
      sourceTabId: opts.sourceTabId == null ? null : Number(opts.sourceTabId),
      ownerTabId: opts.ownerTabId == null ? null : Number(opts.ownerTabId),
      candidateCount: 0,
      candidateTaskKeys: [],
      bestReportName: null,
      bestReportNameLength: null,
      taskStatus: null,
      taskHasClaimedArtifact: false,
      claimedDownloadId: null,
      claimedPath: null,
      sourceVerified: null,
    };
    const verdict = (duplicate, reason, taskKey) => ({
      duplicate: !!duplicate,
      taskKey: taskKey || null,
      reason,
      filename: filename || null,
      evidence,
      quarantineRelativePath: duplicate
        ? duplicateQuarantineRelativePath({ sessionId: opts.sessionId, filename })
        : null,
    });

    // ① 必须是 .xlsx（生参是 xlsx；其它下载一律不碰）
    let sr;
    try {
      sr = getSelectors();
    } catch (error) {
      return verdict(false, `无法载入页面知识表，判定中止：${error && error.message}`);
    }
    const ext = String((sr && sr.FILE && sr.FILE.ext) || '.xlsx').toLowerCase();
    if (!filename || !filename.toLowerCase().endsWith(ext)) {
      return verdict(false, `不是 ${ext} 下载（filename=${filename || '(空)'}）→ 不取消`);
    }

    // ② 来源校验：只在"能拿到两侧标签页且不一致"时否决（拿不到不因此放宽其它判据）
    if (evidence.sourceTabId != null && evidence.ownerTabId != null) {
      evidence.sourceVerified = evidence.sourceTabId === evidence.ownerTabId;
      if (!evidence.sourceVerified) {
        return verdict(false, `下载来源标签页 ${evidence.sourceTabId} 不是本会话的 ownerTabId ${evidence.ownerTabId} → 不取消`);
      }
    }

    // ③ 必须能在**本会话任务清单**里精确匹配（reportName 前缀 + 导出日期 + 32 位 hash）
    if (tasks.length === 0) return verdict(false, '会话任务清单为空 → 无从判定，不取消');
    const candidates = tasks.filter((task) => task && task.reportName && matchesExpectedFile(task, filename));
    evidence.candidateCount = candidates.length;
    evidence.candidateTaskKeys = candidates.map((task) => task.key).slice(0, 8);
    if (candidates.length === 0) {
      return verdict(false, '文件名与本次会话任何任务的 reportName 都不匹配（不认识的文件）→ 不取消');
    }

    // ④ 在途归属指向的任务若就在候选里 → 那是"首份产物正在认领"，绝不取消
    const inFlight = opts.inFlightTaskKey
      ? candidates.find((task) => task.key === opts.inFlightTaskKey) || null
      : null;
    if (inFlight && !isTerminalTaskState(inFlight.status)) {
      return verdict(false, `文件属于**在途**任务 ${inFlight.key}（status=${inFlight.status}）→ 这是首份产物的认领路径，不取消`);
    }

    // ⑤ 歧义消解：reportName 可能互为前缀（如 `X` 与 `X_B1`）→ 只认**最长**的那一个；并列即歧义
    const bestLength = candidates.reduce((max, task) => Math.max(max, String(task.reportName).length), 0);
    const bests = candidates.filter((task) => String(task.reportName).length === bestLength);
    evidence.bestReportNameLength = bestLength;
    evidence.bestReportName = bests.length === 1 ? String(bests[0].reportName) : null;
    if (bests.length !== 1) {
      return verdict(false, `${bests.length} 个任务的 reportName 同时命中（互为前缀）→ 歧义，不取消`);
    }
    const task = bests[0];
    evidence.taskKey = task.key;
    evidence.taskStatus = task.status || null;
    evidence.taskReportName = String(task.reportName);

    // ⑥ 必须是"已成功完结"的任务
    if (task.status !== 'done') {
      return verdict(false, `命中的任务 ${task.key} 未到 done（status=${task.status || '未知'}）→ 无可对照的已认领产物，不取消`);
    }

    // ⑦ 必须**已有一份成功认领的产物**（落点 + downloadId + fileExists===true）
    const claimed = claimedArtifactOf(task);
    evidence.taskHasClaimedArtifact = !!claimed;
    if (!claimed) {
      return verdict(false, `任务 ${task.key} 尚无"成功认领的产物"（缺落点/downloadId/fileExists===true 之一）→ 不取消`);
    }
    evidence.claimedDownloadId = claimed.downloadId;
    evidence.claimedPath = claimed.path || claimed.relative;

    // ⑧ 就是那份已认领产物本身（同一 downloadId，例如事件重放）→ 不是重复
    if (evidence.itemDownloadId != null && evidence.itemDownloadId === claimed.downloadId) {
      return verdict(false, `本次下载 id=${evidence.itemDownloadId} 就是任务 ${task.key} 已认领的那份产物 → 不是重复`);
    }

    return verdict(true, `同一任务的第二份产物：任务 ${task.key} 已认领 downloadId=${claimed.downloadId}（${claimed.path || claimed.relative}），本次 downloadId=${evidence.itemDownloadId == null ? '(未知)' : evidence.itemDownloadId}`, task.key);
  }

  /**
   * 重复下载的**隔离落点**（相对下载目录的路径）。
   *   `生参取数/_duplicates/<会话id>_quarantine/<平台原文件名>`
   *
   * ⚠️ 叶子目录名**故意以 `_quarantine` 结尾**：与 `scripts/audit_archive.py` 的隔离豁免后缀
   *    （`_superseded` / `_quarantine` / `_backup`）一致 —— 万一取消没拦住、文件真的落在这里，
   *    它既不会污染下载根目录，也不会被完整性审计当成"当前需重取"的交付产物（仍逐一计数、不静默）。
   */
  function duplicateQuarantineRelativePath(input) {
    const opts = input || {};
    const sessionSeg = sanitizePathSegment(opts.sessionId || 'unknown-session', 'unknown-session');
    const leaf = String(opts.filename == null ? '' : opts.filename)
      .replace(/\\/g, '/').split('/').pop() || 'duplicate.xlsx';
    return `${ARCHIVE_ROOT}/_duplicates/${sessionSeg}_quarantine/${leaf}`;
  }

  // ==================================================================================
  // 8.2 深链接回执的**短摘要**（2026-09-14 加固②）
  // ==================================================================================
  //
  // 背景（两条实测事实，见 HANDOFF §4）：
  //   ① `content.js` 原来写 `JSON.stringify(obj).slice(0, 900)` —— **属性硬上限 900 字符**，
  //      回执体一超就腰斩 → **非法 JSON**（实测 `rawLength=900` + `Unable to parse at 900`），
  //      消费方（`scripts\run_batch.ps1` 等）只能靠"头部正则抠标量"这种变通读它。
  //   ② 该属性**粘性**：`sr_action=STATE` 常是同文档导航、内容脚本不重跑 → 读到的可能是
  //      **上一次 START 的回执** → 拿它判会话状态会错（run7 整批空转就是这么来的）。
  //
  // 现方案：写**短摘要**（本函数）——
  //   · **始终是合法 JSON**（超长时**丢弃明细**，绝不截断字符串）；
  //   · **始终 ≤ 900 字符**（目标 ≤ 400，留足余量）；
  //   · 必带 `at`（ISO 时间戳）让消费方判新鲜度，并显式标注**不可用于判会话状态**（`hint`）；
  //   · **兼容既有消费方**：保留 `stage` / `action` 与 `resp.ok` / `resp.sessionId` / `resp.total` /
  //     `resp.error` / `resp.session.{status,sessionId,total}` 这些字段（形状尽量不变），
  //     并在顶层**提升**一份 `ok` / `sessionId` / `total` 便于直接读。
  //
  // ⚠️ 字段名/口径的兼容性清单（改这里之前先看）：
  //   `scripts\run_batch.ps1` 的 `$SR_RECEIPT` 正则读：`"action"` / `"stage"` / `"resp":{"ok":true|false` /
  //   第一个 `"sessionId"` / 文本里是否含「存在未结束的会话」；
  //   `scripts\acceptance_report.py` 文档化的读法：`obj.resp.sessionId` / `obj.resp.total` / `obj.resp.session.*`。
  //   → 因此 `resp` 里 `ok` 必须**排第一**（正则用），`error` 原文必须保留（忙碌文案判据用）。

  /** 回执摘要的硬约束（单测逐条钉住；改上限必须同步改 README/HANDOFF） */
  const AUTORUN_RECEIPT = Object.freeze({
    schema: 'sr-autorun-receipt/2',
    /** 属性硬上限（字符）：超过它消费方就会拿到腰斩的非法 JSON */
    maxChars: 900,
    /**
     * 目标长度：留足余量（实测典型回执 260~330 字符）。
     * ⚠️ 2026-09-22：本值**保持 400 不动**。曾试过提到 450 以便塞下 `activeSession`，
     *    结果连带改了多档阶梯的选中档位、把 4 条既有契约测试打挂（`keys`/忙碌文案…）。
     *    ⇒ 结论：**紧预算通道不要塞新东西**。要做"外部能判活跃会话"，就走轻量动作
     *    `QUEUE_STATE`（它的响应用小，回执自然装得下）——见 `background.js` 的同名注释。
     */
    softChars: 400,
    /** 顶层/摘要里的单值上限 */
    maxStageChars: 60,
    maxActionChars: 40,
    maxSessionIdChars: 64,
    maxErrorChars: 240,
    maxKeys: 12,
    maxKeyChars: 24,
    /** 摘要预算阶梯（逐级丢弃明细；**每一级都仍是合法 JSON**） */
    ladder: Object.freeze([
      Object.freeze({ maxLeaves: 20, maxLeafStringChars: 160, maxArrayItems: 3, maxDepth: 4 }),
      Object.freeze({ maxLeaves: 16, maxLeafStringChars: 140, maxArrayItems: 3, maxDepth: 4 }),
      Object.freeze({ maxLeaves: 12, maxLeafStringChars: 120, maxArrayItems: 2, maxDepth: 4 }),
      Object.freeze({ maxLeaves: 9, maxLeafStringChars: 96, maxArrayItems: 2, maxDepth: 3 }),
      Object.freeze({ maxLeaves: 6, maxLeafStringChars: 64, maxArrayItems: 2, maxDepth: 3 }),
      Object.freeze({ maxLeaves: 4, maxLeafStringChars: 48, maxArrayItems: 1, maxDepth: 2 }),
      Object.freeze({ maxLeaves: 2, maxLeafStringChars: 32, maxArrayItems: 1, maxDepth: 1 }),
    ]),
    /**
     * **必须随属性一起被读到的提醒**：这是回执摘要，不是状态源。
     * （粘性 + 摘要 → 判会话状态必须读会话清单 `session_manifest.json`。）
     * ⚠️ 长度是**预算大头**（它随每条回执一起写进 900 字符的属性里），刻意保持短句。
     */
    hint: '回执摘要（非状态源，带粘性）→ 判会话状态请读会话清单 session_manifest.json',
  });

  /** 截断字符串（只用于**单个值**；绝不截断整个 JSON） */
  function clampText(value, max) {
    const text = String(value == null ? '' : value);
    if (text.length <= max) return text;
    return `${text.slice(0, max)}…`;
  }

  function firstNonNullString(...values) {
    for (const value of values) {
      if (typeof value === 'string' && value) return value;
      if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    }
    return null;
  }

  function firstNonNullNumber(...values) {
    for (const value of values) {
      if (typeof value === 'number' && Number.isFinite(value)) return value;
      if (typeof value === 'string' && value && Number.isFinite(Number(value))) return Number(value);
    }
    return null;
  }

  /**
   * 摘要时的**字段优先序**：预算不够时，先保这些键（其余按原顺序排在后面、可能被丢掉）。
   * 依据 = 既有消费方真正读的字段（`run_batch.ps1` / `acceptance_report.py` 的契约）+ 排障常用字段。
   * ⚠️ 这是"保命顺序"，不是白名单：未列出的键照旧保留，只是排后面。
   */
  const RECEIPT_KEY_PRIORITY = Object.freeze([
    'ok', 'error', 'status', 'sessionId', 'total', 'done', 'gaps', 'counts',
    'stage', 'action', 'at', 'disposition', 'decision', 'filename', 'nudge', 'check', 'source', 'reason', 'note',
  ]);

  /**
   * 把任意 payload 压成**有界摘要**：只留标量 + 极少量数组项/嵌套层级。
   * **超限时丢弃明细**（记账 `omitted`）——绝不产生非法 JSON。
   * 深度上限天然挡住循环引用（不会抛）；容器超深时**整棵子树记一个 `[depth]` 叶子**（不逐子键记账）。
   * @returns {{summary:(object|Array|null), omitted:number, truncated:boolean, leaves:number}}
   */
  function summarizeForReceipt(value, budget) {
    const b = budget || {};
    const maxLeaves = Number(b.maxLeaves) > 0 ? Number(b.maxLeaves) : 24;
    const maxStr = Number(b.maxLeafStringChars) > 0 ? Number(b.maxLeafStringChars) : 200;
    const maxItems = Number(b.maxArrayItems) > 0 ? Number(b.maxArrayItems) : 3;
    const maxDepth = Number(b.maxDepth) > 0 ? Number(b.maxDepth) : 3;
    const state = { leaves: 0, omitted: 0, truncated: false };

    const isContainer = (node) => !!node && typeof node === 'object';
    const depthMarker = () => { state.truncated = true; state.omitted += 1; return '[depth]'; };

    const walk = (node, depth) => {
      if (node === null) return null;
      const type = typeof node;
      if (type === 'undefined') return undefined;
      if (type === 'string') return clampText(node, maxStr);
      if (type === 'number') return Number.isFinite(node) ? node : null;
      if (type === 'boolean') return node;
      if (type === 'bigint' || type === 'symbol') return clampText(String(node), maxStr);
      if (type === 'function') return undefined;
      if (depth >= maxDepth) return depthMarker();
      if (Array.isArray(node)) {
        const out = [];
        const limit = Math.min(node.length, maxItems);
        for (let i = 0; i < limit; i += 1) {
          if (state.leaves >= maxLeaves) { state.truncated = true; state.omitted += node.length - i; break; }
          // 容器子项已到深度上限 → 整项记一个叶子（不展开子键）
          const item = isContainer(node[i]) && depth + 1 >= maxDepth ? depthMarker() : walk(node[i], depth + 1);
          if (item !== undefined) { out.push(item); state.leaves += 1; }
        }
        if (node.length > limit) { state.truncated = true; state.omitted += Math.max(0, node.length - limit); }
        return out;
      }
      // 普通对象：**按优先序排键**（预算不够时先保关键字段），未列出的键排在后面
      const rankOf = (key) => {
        const idx = RECEIPT_KEY_PRIORITY.indexOf(key);
        return idx < 0 ? RECEIPT_KEY_PRIORITY.length : idx;
      };
      const keys = Object.keys(node).sort((a, c) => rankOf(a) - rankOf(c));
      const out = {};
      for (const key of keys) {
        if (state.leaves >= maxLeaves) { state.truncated = true; state.omitted += 1; continue; }
        const child = isContainer(node[key]) && depth + 1 >= maxDepth ? depthMarker() : (() => {
          try {
            return walk(node[key], depth + 1);
          } catch (error) {
            return undefined;
          }
        })();
        if (child === undefined) continue;
        out[clampText(key, 40)] = child;
        state.leaves += 1;
      }
      return out;
    };

    let summary = null;
    try {
      summary = walk(value, 0);
    } catch (error) {
      summary = null;
      state.truncated = true;
    }
    return {
      summary: summary === undefined ? null : summary,
      omitted: state.omitted,
      truncated: state.truncated,
      leaves: state.leaves,
    };
  }

  /**
   * 构造**深链接回执摘要**（`<html data-sr-autorun>` 的内容）。
   *
   * @param {object} payload  content.js 原本要写进属性的对象（`{stage, action, tabId, cfg, resp, error}`）
   * @param {object} [opts]   `{ now?:number(ms) }`（便于单测固定时间；默认 `Date.now()`）
   * @returns {object} 合法 JSON 可序列化的摘要对象（长度 ≤ `AUTORUN_RECEIPT.maxChars`）
   */
  function buildAutorunReceipt(payload, opts) {
    const options = opts || {};
    const input = payload && typeof payload === 'object' ? payload : { error: payload == null ? null : String(payload) };
    const nowMs = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
    const at = new Date(nowMs).toISOString();
    // 目标长度可被调用方放宽（例如只读排障探针 NUDGE_TRACE / *_PROBE 要把细节带回来），
    // 但**硬上限 900 不可越过**（留 40 字符余量给消费方/属性本身）。
    const softChars = Number.isFinite(Number(options.softChars))
      ? Math.max(200, Math.min(Number(options.softChars), AUTORUN_RECEIPT.maxChars - 40))
      : AUTORUN_RECEIPT.softChars;

    const stage = input.stage == null ? null : clampText(input.stage, AUTORUN_RECEIPT.maxStageChars);
    const action = input.action == null ? null : clampText(input.action, AUTORUN_RECEIPT.maxActionChars);
    const respSource = input.resp && typeof input.resp === 'object' ? input.resp : null;
    const paramsSource = input.cfg && typeof input.cfg === 'object' ? input.cfg : null;

    // ---- 头部标量：从 resp 里**提升**（旧消费方读 resp.*，新消费方可直接读顶层）
    const ok = respSource && typeof respSource.ok === 'boolean' ? respSource.ok : null;
    const session = respSource && respSource.session && typeof respSource.session === 'object' ? respSource.session : null;
    const sessionId = firstNonNullString(
      respSource && respSource.sessionId,
      session && session.sessionId,
    );
    const total = firstNonNullNumber(
      respSource && respSource.total,
      session && session.total,
    );
    const respError = respSource && respSource.error != null ? String(respSource.error) : null;
    const errorText = input.error != null ? String(input.error) : respError;
    // ⭐ 2026-09-22：**活跃会话摘要**只认 `resp.activeSession`（由轻量动作 `QUEUE_STATE` 提供）。
    //    为什么不从 `resp.session` 取：STATE 的响应太大，往回执里加字段会改动摘要阶梯的选中档位，
    //    把既有契约字段（`resp.session.status`）挤成 "[depth]"（2026-09-22 实测，打挂 4 条契约测试）。
    //    ⇒ 紧预算通道不塞新东西；外部要看"此刻有没有会话在跑"，就调 QUEUE_STATE。
    const activeSrc = respSource && respSource.activeSession && typeof respSource.activeSession === 'object'
      ? respSource.activeSession : null;
    const activeStatus = activeSrc && activeSrc.status != null ? clampText(String(activeSrc.status), 24) : null;

    const keys = respSource
      ? Object.keys(respSource).map((k) => clampText(k, AUTORUN_RECEIPT.maxKeyChars)).slice(0, AUTORUN_RECEIPT.maxKeys)
      : [];

    /** `resp` 的**保序**重建：`ok` 必须第一个（head 正则判据），其余保持原顺序 */
    const orderResp = (summary) => {
      const out = { ok: ok === null ? null : ok };
      const rest = summary && typeof summary === 'object' && !Array.isArray(summary) ? summary : {};
      for (const key of ['error', 'sessionId', 'total']) {
        if (rest[key] !== undefined && out[key] === undefined) out[key] = rest[key];
      }
      // 顶层提升过的会话 id/总数：把 resp 里缺的那一份补齐（保持"形状尽量兼容"）
      if (out.sessionId === undefined && sessionId != null) out.sessionId = clampText(sessionId, AUTORUN_RECEIPT.maxSessionIdChars);
      if (out.total === undefined && total != null) out.total = total;
      if (out.error === undefined && respError != null) out.error = clampText(respError, AUTORUN_RECEIPT.maxErrorChars);
      for (const key of Object.keys(rest)) {
        if (key === 'ok') continue;
        if (out[key] === undefined) out[key] = rest[key];
      }
      return out;
    };

    const buildWithBudget = (budget, level) => {
      const respWalk = respSource ? summarizeForReceipt(respSource, budget) : { summary: null, truncated: false, omitted: 0 };
      const paramsWalk = paramsSource ? summarizeForReceipt(paramsSource, budget) : { summary: null, truncated: false, omitted: 0 };
      const receipt = {
        schema: AUTORUN_RECEIPT.schema,
        stage,
        action,
        ok: ok === null ? null : ok,
        sessionId: sessionId == null ? null : clampText(sessionId, AUTORUN_RECEIPT.maxSessionIdChars),
        // ⭐ 2026-09-22：活跃会话状态提到头部标量（深层对象会被压成 "[depth]"）。
        //    ⚠️ 只在**响应确实带了 activeSession** 时才加：对 STATE 这类重响应加键会改动
        //       摘要阶梯档位、挤掉契约字段（实测），所以这里不是"有会话就加"。
        ...(activeStatus != null ? { sessionStatus: activeStatus } : {}),
        total: total == null ? null : total,
        at,
        hint: AUTORUN_RECEIPT.hint,
        truncated: false,   // 序列化前按实际预算回填
        error: errorText == null ? null : clampText(errorText, AUTORUN_RECEIPT.maxErrorChars),
      };
      // `keys`（字段名清单）只是排障便利 → 预算收紧时**先丢它**，把空间留给值
      if (keys.length && Number(level) <= 1) receipt.keys = keys;
      if (paramsWalk.summary) receipt.params = paramsWalk.summary;
      if (respWalk.summary) receipt.resp = orderResp(respWalk.summary);
      // ⭐ 2026-09-22 新增：回执里带**当前活跃会话的扁平摘要**（与 `queue` 同一套路：由**响应**提供）。
      //    为什么必须带（Codex 复核指出的一条真问题）：
      //      · 会话状态在 chrome.storage 里，外部（脚本/桥/另一个 agent）**读不到**；
      //      · 磁盘上的 `session_manifest.json` 只能证明**某个历史会话结束了**，
      //        证明不了"**此刻**没有会话在跑"（之后可能又启动了一个）；
      //      · 页面属性 `data-sr-autorun` 是唯一的外部可见通道。
      //    扁平是刻意的：深层对象会被摘要器压成 `"[depth]"`（`resp.session` 就是先例）。
      //    ⚠️ 只从 `resp.activeSession` 取（**不**从 `resp.session` 取）：只有轻量动作
      //       （`QUEUE_STATE`）会带这个字段。STATE 的响应太大、回执会被压到极简档，
      //       硬塞新字段会把既有契约字段（`resp.session.status`）挤掉（2026-09-22 实测，
      //       连带打挂 4 条契约测试）⇒ **紧预算通道不塞新东西**，外部要看活跃会话就用 QUEUE_STATE。
      if (activeSrc) {
        const ac = activeSrc.counts && typeof activeSrc.counts === 'object' ? activeSrc.counts : activeSrc;
        receipt.activeSession = {
          sessionId: activeSrc.sessionId == null ? null
            : clampText(String(activeSrc.sessionId), AUTORUN_RECEIPT.maxSessionIdChars),
          status: activeSrc.status == null ? null : clampText(String(activeSrc.status), 24),
          total: Number(activeSrc.total) || 0,
          done: Number(ac.done) || 0,
          failed: Number(ac.failed_permanent != null ? ac.failed_permanent : ac.failed) || 0,
          pending: Number(ac.pending) || 0,
          ended: Number(ac.ended) || 0,
        };
      }
      // ⭐ 2026-09-18：回执里带**队列摘要**。
      //    为什么必须带：队列存在 chrome.storage 里，**外部（脚本/桥/我）读不到**；
      //    页面上的 `data-sr-autorun` 属性是唯一的外部可见通道。不带就只能靠点界面看，
      //    而"点不了鼠标的机器"上等于不可验证（本次实测就卡在这儿）。
      const queueSrc = respSource && respSource.queue && typeof respSource.queue === 'object' ? respSource.queue : null;
      if (queueSrc) {
        const qc = queueSrc.counts && typeof queueSrc.counts === 'object' ? queueSrc.counts : {};
        const brief = (x) => (x && typeof x === 'object'
          ? { label: clampText(String(x.label == null ? '' : x.label), 80), status: x.status || null }
          : null);
        receipt.queue = {
          running: !!queueSrc.running,
          counts: {
            total: Number(qc.total) || 0,
            pending: Number(qc.pending) || 0,
            running: Number(qc.running) || 0,
            done: Number(qc.done) || 0,
            failed: Number(qc.failed) || 0,
          },
          current: brief(queueSrc.current),
          next: brief(queueSrc.next),
          lastError: queueSrc.lastError ? clampText(String(queueSrc.lastError), 120) : null,
        };
      }
      return {
        receipt,
        truncated: !!(respWalk.truncated || paramsWalk.truncated),
        omitted: respWalk.omitted + paramsWalk.omitted,
      };
    };

    /** 极端兜底：只留头部标量（长度有界：常量 hint + 已限长的 stage/action/error） */
    const minimalReceipt = () => ({
      schema: AUTORUN_RECEIPT.schema,
      stage,
      action,
      ok: ok === null ? null : ok,
      sessionId: sessionId == null ? null : clampText(sessionId, AUTORUN_RECEIPT.maxSessionIdChars),
      // ⭐ 2026-09-22：活跃会话**状态**也是头部标量（兜底层也要能回答"此刻有没有会话在跑"）
      ...(activeStatus != null ? { sessionStatus: activeStatus } : {}),
      total: total == null ? null : total,
      at,
      hint: AUTORUN_RECEIPT.hint,
      truncated: true,
      error: errorText == null ? null : clampText(errorText, 80),
    });

    const tried = [];
    for (let i = 0; i < AUTORUN_RECEIPT.ladder.length; i += 1) {
      const built = buildWithBudget(AUTORUN_RECEIPT.ladder[i], i);
      built.receipt.truncated = !!(built.truncated || i > 0);
      let text;
      try {
        text = JSON.stringify(built.receipt);
      } catch (error) {
        text = null;   // 理论上不会发生（摘要里只有我们自己造的标量）；一旦发生直接走兜底
      }
      if (text == null) return minimalReceipt();
      tried.push({ receipt: built.receipt, text, level: i, omitted: built.omitted });
      if (text.length <= softChars) break;
    }
    const withinSoft = tried.find((entry) => entry.text.length <= softChars);
    const pick = withinSoft || tried[tried.length - 1];
    if (pick.text.length <= AUTORUN_RECEIPT.maxChars) return pick.receipt;
    return minimalReceipt();
  }

  // ==================================================================================
  // 9. 安全边界（纯字符串判定，不碰 DOM）
  // ==================================================================================

  /** 主机/路径白名单：只允许生参外壳页与同源 iframe 内的取数页。 */
  function isAllowedPageUrl(rawUrl) {
    const SR = getSelectors();
    const text = String(rawUrl == null ? '' : rawUrl);
    if (!text) return false;
    let parsed;
    try {
      parsed = new URL(text);
    } catch (error) {
      return false;
    }
    if (parsed.hostname !== SR.PAGE.host) return false;
    // ❗ 2026-09-20：微应用当顶层页时，提交后会跳到**结果视图** `/auto_analysis/datafetch/report_generation…`
    //    （不带 `/lyone` 前缀）——漏了它会让第一个任务之后的每一期都报「不在白名单内」（RT3 实测 21/22 期）。
    return parsed.pathname.startsWith(SR.PAGE.formFramePath)
      || parsed.pathname.startsWith(SR.PAGE.shellPath)
      || parsed.pathname.startsWith(SR.PAGE.microAppResultPath);
  }

  /**
   * 从「来源店铺」控件的**勾选项**里取店铺 ID。
   *
   * ❗❗ 2026-09-20 实测更正（此前插件一直认为"店铺 ID 读不到、必须手填"）：
   *    平台页面上店铺 ID **是可读的** —— 「来源店铺」区块里那个店铺勾选框的 `value` 就是 shopSystemId，
   *    实测 DOM（真实页面只读探针）：
   *      LABEL.dt-oui-checkbox-wrapper  txt=「生参旗舰店」
   *        └ INPUT.dt-oui-checkbox-input  type=checkbox  value="000000"  checked
   *    （另有内嵌 JSON `"mainShopSystemId":"000000"` 可作交叉印证。）
   *    又因为 `checked` 表示**当前选中的店铺**，所以"换店铺后不得沿用旧 ID"这条自然成立。
   *
   * 判定规则：**恰好一个勾选项**且值是纯数字（≥3 位）才认；0 个（未选 / 读不到）或
   * 多个（多店铺账号勾了不止一个）一律返回 null —— **不猜**，由调用方回退到手填并如实标注来源。
   * @param {Array<{value:*, checked:boolean}>} entries
   * @returns {string|null}
   */
  function pickStoreIdFromCheckboxValues(entries) {
    const checked = (Array.isArray(entries) ? entries : [])
      .filter((e) => e && e.checked === true)
      .map((e) => String(e.value == null ? '' : e.value).trim())
      .filter((v) => /^\d{3,}$/.test(v));
    return checked.length === 1 ? checked[0] : null;
  }

  /** 在页面文本里找登录失效 / 风控 / 禁止操作的命中词（命中即停）。 */
  function findStopWords(pageText) {
    const SR = getSelectors();
    const text = String(pageText == null ? '' : pageText);
    return {
      login: SR.STOP_WORDS.login.filter((word) => text.includes(word)),
      risk: SR.STOP_WORDS.risk.filter((word) => text.includes(word)),
      forbiddenControl: SR.STOP_WORDS.forbiddenControl.filter((word) => text.includes(word)),
    };
  }

  // ==================================================================================
  // 10. 导出
  // ==================================================================================

  return Object.freeze({
    // schema / 存储
    SCHEMA_VERSION,
    storageKeys,
    TASK_SHARD_SIZE,
    SESSION_DETAIL_KEEP,
    sessionIdOfDetailKey,
    pickSessionDetailVictims,
    ARCHIVE_ROOT,
    // 重试与限速（固定值，无随机化）
    MAX_ATTEMPTS,
    RETRY_BASE_DELAY_MS,
    RETRY_MAX_DELAY_MS,
    MIN_TASK_INTERVAL_MS,
    nextBackoffMs,
    // 日期工具
    CHUNK_UNITS,
    formatDate,
    compactDate,
    addDays,
    daysBetween,
    compareDates,
    assertDateRange,
    monthChunks,
    weekChunks,
    dayChunks,
    chunkRange,
    // 任务模型
    buildTaskCatalog,
    summarizeTasks,
    findTask,
    // 状态机
    TASK_STATES,
    TASK_TRANSITIONS,
    TASK_LINEAR_FLOW,
    SESSION_STATES,
    SESSION_TRANSITIONS,
    SESSION_ACTIONS,
    SESSION_ACTION_FROM,
    canTransition,
    canTransitionSession,
    isTerminalTaskState,
    assertExportableRange,
    normalizeExportableRange,
    latestExportableEnd,
    weekEndOf,
    monthEndOf,
    DATA_DELAY_DAYS,
    transitionTask,
    advanceTaskTo,
    resolveRetry,
    setSessionStatus,
    transitionSession,
    assertSameContext,
    // 闭合校验
    validateClosure,
    evaluateClosure,
    validateDateCoverage,
    groupIntervalsByDimension,
    // 归档与文件
    sanitizePathSegment,
    archiveRelativePath,
    parsePlatformFilename,
    matchesExpectedFile,
    // 重复下载判定（加固①：催单产物的第二份下载，落盘前取消）
    claimedArtifactOf,
    judgeDuplicateDownload,
    duplicateQuarantineRelativePath,
    // 深链接回执摘要（加固②：合法 JSON + ≤900 字符 + 带时间戳 + 明标"不可判态"）
    AUTORUN_RECEIPT,
    summarizeForReceipt,
    buildAutorunReceipt,
    // 口径
    findDimension,
    // 2026-09-15：粒度 → 维度表 / 指标表 / 已实测列数的粒度（面板与编排层据此判断"是否可用"）
    dimensionTable,
    legalTimeGrains,
    expectedMetricCount,
    expectedColumnCount,
    // 列数口径（维度 × 时间粒度；未知返回 null，绝不猜）
    expectedColumnsFor,
    expectedColumnsDetail,
    decomposeMeasuredColumns,
    checkColumnCount,
    countMetricColumnsFromHeader,
    columnLayoutTable,
    columnOffsetTable,
    // 平台 10 万行截断：检出 + 留证 + 更细分片
    autoChunkUnit,
    parseRowCountText,
    parseRowCapWarning,
    assessRowCap,
    // 额外筛选值的显式覆盖
    normalizeExtraFilterValues,
    // ⭐ 2026-09-16：额外筛选控件**按时间粒度**解析（同维度不同粒度控件可能完全不同：
    //    实测 品类/整体 在 分日/分周/分月 有 终端类型+类目，而 **汇总没有**）
    resolveExtraFilters,
    extraFilterFingerprint,
    knownFilterOptions,
    // 安全边界
    isAllowedPageUrl,
    pickStoreIdFromCheckboxValues,
    findStopWords,
    // 依赖注入（测试可替换页面知识表）
    getSelectors,
    deepFreeze,
  });
});
