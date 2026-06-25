const express = require("express");
const Job = require("../models/job");

const router = express.Router();
const QUERY_TIMEOUT_MS = 8000;

router.get("/", async (_req, res, next) => {
  try {
    const [total, completed, failed, cancelled, running, waiting, finishedJobs] = await Promise.all([
      Job.countDocuments().maxTimeMS(QUERY_TIMEOUT_MS),
      Job.countDocuments({ $or: [{ status: "completed" }, { phase: "COMPLETED" }] }).maxTimeMS(QUERY_TIMEOUT_MS),
      Job.countDocuments({ status: "failed", phase: { $ne: "CANCELLED" } }).maxTimeMS(QUERY_TIMEOUT_MS),
      Job.countDocuments({ $or: [{ status: "cancelled" }, { phase: "CANCELLED" }] }).maxTimeMS(QUERY_TIMEOUT_MS),
      Job.countDocuments({ status: "running" }).maxTimeMS(QUERY_TIMEOUT_MS),
      Job.countDocuments({ status: "waiting_for_operator" }).maxTimeMS(QUERY_TIMEOUT_MS),
      Job.find({ completedAt: { $exists: true } })
        .select("startedAt completedAt")
        .maxTimeMS(QUERY_TIMEOUT_MS)
        .lean(),
    ]);
    const durations = finishedJobs
      .map((job) => new Date(job.completedAt).getTime() - new Date(job.startedAt).getTime())
      .filter((duration) => Number.isFinite(duration) && duration >= 0)
      .sort((a, b) => a - b);

    res.json({
      total,
      completed,
      failed,
      cancelled,
      running,
      waiting,
      successRate: total ? completed / total : 0,
      p50DurationMs: percentile(durations, 50),
      p99DurationMs: percentile(durations, 99),
    });
  } catch (error) {
    next(error);
  }
});

module.exports = { metricsRouter: router };

function percentile(values, percentileRank) {
  if (values.length === 0) {
    return 0;
  }

  const index = Math.ceil((percentileRank / 100) * values.length) - 1;
  return values[Math.max(0, Math.min(index, values.length - 1))];
}
