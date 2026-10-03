/**
 * app.js —— 整页工作台（新建取数 / 任务进度 / 历史记录）。
 *
 * 与 popup 的关系：**两者共用 `ui-core.js`**（页面知识、参数装配、校验、后台调用、会话视图）。
 *   本文件只做三件事：① 渲染；② 把界面字段交给 `SRUI.buildConfig`/`SRUI.plan`；③ 调 `SRUI` 的动作。
 *   ⚠️ 不复制任何"页面知识"（维度/指标数/合法粒度/列数都来自 selectors.js + core.js）。
 *
 * 与 popup 的关键差异（必须记住，否则会拿错标签页）：
 *   工作台是**独立标签页**，所以 `tabs.query({active:true})` 拿到的是工作台自己 ——
 *   取数目标页必须按**域名匹配**去找生参取数页，找不到就提示"打开取数页"。
 */
'use strict';

(function () {
  const SRUI = globalThis.SRUI;
  const SR = globalThis.SR;
  const core = globalThis.SRCore;

  const POLL_INTERVAL_MS = 1000;
  const LS_KEY = 'sr:workspace:draft';

  const el = (id) => document.getElementById(id);
  let busy = false;
  let lastSession = null;
  let lastIndex = [];
  let pollTimer = null;
  let targetTabId = null;
  let sycmTabs = [];
  let scope = '店铺';
  let selected = new Set();
  let selectedByScope = {};
  /**
   * 参数是否可改（会话运行中/busy/未握手 → 不可改）。
   * ⚠️ 维度复选框的"禁用"由**两件事**共同决定：① 该维度在当前时间粒度下是否合法（`data-usable`）；
   *    ② 参数是否可改（本变量）。早先把两者混在一个函数里，会出现"运行中反而把不合法维度点亮"的错。
   */
  let configurable = true;
  /** 草稿是否已载入：载入前**不许**回写，否则初始渲染会把用户上次的草稿覆盖掉 */
  let draftReady = false;

  // ------------------------------------------------------------------ 小工具
  function toast(kind, text) {
    const node = el('msg');
    if (!text) { node.className = ''; node.textContent = ''; return; }
    node.className = `show ${kind || ''}`;
    node.textContent = text;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { node.className = ''; }, kind === 'err' ? 6000 : 3600);
  }

  function dialog(title, body) {
    el('dialogTitle').textContent = title;
    el('dialogBody').textContent = body;
    el('dialog').showModal();
  }

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
    ));
  }

  function currentGrain() { return el('timeGrainSelect').value; }

  // ------------------------------------------------------------------ 渲染：页签
  function showPage(page) {
    for (const node of document.querySelectorAll('.nav')) node.classList.toggle('active', node.dataset.page === page);
    for (const node of document.querySelectorAll('.page')) node.classList.toggle('active', node.id === `page-${page}`);
    const meta = {
      new: ['新建取数', '配置本次需要留存的数据'],
      progress: ['任务进度', '会话状态、任务计数与缺口'],
      history: ['历史记录', '本机保存的会话索引'],
    }[page] || ['新建取数', ''];
    el('title').textContent = meta[0];
    el('subtitle').textContent = meta[1];
    if (page === 'history') renderHistory();
  }

  // ------------------------------------------------------------------ 渲染：数据范围 / 粒度 / 维度
  function renderScope() {
    const values = ['全部', ...SRUI.granularities()];
    el('scope').innerHTML = values.map((name) => {
      const count = SRUI.dimensionNamesFor(name).length;
      const usable = count > 0;
      return `<button class="${name === scope ? 'active' : ''}" data-scope="${esc(name)}" ${usable ? '' : 'disabled'}>`
        + `${esc(name)}${usable ? `<span class="quiet"> ${count}维</span>` : '<span class="quiet"> 未实采</span>'}</button>`;
    }).join('');
    for (const node of el('scope').querySelectorAll('button')) {
      node.addEventListener('click', () => {
        if (node.disabled) return;
        scope = node.dataset.scope;
        if (!selectedByScope[scope]) selectedByScope[scope] = new Set();
        selected = selectedByScope[scope];
        seedScopeIfEmpty();
        renderScope();
        renderGrains();
        renderDims();
      });
    }
  }

  function renderGrains() {
    const allowed = ['TTL', ...SRUI.legalGrainsFor(scope)];
    const select = el('timeGrainSelect');
    const previous = select.value;
    select.innerHTML = allowed.map((g) => `<option value="${esc(g)}">${g === 'TTL' ? 'TTL（分日 / 分周 / 分月）' : esc(g)}</option>`).join('');
    select.value = allowed.includes(previous) ? previous : (allowed.includes('分日') ? '分日' : allowed[0]);
    el('grainHint').textContent = `该数据粒度下各维度可用时间粒度的并集：${allowed.join(' / ') || '无'}`;
  }

  function renderDims() {
    const q = el('dimSearch').value.trim();
    const rows = SRUI.dimensionRows(scope, currentGrain()).filter((row) => !q || row.name.includes(q));
    el('dimList').innerHTML = rows.map((row) => {
      // ❗ 2026-09-20（用户反馈"为啥默认全选、我要自己勾，现在只想补跑失败的那些"）：
      //    **「全部 41 维」模式下勾选框也必须可操作** —— 旧写法 `scope !== '全部'` 让勾选恒为全选、
      //    「清空」点了也没反应，只剩"全下"一条路。现在任何范围下都以 `selected`（用户勾选）为准。
      const usable = row.usable && configurable;
      const checked = selected.has(row.name) && row.usable;
      const note = row.usable ? '' : `<em>仅${row.grains.join(' / ')}</em>`;
      const metric = row.metricKnown ? `${row.metricCount}项` : `${currentGrain()}未采`;
      return `<label class="dim ${usable ? '' : 'disabled'}">`
        + `<input type="checkbox" value="${esc(row.name)}" data-usable="${row.usable ? '1' : '0'}"`
        + ` ${checked ? 'checked' : ''} ${usable ? '' : 'disabled'}>`
        + `<span>${esc(row.name)}</span>${note}`
        + `${row.usable ? `<span class="mc ${row.metricKnown ? '' : 'unknown'}" title="「${esc(row.name)} × ${esc(currentGrain())}」实测指标总数">${esc(metric)}</span>` : ''}`
        + '</label>';
    }).join('') || '<div class="dim"><span class="quiet">没有匹配的维度</span></div>';
    for (const node of el('dimList').querySelectorAll('input[type=checkbox]')) {
      node.addEventListener('change', () => {
        if (node.checked) selected.add(node.value); else selected.delete(node.value);
        updateSummary();
      });
    }
    updateSummary();
  }

  /**
   * 当前视图里**用户勾选**的维度。
   * ❗ 2026-09-20：改成一律以 `selected` 集合为准（视图内可用者）——
   *    旧写法在 `scope === '全部'` 时直接返回"全部可用维度"，把用户勾选整个忽略掉了（清空/取消勾选都无效）。
   *    以集合为准还有个好处：**搜索框过滤不会把已勾选但被过滤掉的维度丢掉**。
   */
  function selectedDimensions() {
    return SRUI.dimensionRows(scope, currentGrain())
      .filter((row) => row.usable && selected.has(row.name))
      .map((row) => row.name);
  }

  /** 该范围是否已经"播种"过默认勾选（每范围只播一次，避免用户清空后切回来又被自动勾满） */
  const seededScopes = new Set();
  /** 首次进入某范围且没有任何记忆时，默认勾上该范围下可用的全部维度（**只是默认值，可自由取消**） */
  function seedScopeIfEmpty() {
    if (seededScopes.has(scope)) return;
    seededScopes.add(scope);
    const set = selectedByScope[scope] || (selectedByScope[scope] = new Set());
    if (set.size) return;
    for (const row of SRUI.dimensionRows(scope, currentGrain())) if (row.usable) set.add(row.name);
  }

  // ------------------------------------------------------------------ 配置与计划
  function readFields() {
    return {
      storeId: el('storeIdInput').value,
      storeName: el('storeName').dataset.value || '',
      batch: el('batchInput').value,
      granularity: scope,
      timeGrain: currentGrain(),
      startDate: el('startDate').value,
      endDate: el('endDate').value,
      dimensions: selectedDimensions(),
      efvRaw: el('efvInput').value,
      chunkUnit: el('chunkSelect').value,
      taskIntervalMs: el('intervalInput').value,
      taskTimeoutSec: el('timeoutInput').value,
      ownerTabId: targetTabId,
    };
  }

  function updateSummary() {
    const picked = selectedDimensions();
    const rows = SRUI.dimensionRows(scope, currentGrain());
    el('dimCount').textContent = `已选 ${picked.length} / ${rows.length}`;
    el('selectionSummary').textContent = picked.length ? `已选 ${picked.length} 个维度：${picked.join('、')}` : '尚未选择维度';
    el('rangeSummary').textContent = `${el('startDate').value || '—'} 至 ${el('endDate').value || '—'} · ${scope} · ${currentGrain()}`;
    el('btnQueueAdd').disabled = busy || !picked.length || !SRUI.handshake.ok || !!(lastSession && lastSession.active);
    updatePlan();
    if (draftReady) saveDraft();
  }

  function updatePlan() {
    const config = SRUI.buildConfig(readFields());
    if (scope === '全部' || currentGrain() === 'TTL') {
      const p = SRUI.plan(config);
      el('efvHint').textContent = '批量模式按支持的范围和时间粒度拆分，不包含不支持的组合，不枚举筛选值组合。TTL 不包含汇总。';
      el('reportNameHint').textContent = p.ok ? '各范围独立命名、独立归档' : '—';
      el('planHint').textContent = p.ok
        ? `一次加入 ${p.configs.length} 个自动子计划，预计 ${p.taskCount} 个任务，按队列顺序下载。`
          + (p.excluded.length ? ` 当前粒度不支持、不会下载：${p.excluded.join('；')}。如需这些维度，请另选其支持的时间粒度。` : '所有维度均可下载。')
          // ❗ 2026-09-20：分片单位被按粒度对齐过 ⇒ 必须显示（否则用户以为"按周"生效了，而分月其实整月取）
          + (p.chunkAdjustments && p.chunkAdjustments.length ? ` ⚠️ ${p.chunkAdjustments.join('；')}` : '')
        : p.error;
      return;
    }
    // 额外筛选值：先给出"生效范围"（用 core 的解析器），错配在这里就报出来
    const efv = SRUI.validateExtraFilterValues(config.extraFilterValues || {}, config.dimensions, config.granularity, config.timeGrain);
    el('efvHint').innerHTML = config.dimensions.length
      ? (efv.ok
        ? (efv.reason ? `<br>✅ 生效：${esc(efv.reason)}` : '<br>（未填，全部沿用平台默认值）')
        : `<br>❌ ${esc(efv.reason)}`)
      : '';
    const result = SRUI.plan(config);
    if (!result.ok) {
      el('planHint').textContent = result.error;
      el('reportNameHint').textContent = '—';
      return;
    }
    el('planHint').textContent = `预计任务数 ${result.taskCount}（分片单位：${result.unitsText}；单任务独立成文件、独立校验）`
      + (result.efvText ? `｜额外筛选覆盖：${result.efvText}` : '')
      // ❗ 2026-09-20：区间被自动矫正时必须**看得见**（实际取哪一段 + 改了什么）
      + (result.rangeAdjustments && result.rangeAdjustments.length
        ? `｜已按平台规则自动矫正：${result.rangeAdjustments.join('；')} → 实际取 ${result.rangeStart} ~ ${result.rangeEnd}`
        : '')
      // ❗ 2026-09-20：分片单位与粒度口径不一致时会被对齐 ⇒ 必须看得见（对齐时上面的"分片单位"已是生效值）
      + (result.chunkAdjustments && result.chunkAdjustments.length
        ? `｜⚠️ ${result.chunkAdjustments.join('；')}`
        : '');
    el('reportNameHint').innerHTML = result.reportNameOk
      ? `${esc(result.reportName)} <span class="quiet">（${result.reportNameLength} 字符 ≤ ${SR.REPORT_NAME.maxLength}）</span>`
      : `<span style="color:var(--err)">${esc(result.reportName)}（${result.reportNameLength} 字符 > ${SR.REPORT_NAME.maxLength}，平台会静默拒收）</span>`;
  }

  // ------------------------------------------------------------------ 草稿（本机记忆，避免每次重填）
  function saveDraft() {
    try {
      const draft = {
        scope, grain: currentGrain(), selected: selectedDimensions(),
        start: el('startDate').value, end: el('endDate').value,
        storeId: el('storeIdInput').value, batch: el('batchInput').value,
        efv: el('efvInput').value, chunk: el('chunkSelect').value,
        interval: el('intervalInput').value, timeout: el('timeoutInput').value,
      };
      chrome.storage.local.set({ [LS_KEY]: draft });
    } catch (error) { /* 草稿存不上不影响使用 */ }
  }

  async function loadDraft() {
    try {
      const stored = await chrome.storage.local.get(LS_KEY);
      return stored[LS_KEY] || null;
    } catch (error) { return null; }
  }

  // ------------------------------------------------------------------ 会话状态渲染
  function applyHandshake() {
    const banner = el('lockBanner');
    el('versionLine').textContent = `界面 v${SRUI.VERSION} · TTL版`;
    if (SRUI.handshake.ok) {
      banner.className = 'banner';
      el('handshakeLine').textContent = '已连接后台';
      el('modeTag').className = 'tag ok';
      el('modeTag').textContent = '已连接';
    } else {
      banner.className = 'banner show';
      banner.textContent = `⚠ ${SRUI.handshake.reason}。已禁用全部操作：请在 chrome://extensions 重新加载本扩展，然后重开本页（只刷新网页无效）。`;
      el('handshakeLine').textContent = SRUI.handshake.reason;
      el('modeTag').className = 'tag';
      el('modeTag').textContent = '未连接后台';
    }
    applyEnablement();
  }

  function applyEnablement() {
    const active = !!(lastSession && lastSession.active);
    const status = lastSession ? lastSession.status : null;
    const controls = SRUI.sessionControls(lastSession);
    const rules = {
      btnQueueAdd: SRUI.handshake.ok && !busy && !active && selectedDimensions().length > 0,
      btnPause: SRUI.handshake.ok && !busy && status === 'running',
      btnResume: SRUI.handshake.ok && !busy && status === 'paused',
      btnQueuePause: SRUI.handshake.ok && !busy && controls.canPause,
      btnQueueResume: SRUI.handshake.ok && !busy && controls.canResume,
      btnRetry: SRUI.handshake.ok && !busy && active && ['paused', 'error'].includes(status) && lastSession.retryable > 0 &&
        (!lastSession.activeTask || ['pending', 'retry_wait', 'error', 'delayed', 'failed_permanent', 'done', 'ended'].includes(lastSession.activeTask.status)),
      btnEnd: SRUI.handshake.ok && !busy && active,
      btnDiag: SRUI.handshake.ok && !busy,
      btnPreflight: SRUI.handshake.ok && !busy,
      btnReadStore: SRUI.handshake.ok && !busy,
      btnRefresh: !busy,
      btnReloadHistory: !busy,
      btnOpenPage: true,
    };
    for (const [id, enabled] of Object.entries(rules)) {
      const node = el(id);
      if (node) node.disabled = !enabled;
    }
    const queueButtons = SRUI.queueControls(lastQueue, lastSession, SRUI.handshake.ok, busy);
    el('btnQueueRun').disabled = !queueButtons.canRun;
    el('btnQueueStop').disabled = !queueButtons.canStop;
    el('btnQueueClear').disabled = !queueButtons.canClear;
    el('btnQueueRun').title = status === 'paused' ? '请先继续当前任务，再启动后续队列' : '执行队列中已加入的待执行计划';
    for (const id of ['btnPause', 'btnQueuePause']) el(id).hidden = status !== 'running';
    for (const id of ['btnResume', 'btnQueueResume']) el(id).hidden = status !== 'paused';
    for (const node of document.querySelectorAll('[data-range]')) node.disabled = !SRUI.handshake.ok || busy || active;
    configurable = SRUI.handshake.ok && !busy && !active;
    for (const id of ['storeIdInput', 'batchInput', 'startDate', 'endDate', 'timeGrainSelect',
      'efvInput', 'chunkSelect', 'intervalInput', 'timeoutInput', 'dimSearch', 'btnAllDims', 'btnNoDims', 'btnYear2024', 'btnYear2025']) {
      const node = el(id);
      if (node) node.disabled = !configurable;
    }
    // 维度复选框：**不重建 DOM**（每秒轮询重建会丢滚动位置/闪烁）——
    // 只按「该维度在本粒度下是否合法」+「参数是否可改」两件事更新 disabled
    // ❗ 2026-09-20：不再因 `scope === '全部'` 而禁用（那个禁用让用户无法只挑几个维度补跑）
    for (const node of el('dimList').querySelectorAll('input[type=checkbox]')) {
      node.disabled = node.dataset.usable !== '1' || !configurable;
    }
    updateQueueSelectionControls();
    for (const node of el('scope').querySelectorAll('button')) {
      const usable = SRUI.dimensionNamesFor(node.dataset.scope).length > 0;
      node.disabled = !usable || !configurable;
    }
  }

  function renderSession(session) {
    lastSession = session ? SRUI.sessionView(session) : null;
    const v = lastSession || SRUI.sessionView(null);
    el('sessionStatus').textContent = v.statusText;
    el('sessionId').textContent = v.sessionId ? ` ${v.sessionId}` : '';
    el('sessionRange').textContent = v.exists ? `${v.startDate || '—'} ~ ${v.endDate || '—'}（会话创建 ${v.createdAt || '—'}）` : '';
    el('cDone').textContent = String(v.done);
    el('cFailed').textContent = String(v.failed);
    el('cPending').textContent = String(v.pending);
    el('cGap').textContent = String(v.gap);
    el('progressBar').style.width = `${v.percent}%`;
    el('curTask').textContent = v.activeTask
      ? `${v.activeTask.dimension} / ${v.activeTask.timeGrain} / ${v.activeTask.startDate}~${v.activeTask.endDate}（${v.activeTask.status}，第 ${v.activeTask.attempts} 次）`
      : (v.activeTaskKey || '—');
    el('lastError').textContent = v.lastError || '—';
    el('sessionParams').textContent = v.exists
      ? `${v.storeName || ''}（${v.storeId || ''}）· ${v.granularity || ''} · ${v.timeGrain || ''} · 批次 ${v.batch || '无'} · 共 ${v.total} 个任务`
      : '—';
    const gaps = (v.gaps || []).slice(0, 30);
    el('gapList').innerHTML = gaps.map((gap) => `<div>[${esc(gap.kind)}] ${esc(gap.message)}</div>`).join('')
      + (v.gaps && v.gaps.length > 30 ? `<div>…另有 ${v.gaps.length - 30} 条缺口，完整清单见 session_manifest.json</div>` : '');
    applyEnablement();
  }

  function renderHistory() {
    const rows = (lastIndex || []).slice().reverse();
    el('historyList').innerHTML = rows.map((item) => {
      const status = String(item.status || '');
      const cls = status === 'completed' ? 'completed' : (/error|ended/.test(status) ? 'error' : '');
      return `<div class="hrow"><span>${esc(item.sessionId)}<br><span class="quiet">${esc(item.storeName || '')} ${esc(item.storeId || '')}</span></span>`
        + `<span>${esc(item.startDate || '')} ~ ${esc(item.endDate || '')}</span>`
        + `<span>${esc(item.granularity || '')}<br><span class="quiet">${esc(item.timeGrain || '')} · 批次 ${esc(item.batch || '无')}</span></span>`
        + `<span>${esc(item.total || 0)}</span>`
        + `<span class="st ${cls}">${esc(status || '未知')}<br><span class="quiet">${esc((item.updatedAt || '').replace('T', ' ').slice(0, 19))}</span></span></div>`;
    }).join('');
    el('historyEmpty').textContent = rows.length
      ? `共 ${rows.length} 条（最多保留最近 50 条）。`
      : '本机还没有会话记录。完成一次取数后这里会出现历史。';
  }

  // ------------------------------------------------------------------ 目标标签页
  async function refreshTargetTabs(preferred) {
    sycmTabs = await SRUI.findSycmTabs();
    const select = el('tabSelect');
    if (!sycmTabs.length) {
      targetTabId = null;
      select.style.display = 'none';
      el('tabState').textContent = '未找到生参取数页（点「打开取数页」）';
      return null;
    }
    const keep = preferred != null ? Number(preferred) : targetTabId;
    const found = sycmTabs.find((t) => t.id === keep) || sycmTabs[0];
    targetTabId = found.id;
    if (sycmTabs.length > 1) {
      select.style.display = '';
      select.innerHTML = sycmTabs.map((t) => `<option value="${t.id}">标签页 ${t.id}：${esc((t.title || '').slice(0, 40))}</option>`).join('');
      select.value = String(targetTabId);
    } else {
      select.style.display = 'none';
    }
    el('tabState').textContent = `标签页 ${targetTabId}`;
    await SRUI.setTargetTab(targetTabId);
    return targetTabId;
  }

  // ------------------------------------------------------------------ 动作
  async function withBusy(fn) {
    if (busy) return;
    busy = true;
    applyEnablement();
    el('statusLine').textContent = '正在执行…';
    try {
      await fn();
    } catch (error) {
      toast('err', String((error && error.message) || error));
    } finally {
      busy = false;
      el('statusLine').textContent = SRUI.handshake.ok ? '已连接后台。' : '未连接后台。';
      applyEnablement();
    }
  }

  async function refreshState(quiet) {
    const response = await SRUI.state();
    if (!response.ok) {
      if (!quiet) toast('err', response.error || '读取状态失败');
      applyHandshake();
      return response;
    }
    lastIndex = Array.isArray(response.index) ? response.index : [];
    renderSession(response.session);
    renderQueue(response.queue);            // ⭐ 队列视图随 STATE 一起刷新（后台已算好 counts/current/next）
    if (response.session) {
      // 会话存在时把配置同步成会话真实取值，免得误以为是别的参数在跑
      el('storeIdInput').value = response.session.storeId || el('storeIdInput').value;
      if (!el('storeName').dataset.value && response.session.storeName) {
        el('storeName').dataset.value = response.session.storeName;
        el('storeName').textContent = response.session.storeName;
      }
      if (el('page-history').classList.contains('active')) renderHistory();
    }
    return response;
  }

  /** HTML 转义（队列行是拼字符串渲染的，标签/备注里有用户输入 → 必须转义，防注入与串行） */
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  // ==================================================================================
  // 取数队列（2026-09-18 新增）：UI 只负责展示与转发，顺序/计数等逻辑都在 SRUI（可单测）
  // ==================================================================================
  let lastQueue = null;
  const selectedQueueIds = new Set();

  function updateQueueSelectionControls() {
    const q = lastQueue || { items: [], running: false };
    const deletable = q.items.filter((item) => item.status !== 'running');
    const selectedCount = deletable.filter((item) => selectedQueueIds.has(item.id)).length;
    for (const node of document.querySelectorAll('[data-qcount]')) node.textContent = `已选 ${selectedCount} 项`;
    for (const button of document.querySelectorAll('[data-qbulk]')) {
      const action = button.dataset.qbulk;
      button.disabled = busy || !SRUI.handshake.ok || q.running ||
        (action === 'all' && !deletable.length) ||
        (action !== 'all' && !selectedCount);
      if (q.running && action === 'remove') button.title = '先停止队列；当前会话继续执行';
      else button.removeAttribute('title');
    }
  }

  function queueRowHtml(item, readOnly = false) {
    const st = item.status || 'pending';
    const isCurrent = st === 'running' && lastSession && item.sessionId === lastSession.sessionId;
    const stText = isCurrent ? SRUI.sessionControls(lastSession).statusText : (SRUI.QUEUE_STATUS_TEXT[st] || st);
    const label = SRUI.queueItemLabel(item);
    const tasks = item.plan && item.plan.taskCount ? `（${item.plan.taskCount} 份报表）` : '';
    const note = item.note ? `<div class="note">${escapeHtml(item.note)}</div>` : '';
    const canEdit = st === 'pending';
    if (readOnly) return `<div class="qrow readonly"><div class="seq">${item.seq || ''}</div><div class="lab" title="${escapeHtml(label)}">${escapeHtml(label)}${escapeHtml(tasks)}</div><div class="st ${st}">${escapeHtml(stText)}</div>${note}</div>`;
    return `<div class="qrow" data-qid="${escapeHtml(item.id)}">
      <label class="pick" title="${st === 'running' ? '正在执行，不能删除' : '选择此队列项'}"><input type="checkbox" data-qselect="${escapeHtml(item.id)}" aria-label="选择 ${escapeHtml(label)}" ${selectedQueueIds.has(item.id) ? 'checked' : ''} ${st === 'running' || lastQueue.running ? 'disabled' : ''}></label>
      <div class="seq">${item.seq || ''}</div>
      <div class="lab" title="${escapeHtml(label)}">${escapeHtml(label)}${escapeHtml(tasks)}</div>
      <div class="st ${st}">${escapeHtml(stText)}</div>
      <div class="act">
        ${st === 'failed' ? `<button data-qact="requeue" data-qid="${escapeHtml(item.id)}" title="整组重新加入队列，包含之前成功的报表；原失败记录保留" ${lastQueue.running || item.requeuedAs ? 'disabled' : ''}>${item.requeuedAs ? '已重新入队' : '整组重新入队'}</button>` : ''}
        ${canEdit ? `<button data-qact="up" data-qid="${item.id}" title="上移">↑</button>
                     <button data-qact="down" data-qid="${item.id}" title="下移">↓</button>` : ''}
        ${st !== 'running' ? `<button data-qact="rm" data-qid="${escapeHtml(item.id)}" title="移出队列" ${lastQueue.running ? 'disabled' : ''}>✕</button>` : ''}
      </div>
      ${note}
    </div>`;
  }

  function renderQueue(raw) {
    const q = SRUI.queueView(raw);
    lastQueue = q;
    const deletableIds = new Set(q.items.filter((item) => item.status !== 'running').map((item) => item.id));
    for (const id of selectedQueueIds) if (!deletableIds.has(id)) selectedQueueIds.delete(id);
    const html = q.items.length
      ? q.items.map(item => queueRowHtml(item)).join('')
      : '<div class="qempty">队列为空。设好参数后点「加入队列」，可连加多条，再点「开始队列」。</div>';
    el('queueList').innerHTML = html;
    el('queueList2').innerHTML = q.items.length ? q.items.map(item => queueRowHtml(item, true)).join('') : html;
    const currentStatus = lastSession && lastSession.active ? `；当前任务：${SRUI.sessionControls(lastSession).statusText}` : '';
    el('queueSummary').textContent = q.summaryText + currentStatus + (q.lastError ? `　⚠ ${q.lastError}` : '');
    el('queueSummary2').textContent = q.summaryText + currentStatus + (q.lastError ? `　⚠ ${q.lastError}` : '');
    applyEnablement();
  }

  async function doQueueRemoveSelected() {
    await withBusy(async () => {
      const ids = Array.from(selectedQueueIds);
      if (!ids.length) return;
      const result = await SRUI.queueRemoveMany(ids);
      if (!result.ok) { toast('err', result.error || '批量删除失败'); return; }
      selectedQueueIds.clear();
      renderQueue(result.queue);
      toast('ok', `已从队列删除 ${result.removedCount} 项`);
    });
  }

  async function doQueueAdd() {
    await withBusy(async () => {
      const tabId = targetTabId || await refreshTargetTabs();
      if (!tabId) { toast('err', '没有找到生参取数页：请点「打开取数页」'); return; }
      const config = SRUI.buildConfig(readFields());
      config.ownerTabId = tabId;
      if (!config.storeId) { toast('err', '请填写店铺 ID（在「高级设置」里）'); el('advanced').open = true; return; }
      // ❗ 2026-09-20：勾选为空必须**拦住** —— 否则「全部」模式下"空 = 全下"，
      //    用户以为只跑了挑出来的几个、实际跑了全部（用户实况：只想补跑失败的那几项）。
      if (!config.dimensions.length) { toast('err', '请至少勾选一个数据维度（右侧列表可单个勾选；点「清空」后再一个个挑）'); return; }
      if (!config.storeName) { toast('err', '请先点「核验当前页」拿到店铺名'); return; }
      if (!config.dimensions.length) { toast('err', '请至少选择一个数据维度'); return; }
      const p = SRUI.plan(config);                       // 加入队列前先本地过一遍 core 的规则
      if (!p.ok) { toast('err', `参数不可行：${p.error}`); return; }
      if (!p.reportNameOk) { toast('err', `报表名 ${p.reportNameLength} 字符超过平台上限 ${SR.REPORT_NAME.maxLength}，会被静默拒收`); return; }
      const r = await SRUI.queueAdd({ config, ownerTabId: tabId, label: '' });
      if (!r.ok) { toast('err', r.error || '加入队列失败'); return; }
      renderQueue(r.queue);
      toast('ok', scope === '全部' || currentGrain() === 'TTL'
        ? `已一次加入 ${r.items.length} 个范围子计划，共 ${p.taskCount} 个任务；点击「开始队列」执行。`
        : `已加入队列（第 ${r.queue.counts.total} 项，${p.taskCount} 个任务）：${SRUI.queueItemLabel(r.item)}`);
    });
  }

  async function doQueueAddAnnual(year) {
    await withBusy(async () => {
      const tabId = targetTabId || await refreshTargetTabs();
      if (!tabId) { toast('err', '没有找到生参取数页：请先打开取数页'); return; }
      const base = SRUI.buildConfig(readFields());
      base.ownerTabId = tabId;
      if (!base.storeId || !base.storeName) { toast('err', '请先点「核验当前页」读取店铺名和 ID'); return; }
      const plan = SRUI.annualPlan(year, base);
      if (!plan.ok) { toast('err', plan.error); return; }
      const result = await SRUI.queueAddAnnual(year, base);
      if (!result.ok) { toast('err', result.error || '年度任务入队失败'); return; }
      renderQueue(result.queue);
      toast('ok', `已加入 ${year} 年 ${plan.configs.length} 个维度任务组、共 ${plan.taskCount} 个下载任务。请核对队列后点「开始队列」。`);
    });
  }

  async function doQueueAct(action, itemId) {
    if (action === 'requeue') {
      await withBusy(async () => {
        const tabId = targetTabId || await refreshTargetTabs();
        if (!tabId) { toast('err', '没有找到生参取数页：请先打开取数页'); return; }
        const r = await SRUI.queueRequeueFailed(itemId, tabId);
        if (!r.ok) { toast('err', r.error || '重新加入队列失败'); return; }
        renderQueue(r.queue);
        toast('ok', `已按原配置整组重新入队（${r.item.plan.taskCount} 个任务）；核对后点「开始队列」执行。`);
      });
      return;
    }
    const r = action === 'rm' ? await SRUI.queueRemove(itemId)
      : action === 'up' ? await SRUI.queueMove(itemId, 'up')
        : await SRUI.queueMove(itemId, 'down');
    if (!r.ok) { toast('err', r.error || '操作失败'); return; }
    renderQueue(r.queue);
  }

  async function doQueueRun() {
    await withBusy(async () => {
      if (!targetTabId) await refreshTargetTabs();
      const r = await SRUI.queueRun();
      if (!r.ok) { toast('err', r.error || '启动队列失败'); return; }
      toast('ok', r.started ? `队列已启动：会话 ${r.started.sessionId}（${r.started.total} 个任务）` : '队列已启动：正在等当前会话结束');
    });
    setTimeout(() => refreshState(true), 1500);
  }

  async function doQueueStop() {
    return withBusy(async () => {
    const r = await SRUI.queueStop();
    if (!r.ok) { toast('err', r.error || '停止失败'); return; }
    toast('info', r.note || '已停止队列');
    await refreshState(true);
    });
  }

  async function doQueueClear() {
    return withBusy(async () => {
    const r = await SRUI.queueClearFinished();
    if (!r.ok) { toast('err', r.error || '清理失败'); return; }
    renderQueue(r.queue);
    toast('ok', '已清理成功计划记录；失败计划和已下载文件保留');
    });
  }

  async function doReadStore() {
    await withBusy(async () => {
      const tabId = targetTabId || await refreshTargetTabs();
      if (!tabId) { toast('err', '没有找到生参取数页：请点「打开取数页」后再核验'); return; }
      const r = await SRUI.readStore(tabId);
      if (!r.ok) { toast('err', r.error); return; }
      if (r.storeName) {
        el('storeName').dataset.value = r.storeName;
        el('storeName').textContent = r.storeName;
        el('storeAvatar').textContent = r.storeName.slice(0, 1);
      }
      // ❗ 2026-09-20 修正（用户反馈"店铺ID 为啥要手填"）：
      //    ① 店铺 ID **能从页面读到**（「来源店铺」控件的勾选框 value = shopSystemId，见 core.pickStoreIdFromCheckboxValues）；
      //    ② 读到就以页面为准并**覆盖**输入框 —— 换店铺后不得沿用旧 ID；
      //    ③ 读不到才保留手填值，且**必须如实标注来源**（旧代码无条件写"· 来自当前页面"，
      //       而那个值其实来自历史草稿 —— 就是这次误判的根源）。
      const pageId = r.storeId ? String(r.storeId) : '';
      const beforeId = String(el('storeIdInput').value || '').trim();
      let idSource;
      if (pageId) {
        el('storeIdInput').value = pageId;               // 以页面为准（覆盖）
        idSource = '来自当前页面（来源店铺控件）';
        if (beforeId && beforeId !== pageId) idSource += ` · 已覆盖原值 ${beforeId}`;
      } else if (beforeId) {
        idSource = '来自手动填写 / 历史草稿（页面未提供）';
      } else {
        idSource = '未读到（请手填）';
      }
      el('storeHint').textContent = `店铺 ID ${el('storeIdInput').value || '（待填）'} · ${idSource}`;
      if (pageId) {
        toast('ok', `已读到店铺「${r.storeName || '(页面未提供)'}」（ID ${pageId}，来自当前页面）`);
      } else if (beforeId) {
        toast('info', `已读到店铺名「${r.storeName || '(页面未提供)'}」。页面未提供店铺 ID，当前沿用 ${beforeId}（来源：手填/历史）——换店铺后请重新核验。`);
      } else {
        toast('info', `已读到店铺名「${r.storeName || '(页面未提供)'}」。未在页面上找到店铺选择控件 → 请在「高级设置」手填店铺 ID（归档目录与报表名都要用它）。`);
      }
      updatePlan();
    });
  }

  async function doPreflight() {
    await withBusy(async () => {
      const tabId = targetTabId || await refreshTargetTabs();
      if (!tabId) { toast('err', '没有找到生参取数页：请点「打开取数页」后再预检'); return; }
      const r = await SRUI.preflight(tabId);
      if (!r.ok) { toast('err', r.error); el('preflightHint').textContent = r.error; return; }
      const page = r.page || {};
      // 预检也读到了页面 → 顺手补一次店铺 ID（**只填空值**，不覆盖用户已填；覆盖逻辑留给「核验当前页」）
      if (page.storeId && !String(el('storeIdInput').value || '').trim()) {
        el('storeIdInput').value = String(page.storeId);
        el('storeHint').textContent = `店铺 ID ${page.storeId} · 来自当前页面（预检时读取）`;
        updatePlan();
      }
      el('preflightHint').textContent = `环境检查通过 · 维度 ${page.dimension || '?'} / 时间粒度 ${page.timeGrain || '?'}`;
      toast('ok', '预检通过：无登录/风控文案，必填项齐全。');
      await refreshState(true);
    });
  }

  function bind() {
    for (const node of document.querySelectorAll('.nav')) node.addEventListener('click', () => showPage(node.dataset.page));
    el('closeDialog').addEventListener('click', () => el('dialog').close());
    el('dimSearch').addEventListener('input', renderDims);
    el('timeGrainSelect').addEventListener('change', () => { renderDims(); updateSummary(); });
    for (const id of ['storeIdInput', 'batchInput', 'startDate', 'endDate', 'intervalInput', 'timeoutInput']) {
      el(id).addEventListener('input', updateSummary);
      el(id).addEventListener('change', updateSummary);
    }
    el('efvInput').addEventListener('input', updatePlan);
    el('chunkSelect').addEventListener('change', updateSummary);
    for (const node of document.querySelectorAll('[data-range]')) {
      node.addEventListener('click', () => {
        const range = { available: SRUI.availableDayRange, week: SRUI.last7DaysRange, month: SRUI.lastMonthRange }[node.dataset.range]();
        el('startDate').value = range.start;
        el('endDate').value = range.end;
        updateSummary();
      });
    }
    el('btnAllDims').addEventListener('click', () => {
      for (const row of SRUI.dimensionRows(scope, currentGrain())) if (row.usable) selected.add(row.name);
      renderDims();
    });
    el('btnNoDims').addEventListener('click', () => { selected.clear(); renderDims(); });
    el('tabSelect').addEventListener('change', async () => {
      await refreshTargetTabs(Number(el('tabSelect').value));
      toast('info', `已把取数目标切到标签页 ${targetTabId}`);
    });
    el('btnReadStore').addEventListener('click', doReadStore);
    el('btnPreflight').addEventListener('click', doPreflight);
    el('btnReconnect').addEventListener('click', () => withBusy(async () => {
      const tabId = targetTabId || await refreshTargetTabs();
      if (!tabId) { toast('err', '没有找到生参取数页'); return; }
      const r = await SRUI.call('RECONNECT_PAGE', { tabId });
      toast(r.ok ? 'info' : 'err', r.ok ? r.note : r.error);
    }));
    el('btnManageQueue').addEventListener('click', () => { showPage('new'); el('queueSection').scrollIntoView({ behavior: 'smooth' }); });
    el('btnOpenPage').addEventListener('click', async () => { await SRUI.openFetchPage(); toast('info', '已打开取数页；等它加载完再回来点「核验当前页」'); });
    el('btnRefresh').addEventListener('click', () => refreshState().catch(() => undefined));
    el('btnReloadHistory').addEventListener('click', () => refreshState().catch(() => undefined));
    const pauseCurrent = () => withBusy(async () => {
      const r = await SRUI.pause();
      toast(r.ok ? 'info' : 'err', r.ok ? r.note : r.error);
      await refreshState(true);
    });
    el('btnPause').addEventListener('click', pauseCurrent);
    el('btnQueuePause').addEventListener('click', pauseCurrent);
    const resumeCurrent = () => withBusy(async () => {
      const r = await SRUI.resume(targetTabId);
      toast(r.ok ? 'ok' : 'err', r.ok
        ? (r.verified ? '已继续：店铺一致校验通过。' : '已继续：页面未提供可比的店铺名，仅做了 frame 可达性校验（请人工确认店铺正确）。')
        : r.error);
      await refreshState(true);
    });
    el('btnResume').addEventListener('click', resumeCurrent);
    el('btnQueueResume').addEventListener('click', resumeCurrent);
    el('btnRetry').addEventListener('click', () => withBusy(async () => {
      const r = await SRUI.retryFailed();
      toast(r.ok ? 'info' : 'err', r.ok ? `已重置 ${r.retried} 个失败项（attempts 预算重新计满），会话状态：${r.status}` : r.error);
      await refreshState(true);
    }));
    el('btnEnd').addEventListener('click', () => withBusy(async () => {
      const r = await SRUI.end();
      if (!r.ok) { toast('err', r.error); return; }
      if (r.degraded) {
        dialog('会话已结束（归档路径降级）', `缺口 ${r.gapCount} 条。⚠ 归档目录未能生效，清单落盘时改用了扁平文件名：请在浏览器默认下载目录里找 session_manifest_*.json / session_log_*.json（本该在 ${r.artifactRoot}）。文件内容完整，诊断事件里已记录本次降级。`);
      } else {
        toast('info', `会话已结束，缺口 ${r.gapCount} 条。清单已落盘到：${r.artifactRoot}`);
      }
      await refreshState(true);
    }));
    // ---- 取数队列（2026-09-18）----
    el('btnQueueAdd').addEventListener('click', doQueueAdd);
    el('btnYear2024').addEventListener('click', () => doQueueAddAnnual(2024));
    el('btnYear2025').addEventListener('click', () => doQueueAddAnnual(2025));
    el('btnQueueRun').addEventListener('click', doQueueRun);
    el('btnQueueStop').addEventListener('click', doQueueStop);
    el('btnQueueClear').addEventListener('click', doQueueClear);
    for (const button of document.querySelectorAll('[data-qbulk]')) {
      button.addEventListener('click', () => {
        const action = button.dataset.qbulk;
        if (action === 'remove') { doQueueRemoveSelected(); return; }
        if (action === 'clear') selectedQueueIds.clear();
        else if (action === 'all' && lastQueue) {
          for (const item of lastQueue.items) if (item.status !== 'running') selectedQueueIds.add(item.id);
        }
        for (const input of document.querySelectorAll('[data-qselect]')) {
          input.checked = selectedQueueIds.has(input.dataset.qselect);
        }
        updateQueueSelectionControls();
      });
    }
    // 两个队列面板（新建页 / 进度页）共用一套事件委托：↑ ↓ ✕
    for (const hostId of ['queueList', 'queueList2']) {
      el(hostId).addEventListener('change', (ev) => {
        const input = ev.target;
        if (!input || !input.matches('[data-qselect]')) return;
        if (input.checked) selectedQueueIds.add(input.dataset.qselect);
        else selectedQueueIds.delete(input.dataset.qselect);
        for (const peer of document.querySelectorAll('[data-qselect]')) {
          if (peer.dataset.qselect === input.dataset.qselect) peer.checked = input.checked;
        }
        updateQueueSelectionControls();
      });
      el(hostId).addEventListener('click', (ev) => {
        const btn = ev.target && ev.target.closest ? ev.target.closest('button[data-qact]') : null;
        if (!btn) return;
        doQueueAct(btn.dataset.qact, btn.dataset.qid);
      });
    }    el('btnDiag').addEventListener('click', () => withBusy(async () => {
      const r = await SRUI.exportDiagnostics();
      toast(r.ok ? 'ok' : 'err', r.ok ? `诊断已导出：${r.path}` : r.error);
    }));
  }

  // ------------------------------------------------------------------ 启动
  async function init() {
    SRUI.onHandshake(applyHandshake);
    renderScope();
    renderGrains();
    renderDims();
    el('intervalInput').value = String(core.MIN_TASK_INTERVAL_MS);
    el('timeoutInput').value = '180';

    const draft = await loadDraft();
    const fallback = SRUI.lastMonthRange();
    if (draft) {
      if (['全部', ...SRUI.granularities()].includes(draft.scope)) scope = draft.scope;
      if (!selectedByScope[scope]) selectedByScope[scope] = new Set();
      selected = selectedByScope[scope];
      renderScope(); renderGrains();
      if (draft.grain) el('timeGrainSelect').value = draft.grain;
      el('startDate').value = draft.start || fallback.start;
      el('endDate').value = draft.end || fallback.end;
      el('storeIdInput').value = draft.storeId || '';
      el('batchInput').value = draft.batch || '';
      el('efvInput').value = draft.efv || '';
      if (draft.chunk) el('chunkSelect').value = draft.chunk;
      if (draft.interval) el('intervalInput').value = draft.interval;
      if (draft.timeout) el('timeoutInput').value = draft.timeout;
      for (const name of (draft.selected || [])) selected.add(name);
      // 草稿里带过选择（**哪怕是空数组 = 用户上次主动清空**）→ 一律尊重，不再自动播种默认全选
      if (Array.isArray(draft.selected)) seededScopes.add(scope);
      renderDims();
    } else {
      selectedByScope[scope] = new Set();
      selected = selectedByScope[scope];
      seedScopeIfEmpty();
      el('startDate').value = fallback.start;
      el('endDate').value = fallback.end;
      renderDims();
    }
    // ⚠️ 必须**在草稿载入之后**才允许回写：否则上面那次初始渲染会把用户上次的草稿覆盖成空
    draftReady = true;
    updateSummary();

    bind();
    // ⭐ 深链接：`app.html?page=progress|history` 直接落到对应页（便于收藏 / 自动化截图复核）
    const wanted = (() => {
      try { return new URLSearchParams(location.search).get('page') || ''; } catch (error) { return ''; }
    })();
    showPage(['new', 'progress', 'history'].includes(wanted) ? wanted : 'new');

    const response = await SRUI.state();
    if (!response.ok) {
      applyHandshake();
      toast('err', response.error || '后台未就绪：请在 chrome://extensions 重新加载扩展');
      return;
    }
    await refreshTargetTabs();
    await refreshState(true);
    el('statusLine').textContent = '已连接后台。';
    applyHandshake();
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(() => { if (!busy) refreshState(true).catch(() => undefined); }, POLL_INTERVAL_MS);
    window.addEventListener('unload', () => { if (pollTimer) clearInterval(pollTimer); });
  }

  document.addEventListener('DOMContentLoaded', () => { init().catch((error) => toast('err', String((error && error.message) || error))); });
})();
