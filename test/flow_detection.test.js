const test = require('node:test');
const assert = require('node:assert/strict');
const { detectPortalFlowFromText } = require('../src/services/playwrightPortalRunner');

test('detects registration flow for new PAN messaging', () => {
  assert.equal(
    detectPortalFlowFromText('Please register for a new account and complete verification'),
    'registration'
  );
});

test('detects forgot-password flow when portal says user is already registered', () => {
  assert.equal(
    detectPortalFlowFromText('PAN already registered. Use forgot password to recover credentials'),
    'forgot_password'
  );
});
