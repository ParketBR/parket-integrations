import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { createChildLogger } from "../config/logger.js";
import {
  generateProposal,
  markProposalSent,
  updateProposalStatus,
} from "../services/proposal-generator.js";
import { db } from "../db/connection.js";

const log = createChildLogger("api:proposals");

export const proposalRouter = Router();

// ─── Validation Schemas ────────────────────────────

const proposalItemSchema = z.object({
  description: z.string().min(1),
  product: z.string().min(1),
  area_m2: z.number().positive(),
  unit_price: z.number().positive(),
  total: z.number().positive(),
});

const createProposalSchema = z.object({
  lead_id: z.string().uuid(),
  project_name: z.string().min(1),
  items: z.array(proposalItemSchema).min(1),
  payment_terms: z.string().optional(),
  validity_days: z.number().int().positive().optional(),
  notes: z.string().optional(),
});

// ─── Routes ────────────────────────────────────────

/**
 * POST /api/proposals — Generate a new proposal
 */
proposalRouter.post("/", async (req: Request, res: Response) => {
  try {
    const parsed = createProposalSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "Validation failed",
        details: parsed.error.issues,
      });
      return;
    }

    const proposalId = await generateProposal(parsed.data);

    const proposal = await db
      .selectFrom("proposals")
      .selectAll()
      .where("id", "=", proposalId)
      .executeTakeFirstOrThrow();

    res.status(201).json({ data: proposal });
  } catch (err) {
    log.error({ err }, "Failed to generate proposal");
    res.status(500).json({ error: "Failed to generate proposal" });
  }
});

/**
 * GET /api/proposals — List proposals with optional filters
 */
proposalRouter.get("/", async (req: Request, res: Response) => {
  try {
    let query = db.selectFrom("proposals").selectAll().orderBy("created_at", "desc");

    if (req.query.lead_id) {
      query = query.where("lead_id", "=", req.query.lead_id as string);
    }
    if (req.query.status) {
      query = query.where("status", "=", req.query.status as any);
    }

    const limit = Math.min(Number(req.query.limit) || 50, 100);
    const proposals = await query.limit(limit).execute();

    res.json({ data: proposals, count: proposals.length });
  } catch (err) {
    log.error({ err }, "Failed to list proposals");
    res.status(500).json({ error: "Failed to list proposals" });
  }
});

/**
 * GET /api/proposals/:id — Get a single proposal
 */
proposalRouter.get("/:id", async (req: Request, res: Response) => {
  try {
    const proposal = await db
      .selectFrom("proposals")
      .selectAll()
      .where("id", "=", req.params.id)
      .executeTakeFirst();

    if (!proposal) {
      res.status(404).json({ error: "Proposal not found" });
      return;
    }

    res.json({ data: proposal });
  } catch (err) {
    log.error({ err }, "Failed to get proposal");
    res.status(500).json({ error: "Failed to get proposal" });
  }
});

/**
 * PATCH /api/proposals/:id/send — Mark proposal as sent
 */
proposalRouter.patch("/:id/send", async (req: Request, res: Response) => {
  try {
    await markProposalSent(req.params.id);
    res.json({ message: "Proposal marked as sent" });
  } catch (err) {
    log.error({ err }, "Failed to mark proposal as sent");
    res.status(500).json({ error: "Failed to update proposal" });
  }
});

/**
 * PATCH /api/proposals/:id/status — Update proposal status
 */
proposalRouter.patch("/:id/status", async (req: Request, res: Response) => {
  try {
    const schema = z.object({
      status: z.enum(["viewed", "accepted", "rejected"]),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid status" });
      return;
    }

    await updateProposalStatus(req.params.id, parsed.data.status);
    res.json({ message: `Proposal marked as ${parsed.data.status}` });
  } catch (err) {
    log.error({ err }, "Failed to update proposal status");
    res.status(500).json({ error: "Failed to update proposal" });
  }
});
