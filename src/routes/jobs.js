const express = require("express");
const crypto = require("crypto");
const Job = require("../models/job");
const Event = require("../models/event");
const { PHASES } = require("../domain/phases");
const { appendEvent, replayEvents } = require("../services/eventService");
const { startAutomation, submitOrQueueOtp, signalCaptchaContinue, cancelAutomation, canAcceptOperatorOtp, canAcceptCaptchaContinue } = require("../services/automationEngine");
const { requireBearer } = require("../middleware/auth");
const { formatSse, sseHub } = require("../services/sseHub");
const { maskPan } = require("../utils/mask");
const { decrypt } = require("../utils/crypto");

const router = express.Router();
const panRegex = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const QUERY_TIMEOUT_MS = 8000;

router.post("/", requireBearer, async (req, res, next) => {
  try {
    const pan = String(req.body.pan || "").trim().toUpperCase();
    if (!panRegex.test(pan)) {
      return res.status(400).json({ error: "PAN must match ABCDE1234F format" });
    }

    const panHash = crypto.createHash("sha256").update(pan).digest("hex");

    const jobId = crypto.randomUUID();
    const requestId = req.requestId || req.header("x-request-id") || crypto.randomUUID();
    const job = await Job.create({
      jobId,
      pan,
      maskedPan: maskPan(pan),
      panMasked: maskPan(pan),
      panHash,
      phase: PHASES.STARTED,
      status: "running",
      requestId,
    });

    await appendEvent(jobId, {
      phase: PHASES.STARTED,
      level: "info",
      message: "Run accepted by service",
      step: "started",
      requestId,
    });
    startAutomation(jobId);

    res.status(201).json(publicJob(job.toObject()));
  } catch (error) {
    next(error);
  }
});

router.get("/", async (req, res, next) => {
  try {
    const query = {};
    if (req.query.phase) query.phase = req.query.phase;
    if (req.query.status) {
      if (req.query.status === "cancelled") {
        query.$or = [{ status: "cancelled" }, { phase: PHASES.CANCELLED }];
      } else if (req.query.status === "failed") {
        query.status = "failed";
        query.phase = { $ne: PHASES.CANCELLED };
      } else {
        query.status = req.query.status;
      }
    }
    if (req.query.search) {
      const searchQuery = [
        { jobId: new RegExp(String(req.query.search), "i") },
        { maskedPan: new RegExp(String(req.query.search), "i") },
      ];
      query.$and = query.$or ? [{ $or: query.$or }, { $or: searchQuery }] : [{ $or: searchQuery }];
      delete query.$or;
    }

    const [jobs, total] = await Promise.all([
      Job.find(query)
        .sort({ updatedAt: -1 })
        .limit(Math.min(Number(req.query.limit || 50), 100))
        .maxTimeMS(QUERY_TIMEOUT_MS)
        .lean(),
      Job.countDocuments(query).maxTimeMS(QUERY_TIMEOUT_MS),
    ]);

    res.json({ jobs: jobs.map(publicJob), total });
  } catch (error) {
    next(error);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    const job = await Job.findOne({ jobId: req.params.id }).lean();
    if (!job) return res.status(404).json({ error: "Job not found" });
    res.json({ job: publicJob(job) });
  } catch (error) {
    next(error);
  }
});

router.get("/:id/events", async (req, res, next) => {
  try {
    const afterSeqRaw = Number(req.query.afterSeq || 0);
    const afterSeq = Number.isFinite(afterSeqRaw) && afterSeqRaw >= 0 ? afterSeqRaw : 0;
    const events = await replayEvents(req.params.id, afterSeq);
    res.json({ events });
  } catch (error) {
    next(error);
  }
});

router.get("/:id/stream", async (req, res, next) => {
  try {
    const lastEventId = req.header("last-event-id") || "";
    const cursorFromHeader = Number(lastEventId.split(":").at(-1) || 0);
    const cursorFromQuery = Number(req.query.afterSeq || 0);
    const lastSeq = Number.isFinite(cursorFromQuery) && cursorFromQuery > 0 ? cursorFromQuery : cursorFromHeader;
    const jobId = req.params.id;

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders?.();
    res.write("retry: 3000\n\n");

    const backlog = await replayEvents(jobId, lastSeq);
    for (const event of backlog) {
      res.write(formatSse(event));
    }

    const unsubscribe = sseHub.subscribe(jobId, res);
    const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 25000);

    req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  } catch (error) {
    next(error);
  }
});

router.post("/:id/continue", requireBearer, async (req, res, next) => {
  try {
    const job = await Job.findOne({ jobId: req.params.id }).lean();
    if (!job) {
      return res.status(404).json({ error: "Job not found" });
    }
    if (!canAcceptCaptchaContinue(job.phase)) {
      return res.status(409).json({
        error: "Run is not waiting on CAPTCHA. Solve CAPTCHA in the browser when the run reaches that step.",
      });
    }

    const accepted = signalCaptchaContinue(req.params.id);
    if (!accepted) {
      return res.status(409).json({ error: "Continue already queued. Wait a few seconds before clicking again." });
    }

    await appendEvent(req.params.id, {
      phase: PHASES.CAPTCHA_REQUIRED,
      level: "info",
      message: "Operator confirmed CAPTCHA solved; bot resuming portal flow",
      step: "captcha_continue",
    });

    res.status(202).json({ accepted: true });
  } catch (error) {
    next(error);
  }
});

router.post("/:id/otp", requireBearer, async (req, res, next) => {
  try {
    const otp = String(req.body.otp || "").trim();
    if (!/^\d{6}$/.test(otp)) {
      return res.status(400).json({ error: "OTP must be exactly 6 digits" });
    }

    const job = await Job.findOne({ jobId: req.params.id }).lean();
    if (!job) {
      return res.status(404).json({ error: "Job not found" });
    }
    if (!canAcceptOperatorOtp(job.phase)) {
      const hint =
        job.phase === PHASES.CAPTCHA_REQUIRED
          ? "Solve CAPTCHA in the browser first, then click Continue. OTP comes after that."
          : "Run is not ready for OTP yet. Wait until the dashboard shows the OTP input.";
      return res.status(409).json({ error: hint });
    }

    const accepted = submitOrQueueOtp(req.params.id, otp);
    if (!accepted) {
      return res.status(409).json({ error: "Automation is not active for this run." });
    }

    const nextPhase = job.phase === PHASES.OTP_REQUIRED ? PHASES.WAITING_FOR_OTP : job.phase;
    await appendEvent(req.params.id, {
      phase: nextPhase,
      level: "info",
      message: "Operator supplied OTP; bot will fill it on the portal",
      step: "otp_supplied",
      metadata: { otp: "******" },
    });

    res.status(202).json({ accepted: true });
  } catch (error) {
    next(error);
  }
});

router.post("/:id/cancel", requireBearer, async (req, res, next) => {
  try {
    const job = await Job.findOne({ jobId: req.params.id }).lean();
    if (!job) {
      return res.status(404).json({ error: "Job not found" });
    }
    if ([PHASES.COMPLETED, PHASES.FAILED, PHASES.CANCELLED].includes(job.phase)) {
      return res.status(409).json({ error: "Run is already finished" });
    }

    cancelAutomation(req.params.id);
    const event = await appendEvent(req.params.id, {
      phase: PHASES.CANCELLED,
      level: "warn",
      message: "Run cancelled by operator",
      step: "cancelled",
    });

    res.status(202).json({ accepted: true, event });
  } catch (error) {
    next(error);
  }
});

router.delete("/:id", requireBearer, async (req, res, next) => {
  try {
    const job = await Job.findOne({ jobId: req.params.id }).lean();
    if (!job) {
      return res.status(404).json({ error: "Job not found" });
    }
    if (!["completed", "failed", "cancelled"].includes(job.status)) {
      return res.status(409).json({ error: "Only finished runs can be deleted. Cancel the run first." });
    }

    await Promise.all([
      Event.deleteMany({ jobId: req.params.id }),
      Job.deleteOne({ jobId: req.params.id }),
    ]);

    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

function publicJob(job) {
  const startedAt = new Date(job.startedAt).getTime();
  const endAt = job.completedAt ? new Date(job.completedAt).getTime() : Date.now();
  const status =
    job.phase === PHASES.COMPLETED
      ? "completed"
      : job.phase === PHASES.FAILED
      ? "failed"
      : job.phase === PHASES.CANCELLED
      ? "cancelled"
      : job.status;
  
  let result = undefined;
  if (job.result) {
    result = {
      userId: job.result.userId ? maskPan(job.result.userId) : undefined,
      passwordSaved: Boolean(job.result.encryptedPassword),
    };
    if (job.phase === PHASES.COMPLETED && job.result.encryptedPassword) {
      result.password = decrypt(job.result.encryptedPassword);
    }
  }

  return {
    jobId: job.jobId,
    maskedPan: job.maskedPan,
    panMasked: job.panMasked || job.maskedPan,
    panHash: job.panHash,
    phase: job.phase,
    status,
    startedAt: job.startedAt,
    updatedAt: job.updatedAt,
    completedAt: job.completedAt,
    durationMs: job.durationMs !== undefined ? job.durationMs : Math.max(0, endAt - startedAt),
    outcome: job.outcome || (status === "completed" ? "success" : status === "failed" ? "failed" : status === "cancelled" ? "cancelled" : undefined),
    result,
    error: job.error,
  };
}

module.exports = { jobsRouter: router };
