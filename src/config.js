const fs = require("fs");
const path = require("path");

loadEnvFile(path.join(__dirname, "..", ".env"));

const config = {
  port: Number(process.env.PORT || 4000),
  serviceBaseUrl: process.env.SERVICE_BASE_URL || `http://localhost:${process.env.PORT || 4000}`,
  mongoUri: process.env.MONGO_URI || "mongodb://127.0.0.1:27017/registerkaro_itr",
  authToken: process.env.AUTH_TOKEN || "",
  webhookSecret: process.env.WEBHOOK_SECRET || "",
  portalUrl: process.env.PORTAL_URL || "https://www.incometax.gov.in/iec/foportal/",
  playwrightHeadless: process.env.PLAYWRIGHT_HEADLESS === "true",
};

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const lines = fs.readFileSync(filePath, "utf8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) {
      continue;
    }

    const [key, ...valueParts] = trimmed.split("=");
    if (!process.env[key]) {
      process.env[key] = valueParts.join("=");
    }
  }
}

module.exports = { config };
