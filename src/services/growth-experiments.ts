import { sql } from "kysely";
import { db } from "../db/connection.js";
import { createChildLogger } from "../config/logger.js";
import { sendSlackMessage } from "../connectors/slack/client.js";

const log = createChildLogger("service:growth-experiments");

// ─── Types ──────────────────────────────────────────

export interface ExperimentInput {
  name: string;
  hypothesis: string;
  channel: "meta_ads" | "google_ads" | "whatsapp" | "email" | "organic" | "referral";
  funnel: "architects" | "end_client" | "developers";
  variable_tested: string;
  success_metric: string;
  target_value: number;
  budget: number;
  duration_days: number;
  control_description: string;
  variant_description: string;
}

export interface ExperimentResult {
  id: string;
  name: string;
  status: string;
  days_running: number;
  control_value: number;
  variant_value: number;
  lift_pct: number;
  is_significant: boolean;
  verdict: "winner" | "loser" | "inconclusive";
}

// ─── Experiment Lifecycle ───────────────────────────

/**
 * Create a new growth experiment.
 */
export async function createExperiment(
  input: ExperimentInput
): Promise<string> {
  const startDate = new Date();
  const endDate = new Date(
    startDate.getTime() + input.duration_days * 86_400_000
  );

  const result = await db
    .insertInto("growth_experiments")
    .values({
      name: input.name,
      hypothesis: input.hypothesis,
      channel: input.channel,
      funnel: input.funnel,
      variable_tested: input.variable_tested,
      success_metric: input.success_metric,
      target_value: input.target_value,
      budget: input.budget,
      duration_days: input.duration_days,
      control_description: input.control_description,
      variant_description: input.variant_description,
      status: "running",
      started_at: startDate,
      ends_at: endDate,
    })
    .returning("id")
    .executeTakeFirstOrThrow();

  log.info({ id: result.id, name: input.name }, "Experiment created");

  try {
    await sendSlackMessage({
      text: `New experiment started: ${input.name}`,
      blocks: [
        {
          type: "header",
          text: { type: "plain_text", text: `Novo Experimento: ${input.name}` },
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*Hipotese:* ${input.hypothesis}\n*Canal:* ${input.channel} | *Funil:* ${input.funnel}\n*Variavel:* ${input.variable_tested}\n*Metrica de sucesso:* ${input.success_metric} (meta: ${input.target_value})\n*Duracao:* ${input.duration_days} dias | *Budget:* R$ ${input.budget.toLocaleString("pt-BR")}`,
          },
        },
        {
          type: "section",
          fields: [
            { type: "mrkdwn", text: `*Controle:*\n${input.control_description}` },
            { type: "mrkdwn", text: `*Variante:*\n${input.variant_description}` },
          ],
        },
      ],
    });
  } catch (err) {
    log.error({ err }, "Failed to send experiment Slack notification");
  }

  return result.id;
}

/**
 * Record a measurement for an experiment.
 */
export async function recordMeasurement(
  experimentId: string,
  group: "control" | "variant",
  metric: string,
  value: number,
  sampleSize: number
): Promise<void> {
  await db
    .insertInto("experiment_measurements")
    .values({
      experiment_id: experimentId,
      group,
      metric,
      value,
      sample_size: sampleSize,
      measured_at: new Date(),
    })
    .execute();

  log.debug({ experimentId, group, metric, value }, "Measurement recorded");
}

/**
 * Evaluate experiment results.
 * Uses simple lift calculation and minimum sample size check.
 */
export async function evaluateExperiment(
  experimentId: string
): Promise<ExperimentResult> {
  const experiment = await db
    .selectFrom("growth_experiments")
    .selectAll()
    .where("id", "=", experimentId)
    .executeTakeFirstOrThrow();

  // Get latest measurements for each group
  const controlMeasurements = await db
    .selectFrom("experiment_measurements")
    .select(["value", "sample_size"])
    .where("experiment_id", "=", experimentId)
    .where("group", "=", "control")
    .where("metric", "=", experiment.success_metric)
    .orderBy("measured_at", "desc")
    .limit(1)
    .executeTakeFirst();

  const variantMeasurements = await db
    .selectFrom("experiment_measurements")
    .select(["value", "sample_size"])
    .where("experiment_id", "=", experimentId)
    .where("group", "=", "variant")
    .where("metric", "=", experiment.success_metric)
    .orderBy("measured_at", "desc")
    .limit(1)
    .executeTakeFirst();

  const controlValue = Number(controlMeasurements?.value ?? 0);
  const variantValue = Number(variantMeasurements?.value ?? 0);
  const controlSample = Number(controlMeasurements?.sample_size ?? 0);
  const variantSample = Number(variantMeasurements?.sample_size ?? 0);

  const liftPct =
    controlValue > 0
      ? Math.round(((variantValue - controlValue) / controlValue) * 1000) / 10
      : 0;

  // Simple significance check: minimum 30 samples per group + >10% lift
  const isSignificant =
    controlSample >= 30 &&
    variantSample >= 30 &&
    Math.abs(liftPct) > 10;

  const daysRunning = Math.round(
    (Date.now() - new Date(experiment.started_at).getTime()) / 86_400_000
  );

  let verdict: "winner" | "loser" | "inconclusive" = "inconclusive";
  if (isSignificant) {
    verdict = liftPct > 0 ? "winner" : "loser";
  }

  return {
    id: experiment.id,
    name: experiment.name,
    status: experiment.status,
    days_running: daysRunning,
    control_value: controlValue,
    variant_value: variantValue,
    lift_pct: liftPct,
    is_significant: isSignificant,
    verdict,
  };
}

/**
 * Close an experiment and record the verdict.
 */
export async function closeExperiment(
  experimentId: string,
  verdict: "winner" | "loser" | "inconclusive",
  learnings: string
): Promise<void> {
  const evaluation = await evaluateExperiment(experimentId);

  await db
    .updateTable("growth_experiments")
    .set({
      status: verdict === "winner" ? "won" : verdict === "loser" ? "lost" : "inconclusive",
      actual_lift_pct: evaluation.lift_pct,
      learnings,
      closed_at: new Date(),
    })
    .where("id", "=", experimentId)
    .execute();

  const experiment = await db
    .selectFrom("growth_experiments")
    .select(["name", "hypothesis", "channel"])
    .where("id", "=", experimentId)
    .executeTakeFirstOrThrow();

  const emoji = verdict === "winner" ? "🏆" : verdict === "loser" ? "❌" : "🤷";

  try {
    await sendSlackMessage({
      text: `${emoji} Experiment closed: ${experiment.name} — ${verdict}`,
      blocks: [
        {
          type: "header",
          text: {
            type: "plain_text",
            text: `${emoji} Experimento Finalizado: ${experiment.name}`,
          },
        },
        {
          type: "section",
          fields: [
            { type: "mrkdwn", text: `*Veredicto:*\n${verdict.toUpperCase()}` },
            { type: "mrkdwn", text: `*Lift:*\n${evaluation.lift_pct}%` },
          ],
        },
        {
          type: "section",
          text: { type: "mrkdwn", text: `*Learnings:*\n${learnings}` },
        },
      ],
    });
  } catch (err) {
    log.error({ err }, "Failed to send experiment close notification");
  }

  log.info({ experimentId, verdict, lift: evaluation.lift_pct }, "Experiment closed");
}

/**
 * Check experiments that have exceeded their duration.
 */
export async function checkExpiredExperiments(): Promise<number> {
  const expired = await db
    .selectFrom("growth_experiments")
    .select(["id", "name"])
    .where("status", "=", "running")
    .where("ends_at", "<", new Date())
    .execute();

  for (const exp of expired) {
    const evaluation = await evaluateExperiment(exp.id);
    await closeExperiment(
      exp.id,
      evaluation.verdict,
      `Auto-closed after duration expired. Lift: ${evaluation.lift_pct}%.`
    );
  }

  if (expired.length > 0) {
    log.info({ count: expired.length }, "Expired experiments auto-closed");
  }

  return expired.length;
}

/**
 * Get experiment scoreboard — all running + recent closed.
 */
export async function getExperimentScoreboard(): Promise<{
  running: ExperimentResult[];
  recent_closed: Array<{
    id: string;
    name: string;
    verdict: string;
    lift_pct: number;
    channel: string;
  }>;
  stats: { total: number; winners: number; win_rate: number };
}> {
  const running = await db
    .selectFrom("growth_experiments")
    .select("id")
    .where("status", "=", "running")
    .execute();

  const runningResults: ExperimentResult[] = [];
  for (const exp of running) {
    runningResults.push(await evaluateExperiment(exp.id));
  }

  const recentClosed = await db
    .selectFrom("growth_experiments")
    .select(["id", "name", "status", "actual_lift_pct", "channel"])
    .where("status", "in", ["won", "lost", "inconclusive"])
    .orderBy("closed_at", "desc")
    .limit(10)
    .execute();

  // Win rate
  const allClosed = await db
    .selectFrom("growth_experiments")
    .select([
      db.fn.count("id").as("total"),
      sql<number>`COUNT(CASE WHEN status = 'won' THEN id END)`.as("winners"),
    ])
    .where("status", "in", ["won", "lost", "inconclusive"])
    .executeTakeFirst();

  const total = Number(allClosed?.total ?? 0);
  const winners = Number(allClosed?.winners ?? 0);

  return {
    running: runningResults,
    recent_closed: recentClosed.map((e) => ({
      id: e.id,
      name: e.name,
      verdict: e.status,
      lift_pct: Number(e.actual_lift_pct ?? 0),
      channel: e.channel,
    })),
    stats: {
      total,
      winners,
      win_rate: total > 0 ? Math.round((winners / total) * 1000) / 10 : 0,
    },
  };
}
