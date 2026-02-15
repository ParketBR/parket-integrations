import { db } from "../db/connection.js";
import { createChildLogger } from "../config/logger.js";
import { sendSlackMessage } from "../connectors/slack/client.js";
import { sendGroupMessage } from "../connectors/whatsapp/client.js";
import { generateExecutiveScoreboard } from "./cac-calculator.js";
import { calculateNpsMetrics } from "./quality-tracking.js";
import { getExperimentScoreboard } from "./growth-experiments.js";
import { getProspectPipeline } from "./market-intelligence.js";

const log = createChildLogger("service:weekly-digest");

// ─── Types ──────────────────────────────────────────

export interface AlertRule {
  id: string;
  name: string;
  area: "commercial" | "financial" | "operations" | "quality" | "growth";
  metric: string;
  operator: ">" | "<" | ">=" | "<=" | "==";
  threshold: number;
  severity: "info" | "warning" | "critical";
  notify_slack: boolean;
  notify_whatsapp: boolean;
  active: boolean;
}

// ─── Alert Rules Engine ─────────────────────────────

const DEFAULT_ALERT_RULES: Omit<AlertRule, "id">[] = [
  {
    name: "Margem abaixo de 25%",
    area: "financial",
    metric: "gross_margin_pct",
    operator: "<",
    threshold: 25,
    severity: "critical",
    notify_slack: true,
    notify_whatsapp: true,
    active: true,
  },
  {
    name: "CAC acima de R$ 5.000",
    area: "growth",
    metric: "cac",
    operator: ">",
    threshold: 5000,
    severity: "warning",
    notify_slack: true,
    notify_whatsapp: false,
    active: true,
  },
  {
    name: "Receita MTD abaixo de 50% da meta",
    area: "financial",
    metric: "mtd_revenue_pct",
    operator: "<",
    threshold: 50,
    severity: "critical",
    notify_slack: true,
    notify_whatsapp: true,
    active: true,
  },
  {
    name: "NPS abaixo de 50",
    area: "quality",
    metric: "nps_score",
    operator: "<",
    threshold: 50,
    severity: "warning",
    notify_slack: true,
    notify_whatsapp: false,
    active: true,
  },
  {
    name: "Projetos on-time abaixo de 80%",
    area: "operations",
    metric: "projects_on_time_pct",
    operator: "<",
    threshold: 80,
    severity: "warning",
    notify_slack: true,
    notify_whatsapp: true,
    active: true,
  },
  {
    name: "Pipeline ponderado abaixo de R$ 200k",
    area: "commercial",
    metric: "pipeline_weighted",
    operator: "<",
    threshold: 200_000,
    severity: "warning",
    notify_slack: true,
    notify_whatsapp: false,
    active: true,
  },
];

function evaluateRule(
  rule: Omit<AlertRule, "id">,
  value: number
): boolean {
  switch (rule.operator) {
    case ">": return value > rule.threshold;
    case "<": return value < rule.threshold;
    case ">=": return value >= rule.threshold;
    case "<=": return value <= rule.threshold;
    case "==": return value === rule.threshold;
    default: return false;
  }
}

/**
 * Run all alert rules against current metrics.
 */
export async function runAlertRules(): Promise<
  Array<{ rule: string; severity: string; metric: string; value: number; threshold: number }>
> {
  const scoreboard = await generateExecutiveScoreboard();
  const nps = await calculateNpsMetrics(90);

  const metricsMap: Record<string, number> = {
    gross_margin_pct: scoreboard.gross_margin_pct,
    cac: scoreboard.cac,
    mtd_revenue_pct: scoreboard.mtd_revenue_pct,
    nps_score: nps.nps_score,
    projects_on_time_pct: scoreboard.projects_on_time_pct,
    pipeline_weighted: scoreboard.pipeline_weighted,
    lead_to_close_rate: scoreboard.lead_to_close_rate,
    avg_quality_score: scoreboard.avg_quality_score,
    ltv_cac_ratio: scoreboard.ltv_cac_ratio,
    active_deals: scoreboard.active_deals,
  };

  const triggered: Array<{
    rule: string;
    severity: string;
    metric: string;
    value: number;
    threshold: number;
  }> = [];

  for (const rule of DEFAULT_ALERT_RULES) {
    if (!rule.active) continue;

    const value = metricsMap[rule.metric];
    if (value === undefined) continue;

    if (evaluateRule(rule, value)) {
      triggered.push({
        rule: rule.name,
        severity: rule.severity,
        metric: rule.metric,
        value,
        threshold: rule.threshold,
      });

      const emoji = rule.severity === "critical" ? "🔴" : "🟡";
      const msg = `${emoji} *${rule.name}*\nValor atual: ${value} (limite: ${rule.threshold})`;

      if (rule.notify_slack) {
        try {
          await sendSlackMessage({ text: msg });
        } catch (err) {
          log.error({ err, rule: rule.name }, "Failed to send alert to Slack");
        }
      }

      if (rule.notify_whatsapp) {
        const opsGroup = process.env.WHATSAPP_OPS_GROUP;
        if (opsGroup) {
          try {
            await sendGroupMessage(opsGroup, msg);
          } catch (err) {
            log.error({ err, rule: rule.name }, "Failed to send alert to WhatsApp");
          }
        }
      }
    }
  }

  if (triggered.length > 0) {
    log.warn({ count: triggered.length }, "Alert rules triggered");
  }

  return triggered;
}

// ─── Weekly Digest ──────────────────────────────────

/**
 * Generate and send the consolidated weekly digest.
 * Single-page executive summary across all areas.
 */
export async function generateWeeklyDigest(): Promise<string> {
  const scoreboard = await generateExecutiveScoreboard();
  const nps = await calculateNpsMetrics(90);
  const experiments = await getExperimentScoreboard();
  const prospects = await getProspectPipeline();

  const fmt = (n: number) => `R$ ${n.toLocaleString("pt-BR")}`;
  const pct = (n: number) => `${n}%`;

  // Build sections
  const sections: string[] = [];

  // Header
  sections.push(`*DIGEST SEMANAL PARKET*`);
  sections.push(`${new Date().toLocaleDateString("pt-BR")} — Visao Consolidada`);
  sections.push(``);

  // Revenue
  const revEmoji = scoreboard.mtd_revenue_pct >= 80 ? "🟢" : scoreboard.mtd_revenue_pct >= 50 ? "🟡" : "🔴";
  sections.push(`*RECEITA*`);
  sections.push(`${revEmoji} MTD: ${fmt(scoreboard.mtd_revenue)} / ${fmt(scoreboard.mtd_revenue_target)} (${pct(scoreboard.mtd_revenue_pct)})`);
  sections.push(`YTD: ${fmt(scoreboard.ytd_revenue)} | Margem: ${pct(scoreboard.gross_margin_pct)}`);
  sections.push(``);

  // Pipeline
  sections.push(`*PIPELINE*`);
  sections.push(`${scoreboard.active_deals} deals ativos | ${fmt(scoreboard.pipeline_weighted)} ponderado`);
  sections.push(`Ticket medio: ${fmt(scoreboard.avg_deal_size)} | Ciclo: ${scoreboard.avg_sales_cycle_days}d`);
  sections.push(`Conversao: ${pct(scoreboard.lead_to_close_rate)} lead→close`);
  sections.push(``);

  // Operations
  const opsEmoji = scoreboard.projects_on_time_pct >= 90 ? "🟢" : scoreboard.projects_on_time_pct >= 75 ? "🟡" : "🔴";
  sections.push(`*OBRAS*`);
  sections.push(`${opsEmoji} ${scoreboard.active_projects} projetos ativos | ${pct(scoreboard.projects_on_time_pct)} on-time`);
  sections.push(`Qualidade media: ${scoreboard.avg_quality_score}/100`);
  sections.push(``);

  // Quality/NPS
  if (nps.total_responses > 0) {
    const npsEmoji = nps.nps_score >= 70 ? "🟢" : nps.nps_score >= 40 ? "🟡" : "🔴";
    sections.push(`*NPS*`);
    sections.push(`${npsEmoji} Score: ${nps.nps_score} (${nps.total_responses} respostas)`);
    sections.push(`Promotores: ${nps.promoters} | Passivos: ${nps.passives} | Detratores: ${nps.detractors}`);
    sections.push(``);
  }

  // Growth
  sections.push(`*GROWTH*`);
  sections.push(`CAC: ${fmt(scoreboard.cac)} | LTV/CAC: ${scoreboard.ltv_cac_ratio}x`);
  sections.push(`MoM receita: ${scoreboard.mom_revenue_growth > 0 ? "📈" : "📉"} ${pct(scoreboard.mom_revenue_growth)} | Leads: ${scoreboard.mom_lead_growth > 0 ? "📈" : "📉"} ${pct(scoreboard.mom_lead_growth)}`);

  if (experiments.running.length > 0) {
    sections.push(`Experimentos rodando: ${experiments.running.length} | Win rate: ${pct(experiments.stats.win_rate)}`);
  }
  sections.push(``);

  // Intelligence
  if (prospects.total_estimated_value > 0) {
    sections.push(`*INTELIGENCIA*`);
    sections.push(`Pipeline prospects: ${fmt(prospects.total_estimated_value)}/ano`);
    const regions = prospects.by_region
      .slice(0, 3)
      .map((r) => `${r.region}: ${r.count}`)
      .join(" | ");
    sections.push(`Top regioes: ${regions}`);
  }

  const digest = sections.join("\n");

  // Send to Slack
  try {
    await sendSlackMessage({
      text: digest,
      blocks: [
        {
          type: "header",
          text: { type: "plain_text", text: "Digest Semanal Parket" },
        },
        {
          type: "section",
          text: { type: "mrkdwn", text: digest },
        },
      ],
    });
  } catch (err) {
    log.error({ err }, "Failed to send digest to Slack");
  }

  // Send to WhatsApp (executive group)
  const sdrGroup = process.env.WHATSAPP_SDR_GROUP;
  if (sdrGroup) {
    try {
      await sendGroupMessage(sdrGroup, digest);
    } catch (err) {
      log.error({ err }, "Failed to send digest to WhatsApp");
    }
  }

  log.info("Weekly digest generated and sent");
  return digest;
}
