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

// ─── Follow-up Sequence ────────────────────────────
export interface FollowUpSequenceTable {
  id: Generated<string>;
  name: string;
  funnel: "architects" | "end_client" | "developers";
  active: Generated<boolean>;
  created_at: Generated<Date>;
}

export type FollowUpSequence = Selectable<FollowUpSequenceTable>;

export interface FollowUpStepTable {
  id: Generated<string>;
  sequence_id: string;
  step_order: number;
  delay_minutes: number;
  channel: "whatsapp" | "email";
  template: string;
  created_at: Generated<Date>;
}

export type FollowUpStep = Selectable<FollowUpStepTable>;

export interface FollowUpExecutionTable {
  id: Generated<string>;
  lead_id: string;
  sequence_id: string;
  current_step: number;
  status: "active" | "completed" | "cancelled" | "responded";
  next_run_at: Date | null;
  started_at: Generated<Date>;
  completed_at: Date | null;
}

export type FollowUpExecution = Selectable<FollowUpExecutionTable>;

// ─── Proposal ──────────────────────────────────────
export interface ProposalTable {
  id: Generated<string>;
  lead_id: string;
  pipedrive_deal_id: number | null;
  version: Generated<number>;
  status: "draft" | "sent" | "viewed" | "accepted" | "rejected" | "expired";

  // Content
  client_name: string;
  project_name: string;
  project_type: string | null;
  location: string | null;

  // Items
  items: Record<string, unknown>[];
  total_value: number;
  payment_terms: string | null;
  validity_days: Generated<number>;

  // Files
  google_doc_id: string | null;
  pdf_url: string | null;

  // Timestamps
  created_at: Generated<Date>;
  sent_at: Date | null;
  viewed_at: Date | null;
  responded_at: Date | null;
  expires_at: Date | null;
}

export type Proposal = Selectable<ProposalTable>;
export type NewProposal = Insertable<ProposalTable>;

// ─── Pipeline Snapshot ─────────────────────────────
export interface PipelineSnapshotTable {
  id: Generated<string>;
  snapshot_date: Date;
  funnel: string;
  stage: string;
  deal_count: number;
  total_value: number;
  avg_age_days: number;
  conversion_rate: number | null;
  created_at: Generated<Date>;
}

export type PipelineSnapshot = Selectable<PipelineSnapshotTable>;

// ─── Project (Obra) ────────────────────────────────
export interface ProjectTable {
  id: Generated<string>;
  lead_id: string;
  proposal_id: string | null;
  pipedrive_deal_id: number | null;

  // Info
  name: string;
  client_name: string;
  client_phone: string;
  architect_name: string | null;
  architect_phone: string | null;
  location: string;
  address: string | null;

  // Scope
  project_type: "residential" | "commercial" | "corporate";
  products: Record<string, unknown>[];
  total_area_m2: number;
  contract_value: number;

  // Status
  status: "handoff" | "vistoria" | "material_pedido" | "aguardando_material" | "agendado" | "em_execucao" | "entrega" | "pos_obra" | "concluido" | "cancelado";

  // Dates
  contract_signed_at: Date;
  vistoria_scheduled_at: Date | null;
  vistoria_completed_at: Date | null;
  installation_start_at: Date | null;
  installation_end_at: Date | null;
  delivered_at: Date | null;
  estimated_delivery_at: Date | null;

  // Quality
  quality_score: number | null;
  has_rework: Generated<boolean>;
  rework_notes: string | null;

  // Logistics constraints
  logistics_notes: string | null;
  access_hours: string | null;
  elevator_available: boolean | null;
  floor_number: number | null;

  // Contacts
  site_contact_name: string | null;
  site_contact_phone: string | null;

  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export type Project = Selectable<ProjectTable>;
export type NewProject = Insertable<ProjectTable>;
export type ProjectUpdate = Updateable<ProjectTable>;

// ─── Project Checklist ─────────────────────────────
export interface ProjectChecklistTable {
  id: Generated<string>;
  project_id: string;
  phase: "pre_obra" | "instalacao" | "entrega" | "pos_obra";
  item_order: number;
  description: string;
  is_mandatory: Generated<boolean>;
  requires_photo: Generated<boolean>;

  // Completion
  completed: Generated<boolean>;
  completed_by: string | null;
  completed_at: Date | null;
  photo_url: string | null;
  notes: string | null;

  created_at: Generated<Date>;
}

export type ProjectChecklist = Selectable<ProjectChecklistTable>;

// ─── Purchase Order ────────────────────────────────
export interface PurchaseOrderTable {
  id: Generated<string>;
  project_id: string;
  supplier: string;
  description: string;
  items: Record<string, unknown>[];
  total_value: number;

  status: "draft" | "sent" | "confirmed" | "production" | "shipped" | "delivered" | "cancelled";

  ordered_at: Date | null;
  estimated_delivery_at: Date | null;
  actual_delivery_at: Date | null;
  delivered_on_time: boolean | null;

  tracking_code: string | null;
  notes: string | null;

  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export type PurchaseOrder = Selectable<PurchaseOrderTable>;
export type NewPurchaseOrder = Insertable<PurchaseOrderTable>;

// ─── Project Communication Log ─────────────────────
export interface ProjectCommunicationTable {
  id: Generated<string>;
  project_id: string;
  recipient_type: "client" | "architect" | "site_contact" | "internal";
  recipient_phone: string | null;
  channel: "whatsapp" | "email" | "call";
  message: string;
  template_key: string | null;
  sent_at: Generated<Date>;
}

export type ProjectCommunication = Selectable<ProjectCommunicationTable>;

// ─── Financial Transaction ────────────────────────────
export interface FinancialTransactionTable {
  id: Generated<string>;
  erp_invoice_id: string | null;
  project_id: string | null;
  type: "receivable" | "payable";
  description: string;
  gross_value: number;
  tax_value: number;
  net_value: number;
  cost_center: string | null;
  category: string | null;
  issued_at: Date;
  due_at: Date;
  paid_at: Date | null;
  status: "open" | "paid" | "overdue" | "cancelled";
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export type FinancialTransaction = Selectable<FinancialTransactionTable>;
export type NewFinancialTransaction = Insertable<FinancialTransactionTable>;

// ─── Financial Payment ────────────────────────────────
export interface FinancialPaymentTable {
  id: Generated<string>;
  erp_payment_id: string | null;
  erp_invoice_id: string | null;
  amount: number;
  method: "pix" | "boleto" | "transfer" | "credit_card" | "cash";
  paid_at: Date;
  bank_account: string | null;
  created_at: Generated<Date>;
}

export type FinancialPayment = Selectable<FinancialPaymentTable>;
export type NewFinancialPayment = Insertable<FinancialPaymentTable>;

// ─── NPS Survey ───────────────────────────────────────
export interface NpsSurveyTable {
  id: Generated<string>;
  project_id: string;
  respondent_type: "client" | "architect";
  respondent_phone: string;
  respondent_name: string;
  score: number | null;
  feedback: string | null;
  status: "pending" | "sent" | "responded" | "expired";
  sent_at: Date | null;
  responded_at: Date | null;
  created_at: Generated<Date>;
}

export type NpsSurvey = Selectable<NpsSurveyTable>;

// ─── Quality Incident ─────────────────────────────────
export interface QualityIncidentTable {
  id: Generated<string>;
  project_id: string;
  type: "rework" | "defect" | "complaint" | "delay" | "material_issue";
  severity: "low" | "medium" | "high" | "critical";
  description: string;
  root_cause: string | null;
  resolution: string | null;
  cost_impact: number;
  status: "open" | "investigating" | "resolved" | "closed";
  resolved_at: Date | null;
  created_at: Generated<Date>;
}

export type QualityIncident = Selectable<QualityIncidentTable>;

// ─── Growth Experiment ────────────────────────────────
export interface GrowthExperimentTable {
  id: Generated<string>;
  name: string;
  hypothesis: string;
  channel: string;
  funnel: string;
  variable_tested: string;
  success_metric: string;
  target_value: number;
  budget: number;
  duration_days: number;
  control_description: string;
  variant_description: string;
  status: "running" | "won" | "lost" | "inconclusive" | "cancelled";
  actual_lift_pct: number | null;
  learnings: string | null;
  started_at: Date;
  ends_at: Date;
  closed_at: Date | null;
  created_at: Generated<Date>;
}

export type GrowthExperiment = Selectable<GrowthExperimentTable>;

// ─── Experiment Measurement ───────────────────────────
export interface ExperimentMeasurementTable {
  id: Generated<string>;
  experiment_id: string;
  group: "control" | "variant";
  metric: string;
  value: number;
  sample_size: number;
  measured_at: Date;
  created_at: Generated<Date>;
}

export type ExperimentMeasurement = Selectable<ExperimentMeasurementTable>;

// ─── Prospect ─────────────────────────────────────────
export interface ProspectTable {
  id: Generated<string>;
  name: string;
  type: "architect" | "incorporadora" | "designer" | "builder";
  company: string | null;
  phone: string | null;
  email: string | null;
  instagram: string | null;
  region: string;
  tier: "high_potential" | "build_relationship" | "nurture";
  rationale: string;
  entry_strategy: string | null;
  estimated_annual_value: number;
  relationship_score: number;
  status: "identified" | "contacted" | "engaged" | "converted" | "disqualified";
  converted_lead_id: string | null;
  last_contact_at: Date | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export type Prospect = Selectable<ProspectTable>;

// ─── Prospect Connection ──────────────────────────────
export interface ProspectConnectionTable {
  id: Generated<string>;
  prospect_id: string;
  channel: "whatsapp" | "email" | "instagram_dm" | "phone" | "visit" | "event";
  description: string;
  outcome: "positive" | "neutral" | "negative" | "no_response";
  created_at: Generated<Date>;
}

export type ProspectConnection = Selectable<ProspectConnectionTable>;

// ─── Database ──────────────────────────────────────
export interface Database {
  leads: LeadTable;
  activities: ActivityTable;
  sla_events: SlaEventTable;
  webhook_logs: WebhookLogTable;
  follow_up_sequences: FollowUpSequenceTable;
  follow_up_steps: FollowUpStepTable;
  follow_up_executions: FollowUpExecutionTable;
  proposals: ProposalTable;
  pipeline_snapshots: PipelineSnapshotTable;
  projects: ProjectTable;
  project_checklists: ProjectChecklistTable;
  purchase_orders: PurchaseOrderTable;
  project_communications: ProjectCommunicationTable;
  financial_transactions: FinancialTransactionTable;
  financial_payments: FinancialPaymentTable;
  nps_surveys: NpsSurveyTable;
  quality_incidents: QualityIncidentTable;
  growth_experiments: GrowthExperimentTable;
  experiment_measurements: ExperimentMeasurementTable;
  prospects: ProspectTable;
  prospect_connections: ProspectConnectionTable;
}
