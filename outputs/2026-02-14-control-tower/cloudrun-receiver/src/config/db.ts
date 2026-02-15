import pg from "pg";
import { env } from "./env.js";
import { createLogger } from "./logger.js";

const log = createLogger("db");

function buildConnectionConfig(): pg.PoolConfig {
  // Cloud Run connects via Unix socket
  if (env.CLOUD_SQL_CONNECTION_NAME) {
    return {
      host: `${env.DB_HOST}/${env.CLOUD_SQL_CONNECTION_NAME}`,
      database: env.DB_NAME,
      user: env.DB_USER,
      password: env.DB_PASS,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    };
  }

  // Local development via TCP
  return {
    host: env.DB_HOST,
    port: env.DB_PORT,
    database: env.DB_NAME,
    user: env.DB_USER,
    password: env.DB_PASS,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  };
}

export const pool = new pg.Pool(buildConnectionConfig());

pool.on("error", (err) => {
  log.error("Unexpected database pool error", { error: err.message });
});

export async function checkDbHealth(): Promise<boolean> {
  try {
    const client = await pool.connect();
    await client.query("SELECT 1");
    client.release();
    return true;
  } catch {
    return false;
  }
}

export async function closeDb(): Promise<void> {
  await pool.end();
  log.info("Database pool closed");
}
