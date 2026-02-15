import pg from "pg";
import dotenv from "dotenv";

dotenv.config();

const MIGRATIONS = [
  {
    name: "001_create_leads",
    up: `
      CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

      CREATE TABLE IF NOT EXISTS leads (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        external_id TEXT,
        source TEXT NOT NULL CHECK (source IN ('meta_ads','google_ads','website','instagram','whatsapp','referral','architect')),
        funnel TEXT NOT NULL CHECK (funnel IN ('architects','end_client','developers')),
        stage TEXT NOT NULL DEFAULT 'triagem' CHECK (stage IN ('triagem','qualificado','reuniao','proposta','negociacao','fechado','perdido')),

        name TEXT NOT NULL,
        email TEXT,
        phone TEXT NOT NULL,
        phone_normalized TEXT NOT NULL,

        client_type TEXT CHECK (client_type IN ('architect','end_client','developer','contractor')),
        project_type TEXT CHECK (project_type IN ('residential','commercial','corporate')),
        project_stage TEXT CHECK (project_stage IN ('planta','obra_iniciada','acabamentos')),
        location TEXT,
        estimated_deadline TEXT,
        estimated_ticket NUMERIC,

        score INTEGER NOT NULL DEFAULT 0,

        utm_source TEXT,
        utm_medium TEXT,
        utm_campaign TEXT,
        utm_content TEXT,

        pipedrive_deal_id BIGINT,
        pipedrive_person_id BIGINT,

        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        qualified_at TIMESTAMPTZ,
        closed_at TIMESTAMPTZ
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_phone_normalized ON leads(phone_normalized);
      CREATE INDEX IF NOT EXISTS idx_leads_source ON leads(source);
      CREATE INDEX IF NOT EXISTS idx_leads_stage ON leads(stage);
      CREATE INDEX IF NOT EXISTS idx_leads_funnel ON leads(funnel);
      CREATE INDEX IF NOT EXISTS idx_leads_created_at ON leads(created_at);
      CREATE INDEX IF NOT EXISTS idx_leads_pipedrive_deal ON leads(pipedrive_deal_id);
    `,
  },
  {
    name: "002_create_activities",
    up: `
      CREATE TABLE IF NOT EXISTS activities (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        description TEXT,
        metadata JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_activities_lead ON activities(lead_id);
      CREATE INDEX IF NOT EXISTS idx_activities_type ON activities(type);
    `,
  },
  {
    name: "003_create_sla_events",
    up: `
      CREATE TABLE IF NOT EXISTS sla_events (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
        sla_type TEXT NOT NULL CHECK (sla_type IN ('response_5min','qualification_15min','meeting_48h','proposal_72h','handoff_24h')),
        started_at TIMESTAMPTZ NOT NULL,
        deadline_at TIMESTAMPTZ NOT NULL,
        completed_at TIMESTAMPTZ,
        breached BOOLEAN NOT NULL DEFAULT FALSE,
        notified BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_sla_lead ON sla_events(lead_id);
      CREATE INDEX IF NOT EXISTS idx_sla_type ON sla_events(sla_type);
      CREATE INDEX IF NOT EXISTS idx_sla_breached ON sla_events(breached) WHERE breached = FALSE;
    `,
  },
  {
    name: "004_create_webhook_logs",
    up: `
      CREATE TABLE IF NOT EXISTS webhook_logs (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        source TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload JSONB NOT NULL,
        status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received','processed','failed','duplicate')),
        error TEXT,
        idempotency_key TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_webhook_idempotency ON webhook_logs(idempotency_key);
      CREATE INDEX IF NOT EXISTS idx_webhook_source ON webhook_logs(source);
    `,
  },
  {
    name: "005_create_migrations_table",
    up: `
      CREATE TABLE IF NOT EXISTS _migrations (
        name TEXT PRIMARY KEY,
        executed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `,
  },
  {
    name: "006_create_follow_up_sequences",
    up: `
      CREATE TABLE IF NOT EXISTS follow_up_sequences (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        name TEXT NOT NULL,
        funnel TEXT NOT NULL CHECK (funnel IN ('architects','end_client','developers')),
        active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS follow_up_steps (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        sequence_id UUID NOT NULL REFERENCES follow_up_sequences(id) ON DELETE CASCADE,
        step_order INTEGER NOT NULL,
        delay_minutes INTEGER NOT NULL,
        channel TEXT NOT NULL DEFAULT 'whatsapp' CHECK (channel IN ('whatsapp','email')),
        template TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(sequence_id, step_order)
      );

      CREATE TABLE IF NOT EXISTS follow_up_executions (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
        sequence_id UUID NOT NULL REFERENCES follow_up_sequences(id),
        current_step INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','cancelled','responded')),
        next_run_at TIMESTAMPTZ,
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMPTZ
      );

      CREATE INDEX IF NOT EXISTS idx_followup_exec_lead ON follow_up_executions(lead_id);
      CREATE INDEX IF NOT EXISTS idx_followup_exec_status ON follow_up_executions(status) WHERE status = 'active';
      CREATE INDEX IF NOT EXISTS idx_followup_exec_next_run ON follow_up_executions(next_run_at) WHERE status = 'active';
    `,
  },
  {
    name: "007_create_proposals",
    up: `
      CREATE TABLE IF NOT EXISTS proposals (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
        pipedrive_deal_id BIGINT,
        version INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','viewed','accepted','rejected','expired')),

        client_name TEXT NOT NULL,
        project_name TEXT NOT NULL,
        project_type TEXT,
        location TEXT,

        items JSONB NOT NULL DEFAULT '[]',
        total_value NUMERIC NOT NULL DEFAULT 0,
        payment_terms TEXT,
        validity_days INTEGER NOT NULL DEFAULT 15,

        google_doc_id TEXT,
        pdf_url TEXT,

        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        sent_at TIMESTAMPTZ,
        viewed_at TIMESTAMPTZ,
        responded_at TIMESTAMPTZ,
        expires_at TIMESTAMPTZ
      );

      CREATE INDEX IF NOT EXISTS idx_proposals_lead ON proposals(lead_id);
      CREATE INDEX IF NOT EXISTS idx_proposals_status ON proposals(status);
      CREATE INDEX IF NOT EXISTS idx_proposals_deal ON proposals(pipedrive_deal_id);
    `,
  },
  {
    name: "008_create_pipeline_snapshots",
    up: `
      CREATE TABLE IF NOT EXISTS pipeline_snapshots (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        snapshot_date DATE NOT NULL,
        funnel TEXT NOT NULL,
        stage TEXT NOT NULL,
        deal_count INTEGER NOT NULL DEFAULT 0,
        total_value NUMERIC NOT NULL DEFAULT 0,
        avg_age_days NUMERIC NOT NULL DEFAULT 0,
        conversion_rate NUMERIC,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_snapshot_date ON pipeline_snapshots(snapshot_date);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_snapshot_unique ON pipeline_snapshots(snapshot_date, funnel, stage);
    `,
  },
  {
    name: "009_seed_follow_up_sequences",
    up: `
      -- End Client sequence (most common)
      INSERT INTO follow_up_sequences (id, name, funnel) VALUES
        ('a0000000-0000-0000-0000-000000000001', 'Cliente Final — Padrao', 'end_client');

      INSERT INTO follow_up_steps (sequence_id, step_order, delay_minutes, channel, template) VALUES
        ('a0000000-0000-0000-0000-000000000001', 1, 60, 'whatsapp',
         'Ola {{name}}! Aqui e a Parket. Recebemos seu contato e ficamos felizes com seu interesse. Um de nossos consultores vai entrar em contato em breve para entender melhor seu projeto. Enquanto isso, tem alguma duvida que possamos ajudar?'),
        ('a0000000-0000-0000-0000-000000000001', 2, 1440, 'whatsapp',
         'Ola {{name}}, tudo bem? Aqui e a Parket. Gostavamos de saber mais sobre seu projeto{{#if location}} em {{location}}{{/if}}. Podemos agendar uma conversa rapida para entender suas necessidades e apresentar as melhores opcoes? Qual o melhor horario para voce?'),
        ('a0000000-0000-0000-0000-000000000001', 3, 4320, 'whatsapp',
         '{{name}}, sabemos que escolher o piso perfeito e uma decisao importante. Na Parket, oferecemos consultoria tecnica gratuita para garantir o melhor resultado para seu projeto. Posso agendar uma visita ao nosso showroom ou uma videochamada?'),
        ('a0000000-0000-0000-0000-000000000001', 4, 10080, 'whatsapp',
         'Ola {{name}}! Passando para lembrar que a Parket esta a disposicao para seu projeto. Temos condicoes especiais este mes. Gostaria de saber mais?');

      -- Architect sequence
      INSERT INTO follow_up_sequences (id, name, funnel) VALUES
        ('a0000000-0000-0000-0000-000000000002', 'Arquitetos — Relacionamento', 'architects');

      INSERT INTO follow_up_steps (sequence_id, step_order, delay_minutes, channel, template) VALUES
        ('a0000000-0000-0000-0000-000000000002', 1, 30, 'whatsapp',
         'Ola {{name}}! Aqui e a Parket. Recebemos seu contato e ficamos muito felizes. Somos especializados em pisos de madeira de alto padrao e trabalhamos com diversos escritorios de arquitetura. Posso enviar nosso portfolio tecnico?'),
        ('a0000000-0000-0000-0000-000000000002', 2, 2880, 'whatsapp',
         '{{name}}, gostaria de apresentar nossos diferenciais tecnicos para especificacao: biblioteca 3D/BIM, amostras premium e suporte tecnico dedicado. Podemos agendar uma apresentacao no seu escritorio ou via video?'),
        ('a0000000-0000-0000-0000-000000000002', 3, 10080, 'whatsapp',
         'Ola {{name}}! A Parket esta preparando um evento exclusivo para arquitetos parceiros. Gostaria de receber o convite? Tambem posso enviar amostras dos nossos lancamentos.');

      -- Developer sequence
      INSERT INTO follow_up_sequences (id, name, funnel) VALUES
        ('a0000000-0000-0000-0000-000000000003', 'Incorporadores — B2B', 'developers');

      INSERT INTO follow_up_steps (sequence_id, step_order, delay_minutes, channel, template) VALUES
        ('a0000000-0000-0000-0000-000000000003', 1, 60, 'whatsapp',
         'Ola {{name}}! Aqui e a Parket. Somos referencia em pisos de madeira para empreendimentos de alto padrao. Trabalhamos com as principais incorporadoras do Brasil. Posso enviar cases e condicoes para volume?'),
        ('a0000000-0000-0000-0000-000000000003', 2, 4320, 'whatsapp',
         '{{name}}, a Parket oferece condicoes especiais para incorporadoras: pricing por volume, cronograma de entregas flexivel e suporte tecnico na obra. Gostaria de agendar uma reuniao para discutir seu empreendimento?');
    `,
  },
  {
    name: "010_create_dashboard_views",
    up: `
      -- Pipeline overview by stage
      CREATE OR REPLACE VIEW v_pipeline_overview AS
      SELECT
        funnel,
        stage,
        COUNT(*) as deal_count,
        COALESCE(SUM(estimated_ticket), 0) as total_value,
        ROUND(AVG(EXTRACT(EPOCH FROM (NOW() - created_at)) / 86400)::numeric, 1) as avg_age_days
      FROM leads
      WHERE stage NOT IN ('fechado', 'perdido')
      GROUP BY funnel, stage
      ORDER BY funnel,
        CASE stage
          WHEN 'triagem' THEN 1
          WHEN 'qualificado' THEN 2
          WHEN 'reuniao' THEN 3
          WHEN 'proposta' THEN 4
          WHEN 'negociacao' THEN 5
        END;

      -- Conversion rates between stages
      CREATE OR REPLACE VIEW v_conversion_rates AS
      WITH stage_counts AS (
        SELECT
          funnel,
          COUNT(*) FILTER (WHERE stage IN ('triagem','qualificado','reuniao','proposta','negociacao','fechado')) as triagem,
          COUNT(*) FILTER (WHERE stage IN ('qualificado','reuniao','proposta','negociacao','fechado')) as qualificado,
          COUNT(*) FILTER (WHERE stage IN ('reuniao','proposta','negociacao','fechado')) as reuniao,
          COUNT(*) FILTER (WHERE stage IN ('proposta','negociacao','fechado')) as proposta,
          COUNT(*) FILTER (WHERE stage IN ('negociacao','fechado')) as negociacao,
          COUNT(*) FILTER (WHERE stage = 'fechado') as fechado
        FROM leads
        GROUP BY funnel
      )
      SELECT
        funnel,
        triagem as total_leads,
        CASE WHEN triagem > 0 THEN ROUND(100.0 * qualificado / triagem, 1) END as pct_qualificacao,
        CASE WHEN qualificado > 0 THEN ROUND(100.0 * reuniao / qualificado, 1) END as pct_reuniao,
        CASE WHEN reuniao > 0 THEN ROUND(100.0 * proposta / reuniao, 1) END as pct_proposta,
        CASE WHEN proposta > 0 THEN ROUND(100.0 * fechado / proposta, 1) END as pct_fechamento,
        CASE WHEN triagem > 0 THEN ROUND(100.0 * fechado / triagem, 1) END as pct_total
      FROM stage_counts;

      -- SLA compliance
      CREATE OR REPLACE VIEW v_sla_compliance AS
      SELECT
        sla_type,
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE breached = FALSE AND completed_at IS NOT NULL) as met,
        COUNT(*) FILTER (WHERE breached = TRUE) as breached,
        COUNT(*) FILTER (WHERE completed_at IS NULL AND breached = FALSE) as pending,
        CASE WHEN COUNT(*) FILTER (WHERE completed_at IS NOT NULL OR breached = TRUE) > 0
          THEN ROUND(100.0 * COUNT(*) FILTER (WHERE breached = FALSE AND completed_at IS NOT NULL) /
               COUNT(*) FILTER (WHERE completed_at IS NOT NULL OR breached = TRUE), 1)
        END as compliance_pct
      FROM sla_events
      GROUP BY sla_type;

      -- Lead sources performance
      CREATE OR REPLACE VIEW v_lead_sources AS
      SELECT
        source,
        COUNT(*) as total_leads,
        ROUND(AVG(score), 0) as avg_score,
        COUNT(*) FILTER (WHERE stage = 'fechado') as closed,
        COALESCE(SUM(estimated_ticket) FILTER (WHERE stage = 'fechado'), 0) as closed_value,
        CASE WHEN COUNT(*) > 0
          THEN ROUND(100.0 * COUNT(*) FILTER (WHERE stage = 'fechado') / COUNT(*), 1)
        END as close_rate
      FROM leads
      GROUP BY source
      ORDER BY total_leads DESC;

      -- Weekly scoreboard
      CREATE OR REPLACE VIEW v_weekly_scoreboard AS
      SELECT
        DATE_TRUNC('week', created_at)::date as week_start,
        COUNT(*) as new_leads,
        COUNT(*) FILTER (WHERE stage NOT IN ('triagem','perdido')) as qualified,
        COUNT(*) FILTER (WHERE stage = 'fechado') as closed,
        COALESCE(SUM(estimated_ticket) FILTER (WHERE stage = 'fechado'), 0) as revenue,
        ROUND(AVG(score), 0) as avg_score
      FROM leads
      GROUP BY DATE_TRUNC('week', created_at)
      ORDER BY week_start DESC;

      -- Proposal performance
      CREATE OR REPLACE VIEW v_proposal_performance AS
      SELECT
        DATE_TRUNC('week', created_at)::date as week_start,
        COUNT(*) as total_proposals,
        COUNT(*) FILTER (WHERE status = 'accepted') as accepted,
        COUNT(*) FILTER (WHERE status = 'rejected') as rejected,
        COUNT(*) FILTER (WHERE status = 'expired') as expired,
        COALESCE(SUM(total_value) FILTER (WHERE status = 'accepted'), 0) as accepted_value,
        CASE WHEN COUNT(*) FILTER (WHERE status IN ('accepted','rejected')) > 0
          THEN ROUND(100.0 * COUNT(*) FILTER (WHERE status = 'accepted') /
               COUNT(*) FILTER (WHERE status IN ('accepted','rejected')), 1)
        END as win_rate
      FROM proposals
      GROUP BY DATE_TRUNC('week', created_at)
      ORDER BY week_start DESC;
    `,
  },
  {
    name: "011_create_projects",
    up: `
      CREATE TABLE IF NOT EXISTS projects (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        lead_id UUID NOT NULL REFERENCES leads(id),
        proposal_id UUID REFERENCES proposals(id),
        pipedrive_deal_id BIGINT,

        name TEXT NOT NULL,
        client_name TEXT NOT NULL,
        client_phone TEXT NOT NULL,
        architect_name TEXT,
        architect_phone TEXT,
        location TEXT NOT NULL,
        address TEXT,

        project_type TEXT NOT NULL CHECK (project_type IN ('residential','commercial','corporate')),
        products JSONB NOT NULL DEFAULT '[]',
        total_area_m2 NUMERIC NOT NULL DEFAULT 0,
        contract_value NUMERIC NOT NULL DEFAULT 0,

        status TEXT NOT NULL DEFAULT 'handoff' CHECK (status IN (
          'handoff','vistoria','material_pedido','aguardando_material',
          'agendado','em_execucao','entrega','pos_obra','concluido','cancelado'
        )),

        contract_signed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        vistoria_scheduled_at TIMESTAMPTZ,
        vistoria_completed_at TIMESTAMPTZ,
        installation_start_at TIMESTAMPTZ,
        installation_end_at TIMESTAMPTZ,
        delivered_at TIMESTAMPTZ,
        estimated_delivery_at TIMESTAMPTZ,

        quality_score NUMERIC,
        has_rework BOOLEAN NOT NULL DEFAULT FALSE,
        rework_notes TEXT,

        logistics_notes TEXT,
        access_hours TEXT,
        elevator_available BOOLEAN,
        floor_number INTEGER,

        site_contact_name TEXT,
        site_contact_phone TEXT,

        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_projects_lead ON projects(lead_id);
      CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);
      CREATE INDEX IF NOT EXISTS idx_projects_delivery ON projects(estimated_delivery_at);
    `,
  },
  {
    name: "012_create_project_checklists",
    up: `
      CREATE TABLE IF NOT EXISTS project_checklists (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        phase TEXT NOT NULL CHECK (phase IN ('pre_obra','instalacao','entrega','pos_obra')),
        item_order INTEGER NOT NULL,
        description TEXT NOT NULL,
        is_mandatory BOOLEAN NOT NULL DEFAULT TRUE,
        requires_photo BOOLEAN NOT NULL DEFAULT FALSE,

        completed BOOLEAN NOT NULL DEFAULT FALSE,
        completed_by TEXT,
        completed_at TIMESTAMPTZ,
        photo_url TEXT,
        notes TEXT,

        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_checklist_project ON project_checklists(project_id);
      CREATE INDEX IF NOT EXISTS idx_checklist_phase ON project_checklists(project_id, phase);
    `,
  },
  {
    name: "013_create_purchase_orders",
    up: `
      CREATE TABLE IF NOT EXISTS purchase_orders (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        supplier TEXT NOT NULL,
        description TEXT NOT NULL,
        items JSONB NOT NULL DEFAULT '[]',
        total_value NUMERIC NOT NULL DEFAULT 0,

        status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN (
          'draft','sent','confirmed','production','shipped','delivered','cancelled'
        )),

        ordered_at TIMESTAMPTZ,
        estimated_delivery_at TIMESTAMPTZ,
        actual_delivery_at TIMESTAMPTZ,
        delivered_on_time BOOLEAN,

        tracking_code TEXT,
        notes TEXT,

        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_po_project ON purchase_orders(project_id);
      CREATE INDEX IF NOT EXISTS idx_po_status ON purchase_orders(status);
    `,
  },
  {
    name: "014_create_project_communications",
    up: `
      CREATE TABLE IF NOT EXISTS project_communications (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        recipient_type TEXT NOT NULL CHECK (recipient_type IN ('client','architect','site_contact','internal')),
        recipient_phone TEXT,
        channel TEXT NOT NULL DEFAULT 'whatsapp' CHECK (channel IN ('whatsapp','email','call')),
        message TEXT NOT NULL,
        template_key TEXT,
        sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_projcomm_project ON project_communications(project_id);
    `,
  },
  {
    name: "015_create_obras_dashboard_views",
    up: `
      -- Projects overview
      CREATE OR REPLACE VIEW v_projects_overview AS
      SELECT
        status,
        project_type,
        COUNT(*) as project_count,
        COALESCE(SUM(contract_value), 0) as total_value,
        COALESCE(SUM(total_area_m2), 0) as total_area,
        COUNT(*) FILTER (WHERE has_rework = TRUE) as rework_count,
        ROUND(AVG(quality_score)::numeric, 1) as avg_quality
      FROM projects
      WHERE status != 'cancelado'
      GROUP BY status, project_type
      ORDER BY
        CASE status
          WHEN 'handoff' THEN 1
          WHEN 'vistoria' THEN 2
          WHEN 'material_pedido' THEN 3
          WHEN 'aguardando_material' THEN 4
          WHEN 'agendado' THEN 5
          WHEN 'em_execucao' THEN 6
          WHEN 'entrega' THEN 7
          WHEN 'pos_obra' THEN 8
          WHEN 'concluido' THEN 9
        END;

      -- Project delays
      CREATE OR REPLACE VIEW v_project_delays AS
      SELECT
        p.id,
        p.name,
        p.client_name,
        p.status,
        p.estimated_delivery_at,
        p.contract_value,
        EXTRACT(EPOCH FROM (NOW() - p.estimated_delivery_at)) / 86400 as days_overdue
      FROM projects p
      WHERE p.estimated_delivery_at < NOW()
        AND p.status NOT IN ('concluido','cancelado','pos_obra')
      ORDER BY days_overdue DESC;

      -- Checklist compliance by project
      CREATE OR REPLACE VIEW v_checklist_compliance AS
      SELECT
        p.id as project_id,
        p.name as project_name,
        p.status,
        pc.phase,
        COUNT(*) as total_items,
        COUNT(*) FILTER (WHERE pc.completed = TRUE) as completed_items,
        COUNT(*) FILTER (WHERE pc.is_mandatory AND pc.completed = FALSE) as pending_mandatory,
        COUNT(*) FILTER (WHERE pc.requires_photo AND pc.photo_url IS NULL AND pc.completed = TRUE) as missing_photos,
        CASE WHEN COUNT(*) > 0
          THEN ROUND(100.0 * COUNT(*) FILTER (WHERE pc.completed = TRUE) / COUNT(*), 1)
        END as completion_pct
      FROM projects p
      JOIN project_checklists pc ON pc.project_id = p.id
      WHERE p.status NOT IN ('concluido','cancelado')
      GROUP BY p.id, p.name, p.status, pc.phase;

      -- Purchase order OTIF
      CREATE OR REPLACE VIEW v_purchase_order_otif AS
      SELECT
        supplier,
        COUNT(*) as total_orders,
        COUNT(*) FILTER (WHERE status = 'delivered') as delivered,
        COUNT(*) FILTER (WHERE delivered_on_time = TRUE) as on_time,
        COUNT(*) FILTER (WHERE delivered_on_time = FALSE) as late,
        CASE WHEN COUNT(*) FILTER (WHERE status = 'delivered') > 0
          THEN ROUND(100.0 * COUNT(*) FILTER (WHERE delivered_on_time = TRUE) /
               COUNT(*) FILTER (WHERE status = 'delivered'), 1)
        END as otif_pct,
        ROUND(AVG(
          CASE WHEN actual_delivery_at IS NOT NULL AND ordered_at IS NOT NULL
            THEN EXTRACT(EPOCH FROM (actual_delivery_at - ordered_at)) / 86400
          END
        )::numeric, 1) as avg_lead_time_days
      FROM purchase_orders
      GROUP BY supplier
      ORDER BY total_orders DESC;

      -- Weekly obras scoreboard
      CREATE OR REPLACE VIEW v_obras_weekly AS
      SELECT
        DATE_TRUNC('week', created_at)::date as week_start,
        COUNT(*) FILTER (WHERE status = 'handoff') as new_handoffs,
        COUNT(*) FILTER (WHERE status = 'em_execucao') as in_execution,
        COUNT(*) FILTER (WHERE status = 'concluido') as completed,
        COUNT(*) FILTER (WHERE has_rework = TRUE) as rework_count,
        COALESCE(SUM(contract_value) FILTER (WHERE status = 'concluido'), 0) as completed_value
      FROM projects
      GROUP BY DATE_TRUNC('week', created_at)
      ORDER BY week_start DESC;
    `,
  },
];

async function migrate() {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  // Ensure migrations tracking table exists
  await client.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      executed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  const { rows: executed } = await client.query(
    "SELECT name FROM _migrations"
  );
  const executedNames = new Set(executed.map((r: { name: string }) => r.name));

  for (const migration of MIGRATIONS) {
    if (executedNames.has(migration.name)) {
      console.log(`  ✓ ${migration.name} (already applied)`);
      continue;
    }

    console.log(`  → Running ${migration.name}...`);
    await client.query("BEGIN");
    try {
      await client.query(migration.up);
      await client.query("INSERT INTO _migrations (name) VALUES ($1)", [
        migration.name,
      ]);
      await client.query("COMMIT");
      console.log(`  ✓ ${migration.name} applied`);
    } catch (err) {
      await client.query("ROLLBACK");
      console.error(`  ✗ ${migration.name} failed:`, err);
      process.exit(1);
    }
  }

  await client.end();
  console.log("\n✅ All migrations applied successfully.");
}

migrate().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
