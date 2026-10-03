(function () {
  "use strict";
  if (window.__sycmCompetitorLossV028Loaded) return;
  window.__sycmCompetitorLossV028Loaded = true;
  const core = window.CompetitorCore, taskState = window.CompetitorTaskState;
  const competitorIdCache = new Map();
  const KEY = "sycmCompetitorLossStateV2", CONTROL_KEY = "sycmCompetitorLossControlV1";
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const page = () => location.pathname === "/mc/free/ci_item" && new URL(location.href).searchParams.get("activeKey") === "itemLoss";
  const removeLegacyOverlay = () => document.getElementById("sycm-competitor-loss-overlay")?.remove();
  removeLegacyOverlay();
  setTimeout(removeLegacyOverlay, 1000);
  const get = async () => (await chrome.storage.local.get(KEY))[KEY];
  const getControl = async () => (await chrome.storage.local.get(CONTROL_KEY))[CONTROL_KEY];
  function checkChallenge() {
    const text = document.body?.innerText || "";
    if (core.isRiskText(text)) {
      const error = new Error("页面出现安全限制或验证提示，已停止并保留进度；请先按平台要求人工处理，插件不会自动刷新或继续。");
      error.name = "RiskControlError";
      throw error;
    }
  }
  async function pace(s, kind = "action") {
    const milliseconds = window.CompetitorPacing.draw(s.paceProfile, kind);
    for (let elapsed = 0; elapsed < milliseconds;) {
      const current = await get();
      if (current?.status !== "running") { const error = new Error("采集已结束"); error.name = "StopRequested"; throw error; }
      checkChallenge();
      const step = Math.min(500, milliseconds - elapsed);
      await sleep(step); elapsed += step;
    }
    checkChallenge();
  }
  async function save(s) {
    const control = await getControl(), current = await get();
    if (control?.discardedRunId === s.runId || control?.pausedRunId === s.runId || !taskState.isCurrentRun(current, s.runId)) return false;
    s.updatedAt = new Date().toISOString();
    await chrome.storage.local.set({ [KEY]: s });
    const latestControl = await getControl();
    if (latestControl?.discardedRunId === s.runId) {
      const latest = await get();
      if (latest?.runId === s.runId) await chrome.storage.local.set({ [KEY]: taskState.discard(latest) });
      render(await get());
      return false;
    }
    if (latestControl?.pausedRunId === s.runId) {
      const latest = await get();
      if (latest?.runId === s.runId && latest.status === "running") {
        const paused = taskState.pause(latest);
        log(paused, "任务已暂停，已保存结果保留");
        await chrome.storage.local.set({ [KEY]: paused });
        render(paused);
      }
      return false;
    }
    render(s);
    return true;
  }
  const log = (s, text) => { s.logs.push(`${new Date().toLocaleTimeString("zh-CN", { hour12: false })} ${text}`); s.logs = s.logs.slice(-100); };
  function render(s) {
    removeLegacyOverlay();
    const old = document.getElementById("sycm-competitor-loss-v2");
    if (!page() || !s || s.status !== "running") { old?.remove(); return; }
    let element = old;
    if (!element) {
      element = document.createElement("div"); element.id = "sycm-competitor-loss-v2";
      element.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483647;background:#193c3c;color:white;border-radius:9px;box-shadow:0 8px 24px #162c2844;padding:9px 12px;max-width:230px;font:12px Microsoft YaHei,sans-serif;pointer-events:none";
      document.documentElement.appendChild(element);
    }
    element.textContent = `竞品流失采集中 · ${s.currentDate || "准备中"} · ${s.done || 0}/${s.total || 0}`;
  }
  function dates(start, end) { const result = []; const d = new Date(`${start}T12:00:00`), last = new Date(`${end}T12:00:00`); while (d <= last) { result.push([d.getFullYear(), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0")].join("-")); d.setDate(d.getDate() + 1); } return result; }
  function desiredUrl(date) { const url = new URL(location.href); url.searchParams.set("dateRange", `${date}|${date}`); url.searchParams.set("dateType", "day"); return url.href; }
  function displayedDate(date) {
    const text = document.body?.innerText || "";
    const anchor = text.match(/统计时间\s*(\d{4}-\d{2}-\d{2})(?:\s*[~～至|]\s*(\d{4}-\d{2}-\d{2}))?/);
    if (!anchor) return false;
    return anchor[1] === date && (!anchor[2] || anchor[2] === date);
  }
  const hasView = () => Boolean(document.querySelector(".ci-item-loss-view-table") && document.querySelector(".tab-item"));
  async function ensureDate(date, s) {
    const params = new URL(location.href).searchParams;
    if (params.get("dateRange") !== `${date}|${date}` || params.get("dateType") !== "day") { await pace(s, "day"); location.assign(desiredUrl(date)); return false; }
    const reloadKey = `sycmCompetitorDateReload:${s.runId}:${date}`;
    for (let i = 0; i < 30; i++) {
      checkChallenge();
      if (displayedDate(date) && hasView()) { sessionStorage.removeItem(reloadKey); return true; }
      await sleep(500);
    }
    checkChallenge();
    if (core.shouldReloadDatePage({ displayed: displayedDate(date), hasView: hasView(), attempted: sessionStorage.getItem(reloadKey) === "1" })) {
      sessionStorage.setItem(reloadKey, "1");
      log(s, `${date} 页面未完整呈现，尝试刷新当前网址一次`);
      await save(s);
      location.reload();
      return false;
    }
    throw Error(`日期 ${date} 页面刷新后仍未完整呈现；已暂停在当前进度，请检查页面后使用“继续任务”`);
  }
  function outerRows() { return [...document.querySelectorAll("tr[data-row-key^='item_']")].filter(r => !r.closest(".ant-table-expanded-row") && !r.classList.contains("ant-table-expanded-row")); }
  function mainPaginationArea() { return document.querySelector(".ci-item-loss-view-table > .oui-card-content > .contentContainer > .alife-dt-card-common-table-pagination-container"); }
  function outerPagination() { return mainPaginationArea()?.querySelector(".ant-pagination") || [...document.querySelectorAll(".ant-pagination")].find(p => !p.closest(".ant-table-expanded-row")); }
  async function ensurePageSize100(s) {
    const area = mainPaginationArea(), selector = area?.querySelector(".oui-page-size-select .ant-select-selection");
    if (!selector) return false;
    const selected = () => core.clean(mainPaginationArea()?.querySelector(".oui-page-size-select .ant-select-selection-selected-value")?.textContent);
    if (selected() === "100") return true;
    await pace(s); selector.click();
    let option;
    for (let i = 0; i < 20; i++) {
      option = [...document.querySelectorAll(".ant-select-dropdown:not(.ant-select-dropdown-hidden) [role='option']")]
        .find(el => core.clean(el.textContent) === "100" && el.getClientRects().length);
      if (option) break;
      await sleep(200);
    }
    if (!option) { if (selector.getAttribute("aria-expanded") === "true") selector.click(); return false; }
    await pace(s); option.click();
    for (let i = 0; i < 40; i++) { if (selected() === "100" && outerRows().length) { await sleep(700); return true; } await sleep(250); }
    return false;
  }
  function pageNumber(p) { return Number(p?.querySelector(".ant-pagination-item-active")?.getAttribute("title") || 1); }
  async function clickNumber(p, n, s) { const li = [...p.querySelectorAll("li")].find(x => x.getAttribute("title") === String(n)) || (n === pageNumber(p) + 1 ? p.querySelector(".ant-pagination-next:not(.ant-pagination-disabled)") : null); if (!li) return false; const before = outerRows()[0]?.dataset.rowKey; await pace(s); li.click(); for (let i = 0; i < 60; i++) { checkChallenge(); if (pageNumber(outerPagination()) === n && outerRows().length && outerRows()[0]?.dataset.rowKey !== before) return true; await sleep(200); } throw Object.assign(Error(`商品列表未切换到第 ${n} 页`), { name: "PageIntegrityError" }); }
  async function waitRows() { for (let i = 0; i < 40; i++) { checkChallenge(); const rows = outerRows(); if (rows.length) return rows; await sleep(250); } throw Error("商品列表未加载或无数据"); }
  async function selectTab(kind, s) {
    const name = kind === "browse" ? "浏览流失竞品推荐" : "搜索流失竞品推荐";
    const tab = [...document.querySelectorAll(".tab-item")].find(el => core.clean(el.textContent) === name);
    if (!tab) throw Error(`未找到「${name}」页签`);
    if (!tab.classList.contains("active")) { await pace(s); tab.click(); for (let i = 0; i < 30; i++) { if (tab.classList.contains("active")) break; await sleep(200); } await sleep(600); }
    if (!tab.classList.contains("active")) throw Error(`切换「${name}」失败`);
    if (!await ensurePageSize100(s)) throw Object.assign(Error("未能确认每页显示100条，请检查页面后继续当前日期"), { name: "PageIntegrityError" });
    const p = outerPagination(); if (p && pageNumber(p) !== 1) await clickNumber(p, 1, s);
  }
  async function findItem(item, s) {
    const p = outerPagination(); if (p && pageNumber(p) !== 1) await clickNumber(p, 1, s);
    for (let index = 1; index <= 100; index++) {
      const rows = await waitRows();
      const matches = rows.map(row => ({ row, found: core.matchRow(row, item) })).filter(({ found }) => item.id ? found.idMatch && (!item.name || found.nameMatch) : found.nameMatch);
      if (matches.length > 1) throw Error(`商品精确匹配不唯一：${item.id || item.name}`);
      if (matches.length) return matches[0].row;
      const pager = outerPagination(); if (!pager || pager.querySelector(".ant-pagination-next.ant-pagination-disabled")) break;
      if (!await clickNumber(pager, index + 1, s)) break;
    }
    throw Error(`未找到精确匹配的商品：${item.id || item.name}`);
  }
  function detailRow(row, headers, item, kind, date, rank) {
    const values = core.detailValues(headers, core.detailCells(row), kind);
    const missing = core.missingDetailFields(values);
    const competitorUrl = core.competitorRedirect(row);
    return { date, sourceId: item.id || "", sourceName: item.name || "", sourcePage: kind === "browse" ? "浏览流失竞品推荐" : "搜索流失竞品推荐", status: missing.length ? "字段缺失" : "成功", rank, ...values, competitorId: "", competitorUrl, note: missing.length ? `${missing.join("、")}在页面上仍为空（已等待加载），请复核` : "" };
  }
  async function resolveCompetitorId(row, s) {
    if (!row.competitorUrl) { row.note = [row.note, "竞品商品链接缺失，无法解析商品ID"].filter(Boolean).join("；"); return; }
    const directId = core.productIdFromUrl(row.competitorUrl);
    if (directId) { row.competitorId = directId; return; }
    if (!competitorIdCache.has(row.competitorUrl)) {
      await pace(s);
      const result = await chrome.runtime.sendMessage({ type: "RESOLVE_COMPETITOR_ID", url: row.competitorUrl }).catch(() => null);
      if (result?.id) competitorIdCache.set(row.competitorUrl, result.id);
    }
    row.competitorId = competitorIdCache.get(row.competitorUrl) || "";
    if (!row.competitorId) row.note = [row.note, "竞品商品ID未能从商品链接解析"].filter(Boolean).join("；");
  }
  const nestedRows = expanded => [...expanded.querySelectorAll("tbody tr[data-row-key]")].filter(row => row.querySelectorAll("td").length >= 5);
  async function waitNestedRows(expanded, kind) {
    let partialRows = [];
    let emptyChecks = 0;
    for (let i = 0; i < 120; i++) {
      checkChallenge();
      const rows = nestedRows(expanded);
      const headers = [...expanded.querySelectorAll("thead th")].map(cell => core.clean(cell.innerText));
      const emptyText = [...expanded.querySelectorAll(".oui-dt-message-content, .ant-table-placeholder")].filter(el => el.getClientRects().length).map(el => core.clean(el.textContent));
      const confirmedEmpty = !rows.length && headers.includes("商品名称") && headers.includes("所属店铺") && emptyText.some(text => /^(数据为空|暂无数据)$/.test(text)) && !expanded.querySelector(".ant-spin-spinning");
      emptyChecks = confirmedEmpty ? emptyChecks + 1 : 0;
      if (emptyChecks >= 5) return [];
      if (rows.length && headers.includes("商品名称") && headers.includes("所属店铺")) {
        partialRows = rows;
        if (rows.every(row => !core.missingDetailFields(core.detailValues(headers, core.detailCells(row), kind)).length)) return rows;
      }
      await sleep(250);
    }
    if (partialRows.length) return partialRows;
    throw Error("商品已展开，但竞品明细在30秒内未加载，请补采当前商品");
  }
  async function collect(item, kind, date, s, currentRow) {
    if (!currentRow) await selectTab(kind, s);
    const row = currentRow || await findItem(item, s);
    item = { ...item, name: item.name || core.rowName(row) };
    const toggle = row.querySelector("td.ant-table-row-expand-icon-cell span");
    if (!toggle) throw Error("匹配商品无展开按钮");
    const key = row.dataset.rowKey;
    if (!row.classList.contains("ant-table-row-expanded")) { await pace(s); toggle.click(); }
    let expanded;
    for (let i = 0; i < 30; i++) { expanded = [...document.querySelectorAll("tr.ant-table-expanded-row")].find(el => el.dataset.rowKey === `${key}-extra-row`); if (expanded) break; await sleep(200); }
    if (!expanded) throw Error("商品展开后明细未出现");
    const output = [];
    for (let index = 1; index <= 100; index++) {
      const rows = await waitNestedRows(expanded, kind);
      if (!rows.length) {
        if (output.length) throw Error("竞品明细翻页后显示空数据，请复核分页结果");
        return [{ date, sourceId: item.id || "", sourceName: item.name || "", sourcePage: kind === "browse" ? "浏览流失竞品推荐" : "搜索流失竞品推荐", status: "无数据", rank: "", competitorId: "", competitorName: "", shopName: "", note: "页面明确显示数据为空（已确认无加载动画且持续显示），该商品当天无竞品推荐明细" }];
      }
      const headers = [...expanded.querySelectorAll("thead th")].map(cell => core.clean(cell.innerText));
      const expected = kind === "browse" ? ["流失指数", "流失人气"] : ["搜索竞争指数", "搜索人数", "搜索收藏指数", "搜索加购指数", "搜索交易指数"];
      if (!["商品名称", "所属店铺", ...expected].every(name => headers.includes(name))) throw Error(`竞品明细表头不完整：${headers.join(" / ")}`);
      for (const nested of rows) {
        const detail = detailRow(nested, headers, item, kind, date, output.length + 1);
        await resolveCompetitorId(detail, s);
        output.push(detail);
      }
      const pager = expanded.querySelector(".ant-pagination");
      if (!pager || pager.querySelector(".ant-pagination-next.ant-pagination-disabled")) break;
      const next = [...pager.querySelectorAll("li")].find(el => el.getAttribute("title") === String(index + 1));
      if (!next) throw Error(`竞品明细第 ${index + 1} 页不可点击`);
      const first = core.clean(rows[0]?.innerText);
      await pace(s); next.click();
      for (let i = 0; i < 30; i++) { if (pageNumber(pager) === index + 1 && core.clean(nestedRows(expanded)[0]?.innerText) !== first) break; await sleep(200); }
      if (pageNumber(pager) !== index + 1 || core.clean(nestedRows(expanded)[0]?.innerText) === first) throw Error(`竞品明细未切换到第 ${index + 1} 页`);
    }
    if (!output.length) throw Error("展开成功但没有竞品明细");
    return output;
  }
  async function collectAll(kind, date, s) {
    await selectTab(kind, s);
    const output = [];
    for (let pageIndex = 1; pageIndex <= 100; pageIndex++) {
      const rows = await waitRows();
      for (const row of rows) {
        const item = { id: core.rowIds(row).find(id => /^\d+$/.test(id)) || "", name: core.rowName(row) || "" };
        try { output.push(...await collect(item, kind, date, s, row)); }
        catch (error) {
          if (error.name === "RiskControlError" || error.name === "StopRequested") throw error;
          s.failures.push({ date, sourceId: item.id, sourceName: item.name, sourcePage: kind === "browse" ? "浏览流失竞品推荐" : "搜索流失竞品推荐", status: "缺失/失败", rank: "", competitorName: "", shopName: "", lossIndex: "", lossPopularity: "", note: error.message || String(error) });
        }
      }
      const pager = outerPagination();
      if (!pager || pager.querySelector(".ant-pagination-next.ant-pagination-disabled")) break;
      if (pageIndex === 100 || !await clickNumber(pager, pageIndex + 1, s)) throw Object.assign(Error(`商品列表仍有下一页，第${pageIndex + 1}页未完成，请继续当前日期`), { name: "PageIntegrityError" });
    }
    if (!output.length && !s.failures.some(f => f.date === date && f.sourcePage === (kind === "browse" ? "浏览流失竞品推荐" : "搜索流失竞品推荐"))) throw Error("全店商品列表为空或未产生竞品明细");
    return output;
  }
  async function run() {
    if (!page() || window.__sycmCompetitorRunActive) return;
    window.__sycmCompetitorRunActive = true;
    let runId;
    try {
      let s = await get(); runId = s?.runId;
      if (!taskState.isCurrentRun(s, runId)) return;
      for (const row of s.rows || []) if (row.competitorUrl && row.competitorId) competitorIdCache.set(row.competitorUrl, row.competitorId);
      const list = dates(s.start, s.end), kinds = ["browse", "search"];
      while (s.cursor < s.total) {
        s = await get(); if (!taskState.isCurrentRun(s, runId)) return;
        const allMode = s.items.length === 1 && s.items[0]?.all;
        // 按推荐类型分组：先完成全部日期，再切换到另一页签，减少页面切换。
        const perKind = list.length * s.items.length;
        const kindIndex = Math.floor(s.cursor / perKind);
        const withinKind = s.cursor % perKind;
        const dateIndex = Math.floor(withinKind / s.items.length);
        const itemIndex = allMode ? 0 : withinKind % s.items.length;
        const kind = kinds[kindIndex], date = list[dateIndex], item = s.items[itemIndex];
        s.currentDate = date; s.currentItem = item.name || item.id; s.currentKind = kind === "browse" ? "浏览流失" : "搜索流失";
        if (!await save(s)) return;
        if (!await ensureDate(date, s)) return;
        try { const rows = item.all ? await collectAll(kind, date, s) : await collect(item, kind, date, s); s.rows.push(...rows); const missing = rows.filter(row => row.status !== "成功").length; log(s, `${date} · ${s.currentItem} · ${s.currentKind}：${rows.length} 条${missing ? `，其中 ${missing} 条字段缺失` : ""}`); }
        catch (error) {
          if (["RiskControlError", "StopRequested", "PageIntegrityError"].includes(error.name)) throw error;
          const note = error.message || String(error);
          s.failures.push({ date, sourceId: item.id || "", sourceName: item.name || "", sourcePage: s.currentKind, status: "缺失/失败", rank: "", competitorName: "", shopName: "", lossIndex: "", lossPopularity: "", note });
          log(s, `${date} · ${s.currentItem} · ${s.currentKind}：${note}`);
        }
        const fresh = await get();
        if (!taskState.isCurrentRun(fresh, runId)) return;
        s.cursor++; s.done = s.cursor; if (!await save(s)) return;
      }
      s.status = "completed"; s.currentItem = ""; s.currentKind = ""; log(s, "全部日期已处理完成"); await save(s);
    } catch (error) {
      const s = await get(); if (taskState.isCurrentRun(s, runId)) { s.status = error.name === "RiskControlError" ? "blocked" : "error"; s.error = error.message || String(error); log(s, s.error); s.updatedAt = new Date().toISOString(); await chrome.storage.local.set({ [KEY]: s }); render(s); }
    } finally {
      window.__sycmCompetitorRunActive = false;
      const pending = await get();
      if (taskState.isCurrentRun(pending, pending?.runId) && pending.runId !== runId) setTimeout(run, 0);
    }
  }
  chrome.runtime.onMessage.addListener((message, _, respond) => {
    if (message.type === "PING") { respond({ ok: page() }); return; }
    if (message.type === "START_COMPETITOR") {
      if (!page()) { respond({ ok: false, message: "请打开竞品流失页面" }); return; }
      try { checkChallenge(); } catch (error) { respond({ ok: false, message: error.message }); return; }
      const job = message.job; if (!job?.items?.length || !job.start || !job.end) { respond({ ok: false, message: "日期无效" }); return; }
      (async () => {
        const previous = await get();
        if (previous?.status === "running") { respond({ ok: false, message: "已有任务运行，请先结束任务" }); return; }
        const total = dates(job.start, job.end).length * job.items.length * 2;
        const runId = crypto.randomUUID();
        const s = taskState.start(job, runId, total);
        await chrome.storage.local.set({ [KEY]: s }); render(s); run(); respond({ ok: true });
      })().catch(error => respond({ ok: false, message: error.message || String(error) }));
      return true;
    }
    if (message.type === "RESUME_COMPETITOR") {
      (async () => {
        if (!page()) { respond({ ok: false, message: "请打开竞品流失页面" }); return; }
        checkChallenge();
        const previous = await get();
        if (!taskState.canResume(previous)) { respond({ ok: false, message: "没有可继续的未完成任务" }); return; }
        const s = taskState.resume(previous, crypto.randomUUID());
        log(s, `从第 ${s.cursor + 1}/${s.total} 项继续任务，保留已有 ${s.rows.length} 条明细`);
        await chrome.storage.local.set({ [KEY]: s });
        render(s);
        respond({ ok: true, cursor: s.cursor, total: s.total });
        if (hasView()) setTimeout(run, 0);
        else setTimeout(() => { try { checkChallenge(); location.reload(); } catch (error) { get().then(latest => { if (taskState.isCurrentRun(latest, s.runId)) { latest.status = "blocked"; latest.error = error.message; chrome.storage.local.set({ [KEY]: latest }).then(() => render(latest)); } }); } }, 150);
      })().catch(error => respond({ ok: false, message: error.message || String(error) }));
      return true;
    }
    if (message.type === "PAUSE_COMPETITOR") {
      (async () => {
        const current = await get();
        if (current?.status !== "running") { respond({ ok: false, message: "当前没有运行中的任务" }); return; }
        await chrome.storage.local.set({ [CONTROL_KEY]: { ...(await getControl() || {}), pausedRunId: current.runId, updatedAt: new Date().toISOString() } });
        const latest = await get();
        if (latest?.runId !== current.runId) { respond({ ok: false, message: "任务已变化，请重新查看状态" }); return; }
        if (latest.status === "running") {
          const paused = taskState.pause(latest);
          log(paused, "用户暂停任务，已保存结果保留");
          await chrome.storage.local.set({ [KEY]: paused });
          render(paused);
        }
        respond({ ok: true });
      })().catch(error => respond({ ok: false, message: error.message || String(error) }));
      return true;
    }
    if (message.type === "END_COMPETITOR_TASK") {
      (async () => {
        const current = await get();
        if (current && current.status !== "discarded") {
          await chrome.storage.local.set({ [CONTROL_KEY]: { discardedRunId: current.runId || "", updatedAt: new Date().toISOString() } });
          await chrome.storage.local.set({ [KEY]: taskState.discard(current) });
          render(await get());
        }
        for (let i = 0; i < 60 && window.__sycmCompetitorRunActive; i++) await sleep(250);
        respond({ ok: true });
      })().catch(error => respond({ ok: false, message: error.message || String(error) }));
      return true;
    }
    if (message.type === "STOP_COMPETITOR") { get().then(s => { if (s?.status === "running") { s.status = "ended"; log(s, "用户结束采集"); save(s); } }); respond({ ok: true }); return; }
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[KEY]) render(changes[KEY].newValue);
  });
  setTimeout(async () => {
    const s = await get(); render(s);
    if (s?.status === "running" && !s.runId) {
      s.status = "error"; s.error = "插件已更新，请结束旧任务后重新开始";
      await chrome.storage.local.set({ [KEY]: s }); render(s);
      return;
    }
    if (taskState.isCurrentRun(s, s?.runId) && page()) run();
  }, 700);
})();
