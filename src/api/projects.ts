import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { createChildLogger } from "../config/logger.js";
import { db } from "../db/connection.js";
import { executeHandoff } from "../services/handoff.js";
import {
  advanceProjectStatus,
  completeChecklistItem,
  calculateQualityScore,
} from "../services/works-management.js";
import {
  createPurchaseOrder,
  updatePurchaseOrderStatus,
  calculateOtifMetrics,
} from "../services/operations-tracking.js";

const log = createChildLogger("api:projects");

export const projectRouter = Router();

// ─── Handoff ───────────────────────────────────────

const handoffSchema = z.object({
  lead_id: z.string().uuid(),
  proposal_id: z.string().uuid().optional(),
  architect_name: z.string().optional(),
  architect_phone: z.string().optional(),
  address: z.string().optional(),
  logistics_notes: z.string().optional(),
  access_hours: z.string().optional(),
  elevator_available: z.boolean().optional(),
  floor_number: z.number().int().optional(),
  site_contact_name: z.string().optional(),
  site_contact_phone: z.string().optional(),
  estimated_delivery_at: z.coerce.date().optional(),
});

projectRouter.post("/handoff", async (req: Request, res: Response) => {
  try {
    const parsed = handoffSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Validation failed", details: parsed.error.issues });
      return;
    }

    const projectId = await executeHandoff(parsed.data);

    const project = await db
      .selectFrom("projects")
      .selectAll()
      .where("id", "=", projectId)
      .executeTakeFirstOrThrow();

    res.status(201).json({ data: project });
  } catch (err) {
    log.error({ err }, "Handoff failed");
    res.status(500).json({ error: "Handoff failed" });
  }
});

// ─── Projects CRUD ─────────────────────────────────

projectRouter.get("/", async (req: Request, res: Response) => {
  try {
    let query = db.selectFrom("projects").selectAll().orderBy("created_at", "desc");

    if (req.query.status) {
      query = query.where("status", "=", req.query.status as string);
    }

    const limit = Math.min(Number(req.query.limit) || 50, 100);
    const projects = await query.limit(limit).execute();

    res.json({ data: projects, count: projects.length });
  } catch (err) {
    log.error({ err }, "Failed to list projects");
    res.status(500).json({ error: "Failed to list projects" });
  }
});

projectRouter.get("/:id", async (req: Request, res: Response) => {
  try {
    const project = await db
      .selectFrom("projects")
      .selectAll()
      .where("id", "=", req.params.id)
      .executeTakeFirst();

    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    // Include checklists and POs
    const [checklists, purchaseOrders, communications] = await Promise.all([
      db
        .selectFrom("project_checklists")
        .selectAll()
        .where("project_id", "=", project.id)
        .orderBy("phase")
        .orderBy("item_order")
        .execute(),
      db
        .selectFrom("purchase_orders")
        .selectAll()
        .where("project_id", "=", project.id)
        .orderBy("created_at", "desc")
        .execute(),
      db
        .selectFrom("project_communications")
        .selectAll()
        .where("project_id", "=", project.id)
        .orderBy("sent_at", "desc")
        .limit(20)
        .execute(),
    ]);

    res.json({
      data: {
        ...project,
        checklists,
        purchase_orders: purchaseOrders,
        recent_communications: communications,
      },
    });
  } catch (err) {
    log.error({ err }, "Failed to get project");
    res.status(500).json({ error: "Failed to get project" });
  }
});

// ─── Status Advance ────────────────────────────────

projectRouter.patch("/:id/advance", async (req: Request, res: Response) => {
  try {
    const newStatus = await advanceProjectStatus(req.params.id);
    res.json({ message: `Project advanced to ${newStatus}`, status: newStatus });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to advance";
    log.error({ err }, "Failed to advance project");
    res.status(400).json({ error: message });
  }
});

// ─── Checklist ─────────────────────────────────────

const checklistCompleteSchema = z.object({
  completed_by: z.string().min(1),
  photo_url: z.string().url().optional(),
  notes: z.string().optional(),
});

projectRouter.patch(
  "/checklists/:itemId/complete",
  async (req: Request, res: Response) => {
    try {
      const parsed = checklistCompleteSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Validation failed", details: parsed.error.issues });
        return;
      }

      await completeChecklistItem(
        req.params.itemId,
        parsed.data.completed_by,
        parsed.data.photo_url,
        parsed.data.notes
      );

      res.json({ message: "Checklist item completed" });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to complete";
      log.error({ err }, "Failed to complete checklist item");
      res.status(400).json({ error: message });
    }
  }
);

// ─── Quality Score ─────────────────────────────────

projectRouter.get("/:id/quality", async (req: Request, res: Response) => {
  try {
    const score = await calculateQualityScore(req.params.id);
    res.json({ project_id: req.params.id, quality_score: score });
  } catch (err) {
    log.error({ err }, "Failed to calculate quality");
    res.status(500).json({ error: "Failed to calculate quality" });
  }
});

// ─── Purchase Orders ───────────────────────────────

const purchaseOrderSchema = z.object({
  project_id: z.string().uuid(),
  supplier: z.string().min(1),
  description: z.string().min(1),
  items: z.array(
    z.object({
      product: z.string().min(1),
      quantity: z.number().positive(),
      unit: z.string().min(1),
      unit_price: z.number().positive(),
    })
  ).min(1),
  estimated_delivery_at: z.coerce.date().optional(),
  notes: z.string().optional(),
});

projectRouter.post("/purchase-orders", async (req: Request, res: Response) => {
  try {
    const parsed = purchaseOrderSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Validation failed", details: parsed.error.issues });
      return;
    }

    const poId = await createPurchaseOrder(parsed.data);

    const po = await db
      .selectFrom("purchase_orders")
      .selectAll()
      .where("id", "=", poId)
      .executeTakeFirstOrThrow();

    res.status(201).json({ data: po });
  } catch (err) {
    log.error({ err }, "Failed to create purchase order");
    res.status(500).json({ error: "Failed to create purchase order" });
  }
});

const poStatusSchema = z.object({
  status: z.enum(["sent", "confirmed", "production", "shipped", "delivered", "cancelled"]),
  tracking_code: z.string().optional(),
  actual_delivery_at: z.coerce.date().optional(),
});

projectRouter.patch(
  "/purchase-orders/:id/status",
  async (req: Request, res: Response) => {
    try {
      const parsed = poStatusSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Validation failed" });
        return;
      }

      await updatePurchaseOrderStatus(req.params.id, parsed.data.status, {
        tracking_code: parsed.data.tracking_code,
        actual_delivery_at: parsed.data.actual_delivery_at,
      });

      res.json({ message: `Purchase order updated to ${parsed.data.status}` });
    } catch (err) {
      log.error({ err }, "Failed to update purchase order");
      res.status(500).json({ error: "Failed to update" });
    }
  }
);

// ─── OTIF Metrics ──────────────────────────────────

projectRouter.get("/metrics/otif", async (req: Request, res: Response) => {
  try {
    const supplier = req.query.supplier as string | undefined;
    const metrics = await calculateOtifMetrics(supplier);
    res.json({ data: metrics });
  } catch (err) {
    log.error({ err }, "Failed to calculate OTIF");
    res.status(500).json({ error: "Failed to calculate metrics" });
  }
});
