import pg from "pg";
import { Kysely, PostgresDialect } from "kysely";
import { createChildLogger } from "../config/logger.js";
import type { Database } from "./schemas/types.js";

const log = createChildLogger("db");

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on("error", (err) => {
  log.error({ err }, "Unexpected pool error");
});

export const db = new Kysely<Database>({
  dialect: new PostgresDialect({ pool }),
});

export async function checkDbHealth(): Promise<boolean> {
  try {
    await db.selectFrom("leads").select(db.fn.count("id").as("count")).execute();
    return true;
  } catch {
    // Table might not exist yet, just check connection
    try {
      const client = await pool.connect();
      await client.query("SELECT 1");
      client.release();
      return true;
    } catch {
      return false;
    }
  }
}

export async function closeDb(): Promise<void> {
  await db.destroy();
  log.info("Database connections closed");
}
