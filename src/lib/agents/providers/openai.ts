import OpenAI from "openai";
import type { LoopInput, LoopResult } from "../types";

export const OPENAI_AGENT_MODEL = process.env.OPENAI_MODEL ?? "gpt-5.5";

/** Agent loop on OpenAI chat completions with function tools. */
export async function runOpenAI(input: LoopInput): Promise<LoopResult> {
  const client = new OpenAI(); // reads OPENAI_API_KEY
  const tools: OpenAI.Chat.ChatCompletionTool[] = input.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.schema } }));
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: input.system },
    { role: "user", content: input.prompt },
  ];
  let inputTokens = 0, outputTokens = 0, text = "", model = OPENAI_AGENT_MODEL;

  for (let turn = 0; turn < input.maxTurns; turn++) {
    const res = await client.chat.completions.create({ model: OPENAI_AGENT_MODEL, messages, tools, max_completion_tokens: 16000 });
    model = res.model;
    inputTokens += res.usage?.prompt_tokens ?? 0;
    outputTokens += res.usage?.completion_tokens ?? 0;
    const msg = res.choices[0]?.message;
    if (!msg) break;
    if (msg.content?.trim()) { text = msg.content.trim(); await input.onText(text); }
    messages.push(msg);
    const calls = (msg.tool_calls ?? []).filter((c) => c.type === "function");
    if (!calls.length) break;
    for (const c of calls) {
      let content: string;
      try {
        content = await input.callTool(c.function.name, JSON.parse(c.function.arguments || "{}"));
      } catch (e) {
        content = `Error: ${(e as Error).message}`;
      }
      messages.push({ role: "tool", tool_call_id: c.id, content });
    }
  }
  return { text, inputTokens, outputTokens, model };
}
