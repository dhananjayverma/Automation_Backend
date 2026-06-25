const assert = require("node:assert/strict");
const test = require("node:test");
const { PHASES, statusForPhase } = require("../src/domain/phases");
const { assertTransition } = require("../src/domain/stateMachine");
const { formatSse } = require("../src/services/sseHub");
const { maskPan } = require("../src/utils/mask");
const { submitOtp } = require("../src/services/automationEngine");

test("state machine accepts the happy path and rejects skipped phases", () => {
  const happyPath = [
    PHASES.STARTED,
    PHASES.OPEN_PORTAL,
    PHASES.IDENTITY,
    PHASES.CAPTCHA_REQUIRED,
    PHASES.CAPTCHA_SOLVED,
    PHASES.OTP_REQUIRED,
    PHASES.WAITING_FOR_OTP,
    PHASES.OTP_VERIFIED,
    PHASES.PASSWORD_GENERATED,
    PHASES.COMPLETED,
  ];

  for (let i = 0; i < happyPath.length - 1; i += 1) {
    assert.doesNotThrow(() => assertTransition(happyPath[i], happyPath[i + 1]));
  }
  assert.throws(
    () => assertTransition(PHASES.STARTED, PHASES.OTP_VERIFIED),
    /Invalid state transition STARTED -> OTP_VERIFIED/
  );
});

test("phase statuses expose terminal and operator-wait states", () => {
  assert.equal(statusForPhase(PHASES.COMPLETED), "completed");
  assert.equal(statusForPhase(PHASES.FAILED), "failed");
  assert.equal(statusForPhase(PHASES.CANCELLED), "cancelled");
  assert.equal(statusForPhase(PHASES.WAITING_FOR_OTP), "waiting_for_operator");
  assert.equal(statusForPhase(PHASES.OPEN_PORTAL), "running");
});

test("PAN masking keeps logs and UI from exposing full PAN", () => {
  assert.equal(maskPan("ABCDE1234F"), "AB******4F");
  assert.equal(maskPan("BAD"), "**********");
});

test("SSE formatter includes reconnect id, event name, and JSON data", () => {
  const event = {
    eventId: "job-1:7",
    jobId: "job-1",
    seq: 7,
    phase: PHASES.WAITING_FOR_OTP,
    level: "info",
    message: "Waiting for OTP",
  };

  const payload = formatSse(event);
  assert.match(payload, /^id: job-1:7/m);
  assert.match(payload, /^event: job-event/m);
  assert.match(payload, /"seq":7/);
});

test("OTP cannot be submitted when no automation is waiting", () => {
  assert.equal(submitOtp("missing-job", "123456"), false);
});
