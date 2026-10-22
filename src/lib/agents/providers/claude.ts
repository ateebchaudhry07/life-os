import Anthropic from "@anthropic-ai/sdk";
import type { LoopInput, LoopResult } from "../types";

export const CLAUDE_AGENT_MODEL = process.env.CLAUDE_AGENT_MODEL ?? "claude-opus-5-5";

/** Agent loop on Claude: send tools, run each tool_use, return all results in one user turn, repeat. */
export async function runClaude(input: LoopInput): Promise<LoopResult> {
  const client = new Anthropic();
  const tools: Anthropic.Beta.BetaTool[] = input.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.schema }));
  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: input.prompt }];
  let inputTokens = 0, outputTokens = 0, text = "", model = CLAUDE_AGENT_MODEL;

  for (let turn = 0; turn < input.maxTurns; turn++) {
    const res = await client.beta.messages.create({
      model: CLAUDE_AGENT_MODEL,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default", // if Claude declines, Anthropic re-runs the request on its recommended fallback model
      output_config: { effort: "medium" },
      system: input.system,
      tools,
      messages,
    });
    model = res.model;
    inputTokens += res.usage.input_tokens + (res.usage.cache_read_input_tokens ?? 0) + (res.usage.cache_creation_input_tokens ?? 0);
    outputTokens += res.usage.output_tokens;
    if (res.stop_reason === "refusal") throw new Error("Claude declined this request.");

    const said = res.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text").map((b) => b.text).join("\n").trim();
    if (said) { text = said; await input.onText(said); }
    // Keep the full assistant content (thinking blocks included) so the next turn stays valid.
    messages.push({ role: "assistant", content: res.content });
    if (res.stop_reason === "pause_turn") continue;

    const uses = res.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    if (!uses.length) break;
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const u of uses) {
      try {
        results.push({ type: "tool_result", tool_use_id: u.id, content: await input.callTool(u.name, (u.input ?? {}) as Record<string, unknown>) });
      } catch (e) {
        results.push({ type: "tool_result", tool_use_id: u.id, content: `Error: ${(e as Error).message}`, is_error: true });
      }
    }
    messages.push({ role: "user", content: results });
  }
  return { text, inputTokens, outputTokens, model };
}
