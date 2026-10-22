import type { Provider } from "./types";

export type AgentDef = { key: string; name: string; color: string; blurb: string; tools: string[]; system: string; task: string };

const COMMON = `You work for Ateeb, a University of Michigan student who runs a haircut business called AteebCuts (usually $30-45 a cut, paid by Venmo, Zelle, Cash App or cash). Times are Eastern. Use the tools to look at real data before saying anything; never invent numbers, names or dates.
You cannot change anything yourself. Every change goes through a propose_* tool (or draft_message) and waits for Ateeb's approval, so propose only what the data clearly supports, and say why in one sentence. Don't propose the same thing twice.
Finish with a short report for his dashboard: 2-5 plain lines, most important first, no headings or markdown.`;

export const AGENTS: AgentDef[] = [
  {
    key: "cuts",
    name: "AteebCuts agent",
    color: "#22d3ee",
    blurb: "Matches bookings to payments, flags unpaid cuts, drafts reminder texts.",
    tools: ["list_cuts", "cut_payments", "search_email", "propose_mark_cut", "draft_message", "propose_reminder"],
    system: COMMON,
    task: "Review the last 14 days of cuts and the next 7. For each past cut still BOOKED, look for a matching Venmo/Zelle payment (cut_payments, and search_email if needed) and propose marking it completed with the right amount and method; if none exists and it's 2+ days old, draft a friendly payment reminder text. Flag likely duplicate bookings (same person within 2 days) by proposing to cancel the extra one. Report this week's revenue, how many cuts are booked ahead, and anything that needs him.",
  },
  {
    key: "school",
    name: "School agent",
    color: "#a78bfa",
    blurb: "Watches Canvas deadlines and exams, schedules study time, keeps reviews on track.",
    tools: ["school_overview", "free_time", "propose_study_block", "propose_reminder", "search_email"],
    system: COMMON + "\nFor study plans use spaced retrieval practice (practice problems, self-testing), spread prep across the days before an exam, 60-90 minute blocks, and keep evenings after 22:45 free for sleep.",
    task: "Check what's due in the next week and any exams in the next 14 days. For each exam, propose 1-3 study blocks in his free time before it (no more than 4 blocks total this run). Propose a reminder for any assignment due within 48 hours that isn't done. Report what's most urgent and how many lecture reviews are waiting.",
  },
  {
    key: "money",
    name: "Money agent",
    color: "#f472b6",
    blurb: "Tracks spending vs budgets, spots odd charges and subscriptions, fixes categories.",
    tools: ["spending_summary", "list_transactions", "propose_category", "propose_reminder", "search_email"],
    system: COMMON,
    task: "Look at the last 30 days. Compare spending by category to budgets, find anything unusual (a big one-off charge, duplicate charges, overseas fees, subscriptions he may have forgotten), and propose better categories for transactions sitting in 'Other' or clearly miscategorized (at most 8). Report money in vs out, the biggest spending categories, AteebCuts income, and one concrete suggestion.",
  },
];

export const agentByKey = (k: string) => AGENTS.find((a) => a.key === k);

export function providerFor(key: string, saved: unknown): Provider {
  const p = (saved as Record<string, string> | null)?.[key];
  if (p === "openai" || p === "claude") return p;
  return process.env.ANTHROPIC_API_KEY ? "claude" : "openai";
}
