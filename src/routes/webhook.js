const express = require("express");
const { appendEvent } = require("../services/eventService");
const { requireWebhookSecret } = require("../middleware/auth");
const { PHASES } = require("../domain/phases");

const router = express.Router();
const levels = new Set(["info", "warn", "error"]);
const phases = new Set(Object.values(PHASES));

router.post("/events", requireWebhookSecret, async (req, res, next) => {
  try {
    const { jobId, phase, level = "info", message, step, metadata, error, result } = req.body;
    if (!jobId || !phase || !message) {
      return res.status(400).json({ error: "jobId, phase, and message are required" });
    }
    if (!phases.has(phase)) {
      return res.status(400).json({ error: "Unknown phase" });
    }
    if (!levels.has(level)) {
      return res.status(400).json({ error: "level must be info, warn, or error" });
    }

    const event = await appendEvent(jobId, {
      phase,
      level,
      message: String(message).slice(0, 500),
      step,
      metadata,
      error,
      result,
      requestId: req.requestId || req.header("x-request-id"),
    });
    res.status(201).json({ event });
  } catch (error) {
    next(error);
  }
});

module.exports = { webhookRouter: router };
