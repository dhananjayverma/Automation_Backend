/**
 * Click-through discovery: Homepage → Login → Forgot Password
 * Run: node scripts/discover_forgot_password.js
 */
const { chromium } = require("playwright");

(async () => {
  let browser;
  try {
    browser = await chromium.launch({ headless: false, args: ["--disable-blink-features=AutomationControlled", "--no-sandbox", "--disable-popup-blocking"] });
    const context = await browser.newContext({
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      viewport: { width: 1280, height: 900 },
    });

    // Dismiss any dialog automatically
    context.on("dialog", async (dialog) => { await dialog.dismiss().catch(() => {}); });

    const page = await context.newPage();
    page.setDefaultTimeout(15000);

    // ── 1. Load homepage ────────────────────────────────────────────────────
    console.log("\n[1] Opening homepage…");
    await page.goto("https://eportal.incometax.gov.in/iec/foservices/", { waitUntil: "domcontentloaded", timeout: 60000 });
    
    // Wait for at least navbar buttons to appear (Angular ready)
    try {
      await page.waitForSelector('button:has-text("Login")', { timeout: 30000 });
    } catch {
      console.log("    ⚠️ Login button not found in 30s. Current URL:", page.url());
    }
    await page.waitForTimeout(2000);
    console.log("    URL:", page.url());

    // ── 2. Click Login ──────────────────────────────────────────────────────
    console.log("\n[2] Clicking Login…");
    try {
      await page.locator('button:has-text("Login")').first().click();
    } catch (e) {
      console.log("    ⚠️ Could not click Login:", e.message);
    }
    await page.waitForTimeout(3000);
    console.log("    URL:", page.url());

    // ── 3. Dump login form ──────────────────────────────────────────────────
    await dumpPage(page, "AFTER LOGIN CLICK");

    // ── 4. Look for Forgot Password ─────────────────────────────────────────
    console.log("\n[4] Searching for Forgot Password…");
    const trySelectors = [
      'a:has-text("Forgot Password")',
      'a:has-text("Forgot")',
      'button:has-text("Forgot Password")',
      'span:has-text("Forgot Password")',
      'p:has-text("Forgot Password")',
      '[class*="forgot" i]',
      'a[href*="forgot" i]',
    ];
    let clicked = false;
    for (const sel of trySelectors) {
      const vis = await page.locator(sel).first().isVisible({ timeout: 1000 }).catch(() => false);
      console.log(`    ${vis ? "✅" : "❌"} ${sel}`);
      if (vis && !clicked) {
        await page.locator(sel).first().click().catch(e => console.log("    click err:", e.message));
        clicked = true;
        console.log(`    → Clicked`);
        await page.waitForTimeout(3000);
        break;
      }
    }
    console.log("    URL after forgot:", page.url());

    // ── 5. Dump forgot password form ────────────────────────────────────────
    await dumpPage(page, "FORGOT PASSWORD FORM");

    console.log("\n✅ Done. Browser stays open 120s for manual inspection.\n");
    console.log("   If 'Forgot Password' link not visible in browser, manually click it,");
    console.log("   then read the log again with: node scripts/discover_forgot_password.js\n");
    await page.waitForTimeout(120000).catch(() => {});
  } catch (e) {
    console.error("Fatal error:", e.message);
  } finally {
    await browser?.close().catch(() => {});
  }
})();

async function dumpPage(page, label) {
  const url = page.url();
  console.log(`\n${"═".repeat(65)}`);
  console.log(`📄 ${label}`);
  console.log(`   URL: ${url}`);
  console.log("═".repeat(65));

  const data = await page.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll("input, textarea, select")).map((el, i) => ({
      i, tag: el.tagName,
      id: el.id, type: el.type,
      fc: el.getAttribute("formcontrolname"),
      aria: el.getAttribute("aria-label"),
      ph: el.placeholder, title: el.getAttribute("title"),
      maxlen: el.getAttribute("maxlength"),
      cls: el.className.slice(0, 70),
      visible: el.offsetParent !== null,
      html: el.outerHTML.slice(0, 280),
    }));

    const interactive = Array.from(document.querySelectorAll("button, a, [role='button']"))
      .filter(el => el.offsetParent !== null)
      .map((el, i) => ({
        i, tag: el.tagName,
        id: el.id, text: (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 80),
        href: el.getAttribute("href"), cls: el.className.slice(0, 50),
      }));

    return { inputs, interactive };
  });

  console.log(`\n📋 Inputs (${data.inputs.length}):`);
  data.inputs.forEach(el => {
    const attrs = [
      el.id && `id="${el.id}"`, el.type && `type="${el.type}"`,
      el.fc && `formcontrolname="${el.fc}"`, el.aria && `aria-label="${el.aria}"`,
      el.title && `title="${el.title}"`, el.ph && `placeholder="${el.ph}"`,
      el.maxlen && `maxlength="${el.maxlen}"`,
    ].filter(Boolean).join("  ");
    const vis = el.visible ? "✅ VISIBLE" : "❌ hidden";
    console.log(`\n  ${vis} [${el.i}] <${el.tag}> ${attrs}`);
    console.log(`    class: ${el.cls}`);
    console.log(`    html:  ${el.html}`);
  });

  console.log(`\n🔘 Visible interactive (${data.interactive.length}):`);
  data.interactive.slice(0, 35).forEach(b =>
    console.log(`  [${b.i}] <${b.tag}> "${b.text}"  id="${b.id}"  href="${b.href}"`)
  );
}
