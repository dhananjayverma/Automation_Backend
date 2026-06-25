"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { PHASES } = require("../domain/phases");
const { config } = require("../config");

const PUBLIC_PORTAL_URL = "https://www.incometax.gov.in/iec/foportal/";
const EPORTAL_SERVICES_URL = "https://eportal.incometax.gov.in/iec/foservices/";
const LOGIN_URL = "https://eportal.incometax.gov.in/iec/foservices/#/login";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const PAN_SELECTORS = [
  'input#panAdhaarUserId',            
  'input[placeholder*="PAN /" i]',
  'input[placeholder*="PAN" i]',
  'input[placeholder*="Aadhaar" i]',
  'input[placeholder*="User ID" i]',
  'input[placeholder*="OTHER USER ID" i]',
  'input[formcontrolname="pan"]',
  'input[formcontrolname="panNumber"]',
  'input[formcontrolname="userId"]',
  'input[formcontrolname="userName"]',
  'input[aria-label*="PAN" i]',
  'input[aria-label="panNumber"]',
  'input[title*="PAN" i]',
  'input[title="pan"]',
  'input[id="mat-input-0"]',
  'input[maxlength="10"]',             // last resort
].filter(Boolean);

function portalStartUrl() {
  const configured = String(config.portalUrl || PUBLIC_PORTAL_URL).trim();
  if (!configured || /eportal\.incometax\.gov\.in\/iec\/foservices/i.test(configured)) {
    return PUBLIC_PORTAL_URL;
  }
  return configured;
}

async function safeGoto(page, url, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
      return;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await page.waitForTimeout(3000);
      }
    }
  }

  const message = lastError?.message || "Portal did not respond";
  const offline = /ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|ERR_PROXY_CONNECTION_FAILED|ERR_NAME_NOT_RESOLVED/i.test(message);
  const code = offline
    ? "BROWSER_NETWORK_OFFLINE"
    : /Timeout|timed out/i.test(message)
      ? "PORTAL_TIMEOUT"
      : "PORTAL_UNAVAILABLE";
  const detail = offline
    ? "Chromium cannot access the internet. Check Wi-Fi/VPN/proxy/firewall, then restart the backend and try again."
    : `Portal unavailable after ${attempts} attempts at ${url}: ${message}`;
  throw Object.assign(
    new Error(detail),
    { code },
  );
}

async function openLoginFromPublicPortal(page) {
  if (await hasAnyVisible(page, PAN_SELECTORS, 1500)) {
    return;
  }

  const loginLink = page.getByRole("link", { name: /login/i }).first();
  if (await loginLink.isVisible({ timeout: 10000 }).catch(() => false)) {
    const href = await loginLink.getAttribute("href").catch(() => "");
    if (href) {
      const loginUrl = new URL(href, page.url()).toString();
      await safeGoto(page, loginUrl);
      return;
    }
  }

  const loginTargets = [
    page.getByRole("button", { name: /login/i }).first(),
    page.getByText(/login/i).first(),
  ];

  for (const target of loginTargets) {
    if (await target.isVisible({ timeout: 2500 }).catch(() => false)) {
      await target.click({ timeout: 5000 });
      await page.waitForTimeout(3000);
      return;
    }
  }
}

async function hasAnyVisible(page, selectors, timeoutMs = 800) {
  for (const selector of selectors) {
    if (await page.locator(selector).first().isVisible({ timeout: timeoutMs }).catch(() => false)) {
      return true;
    }
  }
  return false;
}

async function findIdentityInput(page, timeoutMs = 25000) {
  try {
    return await waitForAny(page, PAN_SELECTORS, timeoutMs);
  } catch (selectorError) {
    const fallback = page
      .locator('input[type="text"]:visible, input:not([type]):visible, input[autocomplete="username"]:visible')
      .first();
    if (await fallback.isVisible({ timeout: 1500 }).catch(() => false)) {
      return fallback;
    }
    throw selectorError;
  }
}

async function waitForIdentityInput(page, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;

  while (Date.now() < deadline) {
    try {
      return await findIdentityInput(page, 15000);
    } catch (error) {
      lastError = error;
      await page.waitForTimeout(700);
    }
  }

  throw lastError || Object.assign(new Error("Identity input did not appear"), { code: "SELECTOR_TIMEOUT" });
}

// ─── Wait for any selector from a list to become visible ─────────────────────
async function waitForAny(page, selectors, timeoutMs = 25000) {
  const list = Array.isArray(selectors)
    ? selectors
    : selectors.split(",").map((s) => s.trim()).filter(Boolean);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const sel of list) {
      try {
        if (await page.locator(sel).first().isVisible({ timeout: 400 }).catch(() => false)) {
          return page.locator(sel).first();
        }
      } catch (_) { /* try next selector */ }
    }
    await page.waitForTimeout(500);
  }

  // Diagnostic on timeout
  const found = await page
    .evaluate(() =>
      Array.from(document.querySelectorAll("input")).map(
        (el) =>
          `fc="${el.getAttribute("formcontrolname")}" id="${el.id}" ` +
          `type="${el.type}" aria="${el.getAttribute("aria-label")}" ` +
          `ph="${el.placeholder}" visible=${el.offsetParent !== null}`
      )
    )
    .catch(() => []);
  const suggestions = await page
    .evaluate(() =>
      Array.from(document.querySelectorAll("input"))
        .filter((el) => el.offsetParent !== null)
        .map((el) => {
          if (el.id) return `input#${CSS.escape(el.id)}`;
          if (el.placeholder) return `input[placeholder*="${el.placeholder.split("/")[0].trim()}"]`;
          const fc = el.getAttribute("formcontrolname");
          if (fc) return `input[formcontrolname="${fc}"]`;
          return "";
        })
        .filter(Boolean)
    )
    .catch(() => []);

  const err = new Error(
    `Selector timeout (${timeoutMs}ms).\n` +
    `Tried: [${list.join(" | ")}]\n` +
    `Visible selector suggestions: ${suggestions.length ? suggestions.join(" | ") : "none"}\n` +
    `Inputs in DOM: ${found.length === 0 ? "NONE (Angular may not have loaded)" : "\n  " + found.join("\n  ")}`
  );
  err.code = "SELECTOR_TIMEOUT";
  throw err;
}

// ─── Wait for Angular to render at least `minInputs` <input> elements ─────────
async function waitForAngular(page, minInputs = 1, timeoutMs = 45000) {
  await page
    .waitForFunction(
      (min) => document.querySelectorAll("input").length >= min,
      minInputs,
      { timeout: timeoutMs, polling: 800 }
    )
    .catch(async () => {
      const url = page.url();
      throw Object.assign(
        new Error(
          `Portal did not render any inputs within ${timeoutMs}ms. ` +
          `URL: ${url}. Check if the portal is under maintenance.`
        ),
        { code: "PORTAL_NOT_LOADED" }
      );
    });
  // Extra settle time for Angular change detection
  await page.waitForTimeout(1500);
}

// ─── Fill OTP across split-box or single inputs ────────────────────────────────
async function fillOtp(page, otp, selectors) {
  const list = Array.isArray(selectors)
    ? selectors
    : selectors.split(",").map((s) => s.trim());

  for (const sel of list) {
    const boxes = page.locator(sel);
    const count = await boxes.count().catch(() => 0);
    if (count === 0) continue;

    if (count > 1) {
      const digitsToFill = Math.min(count, otp.length);
      for (let i = 0; i < digitsToFill; i++) {
        const box = boxes.nth(i);
        await box.click({ timeout: 5000 });
        await page.keyboard.press("Meta+A").catch(() => {});
        await page.keyboard.press("Control+A").catch(() => {});
        await page.keyboard.press("Backspace").catch(() => {});
        await box.type(otp[i], { delay: 80 });
        await box.evaluate((el) => {
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: el.value || "" }));
        }).catch(() => {});
        await page.waitForTimeout(120);
      }

      await boxes.nth(digitsToFill - 1).blur().catch(() => {});
      await page.keyboard.press("Tab").catch(() => {});
    } else {
      const input = boxes.first();
      await input.click({ clickCount: 3, timeout: 5000 });
      await page.keyboard.press("Meta+A").catch(() => {});
      await page.keyboard.press("Control+A").catch(() => {});
      await page.keyboard.press("Backspace").catch(() => {});
      await input.type(otp, { delay: 80 });
      await input.evaluate((el) => {
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: el.value?.at(-1) || "" }));
      }).catch(() => {});
      await input.blur().catch(() => {});
      await page.keyboard.press("Tab").catch(() => {});
    }

    await page.waitForTimeout(1000);
    const checkboxChecked = await page.locator('input[type="checkbox"]').first().isChecked().catch(() => null);
    const verifyDisabled = await page.locator('button:has-text("Verify"), button:has-text("Validate"), button:has-text("Submit")')
      .first()
      .isDisabled()
      .catch(() => null);
    const bodyAfterOtp = await page.locator("body").innerText().catch(() => "");
    console.log(`[automation] OTP entered; checkbox=${checkboxChecked}; verifyDisabled=${verifyDisabled}`);
    console.log(`[automation] OTP page body after entry => ${bodyAfterOtp.replace(/\s+/g, " ").trim().slice(0, 800)}`);
    if (isPasswordResetText(bodyAfterOtp)) {
      console.log("[automation] OTP accepted; password reset page detected after OTP entry");
      return;
    }

    // Click the submit button after filling
    const submitSelectors = [
      'button:has-text("Validate")',
      'button:has-text("Verify")',
      'button:has-text("Submit")',
      'button:has-text("Continue")',
      'button:has-text("Proceed")',
      'button[type="submit"]',
    ];

    const clicked = await clickEnabledButton(page, submitSelectors, 10000);
    if (clicked) {
      return;
    }

    const disabledText = await page
      .locator('button:has-text("Validate"), button:has-text("Verify"), button:has-text("Submit"), button:has-text("Continue"), button:has-text("Proceed")')
      .first()
      .evaluate((el) => `${el.textContent || ""} disabled=${el.disabled || el.getAttribute("aria-disabled") === "true"}`)
      .catch(() => "no submit button found");
    console.log(`[automation] OTP submit button not enabled: ${disabledText}`);

    await page
      .getByRole("button", { name: /validate|verify|submit|continue|proceed/i })
      .first()
      .click({ force: true })
      .catch(() => {});
    return;
  }
}

async function hasVisibleSelector(page, selector, timeout = 800) {
  return page.locator(selector).first().isVisible({ timeout }).catch(() => false);
}

async function isPasswordResetPage(page, passwordSelector) {
  const body = await page.locator("body").innerText().catch(() => "");
  if (isPasswordResetText(body)) {
    return true;
  }

  const passwordInputs = page.locator(passwordSelector);
  const visiblePasswordCount = await passwordInputs
    .evaluateAll((inputs) => inputs.filter((input) => input.offsetParent !== null).length)
    .catch(() => 0);
  if (visiblePasswordCount >= 2) {
    return true;
  }

  return page
    .locator('button:has-text("Set Password"), button:has-text("Reset Password")')
    .first()
    .isVisible({ timeout: 800 })
    .catch(() => false);
}

function isPasswordResetText(text = "") {
  return /set\s+new\s+password|confirm\s+new\s+password|reset\s+password/i.test(String(text));
}

async function clickEnabledButton(page, selectors, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    for (const sel of selectors.filter(Boolean)) {
      const buttons = page.locator(sel);
      const count = await buttons.count().catch(() => 0);
      for (let i = 0; i < count; i++) {
        const button = buttons.nth(i);
        const usable = await button
          .evaluate((el) => {
            const element = el;
            const ariaDisabled = element.getAttribute("aria-disabled") === "true";
            return element.offsetParent !== null && !element.disabled && !ariaDisabled;
          })
          .catch(() => false);

        if (usable) {
          await button.click({ timeout: 5000 });
          return true;
        }
      }
    }

    await page.waitForTimeout(500);
  }

  return false;
}

async function fillInputLikeUser(page, input, value, label = "input") {
  const expected = String(value || "").trim().toUpperCase();
  await input.waitFor({ state: "visible", timeout: 10000 });
  await input.scrollIntoViewIfNeeded().catch(() => {});
  await input.click({ clickCount: 3, timeout: 5000 }).catch(() => {});
  await page.keyboard.press("Meta+A").catch(() => {});
  await page.keyboard.press("Control+A").catch(() => {});
  await page.keyboard.press("Backspace").catch(() => {});
  await input.fill("").catch(() => {});
  await input.type(expected, { delay: 60 }).catch(async () => {
    await input.fill(expected);
  });

  let actual = await input.inputValue().catch(() => "");
  if (actual.trim().toUpperCase() !== expected) {
    await input.evaluate((el, nextValue) => {
      const proto = el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (setter) {
        setter.call(el, nextValue);
      } else {
        el.value = nextValue;
      }
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: nextValue.at(-1) || "" }));
      el.blur();
    }, expected);
    actual = await input.inputValue().catch(() => "");
  }

  if (actual.trim().toUpperCase() !== expected) {
    const error = new Error(`Portal did not accept ${label}; the field remained blank or changed unexpectedly`);
    error.code = "PORTAL_INPUT_REJECTED";
    throw error;
  }

  await page.waitForTimeout(800);
}

async function fillPasswordLikeUser(page, input, value) {
  await input.waitFor({ state: "visible", timeout: 10000 });
  await input.scrollIntoViewIfNeeded().catch(() => {});
  await input.click({ clickCount: 3, timeout: 5000 }).catch(() => {});
  await page.keyboard.press("Meta+A").catch(() => {});
  await page.keyboard.press("Control+A").catch(() => {});
  await page.keyboard.press("Backspace").catch(() => {});
  await input.fill("").catch(() => {});
  await input.type(value, { delay: 50 }).catch(async () => {
    await input.fill(value);
  });
  await input.evaluate((el) => {
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: el.value?.at(-1) || "" }));
  }).catch(() => {});
  await input.blur().catch(() => {});
  await page.waitForTimeout(300);
}

async function clickForgotPasswordIfVisible(page, timeoutMs = 8000) {
  const forgotLocators = [
    page.locator("a").filter({ hasText: /forgot/i }).first(),
    page.getByText(/forgot/i).first(),
  ];
  const forgotSelectors = [
    'a:has-text("Forgot Password")',
    'button:has-text("Forgot Password")',
    'span:has-text("Forgot Password")',
    'p:has-text("Forgot Password")',
    'a:has-text("Forgot")',
    'button:has-text("Forgot")',
    '[href*="forgot" i]',
    '[class*="forgot" i]',
  ];

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const locator of forgotLocators) {
      if (await locator.isVisible({ timeout: 400 }).catch(() => false)) {
        await locator.click({ timeout: 5000 }).catch(() => {});
        await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(3000);
        return true;
      }
    }

    for (const selector of forgotSelectors) {
      const link = page.locator(selector).first();
      if (await link.isVisible({ timeout: 400 }).catch(() => false)) {
        await link.click({ timeout: 5000 }).catch(() => {});
        await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(3000);
        return true;
      }
    }
    await page.waitForTimeout(500);
  }

  return false;
}

async function clickTextOption(page, patterns, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const pattern of patterns) {
      const option = page
        .locator(`label:has-text("${pattern}"), span:has-text("${pattern}"), div:has-text("${pattern}")`)
        .first();
      if (await option.isVisible({ timeout: 500 }).catch(() => false)) {
        await option.click({ timeout: 5000 }).catch(() => {});
        return true;
      }
    }
    await page.waitForTimeout(500);
  }
  return false;
}

async function hasSelectedRadio(page) {
  const checkedInputs = await page.locator('input[type="radio"]:checked').count().catch(() => 0);
  if (checkedInputs > 0) return true;

  const checkedRoles = await page
    .locator('[role="radio"][aria-checked="true"], mat-radio-button.mat-mdc-radio-checked, mat-radio-button.mat-radio-checked')
    .count()
    .catch(() => 0);
  return checkedRoles > 0;
}

async function selectOtpChannel(page, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  const aadhaarOtpText = /OTP on mobile number registered with Aadhaar|OTP on mobile number|Aadhaar OTP|Mobile OTP/i;

  while (Date.now() < deadline) {
    if (await hasSelectedRadio(page)) {
      return true;
    }

    const labelOption = page.getByText(aadhaarOtpText).first();
    if (await labelOption.isVisible({ timeout: 500 }).catch(() => false)) {
      await labelOption.scrollIntoViewIfNeeded().catch(() => {});
      await labelOption.click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(500);
      if (await hasSelectedRadio(page)) {
        return true;
      }
    }

    const labelledRadio = page.getByLabel(aadhaarOtpText).first();
    if (await labelledRadio.isVisible({ timeout: 500 }).catch(() => false)) {
      await labelledRadio.check({ force: true, timeout: 5000 }).catch(async () => {
        await labelledRadio.click({ force: true, timeout: 5000 }).catch(() => {});
      });
      await page.waitForTimeout(500);
      if (await hasSelectedRadio(page)) {
        return true;
      }
    }

    const radioContainers = page
      .locator('label, mat-radio-button, [role="radio"], .mat-radio-label, .mat-mdc-radio-button')
      .filter({ hasText: aadhaarOtpText });
    const containerCount = await radioContainers.count().catch(() => 0);
    for (let i = 0; i < containerCount; i += 1) {
      const option = radioContainers.nth(i);
      if (await option.isVisible({ timeout: 300 }).catch(() => false)) {
        await option.click({ force: true, timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(500);
        if (await hasSelectedRadio(page)) {
          return true;
        }
      }
    }

    const radios = page.locator('input[type="radio"]');
    const radioCount = await radios.count().catch(() => 0);
    for (let i = 0; i < radioCount; i += 1) {
      const radio = radios.nth(i);
      await radio.check({ force: true, timeout: 5000 }).catch(async () => {
        await radio.evaluate((el) => {
          el.checked = true;
          el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        }).catch(() => {});
      });
      await page.waitForTimeout(500);
      if (await hasSelectedRadio(page)) {
        return true;
      }
    }

    await page.waitForTimeout(500);
  }

  return false;
}

async function requestFreshOtpIfOffered(page, jobId, timeoutMs = 8000) {
  const body = await page.locator("body").innerText().catch(() => "");
  console.log(`[automation:${jobId}] requestFreshOtpIfOffered: OTP PAGE CHECK`);
  console.log(`[automation:${jobId}] requestFreshOtpIfOffered body => ${body.replace(/\s+/g, " ").trim().slice(0, 1000)}`);
  if (!/I\s+already\s+have\s+an\s+OTP/i.test(body) || !/Generate\s+OTP/i.test(body)) {
    console.log(`[automation:${jobId}] requestFreshOtpIfOffered: Generate OTP choice not found`);
    return false;
  }
  console.log(`[automation:${jobId}] OTP PAGE DETECTED`);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const selectedByDom = await page.evaluate(() => {
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      };
      const candidates = Array.from(document.querySelectorAll("label, mat-radio-button, [role='radio'], span, div"))
        .filter((el) => /Generate\s+OTP/i.test(el.innerText || el.textContent || "") && visible(el));

      for (const candidate of candidates) {
        const option =
          candidate.closest("mat-radio-button") ||
          candidate.closest("label") ||
          candidate.closest("[role='radio']") ||
          candidate;
        const input = option.querySelector?.("input[type='radio']");
        const target = input || option;
        target.click();
        if (input) {
          input.checked = true;
          input.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
        }
        return true;
      }

      const radios = Array.from(document.querySelectorAll("input[type='radio']"));
      if (radios.length >= 2) {
        const radio = radios[1];
        radio.click();
        radio.checked = true;
        radio.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        radio.dispatchEvent(new Event("input", { bubbles: true }));
        radio.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }

      return false;
    }).catch(() => false);

    if (selectedByDom) {
      console.log(`[automation:${jobId}] Generate OTP clicked`);
      await page.waitForTimeout(1000);
    } else {
      const generateOption = page.locator("text=Generate OTP").last();
      if (await generateOption.isVisible({ timeout: 500 }).catch(() => false)) {
        await generateOption.scrollIntoViewIfNeeded().catch(() => {});
        await generateOption.click({ force: true, timeout: 5000 }).catch(() => {});
        console.log(`[automation:${jobId}] Generate OTP clicked via text locator`);
        await page.waitForTimeout(1000);
      }
    }

    const radioOptions = page.locator('input[type="radio"]');
    const radioCount = await radioOptions.count().catch(() => 0);
    console.log(`[automation:${jobId}] Radio count: ${radioCount}`);
    if (radioCount > 1) {
      const secondRadio = radioOptions.nth(1);
      await secondRadio.check({ force: true, timeout: 5000 }).catch(async () => {
        await secondRadio.evaluate((el) => {
          el.click();
          el.checked = true;
          el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        }).catch(() => {});
      });
      console.log(`[automation:${jobId}] Generate OTP second radio checked`);
      await page.waitForTimeout(1000);
    }

    const checked = await page.locator('input[type="radio"]:checked').count().catch(() => 0);
    const selectedText = await page.evaluate(() => {
      const selected =
        document.querySelector("input[type='radio']:checked")?.closest("label, mat-radio-button, [role='radio']") ||
        document.querySelector("[role='radio'][aria-checked='true']") ||
        document.querySelector("mat-radio-button.mat-mdc-radio-checked, mat-radio-button.mat-radio-checked");
      return (selected?.innerText || selected?.textContent || "").replace(/\s+/g, " ").trim();
    }).catch(() => "");
    console.log(`[automation:${jobId}] Checked radios: ${checked}; selected => ${selectedText || "unknown"}`);

    const clicked = await clickEnabledButton(page, [
      'button:has-text("Continue")',
      'button:has-text("Generate OTP")',
      'button:has-text("Proceed")',
      'button[type="submit"]',
    ], 1200);

    if (clicked) {
      console.log(`[automation:${jobId}] Continue clicked`);
      await page.waitForTimeout(2500);
      const afterClick = await page.locator("body").innerText().catch(() => "");
      console.log(`[automation:${jobId}] after Generate OTP Continue => ${afterClick.replace(/\s+/g, " ").trim().slice(0, 500)}`);
      return true;
    }

    await page.waitForTimeout(500);
  }

  return false;
}

async function handleAadhaarConsentAndGenerateOtp(page, otpSelectors, passwordSelector, jobId, timeoutMs = 8000) {
  const body = await page.locator("body").innerText().catch(() => "");
  const hasConsentText = /I\s+agree\s+to\s+validate\s+my\s+Aadhaar\s+Details/i.test(body);
  const hasGenerateButton = /Generate\s+Aadhaar\s+OTP/i.test(body);
  if (!hasConsentText && !hasGenerateButton) {
    return false;
  }

  console.log(`[automation:${jobId}] Aadhaar consent page detected`);
  console.log(`[automation:${jobId}] Aadhaar consent body => ${body.replace(/\s+/g, " ").trim().slice(0, 1000)}`);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const checkedConsent = await page.evaluate(() => {
      const consentPattern = /I\s+agree\s+to\s+validate\s+my\s+Aadhaar\s+Details/i;
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      };

      const candidates = Array.from(document.querySelectorAll("label, mat-checkbox, [role='checkbox'], span, div"))
        .filter((el) => consentPattern.test(el.innerText || el.textContent || "") && visible(el));

      for (const candidate of candidates) {
        const option =
          candidate.closest("mat-checkbox") ||
          candidate.closest("label") ||
          candidate.closest("[role='checkbox']") ||
          candidate;
        const input = option.querySelector?.("input[type='checkbox']") || document.querySelector("input[type='checkbox']");
        option.click();
        if (input) {
          input.checked = true;
          input.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
        }
        return true;
      }

      const checkbox = document.querySelector("input[type='checkbox']");
      if (checkbox) {
        checkbox.click();
        checkbox.checked = true;
        checkbox.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        checkbox.dispatchEvent(new Event("input", { bubbles: true }));
        checkbox.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }

      return false;
    }).catch(() => false);

    if (!checkedConsent) {
      await page.getByText(/I\s+agree\s+to\s+validate\s+my\s+Aadhaar\s+Details/i)
        .click({ force: true, timeout: 1000 })
        .catch(() => {});
    }
    await page.waitForTimeout(800);

    const checkedCount = await page.locator('input[type="checkbox"]:checked').count().catch(() => 0);
    console.log(`[automation:${jobId}] Aadhaar consent checked count: ${checkedCount}`);

    const clicked = await clickEnabledButton(page, [
      'button:has-text("Generate Aadhaar OTP")',
      'button:has-text("Generate OTP")',
      'button:has-text("Continue")',
      'button[type="submit"]',
    ], 2500);

    if (clicked) {
      console.log(`[automation:${jobId}] Generate Aadhaar OTP clicked`);
      await page.waitForTimeout(3000);
      const afterClick = await page.locator("body").innerText().catch(() => "");
      console.log(`[automation:${jobId}] after Generate Aadhaar OTP => ${afterClick.replace(/\s+/g, " ").trim().slice(0, 1000)}`);
      const nextStage = await detectRecoveryStage(page, otpSelectors, passwordSelector);
      if (nextStage === "otp" || nextStage === "password") {
        return true;
      }
    }

    await page.waitForTimeout(700);
  }

  return false;
}

async function clickAnyCheckbox(page, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const checkboxes = page.locator('input[type="checkbox"], mat-checkbox, label:has-text("agree"), span:has-text("agree")');
    const count = await checkboxes.count().catch(() => 0);
    for (let i = 0; i < count; i += 1) {
      const checkbox = checkboxes.nth(i);
      if (await checkbox.isVisible({ timeout: 500 }).catch(() => false)) {
        await checkbox.click({ timeout: 5000 }).catch(() => {});
        return true;
      }
    }
    await page.waitForTimeout(500);
  }
  return false;
}

async function clickFirstVisible(page, selectors, timeoutMs = 15000) {
  const locator = await waitForAny(page, selectors.filter(Boolean), timeoutMs);
  await locator.click({ timeout: 5000 });
}

function detectPortalFlowFromText(text = "") {
  const normalized = String(text).toLowerCase();
  const existingUserSignals = [
    'already registered',
    'registered user',
    'existing user',
    'forgot password',
    'recover credentials',
    'password recovery',
    'user already exists',
  ];

  if (existingUserSignals.some((signal) => normalized.includes(signal))) {
    return 'forgot_password';
  }

  return 'registration';
}

async function fillForgotPasswordUserId(page, pan, jobId) {
  await page.waitForURL(/forgot|password|reset|login|foservices/i, { timeout: 20000 }).catch(() => {});
  await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(3000);
  await debugPortalSnapshot(page, jobId, "before-pan");

  const input = await waitForIdentityInput(page, 20000).catch(async (error) => {
    await debugPortalSnapshot(page, jobId, "identity-input-missing");
    error.code = error.code || "IDENTITY_INPUT_MISSING";
    throw error;
  });

  await fillInputLikeUser(page, input, pan, "PAN/User ID");

  let clicked = await clickEnabledButton(page, [
    'button:has-text("Continue")',
    'button:has-text("Proceed")',
    'button:has-text("Submit")',
    'button[type="submit"]',
  ], 20000);
  if (!clicked) {
    const continueBtn = page.getByRole("button", { name: /continue/i }).first();
    await page.waitForFunction(() => {
      const buttons = [...document.querySelectorAll("button")];
      const button = buttons.find((el) => /continue/i.test(el.innerText || ""));
      return !!button && !button.disabled;
    }, { timeout: 20000 }).catch(() => {});
    clicked = await continueBtn.click({ timeout: 5000 }).then(() => true).catch(() => false);
  }
  await page.waitForTimeout(2500);

  if (!clicked) {
    await debugPortalSnapshot(page, jobId, "continue-not-clicked").catch(() => {});
    const error = new Error("Portal did not enable the User ID Continue button after PAN entry");
    error.code = "CONTINUE_DISABLED";
    throw error;
  }

  if (!/forgot|reset/i.test(page.url())) {
    const clickedForgot = await clickForgotPasswordIfVisible(page, 10000);
    if (clickedForgot) {
      await page.waitForTimeout(1500);
    }
  }

  if (!/forgot|reset/i.test(page.url())) {
    const passwordOrCaptchaVisible = await page
      .locator('input[type="password"]:visible, input[placeholder*="password" i]:visible, [id*="captcha" i]:visible, iframe[src*="captcha"]')
      .first()
      .isVisible({ timeout: 2500 })
      .catch(() => false);
    if (passwordOrCaptchaVisible) {
      const clickedForgot = await clickForgotPasswordIfVisible(page, 12000);
      if (clickedForgot) {
        await page.waitForTimeout(1500);
      }
    }
  }

  if (/login/i.test(page.url()) && !/forgot|reset/i.test(page.url())) {
    const body = await page.innerText("body").catch(() => "");
    if (/enter your user id/i.test(body)) {
      await debugPortalSnapshot(page, jobId, "login-still-on-user-id").catch(() => {});
      const error = new Error("Portal stayed on the login User ID screen after PAN entry");
      error.code = "LOGIN_USER_ID_NOT_ACCEPTED";
      throw error;
    }
  }

  if (/forgot|reset/i.test(page.url())) {
    const panInputVisible = await hasAnyVisible(page, PAN_SELECTORS, 1200);
    if (panInputVisible) {
      const recoveryInput = await waitForAny(page, PAN_SELECTORS, 5000);
      const currentValue = await recoveryInput.inputValue().catch(() => "");
      if (currentValue.trim().toUpperCase() !== String(pan).trim().toUpperCase()) {
        await fillInputLikeUser(page, recoveryInput, pan, "forgot-password PAN/User ID");
        await clickEnabledButton(page, [
          'button:has-text("Continue")',
          'button:has-text("Proceed")',
          'button:has-text("Submit")',
          'button[type="submit"]',
        ], 12000);
        await page.waitForTimeout(2000);
      }
    }
  }
}

async function debugPortalSnapshot(page, jobId, label) {
  const url = page.url();
  const body = await page.locator("body").innerText().catch(() => "");
  const snippet = body.replace(/\s+/g, " ").trim().slice(0, 1000);

  console.log(`[automation:${jobId}] ${label}`);
  console.log(`URL => ${url}`);
  console.log(`BODY => ${snippet}`);

  const debugDir = path.join(__dirname, "..", "..", "debug", jobId);
  fs.mkdirSync(debugDir, { recursive: true });
  const screenshotPath = path.join(debugDir, `${label}-${Date.now()}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true }).catch((error) => {
    console.error(`[automation:${jobId}] screenshot failed: ${error.message}`);
  });
  console.log(`SCREENSHOT => ${screenshotPath}`);

  return { url, snippet, screenshotPath };
}

async function detectPortalError(page) {
  const text = (await page.innerText("body").catch(() => "")).toLowerCase();
  if (/invalid captcha|incorrect captcha|captcha expired|captcha does not match/.test(text)) {
    return { code: "INVALID_CAPTCHA", message: "Portal rejected CAPTCHA — solve it again in the browser window" };
  }
  if (/session expired|session timed out|please login again/.test(text)) {
    return { code: "SESSION_EXPIRED", message: "Portal session expired — cancel and start a new run" };
  }
  if (/invalid pan|user id does not exist|not registered/.test(text)) {
    return { code: "PAN_NOT_REGISTERED", message: "PAN is not registered on the Income Tax portal" };
  }
  return null;
}

async function hasVisibleOtpInput(page, otpSelectors) {
  for (const selector of otpSelectors) {
    if (await page.locator(selector).first().isVisible({ timeout: 300 }).catch(() => false)) {
      return true;
    }
  }

  const singleDigitInputs = page.locator('input[maxlength="1"]:visible, input[size="1"]:visible');
  const digitBoxCount = await singleDigitInputs.count().catch(() => 0);
  if (digitBoxCount >= 4) {
    return true;
  }

  if (
    await page
      .locator('input[placeholder*="OTP" i]:visible, input[aria-label*="OTP" i]:visible, input[name*="otp" i]:visible')
      .first()
      .isVisible({ timeout: 300 })
      .catch(() => false)
  ) {
    return true;
  }

  const body = await page.innerText("body").catch(() => "");
  if (/enter\s+(the\s+)?otp|validate\s+otp|otp\s+has\s+been\s+sent|otp\s+sent\s+to/i.test(body)) {
    const visibleInputs = await page.locator("input:visible").count().catch(() => 0);
    return visibleInputs > 0;
  }

  return false;
}

async function detectCaptchaPresent(page) {
  return page.evaluate(() => {
    const text = (document.body?.innerText || "").toLowerCase();
    const hasCaptchaText = /captcha|security code|verify you are human|i.?m not a robot/.test(text);
    const hasCaptchaWidget = !!document.querySelector(
      'iframe[src*="recaptcha"], iframe[src*="captcha"], .g-recaptcha, [id*="captcha" i]'
    );
    return hasCaptchaText && hasCaptchaWidget;
  }).catch(() => false);
}

async function detectRecoveryStage(page, otpSelectors, passwordSelector) {
  const body = await page.innerText("body").catch(() => "");
  if (/login/i.test(body) && /enter your user id/i.test(body) && /other ways to access your account/i.test(body)) {
    return "login_user_id";
  }
  if (await hasVisibleOtpInput(page, otpSelectors)) return "otp";
  if (await isPasswordResetPage(page, passwordSelector)) return "password";
  if (await detectCaptchaPresent(page)) return "captcha";
  return "form";
}

async function navigateToForgotPassword(page, emit, jobId) {
  await safeGoto(page, EPORTAL_SERVICES_URL);
  await page.waitForTimeout(1500);

  const loginBtn = page.locator('button:has-text("Login")').first();
  if (await loginBtn.isVisible({ timeout: 15000 }).catch(() => false)) {
    await loginBtn.click({ timeout: 8000 });
    await page.waitForTimeout(2500);
  }

  if (!(await hasAnyVisible(page, PAN_SELECTORS, 15000))) {
    await emit(
      jobId,
      PHASES.OPEN_PORTAL,
      "Opening login User ID route",
      "open_login",
      { metadata: { url: LOGIN_URL } }
    );
    await safeGoto(page, LOGIN_URL);
    await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(3000);
  }

  if (!(await hasAnyVisible(page, PAN_SELECTORS, 15000))) {
    await debugPortalSnapshot(page, jobId, "identity-route-no-input");
    const error = new Error("Login page did not show the PAN/User ID input; cannot start recovery flow");
    error.code = "LOGIN_INPUT_MISSING";
    throw error;
  }
}

async function hasOtpInput(page, otpSelectors) {
  return hasVisibleOtpInput(page, otpSelectors);
}

async function submitRecoveryDetailsAfterCaptcha(page, otpSelectors, passwordSelector, ctx) {
  const { jobId, emit, takeCaptchaContinue, assertNotCancelled } = ctx;
  const submitSelectors = [
    'button:has-text("Generate Aadhaar OTP")',
    'button:has-text("Generate OTP")',
    'button:has-text("Send OTP")',
    'button:has-text("Validate")',
    'button:has-text("Continue")',
    'button:has-text("Proceed")',
    'button:has-text("Submit")',
    'button[type="submit"]',
  ];
  const deadline = Date.now() + 12 * 60 * 1000;
  let manualNotified = false;
  let captchaCleared = false;
  let lastProgressAt = 0;

  async function markCaptchaCleared(message) {
    if (captchaCleared) return;
    captchaCleared = true;
    await emit(jobId, PHASES.CAPTCHA_SOLVED, message, "captcha_solved");
    await emit(
      jobId,
      PHASES.OTP_REQUIRED,
      "Recovery form active — bot is selecting OTP channel and requesting OTP",
      "otp_channel_setup"
    );
  }

  while (Date.now() < deadline) {
    assertNotCancelled(jobId);

    const portalError = await detectPortalError(page);
    if (portalError) {
      captchaCleared = false;
      await debugPortalSnapshot(page, jobId, "portal-error");
      await emit(jobId, PHASES.CAPTCHA_REQUIRED, portalError.message, "portal_error", {
        level: "warn",
        error: portalError,
      });
      if (portalError.code === "PAN_NOT_REGISTERED") {
        const error = new Error(portalError.message);
        error.code = portalError.code;
        throw error;
      }
    }

    const stage = await detectRecoveryStage(page, otpSelectors, passwordSelector);
    if (stage === "login_user_id") {
      await debugPortalSnapshot(page, jobId, "login-page-not-recovery");
      const error = new Error("Portal is on the login User ID page, not the forgot-password recovery form");
      error.code = "LOGIN_PAGE_NOT_RECOVERY";
      throw error;
    }
    if (stage === "otp" || stage === "password") {
      await markCaptchaCleared(
        stage === "password"
          ? "Portal challenge cleared; password reset screen reached"
          : "Portal challenge cleared; OTP input detected on portal"
      );
      return stage;
    }

    if (stage === "captcha") {
      if (!manualNotified) {
        manualNotified = true;
        await emit(
          jobId,
          PHASES.CAPTCHA_REQUIRED,
          "CAPTCHA detected in browser. Solve it, then click Continue in dashboard.",
          "captcha_manual_required",
          { level: "warn" }
        );
      }
    } else if (!captchaCleared) {
      await markCaptchaCleared("Portal challenge cleared; completing recovery form");
    }

    await selectOtpChannel(page, 1200);
    await clickAnyCheckbox(page, 1200);
    const handledAadhaarConsent = await handleAadhaarConsentAndGenerateOtp(page, otpSelectors, passwordSelector, jobId, 2500);
    if (handledAadhaarConsent) {
      const afterConsent = await detectRecoveryStage(page, otpSelectors, passwordSelector);
      if (afterConsent === "otp" || afterConsent === "password") {
        await markCaptchaCleared("OTP requested successfully from portal");
        return afterConsent;
      }
    }

    const clicked = await clickEnabledButton(page, submitSelectors, 2000);
    if (clicked) {
      await page.waitForTimeout(2000);
      const bodyAfterClick = await page.locator("body").innerText().catch(() => "");
      console.log(`[automation:${jobId}] after OTP channel Continue => ${bodyAfterClick.replace(/\s+/g, " ").trim().slice(0, 500)}`);
      const afterClick = await detectRecoveryStage(page, otpSelectors, passwordSelector);
      if (afterClick === "otp" || afterClick === "password") {
        await markCaptchaCleared("OTP requested successfully from portal");
        return afterClick;
      }
    }

    const now = Date.now();
    if (now - lastProgressAt > 12000) {
      lastProgressAt = now;
      if (stage === "captcha") {
        await emit(
          jobId,
          PHASES.CAPTCHA_REQUIRED,
          "Still on CAPTCHA — solve in browser, then click Continue once in dashboard",
          "captcha_waiting",
          { level: "warn" }
        );
      } else {
        const snapshot = await debugPortalSnapshot(page, jobId, "recovery-progress");
        await emit(
          jobId,
          PHASES.OTP_REQUIRED,
          "Requesting OTP from portal — check browser if channel selection is needed",
          "recovery_form_progress",
          {
            level: "info",
            metadata: { url: snapshot.url, pageHint: snapshot.snippet.slice(0, 200) },
          }
        );
      }
    }

    if (takeCaptchaContinue()) {
      await markCaptchaCleared("Operator confirmed CAPTCHA solved");
      await emit(
        jobId,
        PHASES.OTP_REQUIRED,
        "Operator confirmed; submitting recovery form to request OTP",
        "captcha_operator_continue",
        { level: "info" }
      );
      await selectOtpChannel(page, 2000);
      await clickAnyCheckbox(page, 2000);
      await handleAadhaarConsentAndGenerateOtp(page, otpSelectors, passwordSelector, jobId, 5000);
      await clickEnabledButton(page, submitSelectors, 8000);
      await page.waitForTimeout(2500);
      await debugPortalSnapshot(page, jobId, "after-continue");
      const afterContinue = await detectRecoveryStage(page, otpSelectors, passwordSelector);
      if (afterContinue === "otp" || afterContinue === "password") {
        return afterContinue;
      }
    }

    await delay(1200);
  }

  await debugPortalSnapshot(page, jobId, "recovery-timeout");
  const error = new Error("Recovery form was not completed within 12 minutes");
  error.code = "OPERATOR_TIMEOUT";
  throw error;
}

// ─── Main automation ───────────────────────────────────────────────────────────
async function runPlaywrightAutomation({
  jobId,
  pan,
  emit,
  waitForOtp,
  takeCaptchaContinue,
  assertNotCancelled,
  completeWithGeneratedCredentials,
}) {
  const { chromium } = loadPlaywright();

  const browser = await chromium.launch({
    headless: config.playwrightHeadless,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-popup-blocking",
    ],
  });

  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 900 },
  });

  context.on("dialog", (d) => d.dismiss().catch(() => {}));

  const page = await context.newPage();

  const PASSWORD_SELECTORS = [
    'input[formcontrolname="password"]',
    'input[formcontrolname="newPassword"]',
    'input[formcontrolname="newPwd"]',
    'input[formcontrolname="confirmPassword"]',
    'input[id="password"]',
    'input[type="password"]:not(.otp-input)',
  ];
  const OTP_SELECTORS = [
    "input.otp-input",
    'input[autocomplete="one-time-code"]',
    'input[id^="otp_"]',
    'input[formcontrolname*="otp" i]',
    'input[placeholder*="OTP" i]',
    'input[name*="otp" i]',
    'input[maxlength="1"]',
  ];
  const passwordSelector = PASSWORD_SELECTORS.join(", ");

  try {
    await emit(
      jobId,
      PHASES.OPEN_PORTAL,
      "Opening Income Tax e-Filing portal",
      "open_portal",
      { metadata: { url: EPORTAL_SERVICES_URL } }
    );
    await navigateToForgotPassword(page, emit, jobId);
    assertNotCancelled(jobId);

    await emit(
      jobId,
      PHASES.IDENTITY,
      "Entering PAN on forgot-password flow",
      "identity"
    );
    await fillForgotPasswordUserId(page, pan, jobId);
    assertNotCancelled(jobId);

    await emit(
      jobId,
      PHASES.CAPTCHA_REQUIRED,
      "Selecting OTP channel and submitting recovery form",
      "captcha_required"
    );

    const recoveryStage = await submitRecoveryDetailsAfterCaptcha(
      page,
      OTP_SELECTORS,
      passwordSelector,
      { jobId, emit, takeCaptchaContinue, assertNotCancelled }
    );

    let otpStage = recoveryStage;
    console.log(`[automation:${jobId}] recoveryStage after recovery submit => ${recoveryStage}`);
    if (otpStage !== "password") {
      const requestedFreshOtp = await requestFreshOtpIfOffered(page, jobId, 8000);
      console.log(`[automation:${jobId}] requestFreshOtpIfOffered result => ${requestedFreshOtp}`);
      if (requestedFreshOtp) {
        otpStage = await detectRecoveryStage(page, OTP_SELECTORS, passwordSelector);
        console.log(`[automation:${jobId}] otpStage after fresh OTP request => ${otpStage}`);
      }
    }

    if (otpStage !== "password" && otpStage !== "otp") {
      const handledAadhaarConsent = await handleAadhaarConsentAndGenerateOtp(page, OTP_SELECTORS, passwordSelector, jobId, 8000);
      console.log(`[automation:${jobId}] handleAadhaarConsentAndGenerateOtp result => ${handledAadhaarConsent}`);
      if (handledAadhaarConsent) {
        otpStage = await detectRecoveryStage(page, OTP_SELECTORS, passwordSelector);
        console.log(`[automation:${jobId}] otpStage after Aadhaar consent => ${otpStage}`);
      }
    }

    if (otpStage !== "password") {
      await emit(
        jobId,
        PHASES.OTP_REQUIRED,
        "OTP screen ready — enter OTP from dashboard when received",
        "otp_required"
      );
    }

    let otpSuccess = otpStage === "password";
    let attempts = 0;
    const MAX_ATT = 3;

    while (!otpSuccess && attempts < MAX_ATT) {
      if (await isPasswordResetPage(page, passwordSelector)) {
        await emit(jobId, PHASES.OTP_VERIFIED, "OTP accepted by portal.", "otp_verified");
        otpSuccess = true;
        break;
      }

      await emit(
        jobId,
        PHASES.WAITING_FOR_OTP,
        `Enter OTP from dashboard (attempt ${attempts + 1}/${MAX_ATT})`,
        "waiting_for_otp"
      );

      const otpVal = await waitForOtp(jobId);
      assertNotCancelled(jobId);

      if (await isPasswordResetPage(page, passwordSelector)) {
        await emit(jobId, PHASES.OTP_VERIFIED, "OTP accepted by portal.", "otp_verified");
        otpSuccess = true;
        break;
      }

      await fillOtp(page, otpVal, OTP_SELECTORS);
      await page.waitForTimeout(3000);

      if (await isPasswordResetPage(page, passwordSelector)) {
        await emit(
          jobId,
          PHASES.OTP_VERIFIED,
          `OTP accepted by portal (attempt ${attempts + 1})`,
          "otp_verified"
        );
        otpSuccess = true;
      } else {
        const bodyTxt = await page.innerText("body").catch(() => "");
        if (bodyTxt.includes("Incorrect OTP") || bodyTxt.includes("Invalid OTP") || bodyTxt.includes("does not match")) {
          attempts++;
          if (attempts >= MAX_ATT) {
            throw Object.assign(new Error("Portal rejected OTP: maximum attempts exceeded"), { code: "WRONG_OTP" });
          }
          await emit(
            jobId,
            PHASES.WAITING_FOR_OTP,
            `OTP rejected by portal. ${MAX_ATT - attempts} attempt(s) remaining.`,
            "wrong_otp",
            { level: "warn", metadata: { retryCount: attempts, maxAttempts: MAX_ATT } }
          );
        } else {
          await emit(jobId, PHASES.OTP_VERIFIED, `OTP submitted (attempt ${attempts + 1})`, "otp_submitted");
          otpSuccess = true;
        }
      }
    }

    await emit(
      jobId,
      PHASES.PASSWORD_GENERATED,
      "OTP verified. Setting new password on portal",
      "password_generated"
    );
    const generatedPassword = generatePassword();
    const pwdInputs = page.locator(passwordSelector);
    if (await pwdInputs.first().isVisible({ timeout: 5000 }).catch(() => false)) {
      await fillPasswordLikeUser(page, pwdInputs.first(), generatedPassword);
      if (await pwdInputs.nth(1).isVisible().catch(() => false)) {
        await fillPasswordLikeUser(page, pwdInputs.nth(1), generatedPassword);
      }
      await page.keyboard.press("Tab").catch(() => {});
      await page.waitForTimeout(1000);
      await clickEnabledButton(page, ['button:has-text("Submit")', 'button:has-text("Reset Password")', 'button:has-text("Continue")'], 10000);
      await page.waitForTimeout(3000);
      const afterPasswordSubmit = await page.locator("body").innerText().catch(() => "");
      console.log(`[automation:${jobId}] after password submit => ${afterPasswordSubmit.replace(/\s+/g, " ").trim().slice(0, 1000)}`);
    }

    await completeWithGeneratedCredentials(jobId, generatedPassword);

  } finally {
    await browser.close().catch(() => {});
  }
}

function loadPlaywright() {
  try {
    return require("playwright");
  } catch {
    const error = new Error(
      "Playwright is not installed. Run `npm install` inside the backend directory."
    );
    error.code = "PLAYWRIGHT_NOT_INSTALLED";
    throw error;
  }
}

function generatePassword() {
  return `Rk@${crypto.randomBytes(12).toString("base64url")}9`;
}

module.exports = { runPlaywrightAutomation, detectPortalFlowFromText };
