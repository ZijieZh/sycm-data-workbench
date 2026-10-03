(function initCollectorCore(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.SycmCollectorCore = api;
})(typeof window !== "undefined" ? window : null, function collectorCoreFactory() {
  "use strict";

  const TOP_LABEL = "TOP流失去向商品";
  const HEADER_WORDS = new Set(["排名", "店铺名称", "商品名称", "流失指数", "流失人气", "操作"]);

  function normalizeText(value) {
    return String(value ?? "")
      .replace(/\u00a0/g, " ")
      .replace(/[\t ]+/g, " ")
      .replace(/\r/g, "")
      .trim();
  }

  function productIdentityKey(date, storeName, productRank, productName) {
    const rank = Number(productRank);
    const normalizedRank = Number.isInteger(rank) && rank > 0 ? rank : "";
    return `${date}|${normalizeText(storeName)}|${normalizedRank}|${normalizeText(productName)}`;
  }

  function linesOf(value) {
    return String(value ?? "")
      .split(/[\n\t]+/)
      .map(normalizeText)
      .filter(Boolean);
  }

  function numericValue(value) {
    const text = normalizeText(value).replace(/,/g, "");
    if (!/^[+-]?\d+(?:\.\d+)?$/.test(text)) return null;
    const number = Number(text);
    return Number.isFinite(number) ? number : null;
  }

  function isNumericLine(value) {
    return numericValue(value) !== null;
  }

  function cleanLabels(lines) {
    return lines.filter((line) => line !== TOP_LABEL && !HEADER_WORDS.has(line));
  }

  function parseRank(lines, maxRank, excludedIndexes = new Set()) {
    for (let index = 0; index < lines.length; index += 1) {
      if (excludedIndexes.has(index)) continue;
      const value = numericValue(lines[index]);
      if (value !== null && Number.isInteger(value) && value >= 1 && value <= maxRank) {
        return { value, index };
      }
    }
    return { value: null, index: -1 };
  }

  function trailingMetrics(lines, rankIndex) {
    const found = [];
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      if (index === rankIndex) continue;
      const value = numericValue(lines[index]);
      if (value !== null) found.push({ value, index });
      if (found.length === 2) break;
    }
    if (found.length < 2) return null;
    return {
      popularity: found[0].value,
      popularityIndex: found[0].index,
      lossIndex: found[1].value,
      lossIndexIndex: found[1].index,
    };
  }

  function chooseName(lines, excludedIndexes, preferredPattern) {
    const candidates = lines.filter((line, index) => {
      if (excludedIndexes.has(index)) return false;
      if (HEADER_WORDS.has(line) || line === TOP_LABEL) return false;
      if (isNumericLine(line)) return false;
      return line.length >= 2;
    });
    const preferred = candidates.filter((line) => preferredPattern.test(line));
    const pool = preferred.length ? preferred : candidates;
    return pool.sort((a, b) => b.length - a.length)[0] ?? "";
  }

  function parseStoreText(text) {
    const lines = cleanLabels(linesOf(text));
    // 行尾最后两个数字固定是“流失指数、流失人气”。必须先排除它们
    // 再找排名，否则奖牌前三名缺少数字排名时，会把 313、134 等人气
    // 误认为排名，导致整家店解析失败。
    const metrics = trailingMetrics(lines, -1);
    if (!metrics) return null;
    const metricIndexes = new Set([metrics.lossIndexIndex, metrics.popularityIndex]);
    const rank = parseRank(lines, 500, metricIndexes);
    const excluded = new Set([rank.index, ...metricIndexes]);
    const name = chooseName(lines, excluded, /(店|旗舰|专卖|专营|商行|母婴)/i);
    if (!name) return null;
    return {
      rank: rank.value,
      storeName: name,
      lossIndex: metrics.lossIndex,
      lossPopularity: metrics.popularity,
    };
  }

  function parseProductText(text) {
    const lines = cleanLabels(linesOf(text));
    const metrics = trailingMetrics(lines, -1);
    if (!metrics) return null;
    const metricIndexes = new Set([metrics.lossIndexIndex, metrics.popularityIndex]);
    const rank = parseRank(lines, 10, metricIndexes);
    const excluded = new Set([rank.index, ...metricIndexes]);
    const name = chooseName(lines, excluded, /[\u4e00-\u9fa5A-Za-z]/);
    if (!name || name.length < 4) return null;
    return {
      rank: rank.value,
      productName: name,
      lossIndex: metrics.lossIndex,
      lossPopularity: metrics.popularity,
    };
  }

  function parseDate(text, url) {
    const urlText = String(url ?? "");
    const rangeMatch = urlText.match(/(?:dateRange|date)=([0-9]{4}-[0-9]{2}-[0-9]{2})/i);
    if (rangeMatch) return rangeMatch[1];
    const pageMatch = String(text ?? "").match(/(?:统计时间\s*)?([0-9]{4}-[0-9]{2}-[0-9]{2})/);
    return pageMatch ? pageMatch[1] : "";
  }

  function parseDisplayedDate(text) {
    const match = String(text ?? "").match(/统计时间\s*([0-9]{4}-[0-9]{2}-[0-9]{2})/);
    return match ? match[1] : "";
  }

  function csvEscape(value) {
    const original = String(value ?? "");
    // 防止店铺名或商品名被 Excel 当作公式执行。
    const text = typeof value === "string" && /^[=+\-@]/.test(original) ? `'${original}` : original;
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  function toCsv(headers, rows) {
    return "\ufeff" + [headers, ...rows]
      .map((row) => row.map(csvEscape).join(","))
      .join("\r\n");
  }

  function toTsv(rows) {
    return "\ufeff" + rows
      .map((row) => row.map((value) => {
        const original = String(value ?? "").replace(/[\t\r\n]+/g, " ");
        return typeof value === "string" && /^[=+\-@]/.test(original) ? `'${original}` : original;
      }).join("\t"))
      .join("\r\n");
  }

  function fillSequentialRanks(rows, maximum = 10) {
    const result = rows.map((row) => ({ ...row }));
    const used = new Set();
    for (const row of result) {
      const rank = Number(row.rank);
      if (Number.isInteger(rank) && rank >= 1 && rank <= maximum && !used.has(rank)) used.add(rank);
      else row.rank = null;
    }
    let nextRank = 1;
    for (const row of result) {
      if (row.rank !== null) continue;
      while (used.has(nextRank) && nextRank <= maximum) nextRank += 1;
      if (nextRank <= maximum) {
        row.rank = nextRank;
        used.add(nextRank);
      }
    }
    return result.sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999));
  }

  function rankNumber(value) {
    const number = Number(value);
    return Number.isInteger(number) && number > 0 ? number : Number.MAX_SAFE_INTEGER;
  }

  function sortStores(rows) {
    return [...rows].sort((a, b) =>
      String(a.date ?? "").localeCompare(String(b.date ?? ""))
      || rankNumber(a.rank) - rankNumber(b.rank)
      || String(a.storeName ?? "").localeCompare(String(b.storeName ?? ""), "zh-CN")
    );
  }

  function sortProducts(rows) {
    return [...rows].sort((a, b) =>
      String(a.date ?? "").localeCompare(String(b.date ?? ""))
      || rankNumber(a.storeRank) - rankNumber(b.storeRank)
      || rankNumber(a.rank) - rankNumber(b.rank)
      || String(a.productName ?? "").localeCompare(String(b.productName ?? ""), "zh-CN")
    );
  }

  function rankCompleteness(rows) {
    const ranks = rows.map((row) => Number(row.rank)).filter((rank) => Number.isInteger(rank) && rank > 0);
    if (!ranks.length) return { complete: false, maximum: 0, missing: [], duplicates: [] };
    const counts = new Map();
    for (const rank of ranks) counts.set(rank, (counts.get(rank) ?? 0) + 1);
    const maximum = Math.max(...ranks);
    const missing = [];
    for (let rank = 1; rank <= maximum; rank += 1) if (!counts.has(rank)) missing.push(rank);
    const duplicates = [...counts.entries()].filter(([, count]) => count > 1).map(([rank]) => rank);
    return { complete: missing.length === 0 && duplicates.length === 0 && ranks.length === rows.length, maximum, missing, duplicates };
  }

  return {
    TOP_LABEL,
    normalizeText,
    productIdentityKey,
    linesOf,
    numericValue,
    parseStoreText,
    parseProductText,
    parseDate,
    parseDisplayedDate,
    toCsv,
    toTsv,
    fillSequentialRanks,
    sortStores,
    sortProducts,
    rankCompleteness,
  };
});
