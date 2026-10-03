(function (root) {
  "use strict";
  const profiles = Object.freeze({
    fast: Object.freeze({ action: [500, 1000], day: [8000, 12000] }),
    gentle: Object.freeze({ action: [2000, 4000], day: [8000, 12000] }),
    conservative: Object.freeze({ action: [4000, 8000], day: [12000, 20000] }),
    verySlow: Object.freeze({ action: [8000, 15000], day: [20000, 35000] })
  });
  function interval(profile, kind) { return (profiles[profile] || profiles.conservative)[kind === "day" ? "day" : "action"]; }
  function draw(profile, kind, random = Math.random) {
    const [minimum, maximum] = interval(profile, kind);
    return minimum + Math.floor(random() * (maximum - minimum + 1));
  }
  root.CompetitorPacing = { profiles, interval, draw };
  if (typeof module !== "undefined" && module.exports) module.exports = root.CompetitorPacing;
})(typeof window !== "undefined" ? window : globalThis);
