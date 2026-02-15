import { z } from "zod";
import dotenv from "dotenv";

dotenv.config();

const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),

  // Database
  DATABASE_URL: z.string().url(),

  // Redis
  REDIS_URL: z.string().default("redis://localhost:6379"),

  // Pipedrive
  PIPEDRIVE_API_TOKEN: z.string().min(1),
  PIPEDRIVE_COMPANY_DOMAIN: z.string().min(1),

  // Meta
  META_APP_SECRET: z.string().min(1),
  META_VERIFY_TOKEN: z.string().min(1),
  META_ACCESS_TOKEN: z.string().min(1),
  META_PAGE_ID: z.string().min(1),

  // Google Ads
  GOOGLE_ADS_WEBHOOK_SECRET: z.string().min(1),

  // WhatsApp
  WHATSAPP_API_URL: z.string().url(),
  WHATSAPP_API_KEY: z.string().min(1),
  WHATSAPP_INSTANCE: z.string().default("parket-main"),
  WHATSAPP_SDR_GROUP: z.string().default(""),
  WHATSAPP_OPS_GROUP: z.string().default(""),

  // Sentry
  SENTRY_DSN: z.string().default(""),

  // Slack
  SLACK_WEBHOOK_URL: z.string().default(""),
});

function loadEnv() {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    const missing = parsed.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    console.error(`\n❌ Invalid environment variables:\n${missing}\n`);
    console.error("Copy .env.example to .env and fill in the values.");
    process.exit(1);
  }

  return parsed.data;
}

export const env = loadEnv();
export type Env = z.infer<typeof envSchema>;
