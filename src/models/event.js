const mongoose = require("mongoose");

const EventSchema = new mongoose.Schema(
  {
    eventId: { type: String, required: true, unique: true },
    jobId: { type: String, required: true },
    seq: { type: Number, required: true },
    phase: { type: String, required: true },
    level: { type: String, enum: ["info", "warn", "error"], required: true },
    message: { type: String, required: true },
    step: String,
    timestamp: { type: Date, required: true, default: Date.now },
    requestId: String,
    metadata: { type: mongoose.Schema.Types.Mixed },
    error: {
      code: String,
      message: String,
    },
  },
  { versionKey: false }
);

EventSchema.index({ jobId: 1, seq: 1 }, { unique: true });
EventSchema.index({ phase: 1, timestamp: -1 });

module.exports = mongoose.model("Event", EventSchema);
