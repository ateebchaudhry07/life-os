import { revalidatePath } from "next/cache";
import { db, getSettings } from "../db";
import { AGENTS, agentByKey, providerFor } from "./defs";
import { TOOLS } from "./tools";
import { costUsd } from "./pricing";
import { runClaude, CLAUDE_AGENT_MODEL } from "./providers/claude";
import { runOpenAI, OPENAI_AGENT_MODEL } from "./providers/openai";
import { dayKey, fmt } from "../time";
import type { Provider } from "./types";

const clip = (s: string, n = 300) => (s.length > n ? s.slice(0, n) + "…" : s);

export function providerReady(p: Provider) {
  return p === "claude" ? Boolean(process.env.ANTHROPIC_API_KEY) : Boolean(process.env.OPENAI_API_KEY);
}

/** Run one agent end to end, logging every step so the dashboard can show it live. */
export async function runAgent(key: string, forced?: Provider) {
  const def = agentByKey(key);
  if (!def) throw new Error(`Unknown agent ${key}`);
  const settings = await getSettings();
  const provider = forced ?? providerFor(key, settings.agentProviders);
  const run = await db.agentRun.create({ data: { agent: key, provider, model: provider === "claude" ? CLAUDE_AGENT_MODEL : OPENAI_AGENT_MODEL } });
  const ctx = { runId: run.id, agent: key };
  const event = (kind: string, detail: string, tool?: string, ms?: number) => db.agentEvent.create({ data: { runId: run.id, kind, detail: clip(detail), tool, ms } });

  try {
    if (!providerReady(provider)) {
      const other = provider === "claude" ? "openai" : "claude";
      throw new Error(providerReady(other)
        ? `No ${provider === "claude" ? "Claude" : "OpenAI"} key yet. Switch this agent to ${other === "claude" ? "Claude" : "OpenAI"}, or add ${provider === "claude" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"} in Vercel.`
        : "Add ANTHROPIC_API_KEY (Claude) and/or OPENAI_API_KEY (OpenAI) in Vercel → Settings → Environment Variables, then redeploy.");
    }
    await event("start", `${def.name} started on ${provider}`);
    const tools = def.tools.map((t) => TOOLS[t]).filter(Boolean);
    const loop = provider === "claude" ? runClaude : runOpenAI;
    const result = await loop({
      system: def.system,
      prompt: `Today is ${fmt.longDay(new Date())} (${dayKey()}).\n\n${def.task}`,
      tools,
      maxTurns: 14,
      onText: async (t) => { await event("message", t); },
      callTool: async (name, input) => {
        const tool = tools.find((t) => t.name === name);
        if (!tool) return `Unknown tool ${name}`;
        const t0 = Date.now();
        try {
          const out = await tool.run(input, ctx);
          const text = typeof out === "string" ? out : JSON.stringify(out);
          await event("tool", `${name}(${clip(JSON.stringify(input), 120)}) → ${clip(text, 160)}`, name, Date.now() - t0);
          return text.slice(0, 30_000);
        } catch (e) {
          await event("error", `${name} failed: ${(e as Error).message}`, name, Date.now() - t0);
          throw e;
        }
      },
    });
    await db.agentRun.update({
      where: { id: run.id },
      data: { status: "done", finishedAt: new Date(), model: result.model, inputTokens: result.inputTokens, outputTokens: result.outputTokens, costUsd: costUsd(result.model, result.inputTokens, result.outputTokens), summary: result.text || "Finished." },
    });
    await event("done", `Finished · ${result.inputTokens + result.outputTokens} tokens`);
  } catch (e) {
    const msg = (e as Error).message;
    await db.agentRun.update({ where: { id: run.id }, data: { status: "error", finishedAt: new Date(), error: msg } });
    await event("error", msg);
  }
  try { revalidatePath("/"); } catch { /* not in a request (cron) */ }
  return run.id;
}

export async function runAllAgents() {
  // Mark runs that died mid-flight (function timeout) so they don't show as working forever.
  await db.agentRun.updateMany({ where: { status: "running", startedAt: { lt: new Date(Date.now() - 10 * 60_000) } }, data: { status: "error", error: "Timed out", finishedAt: new Date() } });
  return Promise.allSettled(AGENTS.map((a) => runAgent(a.key)));
}
