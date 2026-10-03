(function runSycmCollector() {
  "use strict";

  if (window.__sycmLossCollectorLoadedV1) return;
  window.__sycmLossCollectorLoadedV1 = true;

  const core = window.SycmCollectorCore;
  const STORAGE_KEY = "sycmLossCollectorStateV1";
  const OVERLAY_HIDDEN_KEY = "sycmLossCollectorOverlayHiddenV1";
  const STORAGE_WARNING_BYTES = 8 * 1024 * 1024;
  const controller = { running: false, pauseRequested: false, endRequested: false };
  let cachedTabId = null;
  let expectedDate = null;

  // 单页应用切换栏目也必须移除已插入的卡片。
  setInterval(() => {
    if (!isShopLossPage()) document.getElementById("sycm-loss-collector-overlay")?.remove();
  }, 500);

  function isShopLossPage() {
    const url = new URL(location.href);
    const activeKey = url.searchParams.get("activeKey");
    return url.pathname === "/mc/free/ci_shop" && (!activeKey || activeKey === "shopLoss");
  }

  function isOverlayHidden() {
    try { return sessionStorage.getItem(OVERLAY_HIDDEN_KEY) === "1"; } catch { return false; }
  }

  function setOverlayHidden(hidden) {
    try {
      if (hidden) sessionStorage.setItem(OVERLAY_HIDDEN_KEY, "1");
      else sessionStorage.removeItem(OVERLAY_HIDDEN_KEY);
    } catch { /* 页面策略禁止 sessionStorage 时不影响采集 */ }
  }

  function ensureOverlay() {
    let overlay = document.getElementById("sycm-loss-collector-overlay");
    if (overlay) return overlay;
    overlay = document.createElement("div");
    overlay.id = "sycm-loss-collector-overlay";
    overlay.style.cssText = [
      "position:fixed", "right:22px", "bottom:22px", "z-index:2147483647",
      "min-width:250px", "max-width:360px", "padding:12px 14px",
      "border:1px solid #bfdbfe", "border-radius:12px", "background:#ffffff",
      "box-shadow:0 10px 28px rgba(23,62,115,.22)",
      "font-family:Microsoft YaHei,PingFang SC,sans-serif", "font-size:12px",
      "color:#173e73"
    ].join(";");
    overlay.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px">
        <strong style="font-size:13px">竞店流失取数</strong>
        <span style="display:flex;gap:6px">
          <button type="button" data-action="pause" style="display:none;border:1px solid #cbd5e1;border-radius:7px;background:#fff;color:#294666;padding:4px 9px;cursor:pointer">暂停</button>
          <button type="button" data-action="end" style="display:none;border:1px solid #fecaca;border-radius:7px;background:#fff;color:#b42318;padding:4px 9px;cursor:pointer">结束</button>
          <button type="button" data-action="hide" aria-label="隐藏进度卡" style="display:none;border:0;background:transparent;color:#64748b;padding:4px 3px;cursor:pointer">×</button>
        </span>
      </div>
      <div data-role="status" style="margin-top:7px;color:#475569">准备中</div>
      <div style="height:6px;margin-top:8px;border-radius:6px;background:#e8eef6;overflow:hidden">
        <i data-role="bar" style="display:block;width:0;height:100%;background:linear-gradient(90deg,#2563eb,#7c3aed);transition:width .25s"></i>
      </div>`;
    overlay.querySelector("[data-action='pause']").addEventListener("click", () => {
      requestControllerAction("pause");
    });
    overlay.querySelector("[data-action='end']").addEventListener("click", () => {
      if (window.confirm("确定结束本轮任务吗？已采集数据会保留，但会标记为部分结果。")) requestControllerAction("end");
    });
    overlay.querySelector("[data-action='hide']").addEventListener("click", () => {
      setOverlayHidden(true);
      overlay.remove();
    });
    document.documentElement.appendChild(overlay);
    return overlay;
  }

  function renderOverlay(state) {
    if (!state || !isShopLossPage()) {
      document.getElementById("sycm-loss-collector-overlay")?.remove();
      return;
    }
    if (["completed", "ended", "error"].includes(state.status) && isOverlayHidden()) {
      document.getElementById("sycm-loss-collector-overlay")?.remove();
      return;
    }
    const overlay = ensureOverlay();
    const status = overlay.querySelector("[data-role='status']");
    const bar = overlay.querySelector("[data-role='bar']");
    const pause = overlay.querySelector("[data-action='pause']");
    const end = overlay.querySelector("[data-action='end']");
    const hide = overlay.querySelector("[data-action='hide']");
    const stores = state.stores?.length ?? 0;
    const products = state.products?.length ?? 0;
    const label = ({ running: "采集中", paused: "已暂停", completed: "采集完成", ended: "已结束（部分结果）", error: "采集出错" })[state.status] ?? "准备中";
    const dayText = state.progress?.totalDates
      ? `｜第 ${Math.min(state.progress.currentDateIndex ?? 1, state.progress.totalDates)}/${state.progress.totalDates} 天｜第 ${state.job?.page ?? 1} 页`
      : "";
    status.textContent = `${label}${dayText}｜${stores} 家店｜${products} 件商品`;
    pause.style.display = state.status === "running" ? "inline-block" : "none";
    end.style.display = ["running", "paused"].includes(state.status) ? "inline-block" : "none";
    hide.style.display = ["completed", "ended", "error"].includes(state.status) ? "inline-block" : "none";
    const progress = state.status === "completed"
      ? 100
      : state.progress?.totalDates
        ? Math.min(96, Math.max(4, ((state.progress.completedDates ?? 0) / state.progress.totalDates) * 100))
        : Math.min(92, Math.max(5, stores * 2));
    bar.style.width = `${progress}%`;
    bar.style.background = state.status === "error"
      ? "#dc2626"
      : state.status === "completed"
        ? "#059669"
        : "linear-gradient(90deg,#2563eb,#7c3aed)";
  }

  async function sleep(ms) {
    await new Promise((resolve) => setTimeout(resolve, ms));
    if (controller.running && !isShopLossPage()) throw new Error("已离开竞店流失页面，采集停止；返回后可重试");
    if (controller.running && expectedDate && displayedPageDate() !== expectedDate) throw new Error("采集期间页面日期发生变化，已停止以防错采；返回原日期后重试");
  }

  function isVisible(element) {
    if (!(element instanceof Element)) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
  }

  function leafTextElements(label) {
    const selector = "a,button,span,div,td,th";
    return [...document.querySelectorAll(selector)].filter((element) => {
      if (!isVisible(element)) return false;
      if (!core.normalizeText(element.innerText).includes(label)) return false;
      return ![...element.children].some((child) => core.normalizeText(child.innerText).includes(label));
    });
  }

  function numericLineCount(text) {
    return core.linesOf(text).filter((line) => core.numericValue(line) !== null).length;
  }

  function countLabel(element, label) {
    return [...element.querySelectorAll("a,button,span,div,td,th")]
      .filter((child) => core.normalizeText(child.innerText).includes(label)).length;
  }

  function locateStoreRow(link) {
    let element = link;
    let best = null;
    for (let depth = 0; element && depth < 10; depth += 1, element = element.parentElement) {
      const text = element.innerText ?? "";
      if (text.length > 1800) break;
      const parsed = core.parseStoreText(text);
      if (parsed && numericLineCount(text) >= 2 && countLabel(element, core.TOP_LABEL) >= 1) {
        best = { element, parsed, textLength: text.length };
        break;
      }
    }
    return best;
  }

  function candidateScrollableElements() {
    const candidates = [document.scrollingElement, ...document.querySelectorAll("main,section,div")]
      .filter(Boolean)
      .filter((element) => {
        if (element === document.scrollingElement) return true;
        const style = getComputedStyle(element);
        return /(auto|scroll)/.test(style.overflowY) && element.scrollHeight - element.clientHeight > 240;
      });
    return [...new Set(candidates)];
  }

  function chooseScrollTarget() {
    const candidates = candidateScrollableElements();
    const scored = candidates.map((element) => {
      const labelCount = [...element.querySelectorAll("a,button,span,div")]
        .filter((child) => core.normalizeText(child.innerText).includes(core.TOP_LABEL)).length;
      const area = element === document.scrollingElement
        ? window.innerWidth * window.innerHeight
        : element.clientWidth * element.clientHeight;
      return { element, score: labelCount * 1000000 + area };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored[0]?.element ?? document.scrollingElement;
  }

  function scrollInfo(target) {
    if (target === document.scrollingElement) {
      return {
        top: window.scrollY,
        height: document.documentElement.scrollHeight,
        viewport: window.innerHeight,
      };
    }
    return { top: target.scrollTop, height: target.scrollHeight, viewport: target.clientHeight };
  }

  function setScrollTop(target, top) {
    if (target === document.scrollingElement) window.scrollTo({ top, behavior: "instant" });
    else target.scrollTop = top;
  }

  async function waitUntil(check, timeoutMs = 3500, intervalMs = 120) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const result = check();
      if (result) return result;
      await sleep(intervalMs);
    }
    return null;
  }

  function exactHeaderElements() {
    return leafTextElements("商品名称");
  }

  function locateProductPanel(storeRect) {
    const candidates = exactHeaderElements()
      .map((header) => ({ header, rect: header.getBoundingClientRect() }))
      .filter(({ rect }) => rect.top >= storeRect.top - 30 && rect.top <= storeRect.bottom + 1100)
      .sort((a, b) => Math.abs(a.rect.top - storeRect.bottom) - Math.abs(b.rect.top - storeRect.bottom));

    for (const { header } of candidates) {
      let element = header;
      for (let depth = 0; element && depth < 9; depth += 1, element = element.parentElement) {
        const text = element.innerText ?? "";
        if (text.length > 15000) break;
        if (text.includes("商品名称") && text.includes("流失指数") && text.includes("流失人气")) {
          const rows = extractProductRows(element);
          if (rows.length) return { element, rows };
        }
      }
    }
    return null;
  }

  function rowLikeElements(panel) {
    const structured = [...panel.querySelectorAll("tr,[role='row'],li")].filter(isVisible);
    if (structured.length) return structured;
    return [...panel.querySelectorAll("div")]
      .filter(isVisible)
      .filter((element) => element.children.length >= 2 && element.children.length <= 12);
  }

  function extractProductRows(panel) {
    const byKey = new Map();
    for (const element of rowLikeElements(panel)) {
      const text = element.innerText ?? "";
      if (text.includes("商品名称") || text.includes(core.TOP_LABEL)) continue;
      const parsed = core.parseProductText(text);
      if (!parsed) continue;
      // 内容完全相同的商品也可能是不同排名。按页面纵向位置区分真实行，
      // 仅合并同一视觉行中由嵌套 div 造成的重复解析结果。
      const visualBand = Math.round(element.getBoundingClientRect().top / 4);
      const key = `${visualBand}|${parsed.rank ?? ""}|${parsed.productName}|${parsed.lossIndex}|${parsed.lossPopularity}`;
      const previous = byKey.get(key);
      if (!previous || text.length < previous.textLength) byKey.set(key, { ...parsed, textLength: text.length });
    }
    const rows = [...byKey.values()].map(({ textLength, ...row }) => row);
    return core.fillSequentialRanks(rows, 10);
  }

  function productRowsSignature(rows) {
    return rows.map((row) => `${row.rank ?? ""}|${row.productName}|${row.lossIndex}|${row.lossPopularity}`).join("||");
  }

  function productRowsScore(rows) {
    const check = core.rankCompleteness(rows);
    return rows.length * 100 + (check.complete ? 25 : 0) + check.maximum;
  }

  async function stabilizeProductPanel(storeRect, initialPanel) {
    if (!initialPanel) return null;
    const started = Date.now();
    let best = initialPanel;
    let bestScore = productRowsScore(initialPanel.rows);
    let lastSignature = productRowsSignature(initialPanel.rows);
    let stableChecks = 0;

    while (Date.now() - started < 6000) {
      await sleep(250);
      const current = locateProductPanel(storeRect);
      if (!current) continue;
      const signature = productRowsSignature(current.rows);
      if (signature === lastSignature) stableChecks += 1;
      else {
        lastSignature = signature;
        stableChecks = 0;
      }
      const score = productRowsScore(current.rows);
      if (score >= bestScore) {
        best = current;
        bestScore = score;
      }
      const check = core.rankCompleteness(current.rows);
      if (check.complete && stableChecks >= 2 && Date.now() - started >= 650) return current;
    }
    return best;
  }

  function findToggle(row, link) {
    const expanded = row.querySelector("[aria-expanded='true']");
    if (expanded && isVisible(expanded)) return expanded;
    if (link instanceof HTMLElement) return link;
    return row.querySelector("button,a,[role='button']");
  }

  async function expandAndExtract(link, storeRow, delayMs) {
    const beforeHeaders = exactHeaderElements().length;
    link.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
    await sleep(120);
    link.click();
    await sleep(delayMs);
    const storeRect = storeRow.getBoundingClientRect();
    const initialPanel = await waitUntil(() => locateProductPanel(storeRect), 4200, 150);
    const panel = await stabilizeProductPanel(storeRect, initialPanel);
    if (!panel && exactHeaderElements().length === beforeHeaders) return { products: [], panel: null, productStatus: "missing" };
    const products = panel?.rows ?? [];
    return { products, panel: panel?.element ?? null, productStatus: products.length ? "collected" : "missing" };
  }

  async function collapseRow(storeRow, link, panel, delayMs) {
    if (!panel || !isVisible(panel)) return;
    const toggle = findToggle(storeRow, link);
    if (!toggle) return;
    toggle.click();
    await sleep(Math.min(350, delayMs));
  }

  async function currentTabId() {
    if (cachedTabId !== null) return cachedTabId;
    const response = await chrome.runtime.sendMessage({ type: "GET_TAB_ID" });
    if (!response?.ok || !Number.isInteger(response.tabId)) throw new Error("无法识别当前标签页，任务未启动");
    cachedTabId = response.tabId;
    return cachedTabId;
  }

  async function ownsJob(state) {
    if (!Number.isInteger(state?.job?.ownerTabId)) return true;
    return state.job.ownerTabId === await currentTabId();
  }

  async function loadState() {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    return stored[STORAGE_KEY] ?? null;
  }

  async function saveState(state) {
    state.updatedAt = new Date().toISOString();
    state.logs = (state.logs ?? []).slice(-80);
    state.diagnostics = state.diagnostics ?? {};
    state.diagnostics.storageBytes = new Blob([JSON.stringify({ [STORAGE_KEY]: state })]).size;
    if (state.diagnostics.storageBytes >= STORAGE_WARNING_BYTES) {
      state.warning = "本地数据已接近 Chrome 默认存储上限，建议立即结束并导出。";
    }
    try {
      await chrome.storage.local.set({ [STORAGE_KEY]: state });
    } catch (error) {
      throw new Error(`保存采集进度失败，可能已达到浏览器存储上限：${error?.message ?? error}`);
    }
    renderOverlay(state);
  }

  function addLog(state, message) {
    state.logs.push(`${new Date().toLocaleTimeString("zh-CN", { hour12: false })} ${message}`);
  }

  async function requestControllerAction(action) {
    const state = await loadState();
    if (!state || !await ownsJob(state)) return { ok: false, message: "当前标签页不是任务所属页面" };
    if (action === "pause") {
      if (state.status !== "running") return { ok: false, message: "当前没有正在运行的任务" };
      controller.pauseRequested = true;
      controller.endRequested = false;
      return { ok: true, pending: true };
    }
    if (action === "end") {
      if (["paused", "error"].includes(state.status) || (state.status === "running" && !controller.running)) {
        state.status = "ended";
        state.partialResult = true;
        state.endedAt = new Date().toISOString();
        addLog(state, "用户结束任务，已保留当前部分结果");
        await saveState(state);
        return { ok: true, ended: true };
      }
      if (state.status !== "running") return { ok: false, message: "当前没有可结束的任务" };
      controller.endRequested = true;
      controller.pauseRequested = false;
      return { ok: true, pending: true };
    }
    return { ok: false, message: "未知任务操作" };
  }

  function uniqueVisibleTopLinks() {
    const candidates = leafTextElements(core.TOP_LABEL)
      .map((element) => element.closest("a,button") ?? element)
      .filter(isVisible);
    return [...new Set(candidates)].sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
  }

  function dateList(startDate, endDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
      throw new Error("请选择正确的开始和结束日期");
    }
    const start = new Date(`${startDate}T00:00:00+08:00`);
    const end = new Date(`${endDate}T00:00:00+08:00`);
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start > end) {
      throw new Error("开始日期不能晚于结束日期");
    }
    const dates = [];
    for (let cursor = new Date(start); cursor <= end; cursor.setDate(cursor.getDate() + 1)) {
      const year = cursor.getFullYear();
      const month = String(cursor.getMonth() + 1).padStart(2, "0");
      const day = String(cursor.getDate()).padStart(2, "0");
      dates.push(`${year}-${month}-${day}`);
      if (dates.length > 31) throw new Error("单次最多采集31天，请缩短日期范围");
    }
    return dates;
  }

  function displayedPageDate() {
    return core.parseDisplayedDate(document.body.innerText);
  }

  function pageDataSignature() {
    return uniqueVisibleTopLinks().map((link) => {
      const rowInfo = locateStoreRow(link);
      if (!rowInfo) return core.normalizeText(link.innerText);
      const row = rowInfo.parsed;
      return `${row.rank ?? ""}|${row.storeName}|${row.lossIndex}|${row.lossPopularity}`;
    }).join("|");
  }

  function dateAnchor(date) {
    return leafTextElements(date)
      .filter((element) => element.getBoundingClientRect().top < 420)
      .sort((a, b) => {
        const aText = core.normalizeText(a.innerText);
        const bText = core.normalizeText(b.innerText);
        return Number(!aText.includes("统计时间")) - Number(!bText.includes("统计时间"))
          || aText.length - bText.length;
      })[0] ?? null;
  }

  function dateNavigationControl(direction, date) {
    const anchor = dateAnchor(date);
    if (!anchor) return null;
    const anchorRect = anchor.getBoundingClientRect();
    const candidates = [...document.querySelectorAll("button,[role='button'],a")]
      .filter(isVisible)
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return Math.abs((rect.top + rect.bottom) / 2 - (anchorRect.top + anchorRect.bottom) / 2) < 70
          && rect.left >= anchorRect.right - 40
          && rect.left <= anchorRect.right + 420
          && rect.width <= 110
          && rect.height <= 72;
      });
    const pattern = direction === "previous"
      ? /(arrow|chevron|angle|caret)[-_ ]?left|\bprev(?:ious)?\b|上一|前一天|向左/i
      : /(arrow|chevron|angle|caret)[-_ ]?right|\bnext\b|下一|后一天|向右/i;
    const described = candidates.find((element) => {
      const descriptor = [
        element.getAttribute("aria-label"),
        element.getAttribute("title"),
        element.className,
        element.innerHTML,
      ].join(" ");
      return pattern.test(descriptor);
    });
    if (described) return described;

    const arrows = candidates
      .filter((element) => core.normalizeText(element.innerText) !== "日")
      .filter((element) => element.querySelector("svg,i") || /^[<>‹›←→]$/.test(core.normalizeText(element.innerText)))
      .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
    if (direction === "previous") return arrows[0] ?? null;
    return arrows[1] ?? arrows[arrows.length - 1] ?? null;
  }

  function dayDelta(fromDate, toDate) {
    const from = new Date(`${fromDate}T00:00:00+08:00`);
    const to = new Date(`${toDate}T00:00:00+08:00`);
    return Math.round((to - from) / 86400000);
  }

  async function switchDisplayedDate(targetDate, state) {
    let currentDate = displayedPageDate();
    if (!currentDate) throw new Error("未识别到页面上的“统计时间”，无法自动切换日期");
    for (let step = 0; currentDate !== targetDate && step < 62; step += 1) {
      if (controller.pauseRequested || controller.endRequested) throw new Error("日期切换已中止");
      const delta = dayDelta(currentDate, targetDate);
      const direction = delta < 0 ? "previous" : "next";
      const control = dateNavigationControl(direction, currentDate);
      if (!control) throw new Error(`未找到${direction === "previous" ? "前一天" : "后一天"}按钮，页面仍为 ${currentDate}`);
      const beforeDate = currentDate;
      const beforeData = pageDataSignature();
      control.click();
      const changedDate = await waitUntil(() => {
        const value = displayedPageDate();
        return value && value !== beforeDate ? value : null;
      }, 10000, 200);
      if (!changedDate) throw new Error(`点击日期按钮后页面仍为 ${beforeDate}，已停止以防错采`);
      currentDate = changedDate;
      addLog(state, `页面日期已切换：${beforeDate} → ${currentDate}`);
      await saveState(state);
      const changedData = await waitUntil(() => {
        const signature = pageDataSignature();
        return signature && signature !== beforeData ? signature : null;
      }, 12000, 300);
      if (!changedData) throw new Error(`页面日期已到 ${currentDate}，但店铺数据未刷新，已停止以防错采`);
      await sleep(500);
    }
    if (currentDate !== targetDate) throw new Error(`无法切换到 ${targetDate}，当前页面为 ${currentDate}`);
    return currentDate;
  }

  function storeIdentity(date, name) {
    return `${date}|${core.normalizeText(name)}`;
  }

  function productIdentity(date, storeName, productRank, productName) {
    return core.productIdentityKey(date, storeName, productRank, productName);
  }

  function pageSignature() {
    return uniqueVisibleTopLinks().map((link) => {
      const rowInfo = locateStoreRow(link);
      return rowInfo ? core.normalizeText(rowInfo.parsed.storeName) : core.normalizeText(link.innerText);
    }).join("|");
  }

  function disabledControl(element) {
    const clickable = element.matches("button,a") ? element : element.querySelector("button,a") ?? element;
    const classes = `${element.className ?? ""} ${clickable.className ?? ""}`;
    return Boolean(clickable.disabled)
      || clickable.getAttribute("aria-disabled") === "true"
      || element.getAttribute("aria-disabled") === "true"
      || /disabled/i.test(classes);
  }

  function nextPageCandidates() {
    const selectors = [
      ".ant-pagination-next",
      ".el-pagination .btn-next",
      ".arco-pagination-item-next",
      ".next-pagination-item.next-next",
      "[class*='pagination'] [title='下一页']",
      "[class*='pagination'] [class*='next']",
      "[class*='pager'] [class*='next']",
      "button[aria-label='下一页']",
      "button[title='下一页']",
      "li[title='下一页']",
    ];
    return [...new Set(selectors.flatMap((selector) => [...document.querySelectorAll(selector)]).filter(isVisible))];
  }

  function paginationLastPageNumber() {
    const containers = [...document.querySelectorAll("[class*='pagination'],[class*='pager'],nav[aria-label*='分页']")].filter(isVisible);
    const numbers = containers.flatMap((container) => [...container.querySelectorAll("button,a,li,[role='button']")])
      .map((element) => Number(core.normalizeText(element.innerText)))
      .filter((value) => Number.isInteger(value) && value >= 1 && value <= 1000);
    return numbers.length ? Math.max(...numbers) : null;
  }

  function paginationCurrentPageNumber() {
    const selectors = [
      "[class*='pagination'] [aria-current='page']",
      "[class*='pagination'] [class*='active']",
      "[class*='pager'] [aria-current='page']",
      "[class*='pager'] [class*='current']",
    ];
    for (const element of selectors.flatMap((selector) => [...document.querySelectorAll(selector)]).filter(isVisible)) {
      const value = Number(core.normalizeText(element.innerText));
      if (Number.isInteger(value) && value > 0) return value;
    }
    return null;
  }

  async function ensureFirstPage() {
    const currentPage = paginationCurrentPageNumber();
    if (currentPage === null || currentPage === 1) return;
    const containers = [...document.querySelectorAll("[class*='pagination'],[class*='pager'],nav[aria-label*='分页']")].filter(isVisible);
    const firstPage = containers.flatMap((container) => [...container.querySelectorAll("button,a,li,[role='button']")])
      .find((element) => core.normalizeText(element.innerText) === "1" && !disabledControl(element));
    if (!firstPage) throw new Error(`当前位于第 ${currentPage} 页，但未找到第一页按钮`);
    const before = pageSignature();
    const clickable = firstPage.matches("button,a") ? firstPage : firstPage.querySelector("button,a") ?? firstPage;
    clickable.click();
    const changed = await waitUntil(() => {
      const signature = pageSignature();
      return signature && signature !== before ? signature : null;
    }, 10000, 250);
    if (!changed) throw new Error(`从第 ${currentPage} 页返回第一页失败`);
  }

  async function goToNextPage(pageNumber) {
    const candidates = nextPageCandidates();
    const candidate = candidates.find((element) => !disabledControl(element));
    const lastPage = paginationLastPageNumber();
    if (!candidate) {
      return {
        moved: false,
        endConfirmed: candidates.some(disabledControl) || (lastPage !== null && pageNumber >= lastPage),
        lastPage,
      };
    }
    const next = candidate.matches("button,a") ? candidate : candidate.querySelector("button,a") ?? candidate;
    const before = pageSignature();
    next.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
    await sleep(120);
    next.click();
    const changed = await waitUntil(() => {
      const current = pageSignature();
      return current && current !== before ? current : null;
    }, 10000, 250);
    return { moved: Boolean(changed), endConfirmed: false, lastPage };
  }

  async function collectCurrentPage(state, date, pageNumber, seenStores, seenProducts) {
    const delayMs = state.job.delayMs;
    const scrollTarget = chooseScrollTarget();
    setScrollTop(scrollTarget, 0);
    await sleep(500);
    const initialEntrances = uniqueVisibleTopLinks().length;
    if (!initialEntrances) throw new Error(`日期 ${date} 第 ${pageNumber} 页未检测到店铺入口`);

    const collectedPage = new Set();
    let noNewCycles = 0;
    let stableBottomCycles = 0;
    state.diagnostics.topEntrances += initialEntrances;
    state.progress.currentPageExpected = initialEntrances;
    state.progress.currentPageCollected = 0;
    addLog(state, `${date} 第 ${pageNumber} 页初始识别 ${initialEntrances} 家，继续扫描到底`);
    await saveState(state);

    for (let cycle = 0; cycle < 600 && noNewCycles < 30 && stableBottomCycles < 5; cycle += 1) {
      if (controller.pauseRequested || controller.endRequested) break;
      let foundNew = false;
      const links = uniqueVisibleTopLinks();
      state.progress.currentPageExpected = Math.max(state.progress.currentPageExpected, links.length, collectedPage.size);

      for (let linkIndex = 0; linkIndex < links.length; linkIndex += 1) {
        const link = links[linkIndex];
        const rowInfo = locateStoreRow(link);
        if (!rowInfo) {
          state.diagnostics.rowParseFailures += 1;
          continue;
        }
        const store = { ...rowInfo.parsed };
        const key = storeIdentity(date, store.storeName);
        if (seenStores.has(key)) {
          collectedPage.add(key);
          continue;
        }

        if (store.rank === null && pageNumber === 1 && linkIndex < 3) store.rank = linkIndex + 1;
        const expanded = await expandAndExtract(link, rowInfo.element, delayMs);
        if (expanded.products.length) {
          const productCheck = core.rankCompleteness(expanded.products);
          if (!productCheck.complete) {
            addLog(state, `${store.storeName} 商品排名暂不连续：缺 ${productCheck.missing.join("、") || "未知"}`);
          }
        }
        if (expanded.productStatus === "missing") {
          addLog(state, `${store.storeName} 未成功读取商品明细，将阻止任务误报完整`);
        }
        seenStores.add(key);
        collectedPage.add(key);
        state.stores.push({ date, ...store, productStatus: expanded.productStatus });
        for (const product of expanded.products) {
          const productKey = productIdentity(date, store.storeName, product.rank, product.productName);
          if (seenProducts.has(productKey)) continue;
          seenProducts.add(productKey);
          state.products.push({ date, storeRank: store.rank, storeName: store.storeName, ...product });
        }
        await collapseRow(rowInfo.element, link, expanded.panel, delayMs);
        state.progress.stores = state.stores.length;
        state.progress.products = state.products.length;
        state.progress.currentPageCollected = collectedPage.size;
        addLog(state, `${date}｜第 ${pageNumber} 页｜店铺 ${store.rank ?? "-"} ${store.storeName}`);
        await saveState(state);
        foundNew = true;
        break;
      }

      if (foundNew) {
        noNewCycles = 0;
        stableBottomCycles = 0;
      }
      else {
        noNewCycles += 1;
        const info = scrollInfo(scrollTarget);
        const atBottom = info.top + info.viewport >= info.height - 8;
        if (atBottom) {
          stableBottomCycles += 1;
          setScrollTop(scrollTarget, info.height);
        } else {
          stableBottomCycles = 0;
          setScrollTop(scrollTarget, Math.min(info.height, info.top + Math.max(240, info.viewport * 0.45)));
        }
      }
      await sleep(400);
    }

    if (controller.pauseRequested || controller.endRequested) return false;
    if (!collectedPage.size) throw new Error(`${date} 第 ${pageNumber} 页没有成功采集任何店铺`);
    if (stableBottomCycles < 5) throw new Error(`${date} 第 ${pageNumber} 页扫描未稳定到达底部，请重试`);
    addLog(state, `${date} 第 ${pageNumber} 页采集完成：${collectedPage.size} 家`);
    await saveState(state);
    return true;
  }

  async function runPendingJob(state) {
    if (!isShopLossPage() || controller.running || state?.status !== "running" || !state?.job?.dates?.length) return;
    if (!await ownsJob(state)) {
      renderOverlay(state);
      return;
    }
    controller.running = true;
    let resumeAfterFinish = false;
    const seenStores = new Set(state.stores.map((row) => storeIdentity(row.date, row.storeName)));
    const seenProducts = new Set(state.products.map((row) => productIdentity(row.date, row.storeName, row.rank, row.productName)));

    try {
      const date = state.job.dates[state.job.dateIndex];
      const pageDate = displayedPageDate();
      if (!pageDate) throw new Error("未识别到页面真实的“统计时间”");
      if (pageDate !== date) {
        state.date = date;
        addLog(state, `页面当前为 ${pageDate}，正在逐日切换到 ${date}`);
        await saveState(state);
        await switchDisplayedDate(date, state);
      }
      if (displayedPageDate() !== date) throw new Error(`页面日期未真正切换到 ${date}，停止采集`);
      expectedDate = date;

      state.date = date;
      state.job.page = Math.max(1, Number(state.job.page) || 1);
      if (state.job.page === 1) await ensureFirstPage();
      state.progress.currentDateIndex = state.job.dateIndex + 1;
      state.progress.totalDates = state.job.dates.length;
      addLog(state, `开始采集 ${date} 的全部分页`);
      await saveState(state);

      let endConfirmed = false;
      for (let pageNumber = state.job.page; pageNumber <= 100; pageNumber += 1) {
        state.job.page = pageNumber;
        await collectCurrentPage(state, date, pageNumber, seenStores, seenProducts);
        if (controller.pauseRequested || controller.endRequested) break;
        const navigation = await goToNextPage(pageNumber);
        if (!navigation.moved) {
          if (!navigation.endConfirmed) {
            throw new Error(`${date} 第 ${pageNumber} 页无法确认已到最后一页，已停止以防漏采`);
          }
          const dateStoreCount = state.stores.filter((row) => row.date === date).length;
          endConfirmed = true;
          addLog(state, `${date} 已确认到达最后一页，共 ${dateStoreCount} 家`);
          break;
        }
        await sleep(650);
      }

      if (controller.endRequested) {
        state.status = "ended";
        state.partialResult = true;
        state.endedAt = new Date().toISOString();
        addLog(state, "用户结束任务，已保留当前部分结果");
      } else if (controller.pauseRequested) {
        state.status = "paused";
        addLog(state, "任务已暂停，可从弹窗继续采集");
      } else {
        if (!endConfirmed) throw new Error("已达到100页保护上限，未确认最后一页，请检查分页；当前仅为部分结果");
        const dateStores = state.stores.filter((row) => row.date === date);
        const missingProductStores = dateStores.filter((row) => row.productStatus === "missing");
        if (missingProductStores.length) {
          throw new Error(`${date} 有 ${missingProductStores.length} 家店铺未成功读取商品明细：${missingProductStores.map((row) => row.storeName).join("、")}`);
        }
        const rankCheck = core.rankCompleteness(dateStores);
        if (!rankCheck.complete) {
          const details = [
            rankCheck.missing.length ? `缺少排名 ${rankCheck.missing.join("、")}` : "",
            rankCheck.duplicates.length ? `重复排名 ${rankCheck.duplicates.join("、")}` : "",
            dateStores.some((row) => !Number.isInteger(Number(row.rank))) ? "存在无排名店铺" : "",
          ].filter(Boolean).join("；");
          throw new Error(`${date} 排名完整性校验失败：${details || "排名不连续"}`);
        }
        const productRankIssues = [];
        for (const store of dateStores) {
          const storeProducts = state.products.filter((row) => row.date === date && row.storeName === store.storeName);
          if (!storeProducts.length) continue;
          const productCheck = core.rankCompleteness(storeProducts);
          if (!productCheck.complete) {
            const issue = [
              productCheck.missing.length ? `缺 ${productCheck.missing.join("、")}` : "",
              productCheck.duplicates.length ? `重复 ${productCheck.duplicates.join("、")}` : "",
            ].filter(Boolean).join("/") || "存在无排名商品";
            productRankIssues.push(`${store.storeName}（${issue}）`);
          }
        }
        if (productRankIssues.length) {
          throw new Error(`${date} 商品排名完整性校验失败：${productRankIssues.join("；")}`);
        }
        state.stores = core.sortStores(state.stores);
        state.products = core.sortProducts(state.products);
        addLog(state, `${date} 排名 1—${rankCheck.maximum} 校验完整`);
        addLog(state, `${date} 各店铺商品排名连续性校验通过`);
        state.job.completedDates.push(date);
        state.progress.completedDates = state.job.completedDates.length;
        addLog(state, `${date} 全部分页采集完成`);
        if (state.job.dateIndex + 1 < state.job.dates.length) {
          state.job.dateIndex += 1;
          state.job.page = 1;
          const nextDate = state.job.dates[state.job.dateIndex];
          state.date = nextDate;
          addLog(state, `下一日期：${nextDate}`);
          await saveState(state);
          resumeAfterFinish = true;
          return;
        }
        state.status = "completed";
        addLog(state, `全部完成：${state.job.dates.length} 天，${state.stores.length} 家店铺`);
      }
    } catch (error) {
      if (controller.endRequested || controller.pauseRequested) {
        state.status = controller.endRequested ? "ended" : "paused";
        state.partialResult = true;
        addLog(state, controller.endRequested ? "用户结束任务，已保留当前部分结果" : "任务已暂停，可继续采集");
      } else {
        state.status = "error";
        state.partialResult = true;
        state.error = String(error?.message ?? error);
        addLog(state, `错误：${state.error}`);
      }
    } finally {
      state.progress.stores = state.stores.length;
      state.progress.products = state.products.length;
      controller.running = false;
      expectedDate = null;
      controller.pauseRequested = false;
      controller.endRequested = false;
      try { await saveState(state); } catch (error) {
        state.status = "error";
        state.error = String(error?.message ?? error);
        renderOverlay(state);
        console.error(state.error);
      }
      if (resumeAfterFinish && state.status === "running") {
        setTimeout(async () => {
          const latest = await loadState();
          runPendingJob(latest);
        }, 500);
      }
    }
  }

  async function startJob(options) {
    if (!isShopLossPage()) return { ok: false, message: "请先打开竞店流失页面" };
    if (controller.running) return { ok: false, message: "已有采集任务正在运行" };
    controller.pauseRequested = false;
    controller.endRequested = false;
    setOverlayHidden(false);
    const currentDate = displayedPageDate();
    if (!currentDate) throw new Error("未识别页面日期，请先选择日维度并等待页面加载完成");
    const dates = dateList(options?.startDate || currentDate, options?.endDate || currentDate);
    const delayMs = Math.max(350, Math.min(2500, Number(options?.delayMs) || 700));
    const ownerTabId = await currentTabId();
    const state = {
      version: 3,
      status: "running",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      date: dates[0],
      rangeStart: dates[0],
      rangeEnd: dates[dates.length - 1],
      pageUrl: location.href,
      stores: [],
      products: [],
      progress: { stores: 0, products: 0, currentDateIndex: 1, totalDates: dates.length, completedDates: 0 },
      diagnostics: { topEntrances: 0, rowParseFailures: 0 },
      logs: [],
      job: { dates, dateIndex: 0, completedDates: [], page: 1, delayMs, ownerTabId },
      warning: "流失人气为页面可见口径；商品为各店铺页面可见TOP流失去向商品。",
    };
    addLog(state, `创建任务：${state.rangeStart} 至 ${state.rangeEnd}，共 ${dates.length} 天`);
    const claimed = await chrome.runtime.sendMessage({ type: "CLAIM_JOB", state });
    if (!claimed?.ok) return claimed;
    await saveState(state);
    setTimeout(async () => runPendingJob(await loadState()), 150);
    return { ok: true, started: true };
  }

  async function resumeJob() {
    if (!isShopLossPage()) return { ok: false, message: "请先返回竞店流失页面" };
    if (controller.running) return { ok: false, message: "任务已经在运行" };
    const state = await loadState();
    if (!["paused", "error", "running"].includes(state?.status) || !state?.job?.dates?.length) return { ok: false, message: "没有可恢复的任务" };
    const claimed = await chrome.runtime.sendMessage({ type: "CLAIM_JOB", resume: true });
    if (!claimed?.ok) return claimed;
    // 从当天第一页扫描，保留成功店铺，仅移除失败店铺以便补采。
    const date = state.job.dates[state.job.dateIndex];
    const failed = new Set(state.stores.filter((row) => row.date === date && (row.productStatus === "missing" || !core.rankCompleteness(state.products.filter((p) => p.date === date && p.storeName === row.storeName)).complete)).map((row) => row.storeName));
    state.stores = state.stores.filter((row) => row.date !== date || !failed.has(row.storeName));
    state.products = state.products.filter((row) => row.date !== date || !failed.has(row.storeName));
    state.job.page = 1;
    delete state.error;
    setOverlayHidden(false);
    controller.pauseRequested = false;
    controller.endRequested = false;
    state.job.ownerTabId = await currentTabId();
    state.status = "running";
    addLog(state, `继续任务：${state.date} 第 ${state.job.page || 1} 页`);
    await saveState(state);
    setTimeout(async () => runPendingJob(await loadState()), 150);
    return { ok: true, resumed: true };
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message.type !== "string") return false;
    if (message.type === "PING") {
      sendResponse({ ok: isShopLossPage(), url: location.href, date: displayedPageDate(), pageType: isShopLossPage() ? "shopLoss" : "other" });
      return false;
    }
    if (message.type === "GET_STATE") {
      loadState().then((state) => sendResponse({ ok: true, state }));
      return true;
    }
    if (message.type === "START") {
      if (controller.running) {
        sendResponse({ ok: false, message: "已有采集任务正在运行" });
        return false;
      }
      startJob(message.options)
        .then(sendResponse)
        .catch((error) => sendResponse({ ok: false, message: String(error?.message ?? error) }));
      return true;
    }
    if (message.type === "RESUME") {
      resumeJob()
        .then(sendResponse)
        .catch((error) => sendResponse({ ok: false, message: String(error?.message ?? error) }));
      return true;
    }
    if (message.type === "STOP") {
      requestControllerAction("pause").then(sendResponse).catch((error) => sendResponse({ ok: false, message: String(error?.message ?? error) }));
      return true;
    }
    if (message.type === "END") {
      requestControllerAction("end").then(sendResponse).catch((error) => sendResponse({ ok: false, message: String(error?.message ?? error) }));
      return true;
    }
    return false;
  });

  // 日期切换会刷新页面；内容脚本重新加载后从 storage 中恢复任务。
  setTimeout(async () => {
    if (!isShopLossPage()) return;
    const state = await loadState();
    if (state?.status === "running" && state?.job?.dates?.length) runPendingJob(state);
    else if (state) renderOverlay(state);
  }, 700);
})();
