"use strict";

const KEY = "sycmLossCollectorStateV1";
let claims = Promise.resolve();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "CLAIM_JOB") {
    claims = claims.then(async () => {
      if (!Number.isInteger(sender.tab?.id)) return { ok: false, message: "无法识别任务标签页" };
      const previous = (await chrome.storage.local.get(KEY))[KEY];
      if (message.resume) {
        if (!["running", "paused", "error"].includes(previous?.status)) return { ok: false, message: "当前任务不可恢复" };
        if (previous.status === "running" && previous.job.ownerTabId !== sender.tab.id) {
          try {
            await chrome.tabs.get(previous.job.ownerTabId);
            return { ok: false, message: "任务所属标签页仍存在，请回到原标签页暂停或结束任务" };
          } catch { /* 原标签页已关闭，允许接管 */ }
        }
        previous.job.ownerTabId = sender.tab.id;
        previous.status = "running";
        await chrome.storage.local.set({ [KEY]: previous });
      } else {
        if (["running", "paused"].includes(previous?.status)) return { ok: false, message: "已有任务，请先继续或结束它" };
        // 保留最近一次结果，防止新任务意外覆盖。
        if (previous?.stores?.length) await chrome.storage.local.set({ sycmLossCollectorPreviousV1: previous });
        const next = message.state;
        next.job.ownerTabId = sender.tab.id;
        await chrome.storage.local.set({ [KEY]: next });
      }
      return { ok: true };
    }).catch((error) => ({ ok: false, message: `保存任务失败：${error.message}` }));
    claims.then(sendResponse);
    return true;
  }
  if (message?.type !== "GET_TAB_ID") return false;
  sendResponse({ ok: true, tabId: sender.tab?.id ?? null });
  return false;
});
