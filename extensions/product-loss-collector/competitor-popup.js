(function () {
  "use strict";
  const KEY = "sycmCompetitorLossStateV2", CONTROL_KEY = "sycmCompetitorLossControlV1";
  const $ = id => document.getElementById(id);
  let tabId, restored = false, ending = false, starting = false, pausing = false;
  const day = value => new Date(`${value}T12:00:00`);
  const format = date => [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-");
  async function getTab() { const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); tabId = tab?.id; return tab; }
  async function send(message) { await getTab(); return window.CompetitorBridge.send(chrome, tabId, message); }
  function parseItems(text) {
    const items = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean).filter(line => !/^(商品ID|原商品ID|item.?id)(\t|,)/i.test(line)).map(line => {
      const parts = line.split(/\t|,/).map(value => value.trim()).filter(Boolean);
      if (parts.length > 1 && /^\d+$/.test(parts[0])) return { id: parts[0], name: parts.slice(1).join(",") };
      return /^\d+$/.test(line) ? { id: line } : { name: line };
    });
    return [...new Map(items.map(item => [item.id ? `id:${item.id}` : `name:${item.name}`, item])).values()];
  }
  function updateInput() { const n = parseItems($("items").value).length; $("item-count").textContent = n ? `${n} 个商品` : "全店商品"; }
  function daysBetween(start, end) { return Math.round((day(end) - day(start)) / 86400000) + 1; }
  function validate() {
    const start = $("start-date").value, end = $("end-date").value;
    if (!start || !end) throw Error("请选择开始和结束日期");
    const days = daysBetween(start, end);
    if (days < 1) throw Error("结束日期不能早于开始日期");
    const items = parseItems($("items").value);
    // 商品为空时表示全店商品，交给页面端遍历当前推荐类型的全部分页。
    if (!items.length) items.push({ all: true, name: "全店商品" });
    return { start, end, days, items, paceProfile: $("pace").value };
  }
  function rangeSummary() { const start = $("start-date").value, end = $("end-date").value; const n = start && end ? daysBetween(start, end) : 0; $("range-summary").textContent = n > 0 ? `共 ${n} 天 · 含首尾日期，逐日切换页面采集` : "含首尾日期，逐日切换页面采集。"; }
  function showMessage(text) { $("status").textContent = text; $("current").textContent = text; }
  async function refresh() {
    const saved = (await chrome.storage.local.get(KEY))[KEY];
    if (saved && !restored) {
      $("start-date").value = saved.start || $("start-date").value;
      $("end-date").value = saved.end || $("end-date").value;
      $("items").value = (saved.items || []).map(item => item.id && item.name ? `${item.id}\t${item.name}` : item.id || item.name).join("\n");
      $("pace").value = saved.paceProfile || "conservative";
      rangeSummary(); updateInput(); restored = true;
    }
    try {
      const tab = await getTab();
      const onPage = tab?.url?.startsWith("https://sycm.taobao.com/mc/free/ci_item");
      $("connection-text").textContent = onPage ? "已定位到竞品流失页面" : "请先打开生意参谋的竞品流失页面";
      $("connection-dot").className = `dot ${onPage ? "good" : "bad"}`;
      $("start").disabled = !onPage || saved?.status === "running" || ending || starting;
      $("pause").disabled = saved?.status !== "running" || ending || starting || pausing;
      $("resume").disabled = !onPage || !window.CompetitorTaskState.canResume(saved) || ending || starting || pausing;
      $("resume").textContent = saved?.status === "running" ? "恢复卡住任务" : "继续任务";
    } catch { $("connection-text").textContent = "页面连接失败"; $("connection-dot").className = "dot bad"; $("resume").disabled = true; $("pause").disabled = saved?.status !== "running" || ending || pausing; }
    if (!saved || saved.status === "discarded") {
      $("status").textContent = "未开始";
      $("progress-text").textContent = "0 / 0 项";
      $("progress-bar").style.width = "0%";
      $("progress-bar").parentElement.setAttribute("aria-valuenow", "0");
      $("current").textContent = "选择日期后可开始；商品留空将采集全店商品。";
      $("stop").disabled = true;
      $("pause").disabled = true;
      $("resume").disabled = true;
      $("export").disabled = true;
      $("export-note").textContent = "包含日期、推荐类型、商品、竞品和采集状态。";
      $("log").replaceChildren();
      return;
    }
    const labels = { running: "采集中", paused: "已暂停 · 结果保留", completed: "采集完成", ended: "已结束 · 部分结果已保留", error: "采集出错 · 可继续", blocked: "平台安全限制 · 暂停" };
    $("status").textContent = labels[saved.status] || "未开始";
    const done = saved.done || 0, total = saved.total || 0;
    $("progress-text").textContent = `${done} / ${total} 项`;
    const percent = total ? Math.round(done / total * 100) : 0;
    $("progress-bar").style.width = `${percent}%`;
    $("progress-bar").parentElement.setAttribute("aria-valuenow", String(percent));
    $("current").textContent = saved.error || [saved.currentDate, saved.currentItem, saved.currentKind].filter(Boolean).join(" · ") || `${saved.rows?.length || 0} 条明细`;
    $("stop").disabled = ending;
    $("export").disabled = !(saved.rows?.length || saved.failures?.length);
    const incomplete = (saved.rows || []).filter(row => row.status === "字段缺失").length;
    $("export-note").textContent = `${saved.rows?.length || 0} 条竞品明细 · ${incomplete} 条字段缺失 · ${saved.failures?.length || 0} 项缺失/失败；导出保留全部状态。`;
    const logs = [...(saved.logs || [])].slice(-12).reverse();
    $("log").replaceChildren(...logs.map(line => { const li = document.createElement("li"); li.textContent = line; return li; }));
  }
  $("items").addEventListener("input", updateInput);
  for (const id of ["start-date", "end-date"]) $(id).addEventListener("change", rangeSummary);
  $("file").addEventListener("change", async event => { const file = event.target.files?.[0]; if (!file) return; $("items").value = await file.text(); updateInput(); });
  $("start").addEventListener("click", async () => {
    if (starting || ending) return;
    const saved = (await chrome.storage.local.get(KEY))[KEY];
    if (window.CompetitorTaskState.canResume(saved) && !confirm("当前有未完成任务。重新开始会覆盖暂存进度和明细；如需保留，请点“继续任务”或先导出 CSV。确定重新开始吗？")) return;
    starting = true; $("start").disabled = true;
    let errorText = "";
    try { const job = validate(); const result = await send({ type: "START_COMPETITOR", job }); if (!result?.ok) throw Error(result?.message || "启动失败"); }
    catch (error) { errorText = error.message || String(error); }
    finally { starting = false; await refresh(); if (errorText) showMessage(errorText); }
  });
  $("pause").addEventListener("click", async () => {
    if (starting || ending || pausing) return;
    pausing = true; $("pause").disabled = true;
    let errorText = "";
    try { const result = await send({ type: "PAUSE_COMPETITOR" }); if (!result?.ok) throw Error(result?.message || "暂停失败"); }
    catch (error) {
      try {
        const values = await chrome.storage.local.get([KEY, CONTROL_KEY]);
        const current = values[KEY];
        if (current?.status === "running") {
          await chrome.storage.local.set({ [CONTROL_KEY]: { ...(values[CONTROL_KEY] || {}), pausedRunId: current.runId, updatedAt: new Date().toISOString() } });
          await chrome.storage.local.set({ [KEY]: window.CompetitorTaskState.pause(current) });
        } else errorText = error.message || String(error);
      } catch (fallbackError) { errorText = fallbackError.message || String(fallbackError); }
    } finally { pausing = false; await refresh(); if (errorText) showMessage(errorText); }
  });
  $("resume").addEventListener("click", async () => {
    if (starting || ending) return;
    starting = true; $("resume").disabled = true;
    let errorText = "";
    try { const result = await send({ type: "RESUME_COMPETITOR" }); if (!result?.ok) throw Error(result?.message || "继续任务失败"); }
    catch (error) { errorText = error.message || String(error); }
    finally { starting = false; await refresh(); if (errorText) showMessage(errorText); }
  });
  $("stop").addEventListener("click", async () => {
    const saved = (await chrome.storage.local.get(KEY))[KEY];
    if (!saved || saved.status === "discarded" || ending) return;
    if (!confirm("结束任务会清空本次已采集结果和错误记录。需要保留的话，请先取消并导出 CSV。确定结束吗？")) return;
    ending = true; $("stop").disabled = true; $("start").disabled = true;
    try {
      const response = await send({ type: "END_COMPETITOR_TASK" });
      if (!response?.ok) throw Error(response?.message || "页面未响应结束任务指令");
    } catch {
      await chrome.storage.local.set({ [CONTROL_KEY]: { discardedRunId: saved.runId || "", updatedAt: new Date().toISOString() } });
      await chrome.storage.local.set({ [KEY]: window.CompetitorTaskState.discard(saved) });
    } finally { ending = false; await refresh(); }
  });
  $("export").addEventListener("click", async () => {
    const saved = (await chrome.storage.local.get(KEY))[KEY];
    if (!saved) return;
    const headers = ["日期", "原商品ID", "原商品名称", "推荐类型", "采集状态", "竞品排名", "竞品商品ID", "竞品商品名称", "所属店铺", "流失指数", "流失人气", "搜索竞争指数", "搜索人数", "搜索收藏指数", "搜索加购指数", "搜索交易指数", "说明"];
    const rows = [...(saved.rows || []), ...(saved.failures || [])].map(r => [r.date, r.sourceId, r.sourceName, r.sourcePage, r.status, r.rank, r.competitorId, r.competitorName, r.shopName, r.lossIndex, r.lossPopularity, r.searchCompetitionIndex, r.searchPeople, r.searchFavoriteIndex, r.searchCartIndex, r.searchTransactionIndex, r.note]);
    const csv = window.CompetitorCore.toCsv(headers, rows);
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = `竞品流失_分日合并明细_${saved.start}_${saved.end}.csv`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 60000);
  });
  const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
  $("start-date").value = $("end-date").value = format(yesterday); rangeSummary(); updateInput(); refresh(); setInterval(refresh, 1200);
})();
