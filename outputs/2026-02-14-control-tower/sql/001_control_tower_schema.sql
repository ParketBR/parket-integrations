-- ============================================================
-- Parket Control Tower — Cloud SQL Postgres Schema
-- Source of truth for all events, leads, conversations,
-- pipeline, projects, obras.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- 1. EVENTS — append-only event store (core of Control Tower)
-- ============================================================
CREATE TABLE IF NOT EXISTS events (
  id            UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  correlation_id UUID       NOT NULL,
  event_type    TEXT        NOT NULL,
  lead_id       UUID,
  payload       JSONB       NOT NULL DEFAULT '{}',
  idempotency_key TEXT      UNIQUE,
  source        TEXT,
  workflow_execution_id TEXT,
  status        TEXT        NOT NULL DEFAULT 'received'
                            CHECK (status IN ('received','processing','processed','failed')),
  error         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_events_correlation ON events(correlation_id);
CREATE INDEX IF NOT EXISTS idx_events_type        ON events(event_type);
CREATE INDEX IF NOT EXISTS idx_events_lead        ON events(lead_id);
CREATE INDEX IF NOT EXISTS idx_events_created     ON events(created_at);
CREATE INDEX IF NOT EXISTS idx_events_status      ON events(status);

-- ============================================================
-- 2. LEADS — phone_normalized is the unique business key
-- ============================================================
CREATE TABLE IF NOT EXISTS leads (
  id                UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  external_id       TEXT,
  source            TEXT        NOT NULL,
  funnel            TEXT        NOT NULL DEFAULT 'end_client',
  stage             TEXT        NOT NULL DEFAULT 'triagem',

  name              TEXT        NOT NULL,
  email             TEXT,
  phone             TEXT        NOT NULL,
  phone_normalized  TEXT        NOT NULL UNIQUE,

  client_type       TEXT,
  project_type      TEXT,
  project_stage     TEXT,
  location          TEXT,
  estimated_deadline TEXT,
  estimated_ticket  NUMERIC,

  score             INTEGER     NOT NULL DEFAULT 0,

  utm_source        TEXT,
  utm_medium        TEXT,
  utm_campaign      TEXT,
  utm_content       TEXT,

  metadata          JSONB       NOT NULL DEFAULT '{}',

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  qualified_at      TIMESTAMPTZ,
  closed_at         TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_leads_source     ON leads(source);
CREATE INDEX IF NOT EXISTS idx_leads_stage      ON leads(stage);
CREATE INDEX IF NOT EXISTS idx_leads_funnel     ON leads(funnel);
CREATE INDEX IF NOT EXISTS idx_leads_created_at ON leads(created_at);

-- ============================================================
-- 3. CONVERSATIONS — mensagens WhatsApp / outros canais
-- ============================================================
CREATE TABLE IF NOT EXISTS conversations (
  id              UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  lead_id         UUID        NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  correlation_id  UUID,
  channel         TEXT        NOT NULL DEFAULT 'whatsapp'
                              CHECK (channel IN ('whatsapp','email','sms','webchat')),
  direction       TEXT        NOT NULL CHECK (direction IN ('inbound','outbound')),
  from_number     TEXT,
  to_number       TEXT,
  message_type    TEXT        NOT NULL DEFAULT 'text'
                              CHECK (message_type IN ('text','image','audio','video','document','location','template')),
  content         TEXT,
  media_url       TEXT,
  external_msg_id TEXT        UNIQUE,
  metadata        JSONB       NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_conv_lead      ON conversations(lead_id);
CREATE INDEX IF NOT EXISTS idx_conv_channel   ON conversations(channel);
CREATE INDEX IF NOT EXISTS idx_conv_direction ON conversations(direction);
CREATE INDEX IF NOT EXISTS idx_conv_created   ON conversations(created_at);

-- ============================================================
-- 4. PIPELINE — stage transitions log (immutable)
-- ============================================================
CREATE TABLE IF NOT EXISTS pipeline (
  id              UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  lead_id         UUID        NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  correlation_id  UUID,
  from_stage      TEXT,
  to_stage        TEXT        NOT NULL,
  reason          TEXT,
  changed_by      TEXT        NOT NULL DEFAULT 'system',
  metadata        JSONB       NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pipeline_lead    ON pipeline(lead_id);
CREATE INDEX IF NOT EXISTS idx_pipeline_to      ON pipeline(to_stage);
CREATE INDEX IF NOT EXISTS idx_pipeline_created ON pipeline(created_at);

-- ============================================================
-- 5. PROJECTS — projetos pós-venda
-- ============================================================
CREATE TABLE IF NOT EXISTS projects (
  id                UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  lead_id           UUID        NOT NULL REFERENCES leads(id),
  correlation_id    UUID,

  name              TEXT        NOT NULL,
  client_name       TEXT        NOT NULL,
  client_phone      TEXT        NOT NULL,
  architect_name    TEXT,
  architect_phone   TEXT,
  location          TEXT        NOT NULL,
  address           TEXT,

  project_type      TEXT        NOT NULL CHECK (project_type IN ('residential','commercial','corporate')),
  products          JSONB       NOT NULL DEFAULT '[]',
  total_area_m2     NUMERIC     NOT NULL DEFAULT 0,
  contract_value    NUMERIC     NOT NULL DEFAULT 0,

  status            TEXT        NOT NULL DEFAULT 'handoff'
                                CHECK (status IN (
                                  'handoff','vistoria','material_pedido','aguardando_material',
                                  'agendado','em_execucao','entrega','pos_obra','concluido','cancelado'
                                )),

  contract_signed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  estimated_delivery_at   TIMESTAMPTZ,
  delivered_at            TIMESTAMPTZ,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_projects_lead     ON projects(lead_id);
CREATE INDEX IF NOT EXISTS idx_projects_status   ON projects(status);
CREATE INDEX IF NOT EXISTS idx_projects_delivery ON projects(estimated_delivery_at);

-- ============================================================
-- 6. OBRAS — execução de obra (instalação)
-- ============================================================
CREATE TABLE IF NOT EXISTS obras (
  id                UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id        UUID        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  lead_id           UUID        REFERENCES leads(id),
  correlation_id    UUID,

  address           TEXT        NOT NULL,
  floor_type        TEXT,
  area_m2           NUMERIC     NOT NULL DEFAULT 0,
  team_leader       TEXT,
  team_members      JSONB       NOT NULL DEFAULT '[]',

  status            TEXT        NOT NULL DEFAULT 'agendada'
                                CHECK (status IN (
                                  'agendada','em_andamento','pausada',
                                  'concluida','retrabalho','cancelada'
                                )),

  scheduled_start   TIMESTAMPTZ,
  scheduled_end     TIMESTAMPTZ,
  actual_start      TIMESTAMPTZ,
  actual_end        TIMESTAMPTZ,

  quality_score     NUMERIC,
  has_rework        BOOLEAN     NOT NULL DEFAULT FALSE,
  rework_notes      TEXT,
  photos            JSONB       NOT NULL DEFAULT '[]',
  notes             TEXT,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_obras_project  ON obras(project_id);
CREATE INDEX IF NOT EXISTS idx_obras_lead     ON obras(lead_id);
CREATE INDEX IF NOT EXISTS idx_obras_status   ON obras(status);
CREATE INDEX IF NOT EXISTS idx_obras_schedule ON obras(scheduled_start);

-- ============================================================
-- Views para rastreabilidade no Control Tower
-- ============================================================

-- Timeline completa de um lead (todos os eventos)
CREATE OR REPLACE VIEW v_lead_timeline AS
SELECT
  e.id,
  e.correlation_id,
  e.event_type,
  e.lead_id,
  l.name AS lead_name,
  l.phone_normalized,
  e.status AS event_status,
  e.workflow_execution_id,
  e.created_at
FROM events e
LEFT JOIN leads l ON l.id = e.lead_id
ORDER BY e.created_at DESC;

-- Status de workflows por correlation_id
CREATE OR REPLACE VIEW v_workflow_tracking AS
SELECT
  correlation_id,
  COUNT(*) AS event_count,
  COUNT(*) FILTER (WHERE status = 'processed') AS processed,
  COUNT(*) FILTER (WHERE status = 'failed') AS failed,
  MIN(created_at) AS first_event,
  MAX(created_at) AS last_event,
  array_agg(DISTINCT event_type) AS event_types
FROM events
GROUP BY correlation_id
ORDER BY last_event DESC;

-- Pipeline atual
CREATE OR REPLACE VIEW v_pipeline_current AS
SELECT
  l.id AS lead_id,
  l.name,
  l.phone_normalized,
  l.source,
  l.funnel,
  l.stage,
  l.estimated_ticket,
  l.score,
  l.created_at,
  l.updated_at,
  (SELECT COUNT(*) FROM conversations c WHERE c.lead_id = l.id) AS message_count,
  (SELECT COUNT(*) FROM events e WHERE e.lead_id = l.id) AS event_count
FROM leads l
WHERE l.stage NOT IN ('fechado','perdido')
ORDER BY l.updated_at DESC;

-- Obras ativas
CREATE OR REPLACE VIEW v_obras_ativas AS
SELECT
  o.id AS obra_id,
  p.name AS project_name,
  l.name AS client_name,
  o.address,
  o.area_m2,
  o.team_leader,
  o.status,
  o.scheduled_start,
  o.scheduled_end,
  o.actual_start,
  o.quality_score,
  o.has_rework
FROM obras o
JOIN projects p ON p.id = o.project_id
LEFT JOIN leads l ON l.id = o.lead_id
WHERE o.status NOT IN ('concluida','cancelada')
ORDER BY o.scheduled_start ASC;
