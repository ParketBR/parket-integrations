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
