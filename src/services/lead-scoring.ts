import { createChildLogger } from "../config/logger.js";
import type { RawLeadInput } from "./lead-ingestion.js";

const log = createChildLogger("service:lead-scoring");

/**
 * Score a lead from 0-100 based on qualification signals.
 * Higher = more likely to close, higher ticket.
 *
 * Scoring rules (Parket premium context):
 * - Architect referral = high intent
 * - Acabamentos stage = ready to buy
 * - Location in key cities = higher potential
 * - Higher estimated ticket = more weight
 * - Complete data = more engaged
 */
export function scoreLead(input: RawLeadInput): number {
  let score = 0;

  // Source quality (max 25)
  const sourceScores: Record<string, number> = {
    architect: 25,
    referral: 20,
    website: 15,
    instagram: 12,
    meta_ads: 10,
    google_ads: 10,
    whatsapp: 8,
  };
  score += sourceScores[input.source] ?? 5;

  // Client type (max 20)
  if (input.client_type === "architect") score += 20;
  else if (input.client_type === "developer") score += 15;
  else if (input.client_type === "end_client") score += 10;

  // Project stage (max 20)
  if (input.project_stage === "acabamentos") score += 20;
  else if (input.project_stage === "obra_iniciada") score += 12;
  else if (input.project_stage === "planta") score += 5;

  // Estimated ticket (max 20)
  if (input.estimated_ticket) {
    if (input.estimated_ticket >= 100_000) score += 20;
    else if (input.estimated_ticket >= 50_000) score += 15;
    else if (input.estimated_ticket >= 20_000) score += 10;
    else score += 5;
  }

  // Data completeness (max 15)
  const fields = [
    input.email,
    input.client_type,
    input.project_type,
    input.project_stage,
    input.location,
    input.estimated_deadline,
    input.estimated_ticket,
  ];
  const filled = fields.filter(Boolean).length;
  score += Math.round((filled / fields.length) * 15);

  const finalScore = Math.min(score, 100);
  log.debug({ name: input.name, score: finalScore }, "Lead scored");

  return finalScore;
}
