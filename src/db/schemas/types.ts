import type { Generated, Insertable, Selectable, Updateable } from "kysely";

// ─── Lead ──────────────────────────────────────────
export interface LeadTable {
  id: Generated<string>;
  external_id: string | null;
  source: "meta_ads" | "google_ads" | "website" | "instagram" | "whatsapp" | "referral" | "architect";
  funnel: "architects" | "end_client" | "developers";
  stage: "triagem" | "qualificado" | "reuniao" | "proposta" | "negociacao" | "fechado" | "perdido";

  // Contact
  name: string;
  email: string | null;
  phone: string;
  phone_normalized: string;

  // Qualification (BANT)
  client_type: "architect" | "end_client" | "developer" | "contractor" | null;
  project_type: "residential" | "commercial" | "corporate" | null;
  project_stage: "planta" | "obra_iniciada" | "acabamentos" | null;
  location: string | null;
  estimated_deadline: string | null;
  estimated_ticket: number | null;

  // Scoring
  score: number;

  // Tracking
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_content: string | null;

  // CRM sync
  pipedrive_deal_id: number | null;
  pipedrive_person_id: number | null;

  // Timestamps
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  qualified_at: Date | null;
  closed_at: Date | null;
}

export type Lead = Selectable<LeadTable>;
export type NewLead = Insertable<LeadTable>;
export type LeadUpdate = Updateable<LeadTable>;

// ─── Activity ──────────────────────────────────────
export interface ActivityTable {
  id: Generated<string>;
  lead_id: string;
  type: "sla_start" | "sla_met" | "sla_breach" | "follow_up" | "call" | "meeting" | "proposal_sent" | "note" | "stage_change" | "whatsapp_sent" | "whatsapp_received";
  description: string | null;
  metadata: Record<string, unknown> | null;
  created_at: Generated<Date>;
}

export type Activity = Selectable<ActivityTable>;
export type NewActivity = Insertable<ActivityTable>;

// ─── SLA Event ─────────────────────────────────────
export interface SlaEventTable {
  id: Generated<string>;
  lead_id: string;
  sla_type: "response_5min" | "qualification_15min" | "meeting_48h" | "proposal_72h" | "handoff_24h";
  started_at: Date;
  deadline_at: Date;
  completed_at: Date | null;
  breached: Generated<boolean>;
  notified: Generated<boolean>;
  created_at: Generated<Date>;
}

export type SlaEvent = Selectable<SlaEventTable>;
export type NewSlaEvent = Insertable<SlaEventTable>;

// ─── Webhook Log ───────────────────────────────────
export interface WebhookLogTable {
  id: Generated<string>;
  source: string;
  event_type: string;
  payload: Record<string, unknown>;
  status: "received" | "processed" | "failed" | "duplicate";
  error: string | null;
  idempotency_key: string;
  created_at: Generated<Date>;
}

export type WebhookLog = Selectable<WebhookLogTable>;
export type NewWebhookLog = Insertable<WebhookLogTable>;

// ─── Database ──────────────────────────────────────
export interface Database {
  leads: LeadTable;
  activities: ActivityTable;
  sla_events: SlaEventTable;
  webhook_logs: WebhookLogTable;
}
