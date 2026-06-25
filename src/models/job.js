const mongoose = require("mongoose");

const JobSchema = new mongoose.Schema(
  {
    jobId: { type: String, required: true, unique: true, index: true },
    pan: { type: String, required: true, select: false },
    maskedPan: { type: String, required: true },
    panMasked: { type: String, required: true },
    panHash: { type: String, required: true, index: true },
    phase: { type: String, required: true },
    status: { type: String, required: true, index: true },
    lastSeq: { type: Number, required: true, default: 0 },
    startedAt: { type: Date, required: true, default: Date.now },
    updatedAt: { type: Date, required: true, default: Date.now },
    completedAt: { type: Date },
    durationMs: { type: Number },
    outcome: { type: String, index: true },
    result: {
      userId: String,
      encryptedPassword: String,
    },
    error: {
      code: String,
      message: String,
    },
    requestId: String,
  },
  { versionKey: false }
);

JobSchema.index({ phase: 1, updatedAt: -1 });
JobSchema.index({ status: 1, updatedAt: -1 });
JobSchema.index({ panMasked: 1 });
JobSchema.index({ maskedPan: 1 });
JobSchema.index({ startedAt: 1, completedAt: 1 });

module.exports = mongoose.model("Job", JobSchema);
