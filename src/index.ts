import { createServer } from "./api/server.js";
import { createChildLogger } from "./config/logger.js";
import { closeDb } from "./db/connection.js";
import { closeRedis } from "./config/queue.js";
import { registerWorkers } from "./jobs/index.js";

const log = createChildLogger("main");
const PORT = Number(process.env.PORT) || 3000;

async function main() {
  log.info("Starting Parket Integrations...");

  // Register BullMQ workers
  registerWorkers();

  // Start HTTP server
  const app = createServer();
  const server = app.listen(PORT, () => {
    log.info({ port: PORT }, "Server listening");
  });

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    log.info({ signal }, "Shutting down...");
    server.close();
    await closeRedis();
    await closeDb();
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  log.fatal({ err }, "Failed to start");
  process.exit(1);
});
