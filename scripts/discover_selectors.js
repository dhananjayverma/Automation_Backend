/**
 * Selector Discovery Script
 * Run: node scripts/discover_selectors.js
 * 
 * Opens the IT portal in a headed browser, waits for Angular to render,
 * then logs EVERY input/button found with its id, name, placeholder,
 * formcontrolname, type, and a full XPath so you know exactly what to target.
 */

const { chromium } = require("playwright");

(async () => {
  console.log("\n🔍 Opening Income Tax portal in headed browser...\n");

  const browser = await chromium.launch({
    headless: false, // Must be visible so Angular loads fully
    args: ["--disable-blink-features=AutomationControlled", "--no-sandbox"],
  });

  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 900 },
  });

  const page = await context.newPage();

  await page.goto(
    "https://eportal.incometax.gov.in/iec/foservices/#/pre-login/register",
    { waitUntil: "domcontentloaded", timeout: 60000 }
  );

  console.log("⏳ Waiting up to 30s for Angular app to fully render inputs...");

  // Wait until at least one input is visible in the DOM
  await page
    .waitForFunction(() => document.querySelectorAll("input").length > 0, {
      timeout: 30000,
    })
    .catch(() => {
      console.log("⚠️  No inputs found within 30s. Angular may still be loading.");
    });

  // Extra delay to let Angular finish rendering
  await page.waitForTimeout(3000);

  const inputs = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll("input, textarea, select"));
    return all.map((el, idx) => ({
      index: idx,
      tagName: el.tagName.toLowerCase(),
      id: el.id || "",
      name: el.getAttribute("name") || "",
      type: el.getAttribute("type") || "",
      placeholder: el.getAttribute("placeholder") || "",
      formcontrolname: el.getAttribute("formcontrolname") || "",
      ngModel: el.getAttribute("ng-model") || "",
      class: el.className || "",
      visible: el.offsetParent !== null,
      outerHTML: el.outerHTML.slice(0, 300),
    }));
  });

  const buttons = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll("button, [role='button']"));
    return all.map((el, idx) => ({
      index: idx,
      tagName: el.tagName.toLowerCase(),
      id: el.id || "",
      text: (el.textContent || "").trim().slice(0, 80),
      class: el.className || "",
      type: el.getAttribute("type") || "",
      visible: el.offsetParent !== null,
    }));
  });

  console.log("\n═══════════════════════════════════════");
  console.log(`📋 Found ${inputs.length} input elements:`);
  console.log("═══════════════════════════════════════\n");

  inputs.forEach((el) => {
    const markers = [
      el.id && `id="${el.id}"`,
      el.name && `name="${el.name}"`,
      el.type && `type="${el.type}"`,
      el.placeholder && `placeholder="${el.placeholder}"`,
      el.formcontrolname && `formcontrolname="${el.formcontrolname}"`,
    ]
      .filter(Boolean)
      .join("  ");

    console.log(`[${el.index}] <${el.tagName}> ${markers}`);
    console.log(`     visible=${el.visible}  class="${el.class.slice(0, 60)}"`);
    console.log(`     HTML: ${el.outerHTML.slice(0, 150)}`);
    console.log("");
  });

  console.log("\n═══════════════════════════════════════");
  console.log(`🔘 Found ${buttons.length} button elements:`);
  console.log("═══════════════════════════════════════\n");

  buttons.forEach((btn) => {
    console.log(
      `[${btn.index}] <${btn.tagName}> text="${btn.text}"  id="${btn.id}"  type="${btn.type}"  visible=${btn.visible}`
    );
  });

  console.log(
    "\n✅ Done. Copy the selectors above into config or playwrightPortalRunner.js"
  );
  console.log("   Browser will stay open for 30 seconds so you can inspect manually.\n");

  await page.waitForTimeout(30000);
  await browser.close();
})();
