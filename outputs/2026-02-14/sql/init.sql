-- =============================================
-- Parket Control Tower — Schema SQL Mínimo
-- Executado automaticamente pelo Postgres na
-- primeira inicializacao (docker-entrypoint-initdb.d)
-- =============================================

-- Criar databases separados para n8n e metabase
CREATE DATABASE parket_n8n;
CREATE DATABASE parket_metabase;

-- Usar o database principal para tabelas da aplicacao
\c parket_tower;

-- ── Extensions ─────────────────────────────
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- ── Events (tabela central de rastreabilidade) ──
CREATE TABLE events (
    id              BIGSERIAL PRIMARY KEY,
    correlation_id  UUID NOT NULL DEFAULT uuid_generate_v4(),
    event_type      VARCHAR(100) NOT NULL,
    source          VARCHAR(50)  NOT NULL,  -- meta, google, whatsapp, pipedrive, manual, n8n
    payload         JSONB        NOT NULL DEFAULT '{}',
    idempotency_key VARCHAR(255) UNIQUE,    -- previne duplicatas
    status          VARCHAR(20)  NOT NULL DEFAULT 'received',  -- received, processing, processed, failed
    error_message   TEXT,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    processed_at    TIMESTAMPTZ
);

CREATE INDEX idx_events_correlation   ON events (correlation_id);
CREATE INDEX idx_events_type          ON events (event_type);
CREATE INDEX idx_events_source        ON events (source);
CREATE INDEX idx_events_status        ON events (status);
CREATE INDEX idx_events_created       ON events (created_at);

-- ── Leads ──────────────────────────────────
CREATE TABLE leads (
    id                  BIGSERIAL PRIMARY KEY,
    correlation_id      UUID         NOT NULL DEFAULT uuid_generate_v4(),
    name                VARCHAR(255) NOT NULL,
    phone               VARCHAR(20),
    phone_normalized    VARCHAR(20)  UNIQUE,  -- formato 5511999999999
    email               VARCHAR(255),
    source              VARCHAR(50)  NOT NULL,  -- meta, google, whatsapp, referral, manual
    funnel              VARCHAR(30)  NOT NULL DEFAULT 'end_client',  -- end_client, architects, developers
    client_type         VARCHAR(30),  -- end_client, architect, developer, builder
    utm_source          VARCHAR(100),
    utm_medium          VARCHAR(100),
    utm_campaign        VARCHAR(255),
    raw_payload         JSONB        NOT NULL DEFAULT '{}',
    score               SMALLINT     NOT NULL DEFAULT 0,
    status              VARCHAR(30)  NOT NULL DEFAULT 'new',
    -- new -> contacted -> qualified -> meeting -> proposal -> negotiation -> won -> lost
    assigned_to         VARCHAR(100),
    pipedrive_person_id BIGINT,
    pipedrive_deal_id   BIGINT,
    lost_reason         TEXT,
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_leads_source     ON leads (source);
CREATE INDEX idx_leads_funnel     ON leads (funnel);
CREATE INDEX idx_leads_status     ON leads (status);
CREATE INDEX idx_leads_score      ON leads (score DESC);
CREATE INDEX idx_leads_created    ON leads (created_at);
CREATE INDEX idx_leads_pipedrive  ON leads (pipedrive_deal_id) WHERE pipedrive_deal_id IS NOT NULL;

-- ── Conversations (historico WhatsApp) ─────
CREATE TABLE conversations (
    id              BIGSERIAL PRIMARY KEY,
    lead_id         BIGINT       REFERENCES leads(id),
    correlation_id  UUID         NOT NULL DEFAULT uuid_generate_v4(),
    direction       VARCHAR(10)  NOT NULL,  -- inbound, outbound
    channel         VARCHAR(20)  NOT NULL DEFAULT 'whatsapp',
    phone           VARCHAR(20)  NOT NULL,
    message_type    VARCHAR(20)  NOT NULL DEFAULT 'text',  -- text, image, audio, document, template
    content         TEXT,
    media_url       TEXT,
    template_name   VARCHAR(100),
    whatsapp_msg_id VARCHAR(100) UNIQUE,   -- previne duplicatas
    status          VARCHAR(20)  NOT NULL DEFAULT 'sent',  -- sent, delivered, read, failed
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_conv_lead      ON conversations (lead_id);
CREATE INDEX idx_conv_phone     ON conversations (phone);
CREATE INDEX idx_conv_direction ON conversations (direction);
CREATE INDEX idx_conv_created   ON conversations (created_at);

-- ── Pipeline (snapshots para BI) ───────────
CREATE TABLE pipeline_snapshots (
    id              BIGSERIAL PRIMARY KEY,
    snapshot_date   DATE         NOT NULL,
    funnel          VARCHAR(30)  NOT NULL,
    stage           VARCHAR(30)  NOT NULL,
    deal_count      INT          NOT NULL DEFAULT 0,
    total_value     NUMERIC(14,2) NOT NULL DEFAULT 0,
    weighted_value  NUMERIC(14,2) NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    UNIQUE(snapshot_date, funnel, stage)
);

CREATE INDEX idx_pipeline_date ON pipeline_snapshots (snapshot_date);

-- ── SLA Events ─────────────────────────────
CREATE TABLE sla_events (
    id              BIGSERIAL PRIMARY KEY,
    lead_id         BIGINT       NOT NULL REFERENCES leads(id),
    sla_type        VARCHAR(30)  NOT NULL,  -- first_response, qualification, meeting, proposal, handoff
    deadline        TIMESTAMPTZ  NOT NULL,
    completed_at    TIMESTAMPTZ,
    breached        BOOLEAN      NOT NULL DEFAULT FALSE,
    notified        BOOLEAN      NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_sla_lead    ON sla_events (lead_id);
CREATE INDEX idx_sla_type    ON sla_events (sla_type);
CREATE INDEX idx_sla_breach  ON sla_events (breached) WHERE breached = TRUE;

-- ── Activities (log geral de acoes) ────────
CREATE TABLE activities (
    id              BIGSERIAL PRIMARY KEY,
    lead_id         BIGINT       REFERENCES leads(id),
    correlation_id  UUID         NOT NULL DEFAULT uuid_generate_v4(),
    activity_type   VARCHAR(50)  NOT NULL,
    description     TEXT,
    metadata        JSONB        NOT NULL DEFAULT '{}',
    performed_by    VARCHAR(100),
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_act_lead    ON activities (lead_id);
CREATE INDEX idx_act_type    ON activities (activity_type);
CREATE INDEX idx_act_created ON activities (created_at);

-- ── Follow-up Sequences ────────────────────
CREATE TABLE follow_up_sequences (
    id              BIGSERIAL PRIMARY KEY,
    lead_id         BIGINT       NOT NULL REFERENCES leads(id),
    sequence_name   VARCHAR(100) NOT NULL,
    current_step    INT          NOT NULL DEFAULT 0,
    status          VARCHAR(20)  NOT NULL DEFAULT 'active',  -- active, completed, cancelled
    next_run_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_fus_lead   ON follow_up_sequences (lead_id);
CREATE INDEX idx_fus_status ON follow_up_sequences (status) WHERE status = 'active';
CREATE INDEX idx_fus_next   ON follow_up_sequences (next_run_at) WHERE status = 'active';

-- ── Views para Metabase ────────────────────

-- Visao geral do pipeline
CREATE VIEW v_pipeline_overview AS
SELECT
    funnel,
    status AS stage,
    COUNT(*)                          AS deal_count,
    COALESCE(AVG(score), 0)           AS avg_score,
    MIN(created_at)                   AS oldest_lead,
    COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days') AS new_this_week
FROM leads
WHERE status NOT IN ('lost')
GROUP BY funnel, status
ORDER BY funnel, deal_count DESC;

-- Taxa de conversao por fonte
CREATE VIEW v_conversion_rates AS
SELECT
    source,
    funnel,
    COUNT(*)                                                          AS total_leads,
    COUNT(*) FILTER (WHERE status IN ('won'))                         AS won,
    COUNT(*) FILTER (WHERE status IN ('lost'))                        AS lost,
    ROUND(100.0 * COUNT(*) FILTER (WHERE status = 'won') / NULLIF(COUNT(*), 0), 1) AS win_rate_pct
FROM leads
GROUP BY source, funnel
ORDER BY total_leads DESC;

-- Compliance de SLA
CREATE VIEW v_sla_compliance AS
SELECT
    sla_type,
    COUNT(*)                                        AS total,
    COUNT(*) FILTER (WHERE breached = FALSE)        AS on_time,
    COUNT(*) FILTER (WHERE breached = TRUE)         AS breached,
    ROUND(100.0 * COUNT(*) FILTER (WHERE breached = FALSE) / NULLIF(COUNT(*), 0), 1) AS compliance_pct
FROM sla_events
WHERE completed_at IS NOT NULL OR breached = TRUE
GROUP BY sla_type
ORDER BY compliance_pct;

-- Volume de mensagens por dia
CREATE VIEW v_daily_messages AS
SELECT
    DATE(created_at) AS day,
    direction,
    COUNT(*)         AS message_count
FROM conversations
GROUP BY DATE(created_at), direction
ORDER BY day DESC;

-- ── Funcao helper: atualizar updated_at ────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_leads_updated
    BEFORE UPDATE ON leads
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_fus_updated
    BEFORE UPDATE ON follow_up_sequences
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ── Comentarios ────────────────────────────
COMMENT ON TABLE events IS 'Tabela central de eventos — toda acao gera um evento com correlation_id para rastreabilidade completa';
COMMENT ON COLUMN events.idempotency_key IS 'Chave unica para garantir processamento exactly-once de webhooks';
COMMENT ON COLUMN leads.phone_normalized IS 'Telefone no formato WhatsApp: 5511999999999 (com DDI + DDD + 9o digito)';
COMMENT ON TABLE conversations IS 'Historico completo de mensagens WhatsApp para cada lead';
COMMENT ON TABLE pipeline_snapshots IS 'Snapshots diarios do pipeline para dashboards de tendencia no Metabase';
