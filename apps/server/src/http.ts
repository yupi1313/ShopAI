import Fastify from "fastify";
import type { AppLogger } from "./logger.js";

export interface HttpDeps {
  log: AppLogger;
  host: string;
  port: number;
  isReady(): boolean;
}

/** Health endpoint now; the family web page and its API mount here in Phase 3. */
export async function startHttp(deps: HttpDeps) {
  const app = Fastify({ logger: false });
  const startedAt = Date.now();
  app.get("/healthz", async (_req, reply) => {
    const ready = deps.isReady();
    reply.code(ready ? 200 : 503);
    return { ok: ready, uptimeSec: Math.round((Date.now() - startedAt) / 1000) };
  });
  app.get("/", async () => ({ name: "shopai", status: "phase-1", web: "coming in phase 3" }));
  await app.listen({ host: deps.host, port: deps.port });
  deps.log.info({ host: deps.host, port: deps.port }, "http listening");
  return app;
}
