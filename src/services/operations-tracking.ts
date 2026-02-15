import { sql } from "kysely";
import { db } from "../db/connection.js";
import { createChildLogger } from "../config/logger.js";
import { sendSlackAlert } from "../connectors/slack/client.js";
import { sendGroupMessage } from "../connectors/whatsapp/client.js";
import type { NewPurchaseOrder } from "../db/schemas/types.js";

const log = createChildLogger("service:operations-tracking");

// ─── Purchase Orders ───────────────────────────────

export interface PurchaseOrderInput {
  project_id: string;
  supplier: string;
  description: string;
  items: Array<{
    product: string;
    quantity: number;
    unit: string;
    unit_price: number;
  }>;
  estimated_delivery_at?: Date;
  notes?: string;
}

export async function createPurchaseOrder(
  input: PurchaseOrderInput
): Promise<string> {
  const totalValue = input.items.reduce(
    (sum, i) => sum + i.quantity * i.unit_price,
    0
  );

  const [po] = await db
    .insertInto("purchase_orders")
    .values({
      project_id: input.project_id,
      supplier: input.supplier,
      description: input.description,
      items: input.items as unknown as Record<string, unknown>[],
      total_value: totalValue,
      status: "draft",
      ordered_at: null,
      estimated_delivery_at: input.estimated_delivery_at ?? null,
      actual_delivery_at: null,
      delivered_on_time: null,
      tracking_code: null,
      notes: input.notes ?? null,
    })
    .returningAll()
    .execute();

  log.info(
    { poId: po.id, projectId: input.project_id, supplier: input.supplier, totalValue },
    "Purchase order created"
  );

  return po.id;
}

export async function updatePurchaseOrderStatus(
  poId: string,
  status: string,
  extras?: { tracking_code?: string; actual_delivery_at?: Date }
): Promise<void> {
  const po = await db
    .selectFrom("purchase_orders")
    .selectAll()
    .where("id", "=", poId)
    .executeTakeFirstOrThrow();

  const updates: Record<string, unknown> = {
    status,
    updated_at: new Date(),
  };

  if (status === "sent") updates.ordered_at = new Date();
  if (extras?.tracking_code) updates.tracking_code = extras.tracking_code;

  if (status === "delivered") {
    const deliveryDate = extras?.actual_delivery_at ?? new Date();
    updates.actual_delivery_at = deliveryDate;

    // Calculate OTIF
    if (po.estimated_delivery_at) {
      updates.delivered_on_time =
        deliveryDate <= new Date(po.estimated_delivery_at);
    }

    // Update project status if all POs delivered
    await checkAllDelivered(po.project_id);
  }

  await db
    .updateTable("purchase_orders")
    .set(updates)
    .where("id", "=", poId)
    .execute();

  log.info({ poId, status }, "Purchase order status updated");
}

async function checkAllDelivered(projectId: string): Promise<void> {
  const pending = await db
    .selectFrom("purchase_orders")
    .select(db.fn.count("id").as("count"))
    .where("project_id", "=", projectId)
    .where("status", "not in", ["delivered", "cancelled"])
    .executeTakeFirstOrThrow();

  if (Number(pending.count) === 0) {
    // All POs delivered — auto-advance project if in "aguardando_material"
    const project = await db
      .selectFrom("projects")
      .select(["id", "status", "name"])
      .where("id", "=", projectId)
      .executeTakeFirst();

    if (project?.status === "aguardando_material") {
      await db
        .updateTable("projects")
        .set({ status: "agendado", updated_at: new Date() })
        .where("id", "=", projectId)
        .execute();

      log.info({ projectId }, "All materials delivered — project moved to agendado");

      const opsGroup = process.env.WHATSAPP_OPS_GROUP;
      if (opsGroup) {
        try {
          await sendGroupMessage(
            opsGroup,
            `*Material completo!*\n\nProjeto: ${project.name}\nTodos os pedidos entregues.\nProximo passo: agendar instalacao.`
          );
        } catch (err) {
          log.error({ err }, "Failed to notify material completion");
        }
      }
    }
  }
}

// ─── OTIF & Metrics ────────────────────────────────

export interface OtifMetrics {
  totalOrders: number;
  delivered: number;
  onTime: number;
  late: number;
  otifPercentage: number;
  avgLeadTimeDays: number;
}

export async function calculateOtifMetrics(
  supplierFilter?: string
): Promise<OtifMetrics> {
  let query = db
    .selectFrom("purchase_orders")
    .select([
      db.fn.count("id").as("total"),
      sql<number>`COUNT(CASE WHEN status = 'delivered' THEN 1 END)`.as("delivered"),
      sql<number>`COUNT(CASE WHEN delivered_on_time = TRUE THEN 1 END)`.as("on_time"),
      sql<number>`COUNT(CASE WHEN delivered_on_time = FALSE THEN 1 END)`.as("late"),
      sql<number>`AVG(CASE WHEN actual_delivery_at IS NOT NULL AND ordered_at IS NOT NULL THEN EXTRACT(EPOCH FROM (actual_delivery_at - ordered_at)) / 86400 END)`.as("avg_lead_time"),
    ]);

  if (supplierFilter) {
    query = query.where("supplier", "=", supplierFilter);
  }

  const result = await query.executeTakeFirstOrThrow();

  const delivered = Number(result.delivered);
  const onTime = Number(result.on_time);

  return {
    totalOrders: Number(result.total),
    delivered,
    onTime,
    late: Number(result.late),
    otifPercentage: delivered > 0 ? Math.round((onTime / delivered) * 100) : 0,
    avgLeadTimeDays: Math.round(Number(result.avg_lead_time) || 0),
  };
}

/**
 * Detect late purchase orders and send alerts
 */
export async function detectLatePurchaseOrders(): Promise<number> {
  const latePOs = await db
    .selectFrom("purchase_orders")
    .innerJoin("projects", "projects.id", "purchase_orders.project_id")
    .select([
      "purchase_orders.id",
      "purchase_orders.supplier",
      "purchase_orders.description",
      "purchase_orders.estimated_delivery_at",
      "projects.name as project_name",
    ])
    .where("purchase_orders.estimated_delivery_at", "<", new Date())
    .where("purchase_orders.status", "not in", ["delivered", "cancelled"])
    .execute();

  if (latePOs.length === 0) return 0;

  log.warn({ count: latePOs.length }, "Late purchase orders detected");

  const lines = latePOs.map((po) => {
    const daysLate = Math.ceil(
      (Date.now() - new Date(po.estimated_delivery_at!).getTime()) / 86_400_000
    );
    return `- *${po.supplier}* — ${po.description} (${po.project_name}) — ${daysLate}d atrasado`;
  });

  try {
    await sendSlackAlert(
      "warning",
      `${latePOs.length} Pedidos Atrasados`,
      lines.join("\n")
    );
  } catch (err) {
    log.error({ err }, "Failed to send late PO alert");
  }

  return latePOs.length;
}
