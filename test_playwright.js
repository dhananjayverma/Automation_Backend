const { chromium } = require("playwright");

async function run() {
  console.log("Launching browser...");
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
  });
  const page = await context.newPage();
  
  try {
    console.log("Navigating to Income Tax Register page...");
    await page.goto("https://eportal.incometax.gov.in/iec/foservices/#/pre-login/register", {
      waitUntil: "domcontentloaded",
      timeout: 30000
    });
    
    console.log("Current URL:", page.url());
    console.log("Page Title:", await page.title());
    
    // Check if PAN input is visible
    const panInput = page.locator('input[id="panNumber"]');
    const isVisible = await panInput.isVisible().catch(() => false);
    console.log("PAN Input (id=panNumber) visible:", isVisible);
    
    const panControlInput = page.locator('input[formcontrolname="panNumber"]');
    const isControlVisible = await panControlInput.isVisible().catch(() => false);
    console.log("PAN Input (formcontrolname=panNumber) visible:", isControlVisible);
    
    // Get all input fields on the page to inspect
    const inputs = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('input')).map(el => ({
        id: el.id,
        name: el.name,
        type: el.type,
        placeholder: el.placeholder,
        className: el.className,
        formControlName: el.getAttribute('formcontrolname')
      }));
    });
    console.log("Inputs found on page:", inputs);
    
  } catch (err) {
    console.error("Error occurred:", err);
  } finally {
    await browser.close();
  }
}

run();
