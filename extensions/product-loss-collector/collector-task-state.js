(function (root) {
  "use strict";
  function discard(previous) {
    return {
      status: "discarded", runId: previous?.runId || "",
      start: previous?.start || "", end: previous?.end || "",
      items: previous?.items || [], paceProfile: previous?.paceProfile || "conservative",
      total: 0, cursor: 0, done: 0, rows: [], failures: [], logs: [],
      currentDate: "", currentItem: "", currentKind: "", error: "",
      updatedAt: new Date().toISOString()
    };
  }
  function start(job, runId, total) {
    return {
      status: "running", runId, start: job.start, end: job.end,
      items: job.items, paceProfile: job.paceProfile || "conservative",
      total, cursor: 0, done: 0, rows: [], failures: [], logs: [], error: ""
    };
  }
  function isCurrentRun(state, runId) { return Boolean(runId && state?.status === "running" && state.runId === runId); }
  function pause(previous) {
    if (previous?.status !== "running") throw Error("当前任务不在采集中");
    return { ...previous, status: "paused", error: "", updatedAt: new Date().toISOString() };
  }
  function canResume(state, now = Date.now()) {
    const staleRunning = state?.status === "running" && Number.isFinite(Date.parse(state.updatedAt)) && now - Date.parse(state.updatedAt) > 180000;
    return Boolean(state?.runId && (["paused", "error", "ended", "blocked"].includes(state.status) || staleRunning) && Number.isInteger(state.cursor) && state.cursor >= 0 && state.cursor < state.total && state.items?.length);
  }
  function resume(previous, runId) {
    if (!canResume(previous)) throw Error("当前任务不能继续");
    return { ...previous, status: "running", runId, done: previous.cursor, error: "", updatedAt: new Date().toISOString() };
  }
  root.CompetitorTaskState = { discard, start, pause, isCurrentRun, canResume, resume };
  if (typeof module !== "undefined" && module.exports) module.exports = root.CompetitorTaskState;
})(typeof window !== "undefined" ? window : globalThis);
