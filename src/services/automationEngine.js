const Job = require('../models/job');
const { PHASES } = require('../domain/phases');
const { config } = require('../config');
const { runPlaywrightAutomation } = require('./playwrightPortalRunner');
const { encrypt } = require('../utils/crypto');
const { maskPan } = require('../utils/mask');
const crypto = require('crypto');

const otpResolvers = new Map();
const pendingOtps = new Map();
const captchaResolvers = new Map();
const captchaPendingByJob = new Map();
const cancelledJobs = new Set();
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function runAutomation(jobId) {
  try {
    const job = await Job.findOne({ jobId })
      .select('+pan')
      .lean();
    if (!job) throw Object.assign(new Error('Job not found'), { code: 'JOB_NOT_FOUND' });

    const context = {
      jobId,
      pan: job.pan,
      emit,
      waitForOtp,
      takeCaptchaContinue: () => takeCaptchaContinue(jobId),
      assertNotCancelled,
      completeWithGeneratedCredentials,
    };

    await runPlaywrightAutomation(context);
  } catch (error) {
    if (cancelledJobs.has(jobId)) {
      await emit(jobId, PHASES.CANCELLED, 'Run cancelled by operator', 'cancelled', { level: 'warn' }).catch(() => {});
      cleanupJob(jobId);
      return;
    }
    await emit(jobId, PHASES.FAILED, error.message || 'Automation failed', 'failed', {
      level: 'error',
      error: { code: error.code || 'AUTOMATION_ERROR', message: error.message },
    }).catch(() => {});
    cleanupJob(jobId);
  }
}

async function completeWithGeneratedCredentials(jobId, password) {
  const job = await Job.findOne({ jobId }).select('+pan').lean();
  const pan = job ? job.pan : 'UNKNOWN';
  const generatedPwd = password || generatePassword();
  const userId = pan; // PAN is the User ID on the Income Tax portal

  await emit(jobId, PHASES.PASSWORD_GENERATED, 'New password generated and being set on portal', 'password_generated', {
    metadata: { userId: maskPan(userId) },
  });
  await delay(400);

  await emit(jobId, PHASES.COMPLETED, 'Credentials successfully generated and saved', 'completed', {
    result: {
      userId,
      encryptedPassword: encrypt(generatedPwd),
    },
  });
  cleanupJob(jobId);
}

function generatePassword() {
  return `Rk@${crypto.randomBytes(12).toString('base64url')}9`;
}

function startAutomation(jobId) {
  runAutomation(jobId).catch((e) => console.error({ jobId, error: e.message }, 'automation runner crashed'));
}

function submitOtp(jobId, otp) {
  const resolve = otpResolvers.get(jobId);
  if (!resolve) return false;
  otpResolvers.delete(jobId);
  resolve(otp);
  return true;
}

function submitOrQueueOtp(jobId, otp) {
  if (submitOtp(jobId, otp)) {
    return true;
  }
  pendingOtps.set(jobId, otp);
  return true;
}

function signalCaptchaContinue(jobId) {
  const pending = captchaPendingByJob.get(jobId) || 0;
  if (pending >= 1) {
    return false;
  }

  captchaPendingByJob.set(jobId, 1);
  const waiter = captchaResolvers.get(jobId);
  if (waiter) {
    captchaResolvers.delete(jobId);
    waiter();
  }
  return true;
}

function takeCaptchaContinue(jobId) {
  const pending = captchaPendingByJob.get(jobId) || 0;
  if (pending <= 0) return false;
  captchaPendingByJob.set(jobId, pending - 1);
  return true;
}

function cancelAutomation(jobId) {
  cancelledJobs.add(jobId);
  submitOtp(jobId, '000000');
  signalCaptchaContinue(jobId);
}

function waitForOtp(jobId) {
  if (pendingOtps.has(jobId)) {
    const otp = pendingOtps.get(jobId);
    pendingOtps.delete(jobId);
    return Promise.resolve(otp);
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      otpResolvers.delete(jobId);
      pendingOtps.delete(jobId);
      reject(Object.assign(new Error('OTP not received within 15 minutes'), { code: 'OTP_TIMEOUT' }));
    }, 15 * 60 * 1000);

    otpResolvers.set(jobId, (otp) => {
      clearTimeout(timer);
      resolve(otp);
    });
  });
}

function waitForCaptchaContinue(jobId, timeoutMs = 12 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      captchaResolvers.delete(jobId);
      reject(Object.assign(new Error('CAPTCHA step not completed within 12 minutes'), { code: 'CAPTCHA_TIMEOUT' }));
    }, timeoutMs);

    captchaResolvers.set(jobId, () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function assertNotCancelled(jobId) {
  if (cancelledJobs.has(jobId)) {
    throw Object.assign(new Error('Run cancelled by operator'), { code: 'CANCELLED' });
  }
}

function cleanupJob(jobId) {
  otpResolvers.delete(jobId);
  pendingOtps.delete(jobId);
  captchaResolvers.delete(jobId);
  captchaPendingByJob.delete(jobId);
  cancelledJobs.delete(jobId);
}

function emit(jobId, phase, message, step, extra = {}) {
  return postWebhookEvent({ jobId, phase, message, step, level: extra.level || 'info', error: extra.error, result: extra.result, metadata: extra.metadata });
}

async function postWebhookEvent(payload) {
  const maxAttempts = 5;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 7000);
      const res = await fetch(`${config.serviceBaseUrl}/webhook/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Webhook-Secret': config.webhookSecret },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!res.ok) {
        const body = await res.text();
        throw new Error(`webhook append failed (${res.status}): ${body}`);
      }
      return;
    } catch (error) {
      if (attempt >= maxAttempts) {
        throw error;
      }
      await delay(attempt * 400);
    }
  }
}

module.exports = { startAutomation, submitOtp, submitOrQueueOtp, signalCaptchaContinue, cancelAutomation };
