import { createDb, runMigrations } from "@shopai/db";
import { createZagiClient, zagiConfigFromEnv } from "@shopai/llm";
import { Agent } from "@shopai/core";
import { groceryCapability } from "@shopai/capability-grocery";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { ensureAdmin, ensureHousehold } from "./bootstrap.js";
import { makeSystemPromptBuilder } from "./prompt.js";
import { BOT_COMMANDS, createBot } from "./telegram/bot.js";
import { startHttp } from "./http.js";
import { startLiveness } from "./liveness.js";

async function main(): Promise<void> {
  const cfg = loadConfig();
  const log = createLogger(cfg.LOG_LEVEL);
  process.env.TZ ??= cfg.TZ;

  const handle = createDb(cfg.DATABASE_URL);
  const mig = await runMigrations(handle.sql);
  log.info({ applied: mig.applied, skipped: mig.skipped.length }, "migrations");

  const household = await ensureHousehold(handle.db, cfg);
  if (cfg.ADMIN_TELEGRAM_ID) await ensureAdmin(handle.db, household, cfg.ADMIN_TELEGRAM_ID);
  else log.warn("ADMIN_TELEGRAM_ID not set: nobody is a member yet; set it and restart");
  log.info({ household: household.name, id: household.id }, "household ready");

  const zagiCfg = zagiConfigFromEnv();
  const agent = zagiCfg
    ? new Agent({
        llm: createZagiClient(zagiCfg),
        db: handle.db,
        log,
        capabilities: [groceryCapability],
        buildSystemPrompt: makeSystemPromptBuilder(handle.db),
      })
    : null;
  if (agent) log.info({ model: zagiCfg?.model, tools: agent.registry.names() }, "agent ready");
  else log.warn("ZAGI not configured: free-text chat idles, commands and buttons work");

  const bot = createBot({ cfg, db: handle.db, log, agent, household });
  await bot.init();
  await bot.api.setMyCommands(BOT_COMMANDS).catch((err) => log.warn({ err }, "setMyCommands failed"));
  log.info({ username: bot.botInfo.username }, "telegram bot ready");

  let polling = false;
  const http = await startHttp({ log, host: cfg.HTTP_HOST, port: cfg.HTTP_PORT, isReady: () => polling });
  const stopLiveness = startLiveness(cfg.LIVENESS_FILE, () => polling);

  const shutdown = async (signal: string) => {
    log.info({ signal }, "shutting down");
    polling = false;
    stopLiveness();
    await bot.stop().catch(() => {});
    await http.close().catch(() => {});
    await handle.close().catch(() => {});
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  polling = true;
  await bot.start({
    allowed_updates: ["message", "callback_query", "my_chat_member"],
    onStart: (info) => log.info({ username: info.username }, "long polling started"),
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
