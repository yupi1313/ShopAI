import postgres, { type Sql } from "postgres";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "./schema.js";

export * from "./schema.js";
export { runMigrations, defaultMigrationsDir } from "./migrate.js";
export { and, asc, desc, eq, inArray, isNull, ne, sql as sqlTag } from "drizzle-orm";

export type Db = PostgresJsDatabase<typeof schema>;

export interface DbHandle {
  db: Db;
  sql: Sql;
  close(): Promise<void>;
}

export function createDb(databaseUrl: string, opts: { max?: number } = {}): DbHandle {
  const sql = postgres(databaseUrl, {
    max: opts.max ?? 8,
    idle_timeout: 30,
    connect_timeout: 15,
    onnotice: () => {},
  });
  const db = drizzle(sql, { schema });
  return {
    db,
    sql,
    async close() {
      await sql.end({ timeout: 5 });
    },
  };
}
