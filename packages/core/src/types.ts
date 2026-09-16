import type { z } from "zod";
import type { Db, Household, Member } from "@shopai/db";

/** Minimal logger surface; pino satisfies it. */
export interface Logger {
  debug(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
  child(bindings: Record<string, unknown>): Logger;
}

export type ChatKind = "private" | "group" | "supergroup" | "web";

/** Everything a tool handler may need. Built once per incoming message. */
export interface ToolContext {
  db: Db;
  log: Logger;
  household: Household;
  member: Member;
  /** Stable key of the conversation, e.g. `tg:-100123` or `web:42`. */
  chatKey: string;
  chatKind: ChatKind;
  now: Date;
}

export type SideEffect = "none" | "list" | "shop";

export interface ToolDef<TArgs = unknown> {
  /** OpenAI function name: `^[a-zA-Z0-9_-]{1,64}$`. */
  name: string;
  description: string;
  schema: z.ZodType<TArgs>;
  /**
   * "shop" tools never run straight from the model: the call is stored as a
   * pending action and executed only after a human confirms.
   */
  sideEffect: SideEffect;
  handler(args: TArgs, ctx: ToolContext): Promise<unknown>;
}

export interface Capability {
  name: string;
  tools: ToolDef<never>[];
  /** Dynamic prompt snippet (e.g. the current list). Keep it compact. */
  promptFragment?(ctx: ToolContext): Promise<string>;
}

/** Helper to define a tool with its argument type inferred from the schema. */
export function defineTool<S extends z.ZodType>(def: {
  name: string;
  description: string;
  schema: S;
  sideEffect: SideEffect;
  handler(args: z.infer<S>, ctx: ToolContext): Promise<unknown>;
}): ToolDef<z.infer<S>> {
  return def as ToolDef<z.infer<S>>;
}
