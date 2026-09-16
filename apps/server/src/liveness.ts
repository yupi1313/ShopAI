import { writeFile } from "node:fs/promises";

/** Touch a file every 15 s; the Docker healthcheck fails if it goes stale. */
export function startLiveness(path: string, isAlive: () => boolean): () => void {
  const tick = () => {
    if (!isAlive()) return;
    void writeFile(path, String(Date.now())).catch(() => {});
  };
  tick();
  const timer = setInterval(tick, 15_000);
  return () => clearInterval(timer);
}
