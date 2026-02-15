import { sql } from "kysely";
import { db } from "../db/connection.js";
import { createChildLogger } from "../config/logger.js";
import { sendProjectUpdate } from "./project-communications.js";
import { sendSlackAlert } from "../connectors/slack/client.js";

const log = createChildLogger("service:works-management");

// ─── Checklist Templates ───────────────────────────

interface ChecklistTemplate {
  phase: "pre_obra" | "instalacao" | "entrega" | "pos_obra";
  description: string;
  is_mandatory: boolean;
  requires_photo: boolean;
}

const CHECKLIST_TEMPLATES: Record<string, ChecklistTemplate[]> = {
  residential: [
    // Pre-obra
    { phase: "pre_obra", description: "Vistoria tecnica realizada", is_mandatory: true, requires_photo: true },
    { phase: "pre_obra", description: "Medicao final confirmada (m²)", is_mandatory: true, requires_photo: false },
    { phase: "pre_obra", description: "Teste de umidade do contrapiso (< 2.5%)", is_mandatory: true, requires_photo: true },
    { phase: "pre_obra", description: "Nivel e planeza do contrapiso verificados", is_mandatory: true, requires_photo: true },
    { phase: "pre_obra", description: "Aclimatacao do material no local (min 72h)", is_mandatory: true, requires_photo: false },
    { phase: "pre_obra", description: "Planta baixa com paginacao aprovada", is_mandatory: true, requires_photo: false },
    { phase: "pre_obra", description: "Condicoes de acesso e logistica verificadas", is_mandatory: true, requires_photo: false },
    { phase: "pre_obra", description: "Contrapiso limpo e preparado", is_mandatory: true, requires_photo: true },

    // Instalacao
    { phase: "instalacao", description: "Cola/sistema de fixacao correto aplicado", is_mandatory: true, requires_photo: true },
    { phase: "instalacao", description: "Paginacao conforme projeto aprovado", is_mandatory: true, requires_photo: true },
    { phase: "instalacao", description: "Junta de dilatacao respeitada (paredes e batentes)", is_mandatory: true, requires_photo: true },
    { phase: "instalacao", description: "Cortes limpos e precisos", is_mandatory: true, requires_photo: true },
    { phase: "instalacao", description: "Encaixes firmes sem folga", is_mandatory: true, requires_photo: false },
    { phase: "instalacao", description: "Protecao do piso instalado", is_mandatory: true, requires_photo: true },
    { phase: "instalacao", description: "Rodape instalado e alinhado", is_mandatory: false, requires_photo: true },

    // Entrega
    { phase: "entrega", description: "Limpeza final realizada", is_mandatory: true, requires_photo: true },
    { phase: "entrega", description: "Inspecao visual completa (zero defeitos visiveis)", is_mandatory: true, requires_photo: true },
    { phase: "entrega", description: "Teste de som (caminhada sem estalidos)", is_mandatory: true, requires_photo: false },
    { phase: "entrega", description: "Foto geral do ambiente finalizado", is_mandatory: true, requires_photo: true },
    { phase: "entrega", description: "Manual de manutencao entregue ao cliente", is_mandatory: true, requires_photo: false },
    { phase: "entrega", description: "Termo de entrega assinado pelo cliente", is_mandatory: true, requires_photo: true },

    // Pos-obra
    { phase: "pos_obra", description: "Contato pos-obra 7 dias (satisfacao)", is_mandatory: true, requires_photo: false },
    { phase: "pos_obra", description: "Contato pos-obra 30 dias (acompanhamento)", is_mandatory: true, requires_photo: false },
    { phase: "pos_obra", description: "Registro fotografico para portfolio", is_mandatory: false, requires_photo: true },
    { phase: "pos_obra", description: "Solicitacao de depoimento/NPS", is_mandatory: false, requires_photo: false },
  ],
  commercial: [
    { phase: "pre_obra", description: "Vistoria tecnica realizada", is_mandatory: true, requires_photo: true },
    { phase: "pre_obra", description: "Medicao final confirmada (m²)", is_mandatory: true, requires_photo: false },
    { phase: "pre_obra", description: "Teste de umidade do contrapiso", is_mandatory: true, requires_photo: true },
    { phase: "pre_obra", description: "Nivel e planeza verificados", is_mandatory: true, requires_photo: true },
    { phase: "pre_obra", description: "Aclimatacao do material (min 72h)", is_mandatory: true, requires_photo: false },
    { phase: "pre_obra", description: "Cronograma alinhado com obra geral", is_mandatory: true, requires_photo: false },
    { phase: "pre_obra", description: "Horarios de acesso definidos", is_mandatory: true, requires_photo: false },
    { phase: "instalacao", description: "Fixacao conforme especificacao tecnica", is_mandatory: true, requires_photo: true },
    { phase: "instalacao", description: "Paginacao conforme projeto", is_mandatory: true, requires_photo: true },
    { phase: "instalacao", description: "Protecao durante obra geral", is_mandatory: true, requires_photo: true },
    { phase: "entrega", description: "Limpeza profissional realizada", is_mandatory: true, requires_photo: true },
    { phase: "entrega", description: "Inspecao final com responsavel", is_mandatory: true, requires_photo: true },
    { phase: "entrega", description: "Termo de entrega assinado", is_mandatory: true, requires_photo: true },
    { phase: "pos_obra", description: "Contato pos-obra 7 dias", is_mandatory: true, requires_photo: false },
    { phase: "pos_obra", description: "Registro para portfolio", is_mandatory: false, requires_photo: true },
  ],
  corporate: [
    { phase: "pre_obra", description: "Vistoria tecnica realizada", is_mandatory: true, requires_photo: true },
    { phase: "pre_obra", description: "Medicao final confirmada", is_mandatory: true, requires_photo: false },
    { phase: "pre_obra", description: "Teste de umidade", is_mandatory: true, requires_photo: true },
    { phase: "pre_obra", description: "Cronograma alinhado com gestao predial", is_mandatory: true, requires_photo: false },
    { phase: "pre_obra", description: "Aprovacao de acesso pelo condominio/predio", is_mandatory: true, requires_photo: false },
    { phase: "instalacao", description: "Fixacao conforme especificacao", is_mandatory: true, requires_photo: true },
    { phase: "instalacao", description: "Paginacao conforme projeto", is_mandatory: true, requires_photo: true },
    { phase: "instalacao", description: "Protecao areas comuns", is_mandatory: true, requires_photo: true },
    { phase: "entrega", description: "Limpeza final", is_mandatory: true, requires_photo: true },
    { phase: "entrega", description: "Inspecao final", is_mandatory: true, requires_photo: true },
    { phase: "entrega", description: "Termo de entrega assinado", is_mandatory: true, requires_photo: true },
    { phase: "pos_obra", description: "Contato pos-obra 7 dias", is_mandatory: true, requires_photo: false },
  ],
};

/**
 * Generate all phase checklists for a project
 */
export async function generateChecklists(
  projectId: string,
  projectType: string
): Promise<number> {
  const templates = CHECKLIST_TEMPLATES[projectType] ?? CHECKLIST_TEMPLATES.residential;

  let order = 0;
  const values = templates.map((t) => ({
    project_id: projectId,
    phase: t.phase,
    item_order: ++order,
    description: t.description,
    is_mandatory: t.is_mandatory,
    requires_photo: t.requires_photo,
    completed: false as const,
    completed_by: null,
    completed_at: null,
    photo_url: null,
    notes: null,
  }));

  await db.insertInto("project_checklists").values(values).execute();

  log.info({ projectId, count: values.length, projectType }, "Checklists generated");
  return values.length;
}

/**
 * Complete a checklist item
 */
export async function completeChecklistItem(
  itemId: string,
  completedBy: string,
  photoUrl?: string,
  notes?: string
): Promise<void> {
  const item = await db
    .selectFrom("project_checklists")
    .selectAll()
    .where("id", "=", itemId)
    .executeTakeFirstOrThrow();

  if (item.requires_photo && !photoUrl) {
    throw new Error(`Checklist item "${item.description}" requires a photo`);
  }

  await db
    .updateTable("project_checklists")
    .set({
      completed: true,
      completed_by: completedBy,
      completed_at: new Date(),
      photo_url: photoUrl ?? null,
      notes: notes ?? null,
    })
    .where("id", "=", itemId)
    .execute();

  log.info({ itemId, completedBy }, "Checklist item completed");
}

/**
 * Advance project to next status
 */
export async function advanceProjectStatus(
  projectId: string
): Promise<string> {
  const project = await db
    .selectFrom("projects")
    .selectAll()
    .where("id", "=", projectId)
    .executeTakeFirstOrThrow();

  const statusFlow: string[] = [
    "handoff", "vistoria", "material_pedido", "aguardando_material",
    "agendado", "em_execucao", "entrega", "pos_obra", "concluido",
  ];

  const currentIdx = statusFlow.indexOf(project.status);
  if (currentIdx === -1 || currentIdx >= statusFlow.length - 1) {
    throw new Error(`Cannot advance from status: ${project.status}`);
  }

  // Validate mandatory checklists for phase transitions
  const phaseMap: Record<string, string> = {
    vistoria: "pre_obra",
    em_execucao: "instalacao",
    pos_obra: "entrega",
    concluido: "pos_obra",
  };

  const nextStatus = statusFlow[currentIdx + 1];
  const requiredPhase = phaseMap[nextStatus];

  if (requiredPhase) {
    const pendingMandatory = await db
      .selectFrom("project_checklists")
      .select(db.fn.count("id").as("count"))
      .where("project_id", "=", projectId)
      .where("phase", "=", requiredPhase as any)
      .where("is_mandatory", "=", true)
      .where("completed", "=", false)
      .executeTakeFirstOrThrow();

    if (Number(pendingMandatory.count) > 0) {
      throw new Error(
        `Cannot advance: ${pendingMandatory.count} mandatory items pending in phase "${requiredPhase}"`
      );
    }
  }

  // Update status and relevant timestamps
  const updates: Record<string, unknown> = {
    status: nextStatus,
    updated_at: new Date(),
  };

  if (nextStatus === "vistoria") updates.vistoria_completed_at = new Date();
  if (nextStatus === "em_execucao") updates.installation_start_at = new Date();
  if (nextStatus === "entrega") updates.installation_end_at = new Date();
  if (nextStatus === "concluido") updates.delivered_at = new Date();

  await db
    .updateTable("projects")
    .set(updates)
    .where("id", "=", projectId)
    .execute();

  // Send status update to client
  try {
    await sendProjectUpdate(projectId, `status_${nextStatus}`);
  } catch (err) {
    log.error({ err }, "Failed to send status update");
  }

  log.info({ projectId, from: project.status, to: nextStatus }, "Project status advanced");
  return nextStatus;
}

/**
 * Detect projects with overdue delivery dates
 */
export async function detectDelayedProjects(): Promise<number> {
  const delayed = await db
    .selectFrom("projects")
    .selectAll()
    .where("estimated_delivery_at", "<", new Date())
    .where("status", "not in", ["concluido", "cancelado", "pos_obra"])
    .execute();

  if (delayed.length === 0) return 0;

  log.warn({ count: delayed.length }, "Delayed projects detected");

  const alertLines = delayed.map((p) => {
    const daysLate = Math.ceil(
      (Date.now() - new Date(p.estimated_delivery_at!).getTime()) / 86_400_000
    );
    return `- *${p.name}* (${p.status}) — ${daysLate}d atrasado — R$ ${Number(p.contract_value).toLocaleString("pt-BR")}`;
  });

  try {
    await sendSlackAlert(
      "warning",
      `${delayed.length} Obras Atrasadas`,
      alertLines.join("\n")
    );
  } catch (err) {
    log.error({ err }, "Failed to send delay Slack alert");
  }

  const opsGroup = process.env.WHATSAPP_OPS_GROUP;
  if (opsGroup) {
    const { sendGroupMessage } = await import("../connectors/whatsapp/client.js");
    try {
      await sendGroupMessage(
        opsGroup,
        `*ALERTA: ${delayed.length} OBRAS ATRASADAS*\n\n${alertLines.join("\n")}\n\nAcao corretiva necessaria.`
      );
    } catch (err) {
      log.error({ err }, "Failed to send delay WhatsApp alert");
    }
  }

  return delayed.length;
}

/**
 * Calculate quality score for a project based on checklist completion and rework
 */
export async function calculateQualityScore(projectId: string): Promise<number> {
  const checklists = await db
    .selectFrom("project_checklists")
    .select([
      db.fn.count("id").as("total"),
      sql<number>`COUNT(CASE WHEN completed = TRUE THEN 1 END)`.as("completed"),
      sql<number>`COUNT(CASE WHEN requires_photo AND photo_url IS NOT NULL THEN 1 END)`.as("with_photos"),
      sql<number>`COUNT(CASE WHEN requires_photo THEN 1 END)`.as("needs_photos"),
    ])
    .where("project_id", "=", projectId)
    .executeTakeFirstOrThrow();

  const total = Number(checklists.total) || 1;
  const completed = Number(checklists.completed);
  const withPhotos = Number(checklists.with_photos);
  const needsPhotos = Number(checklists.needs_photos) || 1;

  // Score: 70% completion + 30% photo compliance
  const completionScore = (completed / total) * 70;
  const photoScore = (withPhotos / needsPhotos) * 30;
  const score = Math.round(completionScore + photoScore);

  const project = await db
    .selectFrom("projects")
    .select("has_rework")
    .where("id", "=", projectId)
    .executeTakeFirstOrThrow();

  // Deduct 15 points if rework happened
  const finalScore = Math.max(0, project.has_rework ? score - 15 : score);

  await db
    .updateTable("projects")
    .set({ quality_score: finalScore })
    .where("id", "=", projectId)
    .execute();

  log.info({ projectId, score: finalScore }, "Quality score calculated");
  return finalScore;
}
