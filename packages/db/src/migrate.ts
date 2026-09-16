// Minimal, dependency-free SQL migration runner. Files in ../migrations named
// NNNN_name.sql are applied in lexical order inside one transaction each and
// recorded in schema_migrations. Idempotent: re-running applies nothing.

import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { Sql } from "postgres";

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

export function defaultMigrationsDir(): string {
  // dist/migrate.js -> ../migrations (sibling of dist and src)
  return fileURLToPath(new URL("../migrations/", import.meta.url));
}

export async function runMigrations(sql: Sql, dir = defaultMigrationsDir()): Promise<MigrationResult> {
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `;
  // Serialise concurrent boots (two replicas, or a restart racing a slow apply).
  await sql`SELECT pg_advisory_lock(727001)`;
  try {
    const files = (await readdir(dir)).filter((f) => /^\d{4}_.+\.sql$/u.test(f)).sort();
    const done = new Set(
      (await sql<{ version: string }[]>`SELECT version FROM schema_migrations`).map((r) => r.version),
    );
    const applied: string[] = [];
    const skipped: string[] = [];
    for (const file of files) {
      const version = file.replace(/\.sql$/u, "");
      if (done.has(version)) {
        skipped.push(version);
        continue;
      }
      const body = await readFile(path.join(dir, file), "utf8");
      await sql.begin(async (tx) => {
        await tx.unsafe(body);
        await tx`INSERT INTO schema_migrations (version) VALUES (${version})`;
      });
      applied.push(version);
    }
    return { applied, skipped };
  } finally {
    await sql`SELECT pg_advisory_unlock(727001)`;
  }
}
