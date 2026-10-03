(function runPopup() {
  "use strict";

  const core = window.SycmCollectorCore;
  const STORAGE_KEY = "sycmLossCollectorStateV1";
  const elements = {
    page: document.getElementById("page-status"),
    date: document.getElementById("date-value"),
    status: document.getElementById("run-status"),
    progress: document.getElementById("progress-value"),
    log: document.getElementById("log-view"),
    delay: document.getElementById("delay-ms"),
    startDate: document.getElementById("start-date"),
    endDate: document.getElementById("end-date"),
    start: document.getElementById("start-button"),
    stop: document.getElementById("stop-button"),
    end: document.getElementById("end-button"),
  };

  let activeTabId = null;
  let currentState = null;
  let viewingPrevious = false;
  const extensionApiAvailable = typeof chrome !== "undefined" && Boolean(chrome.tabs && chrome.storage);

  async function getActiveTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    activeTabId = tab?.id ?? null;
    return tab;
  }

  async function send(message) {
    if (!activeTabId) await getActiveTab();
    if (!activeTabId) throw new Error("找不到当前页面");
    return chrome.tabs.sendMessage(activeTabId, message);
  }

  async function ensureConnected() {
    const tab = await getActiveTab();
    if (!tab?.url?.startsWith("https://sycm.taobao.com/")) throw new Error("请先打开生意参谋竞店流失页面");
    const url = new URL(tab.url);
    if (url.pathname !== "/mc/free/ci_shop" || (url.searchParams.get("activeKey") && url.searchParams.get("activeKey") !== "shopLoss")) throw new Error("请先打开生意参谋竞店流失页面");
    try {
      return await send({ type: "PING" });
    } catch (error) {
      await chrome.scripting.executeScript({
        target: { tabId: activeTabId },
        files: ["collector-core.js", "content.js"],
      });
      await new Promise((resolve) => setTimeout(resolve, 250));
      return send({ type: "PING" });
    }
  }

  function statusLabel(status) {
    return ({ running: "采集中", paused: "已暂停", completed: "已完成", ended: "已结束（部分结果）", error: "出错" })[status] ?? "未开始";
  }

  function render(state) {
    currentState = state;
    const rangeLabel = state?.rangeStart
      ? (state.rangeStart === state.rangeEnd ? state.rangeStart : `${state.rangeStart} 至 ${state.rangeEnd}`)
      : state?.date || "—";
    elements.date.textContent = rangeLabel;
    elements.status.textContent = statusLabel(state?.status);
    const dayProgress = state?.progress?.totalDates
      ? `｜${state.progress.completedDates ?? 0}/${state.progress.totalDates} 天`
      : "";
    elements.progress.textContent = `${state?.stores?.length ?? 0} 家 / ${state?.products?.length ?? 0} 件${dayProgress}`;
    elements.log.textContent = state?.logs?.length ? state.logs.join("\n") : "等待开始";
    if (state?.rangeStart && !elements.startDate.value) elements.startDate.value = state.rangeStart;
    if (state?.rangeEnd && !elements.endDate.value) elements.endDate.value = state.rangeEnd;
    elements.start.textContent = ["paused", "error", "running"].includes(state?.status) ? "继续 / 恢复任务" : "开始采集日期范围";
    elements.start.disabled = viewingPrevious;
    elements.stop.disabled = state?.status !== "running";
    elements.end.disabled = viewingPrevious || !["running", "paused", "error"].includes(state?.status);
    const lockOptions = ["running", "paused"].includes(state?.status);
    elements.startDate.disabled = lockOptions;
    elements.endDate.disabled = lockOptions;
    elements.delay.disabled = lockOptions;
  }

  async function refresh() {
    const saved = await chrome.storage.local.get([STORAGE_KEY, "sycmLossCollectorPreviousV1"]);
    render(saved[viewingPrevious ? "sycmLossCollectorPreviousV1" : STORAGE_KEY] ?? null);
    if (viewingPrevious) {
      elements.page.textContent = "上一轮结果（只读）";
      elements.stop.disabled = true;
      return;
    }
    try {
      const tab = await getActiveTab();
      if (!tab?.url?.startsWith("https://sycm.taobao.com/")) {
        elements.page.textContent = "请打开生意参谋";
        render(currentState);
        return;
      }
      const ping = await ensureConnected();
      elements.page.textContent = ping?.ok ? "已连接" : "未连接";
      if (ping?.date && !currentState?.date) elements.date.textContent = ping.date;
      if (ping?.date && !elements.startDate.value) elements.startDate.value = ping.date;
      if (ping?.date && !elements.endDate.value) elements.endDate.value = ping.date;
      const stored = await chrome.storage.local.get(STORAGE_KEY);
      render(stored[STORAGE_KEY] ?? { date: ping?.date || "" });
    } catch (error) {
      elements.page.textContent = "连接失败";
      elements.log.textContent = String(error?.message ?? error);
    }
  }

  async function start() {
    try {
      elements.start.disabled = true;
      await ensureConnected();
      if (["paused", "error", "running"].includes(currentState?.status)) {
        const response = await send({ type: "RESUME" });
        if (!response?.ok) throw new Error(response?.message || "继续失败");
        elements.log.textContent = "正在继续上一任务。";
        await new Promise((resolve) => setTimeout(resolve, 350));
        return;
      }
      const startDate = elements.startDate.value;
      const endDate = elements.endDate.value;
      if (!startDate || !endDate) throw new Error("请选择开始和结束日期");
      if (startDate > endDate) throw new Error("开始日期不能晚于结束日期");
      const days = Math.round((new Date(`${endDate}T00:00:00`) - new Date(`${startDate}T00:00:00`)) / 86400000) + 1;
      if (days > 31) throw new Error("单次最多采集31天");
      if (currentState?.stores?.length && !confirm("开始新任务会替换当前结果，并保留最近一轮备份。请确认需要的数据已导出。")) return;
      const response = await send({
        type: "START",
        options: { delayMs: Number(elements.delay.value), startDate, endDate },
      });
      if (!response?.ok) throw new Error(response?.message || "启动失败");
      elements.log.textContent = "采集已启动。扩展小窗可以关闭，请查看网页右下角常驻进度。";
      await new Promise((resolve) => setTimeout(resolve, 350));
    } catch (error) {
      elements.log.textContent = `启动失败：${error?.message ?? error}`;
    } finally {
      await refresh();
    }
  }

  async function stop() {
    try {
      const response = await send({ type: "STOP" });
      if (!response?.ok) throw new Error(response?.message || "暂停失败");
      await refresh();
    } catch (error) {
      elements.log.textContent = `暂停失败：${error?.message ?? error}`;
    }
  }

  async function end() {
    if (!confirm("确定结束本轮任务吗？已采集数据会保留并可导出，但会明确标记为部分结果。")) return;
    try {
      const response = await send({ type: "END" });
      if (!response?.ok) throw new Error(response?.message || "结束失败");
      await refresh();
    } catch (error) {
      elements.log.textContent = `结束失败：${error?.message ?? error}`;
    }
  }

  function download(name, content, mime = "text/csv;charset=utf-8") {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = name;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  function safeDate() {
    const start = currentState?.rangeStart || currentState?.date || new Date().toISOString().slice(0, 10);
    const end = currentState?.rangeEnd || start;
    return (start === end ? start : `${start}_至_${end}`).replace(/[^0-9_至-]/g, "") + (currentState?.status === "completed" ? "_完整" : "_部分结果");
  }

  function requireData() {
    if (!currentState?.stores?.length) throw new Error("没有可导出的数据，请先完成采集");
    return currentState;
  }

  function resultCsv(headers, rows) {
    const label = currentState?.status === "completed" ? "完整" : "部分结果";
    return core.toCsv(["采集完整性", ...headers], rows.map((row) => [label, ...row]));
  }

  function exportStores() {
    const state = requireData();
    const rows = core.sortStores(state.stores).map((row) => [row.date, row.rank, row.storeName, row.lossIndex, row.lossPopularity]);
    download(`竞店流失_${safeDate()}_店铺.csv`, resultCsv(["日期", "排名", "店铺名称", "流失指数", "流失人气"], rows));
  }

  function exportProducts() {
    const state = requireData();
    const rows = core.sortProducts(state.products).map((row) => [row.date, row.storeRank, row.storeName, row.rank, row.productName, row.lossIndex, row.lossPopularity]);
    download(`竞店流失_${safeDate()}_商品.csv`, resultCsv(["日期", "店铺排名", "流向店铺", "商品排名", "商品名称", "流失指数", "流失人气"], rows));
  }

  function exportCombined() {
    const state = requireData();
    const grouped = new Map();
    for (const product of core.sortProducts(state.products)) {
      const key = `${product.date}|${product.storeRank ?? ""}|${product.storeName}`;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(product);
    }
    const rows = [];
    for (const store of core.sortStores(state.stores)) {
      const key = `${store.date}|${store.rank ?? ""}|${store.storeName}`;
      const products = grouped.get(key) ?? [];
      if (!products.length) rows.push([store.date, store.rank, store.storeName, store.lossIndex, store.lossPopularity, "", "", "", ""]);
      for (const product of products) {
        rows.push([store.date, store.rank, store.storeName, store.lossIndex, store.lossPopularity, product.rank, product.productName, product.lossIndex, product.lossPopularity]);
      }
    }
    download(`竞店流失_${safeDate()}_合并明细.csv`, resultCsv(["日期", "店铺排名", "店铺名称", "店铺流失指数", "店铺流失人气", "商品排名", "商品名称", "商品流失指数", "商品流失人气"], rows));
  }

  function exportLayout() {
    const state = requireData();
    const grouped = new Map();
    for (const product of core.sortProducts(state.products)) {
      const key = `${product.date}|${product.storeRank ?? ""}|${product.storeName}`;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(product);
    }
    const rows = [];
    let currentDate = null;
    for (const store of core.sortStores(state.stores)) {
      if (store.date !== currentDate) {
        if (rows.length) rows.push([]);
        currentDate = store.date;
        rows.push(["日期", currentDate]);
      }
      rows.push([store.rank, store.storeName, "", store.lossIndex, store.lossPopularity, core.TOP_LABEL]);
      rows.push(["排名", "商品名称", "流失指数", "流失人气"]);
      const key = `${store.date}|${store.rank ?? ""}|${store.storeName}`;
      for (const product of grouped.get(key) ?? []) {
        rows.push([product.rank, product.productName, product.lossIndex, product.lossPopularity]);
      }
      rows.push([]);
    }
    rows.unshift(["采集完整性", currentState?.status === "completed" ? "完整" : "部分结果"]);
    download(`竞店流失_${safeDate()}_粘贴版.tsv`, core.toTsv(rows), "text/tab-separated-values;charset=utf-8");
  }

  elements.start.addEventListener("click", start);
  document.getElementById("previous-button").addEventListener("click", async (event) => {
    viewingPrevious = !viewingPrevious;
    event.target.textContent = viewingPrevious ? "返回当前任务" : "查看 / 导出上一轮结果";
    await refresh();
  });
  elements.stop.addEventListener("click", stop);
  elements.end.addEventListener("click", end);
  document.getElementById("export-stores").addEventListener("click", () => { try { exportStores(); } catch (e) { alert(e.message); } });
  document.getElementById("export-products").addEventListener("click", () => { try { exportProducts(); } catch (e) { alert(e.message); } });
  document.getElementById("export-combined").addEventListener("click", () => { try { exportCombined(); } catch (e) { alert(e.message); } });
  document.getElementById("export-layout").addEventListener("click", () => { try { exportLayout(); } catch (e) { alert(e.message); } });

  if (extensionApiAvailable) {
    refresh();
    setInterval(refresh, 1200);
  } else {
    elements.page.textContent = "本地界面预览";
    elements.log.textContent = "安装为 Chrome 扩展后即可连接生意参谋页面。";
    elements.start.disabled = true;
    elements.stop.disabled = true;
    elements.end.disabled = true;
  }
})();
