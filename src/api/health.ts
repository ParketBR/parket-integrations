import { Router } from "express";
import { checkDbHealth } from "../db/connection.js";
import { checkRedisHealth } from "../config/queue.js";

export const healthRouter = Router();

healthRouter.get("/", async (_req, res) => {
  const [dbOk, redisOk] = await Promise.all([
    checkDbHealth(),
    checkRedisHealth(),
  ]);

  const status = dbOk && redisOk ? "healthy" : "degraded";

  res.status(status === "healthy" ? 200 : 503).json({
    status,
    timestamp: new Date().toISOString(),
    services: {
      database: dbOk ? "up" : "down",
      redis: redisOk ? "up" : "down",
    },
  });
});
