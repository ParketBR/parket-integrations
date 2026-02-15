import { sql } from "kysely";
import { db } from "../db/connection.js";
import { createChildLogger } from "../config/logger.js";
import { sendTextMessage, sendGroupMessage } from "../connectors/whatsapp/client.js";
import { sendSlackMessage } from "../connectors/slack/client.js";

const log = createChildLogger("service:quality-tracking");

// ─── Types ──────────────────────────────────────────

export interface NpsSurvey {
  project_id: string;
  respondent_type: "client" | "architect";
  respondent_phone: string;
  respondent_name: string;
  score: number | null;
  feedback: string | null;
  status: "pending" | "sent" | "responded" | "expired";
}

export interface QualityIncident {
  project_id: string;
  type: "rework" | "defect" | "complaint" | "delay" | "material_issue";
  severity: "low" | "medium" | "high" | "critical";
  description: string;
  root_cause: string | null;
  resolution: string | null;
  cost_impact: number;
}

export interface ReworkEntry {
  cause: string;
  count: number;
  total_cost: number;
  prevention: string | null;
}

// ─── NPS System ─────────────────────────────────────

const NPS_TEMPLATES = {
  client: `Ola {{name}}! Aqui e a Parket. Seu projeto "{{project}}" foi concluido e gostavamos de saber: de 0 a 10, o quanto voce recomendaria a Parket para amigos e familiares?\n\nResponda apenas com o numero (0-10).`,
  architect: `Ola {{name}}! Aqui e a Parket. O projeto "{{project}}" que especificamos juntos foi concluido. De 0 a 10, o quanto voce recomendaria a Parket para outros projetos?\n\nResponda apenas com o numero (0-10).`,
};

/**
 * Send NPS survey to client and architect after project completion.
 */
export async function sendNpsSurvey(projectId: string): Promise<number> {
  const project = await db
    .selectFrom("projects")
    .select([
      "id",
      "name",
      "client_name",
      "client_phone",
      "architect_name",
      "architect_phone",
    ])
    .where("id", "=", projectId)
    .executeTakeFirst();

  if (!project) {
    log.warn({ projectId }, "Project not found for NPS survey");
    return 0;
  }

  let sent = 0;

  // Send to client
  if (project.client_phone) {
    const message = NPS_TEMPLATES.client
      .replace("{{name}}", project.client_name.split(" ")[0])
      .replace("{{project}}", project.name);

    await db
      .insertInto("nps_surveys")
      .values({
        project_id: projectId,
        respondent_type: "client",
        respondent_phone: project.client_phone,
        respondent_name: project.client_name,
        status: "sent",
        sent_at: new Date(),
      })
      .execute();

    try {
      await sendTextMessage(project.client_phone, message);
      sent++;
    } catch (err) {
      log.error({ err, phone: project.client_phone }, "Failed to send NPS to client");
    }
  }

  // Send to architect
  if (project.architect_phone && project.architect_name) {
    const message = NPS_TEMPLATES.architect
      .replace("{{name}}", project.architect_name.split(" ")[0])
      .replace("{{project}}", project.name);

    await db
      .insertInto("nps_surveys")
      .values({
        project_id: projectId,
        respondent_type: "architect",
        respondent_phone: project.architect_phone,
        respondent_name: project.architect_name,
        status: "sent",
        sent_at: new Date(),
      })
      .execute();

    try {
      await sendTextMessage(project.architect_phone, message);
      sent++;
    } catch (err) {
      log.error({ err }, "Failed to send NPS to architect");
    }
  }

  log.info({ projectId, sent }, "NPS surveys sent");
  return sent;
}

/**
 * Process an NPS response (called from WhatsApp webhook).
 */
export async function processNpsResponse(
  phone: string,
  rawScore: string
): Promise<boolean> {
  const score = parseInt(rawScore.trim(), 10);
  if (isNaN(score) || score < 0 || score > 10) return false;

  const survey = await db
    .selectFrom("nps_surveys")
    .select(["id", "project_id", "respondent_name", "respondent_type"])
    .where("respondent_phone", "=", phone)
    .where("status", "=", "sent")
    .orderBy("sent_at", "desc")
    .executeTakeFirst();

  if (!survey) return false;

  await db
    .updateTable("nps_surveys")
    .set({
      score,
      status: "responded",
      responded_at: new Date(),
    })
    .where("id", "=", survey.id)
    .execute();

  log.info(
    { surveyId: survey.id, score, respondent: survey.respondent_name },
    "NPS response recorded"
  );

  // Alert on detractors (0-6)
  if (score <= 6) {
    const alertMsg = `*ALERTA NPS DETRATOR*\n${survey.respondent_name} (${survey.respondent_type}) deu nota *${score}* para o projeto.\n\nAcao imediata necessaria!`;

    const opsGroup = process.env.WHATSAPP_OPS_GROUP;
    if (opsGroup) {
      try {
        await sendGroupMessage(opsGroup, alertMsg);
      } catch (err) {
        log.error({ err }, "Failed to send NPS detractor alert");
      }
    }

    try {
      await sendSlackMessage({
        text: `NPS Detractor Alert: ${survey.respondent_name} scored ${score}`,
        blocks: [
          {
            type: "header",
            text: { type: "plain_text", text: "NPS Detractor Alert" },
          },
          {
            type: "section",
            fields: [
              { type: "mrkdwn", text: `*Respondent:*\n${survey.respondent_name} (${survey.respondent_type})` },
              { type: "mrkdwn", text: `*Score:*\n${score}/10` },
            ],
          },
        ],
      });
    } catch (err) {
      log.error({ err }, "Failed to send NPS Slack alert");
    }
  }

  // Thank the respondent
  const thankMsg =
    score >= 9
      ? `Muito obrigado pela nota ${score}! Ficamos felizes em saber que a experiencia foi excelente. Se precisar de algo, estamos a disposicao!`
      : score >= 7
        ? `Obrigado pelo feedback! Nota ${score} nos motiva a melhorar sempre. Se tiver alguma sugestao, estamos ouvindo.`
        : `Obrigado pela sua avaliacao. Lamentamos que a experiencia nao tenha sido perfeita. Nossa equipe vai entrar em contato para entender como podemos melhorar.`;

  try {
    await sendTextMessage(phone, thankMsg);
  } catch (err) {
    log.error({ err }, "Failed to send NPS thank you");
  }

  return true;
}

/**
 * Calculate NPS metrics.
 */
export async function calculateNpsMetrics(
  periodDays: number = 90
): Promise<{
  total_responses: number;
  promoters: number;
  passives: number;
  detractors: number;
  nps_score: number;
  avg_score: number;
  by_type: Record<string, { nps: number; avg: number; count: number }>;
}> {
  const since = new Date(Date.now() - periodDays * 86_400_000);

  const responses = await db
    .selectFrom("nps_surveys")
    .select(["score", "respondent_type"])
    .where("status", "=", "responded")
    .where("responded_at", ">=", since)
    .where("score", "is not", null)
    .execute();

  if (responses.length === 0) {
    return {
      total_responses: 0,
      promoters: 0,
      passives: 0,
      detractors: 0,
      nps_score: 0,
      avg_score: 0,
      by_type: {},
    };
  }

  const promoters = responses.filter((r) => r.score! >= 9).length;
  const passives = responses.filter((r) => r.score! >= 7 && r.score! <= 8).length;
  const detractors = responses.filter((r) => r.score! <= 6).length;
  const npsScore = Math.round(
    ((promoters - detractors) / responses.length) * 100
  );
  const avgScore =
    Math.round(
      (responses.reduce((sum, r) => sum + r.score!, 0) / responses.length) * 10
    ) / 10;

  // By respondent type
  const byType: Record<string, { nps: number; avg: number; count: number }> = {};
  for (const type of ["client", "architect"]) {
    const typeResponses = responses.filter((r) => r.respondent_type === type);
    if (typeResponses.length === 0) continue;
    const tp = typeResponses.filter((r) => r.score! >= 9).length;
    const td = typeResponses.filter((r) => r.score! <= 6).length;
    byType[type] = {
      nps: Math.round(((tp - td) / typeResponses.length) * 100),
      avg:
        Math.round(
          (typeResponses.reduce((s, r) => s + r.score!, 0) /
            typeResponses.length) *
            10
        ) / 10,
      count: typeResponses.length,
    };
  }

  return {
    total_responses: responses.length,
    promoters,
    passives,
    detractors,
    nps_score: npsScore,
    avg_score: avgScore,
    by_type: byType,
  };
}

// ─── Quality Incidents ──────────────────────────────

/**
 * Register a quality incident on a project.
 */
export async function registerIncident(
  incident: QualityIncident
): Promise<string> {
  const result = await db
    .insertInto("quality_incidents")
    .values({
      project_id: incident.project_id,
      type: incident.type,
      severity: incident.severity,
      description: incident.description,
      root_cause: incident.root_cause,
      resolution: incident.resolution,
      cost_impact: incident.cost_impact,
      status: "open",
    })
    .returning("id")
    .executeTakeFirstOrThrow();

  // Update project rework flag
  if (incident.type === "rework") {
    await db
      .updateTable("projects")
      .set({ has_rework: true, rework_notes: incident.description })
      .where("id", "=", incident.project_id)
      .execute();
  }

  // Alert on high/critical
  if (incident.severity === "high" || incident.severity === "critical") {
    const project = await db
      .selectFrom("projects")
      .select(["name", "client_name"])
      .where("id", "=", incident.project_id)
      .executeTakeFirst();

    const emoji = incident.severity === "critical" ? "🔴" : "🟡";
    const alertMsg = `${emoji} *Incidente ${incident.severity.toUpperCase()}*\nProjeto: ${project?.name}\nCliente: ${project?.client_name}\nTipo: ${incident.type}\n${incident.description}\n\nCusto estimado: R$ ${incident.cost_impact.toLocaleString("pt-BR")}`;

    try {
      await sendSlackMessage({ text: alertMsg });
    } catch (err) {
      log.error({ err }, "Failed to send incident alert");
    }
  }

  log.info(
    { id: result.id, type: incident.type, severity: incident.severity },
    "Quality incident registered"
  );

  return result.id;
}

/**
 * Resolve a quality incident.
 */
export async function resolveIncident(
  incidentId: string,
  resolution: string,
  actualCost: number
): Promise<void> {
  await db
    .updateTable("quality_incidents")
    .set({
      status: "resolved",
      resolution,
      cost_impact: actualCost,
      resolved_at: new Date(),
    })
    .where("id", "=", incidentId)
    .execute();

  log.info({ incidentId }, "Quality incident resolved");
}

/**
 * Generate rework matrix — recurring failures with causes and prevention.
 */
export async function generateReworkMatrix(): Promise<ReworkEntry[]> {
  const incidents = await db
    .selectFrom("quality_incidents")
    .select([
      "root_cause",
      db.fn.count("id").as("count"),
      db.fn.coalesce(db.fn.sum("cost_impact"), sql.lit(0)).as("total_cost"),
    ])
    .where("type", "=", "rework")
    .where("root_cause", "is not", null)
    .groupBy("root_cause")
    .orderBy(db.fn.count("id"), "desc")
    .execute();

  const PREVENTION_MAP: Record<string, string> = {
    "base_umida": "Medicao de umidade obrigatoria pre-instalacao (max 12%)",
    "contrapiso_irregular": "Vistoria com nivel laser antes de liberar",
    "material_danificado": "Inspecao fotografica na entrega + aclimatacao 72h",
    "instalacao_incorreta": "Checklist de instalacao + supervisao senior",
    "junta_inadequada": "Template padrao de juntas por tipo de madeira",
    "acabamento_ruim": "Revisao de acabamento com luz rasante antes da entrega",
    "comunicacao_falha": "Briefing padronizado + aprovacao formal do cliente",
  };

  return incidents.map((inc) => ({
    cause: inc.root_cause!,
    count: Number(inc.count),
    total_cost: Number(inc.total_cost),
    prevention: PREVENTION_MAP[inc.root_cause!] ?? null,
  }));
}

/**
 * Evaluate go/no-go for installation start.
 * Checks mandatory pre-obra checklist items.
 */
export async function evaluateGoNoGo(projectId: string): Promise<{
  decision: "go" | "no_go";
  ready_items: number;
  total_items: number;
  blocking_items: string[];
}> {
  const items = await db
    .selectFrom("project_checklists")
    .select(["description", "completed", "is_mandatory", "requires_photo", "photo_url"])
    .where("project_id", "=", projectId)
    .where("phase", "=", "pre_obra")
    .execute();

  const mandatoryItems = items.filter((i) => i.is_mandatory);
  const readyItems = mandatoryItems.filter((i) => {
    if (!i.completed) return false;
    if (i.requires_photo && !i.photo_url) return false;
    return true;
  });

  const blockingItems = mandatoryItems
    .filter((i) => !i.completed || (i.requires_photo && !i.photo_url))
    .map((i) => i.description);

  const decision = blockingItems.length === 0 ? "go" : "no_go";

  log.info(
    { projectId, decision, ready: readyItems.length, total: mandatoryItems.length },
    "Go/no-go evaluation"
  );

  return {
    decision,
    ready_items: readyItems.length,
    total_items: mandatoryItems.length,
    blocking_items: blockingItems,
  };
}

/**
 * Auto-send NPS for recently completed projects.
 */
export async function sendPendingNpsSurveys(): Promise<number> {
  // Projects completed in the last 7 days without NPS survey
  const projects = await db
    .selectFrom("projects")
    .select(["id"])
    .where("status", "=", "concluido")
    .where("delivered_at", ">=", new Date(Date.now() - 7 * 86_400_000))
    .where(
      "id",
      "not in",
      db.selectFrom("nps_surveys").select("project_id")
    )
    .execute();

  let totalSent = 0;
  for (const project of projects) {
    totalSent += await sendNpsSurvey(project.id);
  }

  log.info({ projectCount: projects.length, surveysSent: totalSent }, "Pending NPS surveys processed");
  return totalSent;
}
