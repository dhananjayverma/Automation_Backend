const { config } = require("../config");

function requireBearer(req, res, next) {
  if (!config.authToken) {
    return next();
  }

  const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  if (token !== config.authToken) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  next();
}

function requireWebhookSecret(req, res, next) {
  if (!config.webhookSecret) {
    return next();
  }

  if (req.headers["x-webhook-secret"] !== config.webhookSecret) {
    return res.status(401).json({ error: "Invalid webhook secret" });
  }

  next();
}

module.exports = { requireBearer, requireWebhookSecret };
