(function (root) {
  "use strict";
  const missingReceiver = error => /Could not establish connection|Receiving end does not exist/i.test(String(error?.message || error));

  async function send(chromeApi, tabId, message) {
    try {
      return await chromeApi.tabs.sendMessage(tabId, message);
    } catch (error) {
      if (!missingReceiver(error)) throw error;
      try {
        await chromeApi.scripting.executeScript({ target: { tabId }, files: ["competitor-core.js"] });
        await chromeApi.scripting.executeScript({ target: { tabId }, files: ["collector-pacing.js"] });
        await chromeApi.scripting.executeScript({ target: { tabId }, files: ["collector-task-state.js"] });
        await chromeApi.scripting.executeScript({ target: { tabId }, files: ["competitor-content.js"] });
      } catch (injectError) {
        throw new Error(`页面采集脚本未能加载：${injectError.message || injectError}。请确认当前标签是生意参谋竞品流失页。`);
      }
      return chromeApi.tabs.sendMessage(tabId, message);
    }
  }

  root.CompetitorBridge = { send, missingReceiver };
  if (typeof module !== "undefined" && module.exports) module.exports = root.CompetitorBridge;
})(typeof window !== "undefined" ? window : globalThis);
