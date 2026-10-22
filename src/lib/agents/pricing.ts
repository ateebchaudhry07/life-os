// $ per 1M tokens. Claude prices from Anthropic's published rates; OpenAI is an estimate, override with
// OPENAI_PRICE_IN / OPENAI_PRICE_OUT if your model costs something else.
const CLAUDE: Record<string, [number, number]> = {
  "claude-opus-5-5": [4, 20],
  "claude-sonnet-5-5": [2, 10],
  "claude-haiku-5-5": [0.1, 0.5],
  "claude-fable-5-1": [10, 50],
};

export function costUsd(model: string, inputTokens: number, outputTokens: number) {
  const [i, o] = CLAUDE[model] ?? (model.startsWith("claude") ? [4, 20] : [Number(process.env.OPENAI_PRICE_IN ?? 1.25), Number(process.env.OPENAI_PRICE_OUT ?? 10)]);
  return (inputTokens * i + outputTokens * o) / 1_000_000;
}
