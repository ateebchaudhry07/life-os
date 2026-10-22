import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";

const client = new Anthropic(); // reads ANTHROPIC_API_KEY

export const MODEL = process.env.CLAUDE_MODEL ?? "claude-opus-5-5";

type Effort = "low" | "medium" | "high";
type DocPart = { type: "document"; source: { type: "base64"; media_type: "application/pdf"; data: string } };

/**
 * One structured call: Claude reads `prompt` (plus optional PDF documents) and returns data matching `schema`.
 * Uses server-side refusal fallbacks so a declined request is retried on Anthropic's recommended model.
 */
export async function ask<S extends z.ZodType>(opts: {
  schema: S;
  system: string;
  prompt: string;
  effort?: Effort;
  documents?: DocPart[];
  maxTokens?: number;
}): Promise<z.infer<S>> {
  const response = await client.beta.messages.parse({
    model: MODEL,
    max_tokens: opts.maxTokens ?? 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: opts.system,
    output_config: { effort: opts.effort ?? "medium", format: betaZodOutputFormat(opts.schema) },
    messages: [{ role: "user", content: [...(opts.documents ?? []), { type: "text", text: opts.prompt }] }],
  });
  if (response.stop_reason === "refusal") throw new Error("Claude declined this request.");
  if (response.parsed_output == null) throw new Error(`Claude's answer didn't match the expected format (stop: ${response.stop_reason}).`);
  return response.parsed_output as z.infer<S>;
}

export const hasClaude = () => Boolean(process.env.ANTHROPIC_API_KEY);
