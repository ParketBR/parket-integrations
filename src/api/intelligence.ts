import { Router, Request, Response } from "express";
import { createChildLogger } from "../config/logger.js";
import {
  sendNpsSurvey,
  calculateNpsMetrics,
  registerIncident,
  resolveIncident,
  generateReworkMatrix,
  evaluateGoNoGo,
  type QualityIncident,
} from "../services/quality-tracking.js";
import {
  createExperiment,
  recordMeasurement,
  evaluateExperiment,
  closeExperiment,
  getExperimentScoreboard,
  type ExperimentInput,
} from "../services/growth-experiments.js";
import {
  addProspect,
  logConnection,
  convertProspectToLead,
  getProspectPipeline,
  getStaleProspects,
  type ProspectInput,
  type ConnectionLog,
} from "../services/market-intelligence.js";
import { generateWeeklyDigest, runAlertRules } from "../services/weekly-digest.js";
import { db } from "../db/connection.js";

const log = createChildLogger("api:intelligence");

export const intelligenceRouter = Router();

// ─── NPS & Quality ──────────────────────────────────

intelligenceRouter.post("/nps/send/:projectId", async (req: Request, res: Response) => {
  try {
    const sent = await sendNpsSurvey(req.params.projectId);
    res.json({ surveys_sent: sent });
  } catch (err) {
    log.error({ err }, "Failed to send NPS");
    res.status(500).json({ error: "Internal error" });
  }
});

intelligenceRouter.get("/nps/metrics", async (req: Request, res: Response) => {
  try {
    const days = Number(req.query.days ?? 90);
    const metrics = await calculateNpsMetrics(days);
    res.json(metrics);
  } catch (err) {
    log.error({ err }, "Failed to get NPS metrics");
    res.status(500).json({ error: "Internal error" });
  }
});

intelligenceRouter.post("/quality/incidents", async (req: Request, res: Response) => {
  try {
    const incident: QualityIncident = req.body;
    const id = await registerIncident(incident);
    res.status(201).json({ id });
  } catch (err) {
    log.error({ err }, "Failed to register incident");
    res.status(500).json({ error: "Internal error" });
  }
});

intelligenceRouter.patch("/quality/incidents/:id/resolve", async (req: Request, res: Response) => {
  try {
    const { resolution, actual_cost } = req.body;
    await resolveIncident(req.params.id, resolution, actual_cost ?? 0);
    res.json({ status: "resolved" });
  } catch (err) {
    log.error({ err }, "Failed to resolve incident");
    res.status(500).json({ error: "Internal error" });
  }
});

intelligenceRouter.get("/quality/rework-matrix", async (_req: Request, res: Response) => {
  try {
    const matrix = await generateReworkMatrix();
    res.json({ data: matrix });
  } catch (err) {
    log.error({ err }, "Failed to generate rework matrix");
    res.status(500).json({ error: "Internal error" });
  }
});

intelligenceRouter.get("/quality/go-no-go/:projectId", async (req: Request, res: Response) => {
  try {
    const result = await evaluateGoNoGo(req.params.projectId);
    res.json(result);
  } catch (err) {
    log.error({ err }, "Failed to evaluate go/no-go");
    res.status(500).json({ error: "Internal error" });
  }
});

// ─── Growth Experiments ─────────────────────────────

intelligenceRouter.post("/experiments", async (req: Request, res: Response) => {
  try {
    const input: ExperimentInput = req.body;
    const id = await createExperiment(input);
    res.status(201).json({ id });
  } catch (err) {
    log.error({ err }, "Failed to create experiment");
    res.status(500).json({ error: "Internal error" });
  }
});

intelligenceRouter.post("/experiments/:id/measure", async (req: Request, res: Response) => {
  try {
    const { group, metric, value, sample_size } = req.body;
    await recordMeasurement(req.params.id, group, metric, value, sample_size);
    res.json({ status: "recorded" });
  } catch (err) {
    log.error({ err }, "Failed to record measurement");
    res.status(500).json({ error: "Internal error" });
  }
});

intelligenceRouter.get("/experiments/:id/evaluate", async (req: Request, res: Response) => {
  try {
    const result = await evaluateExperiment(req.params.id);
    res.json(result);
  } catch (err) {
    log.error({ err }, "Failed to evaluate experiment");
    res.status(500).json({ error: "Internal error" });
  }
});

intelligenceRouter.post("/experiments/:id/close", async (req: Request, res: Response) => {
  try {
    const { verdict, learnings } = req.body;
    await closeExperiment(req.params.id, verdict, learnings);
    res.json({ status: "closed" });
  } catch (err) {
    log.error({ err }, "Failed to close experiment");
    res.status(500).json({ error: "Internal error" });
  }
});

intelligenceRouter.get("/experiments/scoreboard", async (_req: Request, res: Response) => {
  try {
    const scoreboard = await getExperimentScoreboard();
    res.json(scoreboard);
  } catch (err) {
    log.error({ err }, "Failed to get experiment scoreboard");
    res.status(500).json({ error: "Internal error" });
  }
});

// ─── Market Intelligence ────────────────────────────

intelligenceRouter.post("/prospects", async (req: Request, res: Response) => {
  try {
    const input: ProspectInput = req.body;
    const id = await addProspect(input);
    res.status(201).json({ id });
  } catch (err) {
    log.error({ err }, "Failed to add prospect");
    res.status(500).json({ error: "Internal error" });
  }
});

intelligenceRouter.get("/prospects", async (req: Request, res: Response) => {
  try {
    const { region, tier, type, status, limit = "50" } = req.query;

    let query = db
      .selectFrom("prospects")
      .selectAll()
      .orderBy("relationship_score", "desc")
      .limit(Number(limit));

    if (region) query = query.where("region", "=", region as string);
    if (tier) query = query.where("tier", "=", tier as any);
    if (type) query = query.where("type", "=", type as any);
    if (status) query = query.where("status", "=", status as any);

    const prospects = await query.execute();
    res.json({ data: prospects, count: prospects.length });
  } catch (err) {
    log.error({ err }, "Failed to list prospects");
    res.status(500).json({ error: "Internal error" });
  }
});

intelligenceRouter.post("/prospects/:id/connect", async (req: Request, res: Response) => {
  try {
    const input: Omit<ConnectionLog, "prospect_id"> = req.body;
    await logConnection({ ...input, prospect_id: req.params.id });
    res.json({ status: "logged" });
  } catch (err) {
    log.error({ err }, "Failed to log connection");
    res.status(500).json({ error: "Internal error" });
  }
});

intelligenceRouter.post("/prospects/:id/convert", async (req: Request, res: Response) => {
  try {
    const { funnel } = req.body;
    const leadId = await convertProspectToLead(req.params.id, funnel);
    if (leadId) {
      res.json({ status: "converted", lead_id: leadId });
    } else {
      res.status(400).json({ error: "Cannot convert prospect (missing phone?)" });
    }
  } catch (err) {
    log.error({ err }, "Failed to convert prospect");
    res.status(500).json({ error: "Internal error" });
  }
});

intelligenceRouter.get("/prospects/pipeline", async (_req: Request, res: Response) => {
  try {
    const pipeline = await getProspectPipeline();
    res.json(pipeline);
  } catch (err) {
    log.error({ err }, "Failed to get prospect pipeline");
    res.status(500).json({ error: "Internal error" });
  }
});

intelligenceRouter.get("/prospects/stale", async (req: Request, res: Response) => {
  try {
    const days = Number(req.query.days ?? 14);
    const stale = await getStaleProspects(days);
    res.json({ data: stale, count: stale.length });
  } catch (err) {
    log.error({ err }, "Failed to get stale prospects");
    res.status(500).json({ error: "Internal error" });
  }
});

// ─── Digest & Alerts ────────────────────────────────

intelligenceRouter.post("/digest/send", async (_req: Request, res: Response) => {
  try {
    const digest = await generateWeeklyDigest();
    res.json({ status: "sent", preview: digest.substring(0, 500) + "..." });
  } catch (err) {
    log.error({ err }, "Failed to send digest");
    res.status(500).json({ error: "Internal error" });
  }
});

intelligenceRouter.post("/alerts/check", async (_req: Request, res: Response) => {
  try {
    const triggered = await runAlertRules();
    res.json({ triggered_count: triggered.length, alerts: triggered });
  } catch (err) {
    log.error({ err }, "Failed to check alerts");
    res.status(500).json({ error: "Internal error" });
  }
});
