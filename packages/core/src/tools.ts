import { z } from "zod";
import type { ToolSpec } from "@shopai/llm";
import type { Capability, ToolContext, ToolDef } from "./types.js";

export interface ToolExecution {
  name: string;
  ok: boolean;
  result: unknown;
  ms: number;
}

const NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/u;

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDef<unknown>>();
  readonly byCapability = new Map<string, string>();

  constructor(capabilities: Capability[]) {
    for (const cap of capabilities) {
      for (const tool of cap.tools) {
        if (!NAME_RE.test(tool.name)) throw new Error(`tool name not allowed by the API: ${tool.name}`);
        if (this.tools.has(tool.name)) throw new Error(`duplicate tool name: ${tool.name}`);
        this.tools.set(tool.name, tool as ToolDef<unknown>);
        this.byCapability.set(tool.name, cap.name);
      }
    }
  }

  get(name: string): ToolDef<unknown> | undefined {
    return this.tools.get(name);
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  /** OpenAI `tools` array. zod 4 emits JSON Schema natively. */
  specs(): ToolSpec[] {
    return [...this.tools.values()].map((t) => {
      const json = z.toJSONSchema(t.schema, { target: "draft-7", io: "input" }) as Record<string, unknown>;
      delete json.$schema;
      return {
        type: "function",
        function: { name: t.name, description: t.description, parameters: json },
      };
    });
  }

  /**
   * Parse + validate + run one tool call. Never throws: the model gets an
   * `{ error }` object it can react to, and the caller gets `ok: false`.
   */
  async execute(name: string, rawArgs: string, ctx: ToolContext): Promise<ToolExecution> {
    const started = Date.now();
    const tool = this.tools.get(name);
    if (!tool) {
      return { name, ok: false, result: { error: `unknown tool: ${name}` }, ms: 0 };
    }
    let parsedArgs: unknown;
    try {
      parsedArgs = rawArgs.trim() ? JSON.parse(rawArgs) : {};
    } catch {
      return { name, ok: false, result: { error: "arguments were not valid JSON" }, ms: Date.now() - started };
    }
    const check = tool.schema.safeParse(parsedArgs);
    if (!check.success) {
      const issues = check.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).slice(0, 6);
      return { name, ok: false, result: { error: "invalid arguments", issues }, ms: Date.now() - started };
    }
    try {
      const result = await tool.handler(check.data, ctx);
      return { name, ok: true, result: result ?? { ok: true }, ms: Date.now() - started };
    } catch (err) {
      ctx.log.error({ err, tool: name }, "tool handler failed");
      return {
        name,
        ok: false,
        result: { error: err instanceof Error ? err.message : "tool failed" },
        ms: Date.now() - started,
      };
    }
  }
}

/** Keep tool results small: the model should spend its budget on deciding, not reading. */
export function compactJson(value: unknown, maxChars = 6000): string {
  let s: string;
  try {
    s = JSON.stringify(value);
  } catch {
    s = String(value);
  }
  if (s.length <= maxChars) return s;
  return `${s.slice(0, maxChars)}…(truncated ${s.length - maxChars} chars)`;
}
