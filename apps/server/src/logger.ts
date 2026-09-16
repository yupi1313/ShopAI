import pino from "pino";

export function createLogger(level: string) {
  return pino({
    level,
    base: { service: "shopai-server" },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: ["*.token", "*.apiKey", "req.headers.authorization"], censor: "[redacted]" },
  });
}

export type AppLogger = ReturnType<typeof createLogger>;
