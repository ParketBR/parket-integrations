import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().default(8080),
  NODE_ENV: z.enum(["development", "production", "test"]).default("production"),

  // Cloud SQL (via Unix socket on Cloud Run, or TCP for local)
  DB_HOST: z.string().default("/cloudsql"),
  DB_PORT: z.coerce.number().default(5432),
  DB_NAME: z.string().default("parket_control_tower"),
  DB_USER: z.string().default("parket-app"),
  DB_PASS: z.string().default(""),
  // Cloud SQL connection name (project:region:instance)
  CLOUD_SQL_CONNECTION_NAME: z.string().default(""),

  // Google Cloud
  GCP_PROJECT_ID: z.string(),
  GCP_REGION: z.string().default("southamerica-east1"),
  WORKFLOW_NAME: z.string().default("parket-ingest-event"),

  // Webhook secrets
  WHATSAPP_WEBHOOK_SECRET: z.string().default(""),
});

export function loadEnv() {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    const missing = parsed.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    console.error(JSON.stringify({
      severity: "CRITICAL",
      message: `Invalid environment variables:\n${missing}`,
    }));
    process.exit(1);
  }

  return parsed.data;
}

export const env = loadEnv();
export type Env = z.infer<typeof envSchema>;
