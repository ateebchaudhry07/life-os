/** A tool an agent can call. `schema` is plain JSON Schema so both Claude and OpenAI can use it. */
export type AgentTool = {
  name: string;
  description: string;
  schema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
  run: (input: Record<string, unknown>, ctx: RunContext) => Promise<unknown>;
};

export type RunContext = { runId: string; agent: string };

export type Provider = "claude" | "openai";

/** What a provider loop needs: it calls `callTool` for each tool use and reports usage back. */
export type LoopInput = {
  system: string;
  prompt: string;
  tools: AgentTool[];
  callTool: (name: string, input: Record<string, unknown>) => Promise<string>;
  onText: (text: string) => Promise<void>;
  maxTurns: number;
};

export type LoopResult = { text: string; inputTokens: number; outputTokens: number; model: string };
