const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const { config } = require("./config");
const { jobsRouter } = require("./routes/jobs");
const { webhookRouter } = require("./routes/webhook");
const { metricsRouter } = require("./routes/metrics");
const { requestContext } = require("./middleware/requestContext");

const app = express();
let httpServer;

mongoose.set("bufferCommands", false);

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(requestContext);

app.get("/health", (_req, res) => {
  res.json({ ok: true, mongo: mongoose.connection.readyState === 1 ? "connected" : "disconnected" });
});

app.use(requireMongoReady);
app.use("/jobs", jobsRouter);
app.use("/webhook", webhookRouter);
app.use("/metrics", metricsRouter);

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(error.statusCode || 500).json({
    error: error.statusCode ? error.message : "Internal server error",
  });
});

async function main() {
  await connectMongo();
  httpServer = app.listen(config.port, () => {
    console.log(`service listening on http://localhost:${config.port}`);
  });
  setupShutdownHandlers();
}

main().catch((error) => {
  if (error.name === "MongooseServerSelectionError") {
    console.error(`failed to connect MongoDB at ${config.mongoUri}`);
    console.error("Start MongoDB locally, or set MONGO_URI to a reachable MongoDB/Atlas URI.");
    console.error("Local macOS option: brew services start mongodb-community");
  } else {
    console.error("failed to start service", error);
  }
  process.exit(1);
});

async function connectMongo() {
  await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 5000 });
}

function requireMongoReady(_req, res, next) {
  if (mongoose.connection.readyState === 1) {
    return next();
  }

  return res.status(503).json({
    error: "MongoDB is not connected. Check MONGO_URI, network access, and Atlas IP allowlist.",
  });
}

function setupShutdownHandlers() {
  const signals = ["SIGINT", "SIGTERM"];

  for (const signal of signals) {
    process.on(signal, async () => {
      try {
        if (httpServer) {
          await new Promise((resolve) => httpServer.close(resolve));
        }
        await mongoose.connection.close();
      } catch (error) {
        console.error("shutdown failed", error);
      } finally {
        process.exit(0);
      }
    });
  }
}
