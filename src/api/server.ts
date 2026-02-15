import express from "express";
import helmet from "helmet";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { createChildLogger } from "../config/logger.js";
import { healthRouter } from "./health.js";
import { metaWebhookRouter } from "./webhooks/meta.js";
import { googleWebhookRouter } from "./webhooks/google.js";
import { whatsappWebhookRouter } from "./webhooks/whatsapp.js";
import { pipedriveWebhookRouter } from "./webhooks/pipedrive.js";
import { proposalRouter } from "./proposals.js";
import { projectRouter } from "./projects.js";
import { financeRouter } from "./finance.js";
import { intelligenceRouter } from "./intelligence.js";

const log = createChildLogger("server");

export function createServer() {
  const app = express();

  // Security
  app.use(helmet());
  app.use(cors());

  // Rate limiting for webhooks
  const webhookLimiter = rateLimit({
    windowMs: 60_000,
    max: 200,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests" },
  });

  // Body parsing
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: true, limit: "1mb" }));

  // Request logging
  app.use((req, _res, next) => {
    log.debug({ method: req.method, url: req.url }, "Incoming request");
    next();
  });

  // Routes
  app.use("/health", healthRouter);
  app.use("/webhooks/meta", webhookLimiter, metaWebhookRouter);
  app.use("/webhooks/google", webhookLimiter, googleWebhookRouter);
  app.use("/webhooks/whatsapp", webhookLimiter, whatsappWebhookRouter);
  app.use("/webhooks/pipedrive", webhookLimiter, pipedriveWebhookRouter);

  // API routes
  app.use("/api/proposals", proposalRouter);
  app.use("/api/projects", projectRouter);
  app.use("/api/finance", financeRouter);
  app.use("/api/intelligence", intelligenceRouter);

  // 404
  app.use((_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  // Error handler
  app.use(
    (
      err: Error,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction
    ) => {
      log.error({ err }, "Unhandled error");
      res.status(500).json({ error: "Internal server error" });
    }
  );

  return app;
}
