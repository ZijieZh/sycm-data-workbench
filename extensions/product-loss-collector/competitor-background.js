importScripts("competitor-core.js");
const cache = new Map();
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.type !== "RESOLVE_COMPETITOR_ID") return;
  const url = message.url;
  try {
    const parsed = new URL(url);
    if (sender.url?.startsWith("https://sycm.taobao.com/") && parsed.hostname === "sycm.taobao.com" && /^\/mc\/common\/(tm|tb)_item_redirect\.htm$/.test(parsed.pathname) && parsed.searchParams.get("mi_id")) {
      if (!cache.has(url)) cache.set(url, (async () => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 12000);
        try {
          const response = await fetch(url, { credentials: "include", redirect: "follow", signal: controller.signal });
          const id = CompetitorCore.productIdFromUrl(response.url);
          response.body?.cancel().catch(() => {});
          return id;
        } catch { return ""; }
        finally { clearTimeout(timeout); }
      })());
      cache.get(url).then(id => { if (!id) cache.delete(url); respond({ ok: Boolean(id), id }); });
      return true;
    }
  } catch {}
  respond({ ok: false, id: "" });
});
