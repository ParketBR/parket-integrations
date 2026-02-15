import express from "express";
import helmet from "helmet";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { env } from "./config/env.js";
import { createLogger } from "./config/logger.js";
import { checkDbHealth, closeDb } from "./config/db.js";
import { whatsappRouter } from "./routes/webhook-whatsapp.js";
import { leadRouter } from "./routes/webhook-lead.js";
import { eventsRouter } from "./routes/events.js";

const log = createLogger("main");

const app = express();

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// Rate limiting
app.use(
  rateLimit({
    windowMs: 60_000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "RATE_LIMITED", message: "Too many requests" },
  })
);

// Request logging middleware
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    log.info("HTTP request", {
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration_ms: Date.now() - start,
      correlation_id: req.headers["x-correlation-id"] as string,
    });
  });
  next();
});

// Health check
app.get("/health", async (_req, res) => {
  const dbOk = await checkDbHealth();
  const status = dbOk ? "healthy" : "degraded";
  res.status(dbOk ? 200 : 503).json({
    status,
    service: "parket-control-tower",
    db: dbOk ? "connected" : "disconnected",
    timestamp: new Date().toISOString(),
  });
});

// Routes
app.use("/webhook/whatsapp", whatsappRouter);
app.use("/webhook/lead", leadRouter);
app.use("/events", eventsRouter);

// 404
app.use((_req, res) => {
  res.status(404).json({ error: "NOT_FOUND" });
});

// Error handler
app.use(
  (
    err: Error,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction
  ) => {
    log.error("Unhandled error", {
      error: err.message,
      stack: err.stack,
    });
    res.status(500).json({
      error: "INTERNAL_ERROR",
      message: env.NODE_ENV === "production" ? "Internal server error" : err.message,
    });
  }
);

// Start
const server = app.listen(env.PORT, () => {
  log.info("Parket Control Tower receiver started", {
    port: env.PORT,
    env: env.NODE_ENV,
  });
});

// Graceful shutdown
const shutdown = async (signal: string) => {
  log.info("Shutting down", { signal });
  server.close();
  await closeDb();
  process.exit(0);
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

export { app };
