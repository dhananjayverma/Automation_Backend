const Event = require("../models/event");
const Job = require("../models/job");
const { assertTransition } = require("../domain/stateMachine");
const { TERMINAL_PHASES, statusForPhase } = require("../domain/phases");
const { sseHub } = require("./sseHub");

async function appendEvent(jobId, payload) {
  const job = await Job.findOne({ jobId }).select("+pan");
  if (!job) {
    const error = new Error("Job not found");
    error.statusCode = 404;
    throw error;
  }

  console.log("[STATE]", job.phase, "=>", payload.phase);

  assertTransition(job.phase, payload.phase);

  const updatedAt = new Date();
  const update = {
    $inc: { lastSeq: 1 },
    $set: {
      phase: payload.phase,
      status: statusForPhase(payload.phase),
      updatedAt,
    },
  };

  if (TERMINAL_PHASES.has(payload.phase)) {
    update.$set.completedAt = updatedAt;
    const start = job.startedAt ? new Date(job.startedAt).getTime() : Date.now();
    update.$set.durationMs = Math.max(0, updatedAt.getTime() - start);
    
    let outcome = "failed";
    if (payload.phase === "COMPLETED") {
      outcome = "success";
    } else if (payload.phase === "CANCELLED") {
      outcome = "cancelled";
    }
    update.$set.outcome = outcome;
  }
  if (payload.result) {
    update.$set.result = payload.result;
  }
  if (payload.error) {
    update.$set.error = payload.error;
  }

  const updatedJob = await Job.findOneAndUpdate(
    { jobId, phase: job.phase },
    update,
    { returnDocument: "after" }
  );

  if (!updatedJob) {
    const error = new Error("Job phase changed while appending event");
    error.statusCode = 409;
    throw error;
  }

  const event = await Event.create({
    eventId: `${jobId}:${updatedJob.lastSeq}`,
    jobId,
    seq: updatedJob.lastSeq,
    phase: payload.phase,
    level: payload.level || "info",
    message: payload.message,
    step: payload.step,
    timestamp: new Date(),
    requestId: payload.requestId || job.requestId,
    metadata: scrubMetadata(payload.metadata),
    error: payload.error,
  });

  const plainEvent = event.toObject();
  sseHub.broadcast(jobId, plainEvent);
  return plainEvent;
}

async function replayEvents(jobId, afterSeq = 0) {
  return Event.find({ jobId, seq: { $gt: afterSeq } })
    .sort({ seq: 1 })
    .lean();
}

module.exports = { appendEvent, replayEvents };

function scrubMetadata(metadata) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return metadata;
  }

  const blocked = new Set(["pan", "otp", "password", "encryptedPassword"]);
  return Object.fromEntries(
    Object.entries(metadata).map(([key, value]) => [
      key,
      blocked.has(key) ? "[redacted]" : value,
    ])
  );
}
