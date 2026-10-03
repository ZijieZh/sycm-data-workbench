/**
 * popup.js —— 扩展图标弹出的**极简入口**（2026-09-17 改版）。
 *
 * 职责（刻意保持很小）：
 *   1. 一眼看清：当前店铺 / 会话状态 / 进度与计数 / 缺口数
 *   2. 常用动作：核验当前页、预检、暂停、继续、结束
 *   3. 入口：打开「工作台」整页界面（配置参数、任务进度、历史记录都在那里）
 *
 * 为什么不在这里做配置：参数项多（店铺/批次/日期/4 档数据粒度/时间粒度/维度多选/额外筛选值/
 *   分片/限速/超时），弹窗（Chrome 上限约 800×600）塞不下 —— 新版 UI 把配置搬到整页工作台。
 *   ⚠️ 页面知识与规则**没有复制**：全部走 `ui-core.js` → `core.js`/`selectors.js`（唯一来源）。
 *
 * 版本握手：popup 与 background 版本不一致时**禁用全部操作**
 *   （防止"改了没生效却当成 bug"）。三处版本号由 `scripts/run_tests.ps1` 对齐校验。
 */

'use strict';

(function () {
  const SRUI = globalThis.SRUI;

  /**
   * 面板侧版本：**必须与 manifest.json 的 version 逐字一致**
   * （run_tests.ps1 会把 manifest.json / popup.html 的 meta 声明 / 这里的字面量三处对齐校验）
   */
  const POPUP_VERSION = '0.1.12';

  const POLL_INTERVAL_MS = 900;
  const el = (id) => document.getElementById(id);

  let lastSession = null;
  let lastTabId = null;
  let pollTimer = null;
  let busy = false;

  function toast(kind, text) {
    const node = el('msg');
    if (!text) { node.className = 'msg'; node.textContent = ''; return; }
    node.className = `msg show ${kind || 'info'}`;
    node.textContent = text;
  }

  function applyHandshake() {
    el('versionValue').textContent = POPUP_VERSION;
    const metaVersion = (document.querySelector('meta[name="sr-version"]') || {}).content || '';
    const manifestVersion = chrome.runtime.getManifest().version;
    const drift = (v) => v && v !== POPUP_VERSION;
    el('versionValue').className = (drift(metaVersion) || drift(manifestVersion)) ? 'v bad' : 'v';
    if (SRUI.handshake.ok) {
      el('lockBanner').className = 'lock';
      el('lockBanner').textContent = '';
    } else {
      el('lockBanner').className = 'lock show';
      el('lockBanner').textContent = `⚠ ${SRUI.handshake.reason}。已禁用全部操作：请在 chrome://extensions 重新加载本扩展后再打开面板（只刷新网页无效）。`;
    }
    applyEnablement();
  }

  function applyEnablement() {
    const status = lastSession ? lastSession.status : null;
    const active = !!(lastSession && lastSession.active);
    const rules = {
      btnReadStore: SRUI.handshake.ok && !busy,
      btnPreflight: SRUI.handshake.ok && !busy,
      btnPause: SRUI.handshake.ok && !busy && status === 'running',
      btnResume: SRUI.handshake.ok && !busy && status === 'paused',
      btnEnd: SRUI.handshake.ok && !busy && active,
      btnWorkspace: !busy,
    };
    for (const [id, enabled] of Object.entries(rules)) {
      const node = el(id);
      if (node) node.disabled = !enabled;
    }
    el('btnPause').hidden = status !== 'running';
    el('btnResume').hidden = status !== 'paused';
  }

  function renderSession(session) {
    const v = SRUI.sessionView(session);
    lastSession = v.exists ? v : null;
    el('sessionStatus').textContent = v.statusText;
    el('sessionRange').textContent = v.exists ? `${v.startDate || '—'} ~ ${v.endDate || '—'}` : '';
    el('cDone').textContent = String(v.done);
    el('cFailed').textContent = String(v.failed);
    el('cPending').textContent = String(v.pending);
    el('cGap').textContent = String(v.gap);
    el('progressBar').style.width = `${v.percent}%`;
    applyEnablement();
  }

  async function withBusy(fn) {
    if (busy) return;
    busy = true;
    applyEnablement();
    try {
      await fn();
    } catch (error) {
      toast('err', String((error && error.message) || error));
    } finally {
      busy = false;
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
    lastTabId = response.lastTabId || lastTabId;
    renderSession(response.session);
    if (response.session && response.session.storeName) {
      el('storeName').textContent = response.session.storeName;
    }
    return response;
  }

  async function activeTabId() {
    const tab = await SRUI.activeTab();
    if (!tab) return null;
    lastTabId = tab.id;
    await SRUI.setTargetTab(tab.id);
    return tab.id;
  }

  async function doReadStore() {
    await withBusy(async () => {
      const tabId = await activeTabId();
      if (!tabId) { toast('err', '没有活动标签页：请先在生参取数页打开本面板'); return; }
      const r = await SRUI.readStore(tabId);
      if (!r.ok) { el('tabState').textContent = '不可用'; toast('err', r.error); return; }
      el('tabState').textContent = '已连接表单 frame';
      el('storeName').textContent = r.storeName || '（页面未提供店铺名）';
      toast('ok', `已读到店铺名「${r.storeName || '(未提供)'}」。完整的参数配置请到「工作台」。`);
    });
  }

  async function doPreflight() {
    await withBusy(async () => {
      const tabId = await activeTabId();
      if (!tabId) { toast('err', '没有活动标签页：请先在生参取数页打开本面板'); return; }
      const r = await SRUI.preflight(tabId);
      if (!r.ok) { toast('err', r.error); return; }
      const page = r.page || {};
      el('tabState').textContent = `表单 frame：${page.dimension || '?'} / ${page.timeGrain || '?'}`;
      toast('ok', '预检通过：无登录/风控文案，必填项齐全。');
      await refreshState(true);
    });
  }

  function bind() {
    el('btnReadStore').addEventListener('click', doReadStore);
    el('btnPreflight').addEventListener('click', doPreflight);
    el('btnPause').addEventListener('click', () => withBusy(async () => {
      const r = await SRUI.pause();
      toast(r.ok ? 'info' : 'err', r.ok ? r.note : r.error);
      await refreshState(true);
    }));
    el('btnResume').addEventListener('click', () => withBusy(async () => {
      const tabId = await activeTabId();
      const r = await SRUI.resume(tabId);
      toast(r.ok ? 'ok' : 'err', r.ok
        ? (r.verified ? '已继续：店铺一致校验通过。' : '已继续：页面未提供可比的店铺名，仅做了 frame 可达性校验（请人工确认店铺正确）。')
        : r.error);
      await refreshState(true);
    }));
    el('btnEnd').addEventListener('click', () => withBusy(async () => {
      const r = await SRUI.end();
      if (!r.ok) { toast('err', r.error); return; }
      toast(r.degraded ? 'err' : 'info', r.degraded
        ? `会话已结束，缺口 ${r.gapCount} 条。⚠ 归档目录未生效，清单落在默认下载目录（session_manifest_*.json）。`
        : `会话已结束，缺口 ${r.gapCount} 条。清单已落盘到：${r.artifactRoot}`);
      await refreshState(true);
    }));
    el('btnWorkspace').addEventListener('click', async () => {
      const r = await SRUI.openWorkspace();
      if (r.ok) window.close();
    });
  }

  async function init() {
    SRUI.onHandshake(applyHandshake);
    bind();
    const response = await SRUI.state();
    if (!response.ok) {
      toast('err', response.error || '后台未就绪：请在 chrome://extensions 重新加载扩展');
      applyHandshake();
      return;
    }
    await refreshState(true);
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(() => { if (!busy) refreshState(true).catch(() => undefined); }, POLL_INTERVAL_MS);
    window.addEventListener('unload', () => { if (pollTimer) clearInterval(pollTimer); });
  }

  document.addEventListener('DOMContentLoaded', () => { init().catch(() => undefined); });
})();
