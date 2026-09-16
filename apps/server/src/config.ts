import { existsSync } from "node:fs";
import path from "node:path";
import { config as loadDotenv } from "dotenv";
import { z } from "zod";

// Local dev: read .env from the repo root or the cwd. In Docker the env comes
// from compose and neither file exists, which is fine.
for (const candidate of [path.resolve(process.cwd(), ".env"), path.resolve(process.cwd(), "../../.env")]) {
  if (existsSync(candidate)) {
    loadDotenv({ path: candidate });
    break;
  }
}

const EnvSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(20),
  DATABASE_URL: z.string().min(1),
  // Optional so the stack can boot before the admin's id is known; until it is
  // set nobody is a member and every message is refused (and logged with the id).
  ADMIN_TELEGRAM_ID: z.preprocess(
    (v) => (v === "" || v === undefined || v === null ? undefined : v),
    z.coerce.number().int().positive().optional(),
  ),
  HOUSEHOLD_NAME: z.string().min(1).default("Family"),
  TZ: z.string().min(1).default("Europe/Amsterdam"),
  LOG_LEVEL: z.string().default("info"),
  HTTP_HOST: z.string().default("127.0.0.1"),
  HTTP_PORT: z.coerce.number().int().positive().default(3000),
  NICKNAMES: z.string().default("shopai,шопаи,шоппер,шон"),
  LIVENESS_FILE: z.string().default("/tmp/shopai-alive"),
  // Encrypts store tokens at rest. Required once a store is connected; if unset
  // the stack still boots and store features stay disabled.
  SESSION_SECRET: z.string().min(16).optional(),
  ZAGI_BASE_URL: z.string().optional(),
  ZAGI_API_KEY: z.string().optional(),
  ZAGI_MODEL: z.string().optional(),
});

export type AppConfig = z.infer<typeof EnvSchema> & { nicknames: string[] };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`invalid environment: ${issues}`);
  }
  const cfg = parsed.data;
  return {
    ...cfg,
    nicknames: cfg.NICKNAMES.split(",").map((s) => s.trim()).filter(Boolean),
  };
}
