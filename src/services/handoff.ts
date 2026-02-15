import { db } from "../db/connection.js";
import { createChildLogger } from "../config/logger.js";
import { sendGroupMessage } from "../connectors/whatsapp/client.js";
import { sendSlackAlert } from "../connectors/slack/client.js";
import { startSla } from "./sla-monitor.js";
import { generateChecklists } from "./works-management.js";
import { sendProjectUpdate } from "./project-communications.js";
import type { Lead, Proposal } from "../db/schemas/types.js";

const log = createChildLogger("service:handoff");

interface HandoffInput {
  lead_id: string;
  proposal_id?: string;
  architect_name?: string;
  architect_phone?: string;
  address?: string;
  logistics_notes?: string;
  access_hours?: string;
  elevator_available?: boolean;
  floor_number?: number;
  site_contact_name?: string;
  site_contact_phone?: string;
  estimated_delivery_at?: Date;
}

/**
 * Execute the full handoff from Commercial to Obras.
 *
 * 1. Validate lead + proposal
 * 2. Create project record
 * 3. Generate phase checklists
 * 4. Start handoff SLA (24h)
 * 5. Notify obras team (WhatsApp + Slack)
 * 6. Send confirmation to client
 * 7. Update lead stage to "fechado"
 */
export async function executeHandoff(input: HandoffInput): Promise<string> {
  log.info({ leadId: input.lead_id }, "Starting handoff process");

  // 1. Load lead
  const lead = await db
    .selectFrom("leads")
    .selectAll()
    .where("id", "=", input.lead_id)
    .executeTakeFirstOrThrow();

  // Load proposal if provided
  let proposal: Proposal | undefined;
  if (input.proposal_id) {
    proposal = await db
      .selectFrom("proposals")
      .selectAll()
      .where("id", "=", input.proposal_id)
      .executeTakeFirst() ?? undefined;
  }

  // 2. Create project
  const [project] = await db
    .insertInto("projects")
    .values({
      lead_id: lead.id,
      proposal_id: input.proposal_id ?? null,
      pipedrive_deal_id: lead.pipedrive_deal_id,
      name: `${lead.name} — ${lead.location ?? "Projeto"}`,
      client_name: lead.name,
      client_phone: lead.phone,
      architect_name: input.architect_name ?? null,
      architect_phone: input.architect_phone ?? null,
      location: lead.location ?? "A definir",
      address: input.address ?? null,
      project_type: (lead.project_type as "residential" | "commercial" | "corporate") ?? "residential",
      products: proposal?.items ?? ([] as Record<string, unknown>[]),
      total_area_m2: proposal?.items
        ? (proposal.items as unknown as Array<{ area_m2?: number }>).reduce(
            (sum, i) => sum + (i.area_m2 ?? 0),
            0
          )
        : 0,
      contract_value: proposal?.total_value ?? lead.estimated_ticket ?? 0,
      status: "handoff",
      contract_signed_at: new Date(),
      estimated_delivery_at: input.estimated_delivery_at ?? null,
      logistics_notes: input.logistics_notes ?? null,
      access_hours: input.access_hours ?? null,
      elevator_available: input.elevator_available ?? null,
      floor_number: input.floor_number ?? null,
      site_contact_name: input.site_contact_name ?? null,
      site_contact_phone: input.site_contact_phone ?? null,
      vistoria_scheduled_at: null,
      vistoria_completed_at: null,
      installation_start_at: null,
      installation_end_at: null,
      delivered_at: null,
      quality_score: null,
      rework_notes: null,
    })
    .returningAll()
    .execute();

  log.info({ projectId: project.id, leadId: lead.id }, "Project created");

  // 3. Generate checklists
  await generateChecklists(project.id, project.project_type);

  // 4. Start handoff SLA
  await startSla(lead.id, "handoff_24h");

  // 5. Update lead stage
  await db
    .updateTable("leads")
    .set({ stage: "fechado", closed_at: new Date(), updated_at: new Date() })
    .where("id", "=", lead.id)
    .execute();

  // 6. Log activity
  await db
    .insertInto("activities")
    .values({
      lead_id: lead.id,
      type: "stage_change",
      description: `Handoff completo. Projeto ${project.id} criado.`,
      metadata: { project_id: project.id, contract_value: project.contract_value },
    })
    .execute();

  // 7. Notify obras team
  await notifyObrasTeam(project, lead);

  // 8. Send confirmation to client
  try {
    await sendProjectUpdate(project.id, "handoff_confirmation");
  } catch (err) {
    log.error({ err }, "Failed to send client handoff confirmation");
  }

  log.info({ projectId: project.id }, "Handoff completed successfully");
  return project.id;
}

async function notifyObrasTeam(
  project: { id: string; name: string; client_name: string; location: string; contract_value: number; project_type: string; address: string | null; access_hours: string | null; elevator_available: boolean | null },
  lead: Lead
): Promise<void> {
  const value = Number(project.contract_value).toLocaleString("pt-BR", {
    minimumFractionDigits: 2,
  });

  const message = [
    `*NOVO HANDOFF — OBRA PARKET*`,
    ``,
    `*Projeto:* ${project.name}`,
    `*Cliente:* ${project.client_name}`,
    `*Telefone:* ${lead.phone}`,
    `*Local:* ${project.location}`,
    project.address ? `*Endereco:* ${project.address}` : null,
    `*Tipo:* ${project.project_type}`,
    `*Valor:* R$ ${value}`,
    project.access_hours ? `*Horario acesso:* ${project.access_hours}` : null,
    project.elevator_available !== null
      ? `*Elevador:* ${project.elevator_available ? "Sim" : "Nao"}`
      : null,
    ``,
    `*Proximos passos:*`,
    `1. Realizar vistoria tecnica`,
    `2. Confirmar medidas e base`,
    `3. Solicitar material`,
    ``,
    `SLA: Vistoria em ate 48h`,
  ]
    .filter(Boolean)
    .join("\n");

  // WhatsApp to Ops group
  const opsGroup = process.env.WHATSAPP_OPS_GROUP;
  if (opsGroup) {
    try {
      await sendGroupMessage(opsGroup, message);
    } catch (err) {
      log.error({ err }, "Failed to send handoff WhatsApp notification");
    }
  }

  // Slack alert
  try {
    await sendSlackAlert(
      "info",
      `Novo Handoff: ${project.name}`,
      `*Cliente:* ${project.client_name}\n*Local:* ${project.location}\n*Valor:* R$ ${value}\n*Tipo:* ${project.project_type}`
    );
  } catch (err) {
    log.error({ err }, "Failed to send handoff Slack notification");
  }
}
