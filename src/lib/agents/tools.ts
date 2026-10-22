import { db } from "../db";
import { searchMail, listMany } from "../google";
import { BUSY_CALENDARS } from "../config";
import { freeWindows } from "../jobs/weeklyPlan";
import { addDays, at, dayKey, fmt } from "../time";
import type { AgentTool, RunContext } from "./types";

const num = (v: unknown, d: number) => (typeof v === "number" && isFinite(v) ? v : typeof v === "string" && v.trim() && isFinite(Number(v)) ? Number(v) : d);
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const day = (d: Date) => `${dayKey(d)} ${fmt.hhmm(d)}`;

/** Writes never happen directly: they become a Proposal you approve or deny on the dashboard. */
async function propose(ctx: RunContext, kind: string, title: string, action: Record<string, unknown>, detail?: string) {
  const dup = await db.proposal.findFirst({ where: { status: "pending", kind, title } });
  if (dup) return `Already waiting for approval: "${title}".`;
  await db.proposal.create({ data: { runId: ctx.runId, agent: ctx.agent, kind, title, detail: detail || null, action: action as object } });
  await db.agentEvent.create({ data: { runId: ctx.runId, kind: "proposal", tool: kind, detail: title } });
  return `Queued for Ateeb's approval: "${title}". Do not assume it happened.`;
}

export const TOOLS: Record<string, AgentTool> = {
  // ---------- AteebCuts ----------
  list_cuts: {
    name: "list_cuts",
    description: "List haircut appointments in a date window (Eastern time). Returns id, client, start, status, price, amount paid, payment method, source.",
    schema: { type: "object", properties: { days_back: { type: "number", description: "How many days back (default 14)" }, days_ahead: { type: "number", description: "How many days ahead (default 7)" }, status: { type: "string", enum: ["BOOKED", "COMPLETED", "CANCELLED", "NO_SHOW"] } } },
    run: async (i) => {
      const today = dayKey();
      const rows = await db.appointment.findMany({
        where: { start: { gte: at(addDays(today, -num(i.days_back, 14))), lt: at(addDays(today, num(i.days_ahead, 7) + 1)) }, ...(str(i.status) ? { status: str(i.status) as "BOOKED" } : {}) },
        include: { client: true }, orderBy: { start: "asc" }, take: 150,
      });
      return rows.map((a) => ({ id: a.id, client: a.client.name, start: day(a.start), status: a.status, price: a.price, paid: a.amountPaid, method: a.paymentMethod, source: a.source }));
    },
  },
  cut_payments: {
    name: "cut_payments",
    description: "Venmo/Zelle/cash payments recorded as AteebCuts income in the last N days, with whether each is linked to an appointment.",
    schema: { type: "object", properties: { days: { type: "number", description: "Days back (default 21)" } } },
    run: async (i) => {
      const rows = await db.transaction.findMany({ where: { category: { name: "AteebCuts Income" }, date: { gte: at(addDays(dayKey(), -num(i.days, 21))) } }, orderBy: { date: "desc" }, take: 150 });
      return rows.map((t) => ({ id: t.id, date: day(t.date), name: t.name, amount: t.amount, account: t.account, linkedAppointment: t.appointmentId }));
    },
  },
  propose_mark_cut: {
    name: "propose_mark_cut",
    description: "Ask Ateeb to approve updating one appointment (e.g. mark a past cut COMPLETED with what was paid, or CANCELLED / NO_SHOW). Use the appointment id from list_cuts.",
    schema: { type: "object", properties: { appointment_id: { type: "string" }, status: { type: "string", enum: ["COMPLETED", "CANCELLED", "NO_SHOW"] }, amount: { type: "number" }, method: { type: "string", description: "Cash, Zelle, Venmo, Cash App, Apple Cash" }, why: { type: "string" } }, required: ["appointment_id", "status", "why"] },
    run: async (i, ctx) => {
      const a = await db.appointment.findUnique({ where: { id: str(i.appointment_id) }, include: { client: true } });
      if (!a) return "No appointment with that id.";
      const amt = i.amount != null ? ` · $${num(i.amount, 0)}${str(i.method) ? " " + str(i.method) : ""}` : "";
      return propose(ctx, "mark_cut", `Mark ${a.client.name} (${fmt.short(a.start)}) ${str(i.status).toLowerCase()}${amt}`, { appointmentId: a.id, status: str(i.status), amount: i.amount ?? null, method: str(i.method) || null }, str(i.why));
    },
  },
  draft_message: {
    name: "draft_message",
    description: "Draft a short text Ateeb can send to a client (payment reminder, rebooking nudge). It is shown for him to copy; nothing is sent.",
    schema: { type: "object", properties: { to: { type: "string" }, text: { type: "string" }, why: { type: "string" } }, required: ["to", "text", "why"] },
    run: async (i, ctx) => propose(ctx, "message", `Text to ${str(i.to)}`, { to: str(i.to), text: str(i.text) }, str(i.why)),
  },

  // ---------- Money ----------
  spending_summary: {
    name: "spending_summary",
    description: "Money in and out over the last N days: totals by category (with monthly budgets), income, investing and transfers.",
    schema: { type: "object", properties: { days: { type: "number", description: "Days back (default 30)" } } },
    run: async (i) => {
      const days = num(i.days, 30);
      const tx = await db.transaction.findMany({ where: { date: { gte: at(addDays(dayKey(), -days)) } }, include: { category: true } });
      const by = new Map<string, { type: string; total: number; count: number; budget: number | null }>();
      for (const t of tx) {
        const k = `${t.type}|${t.category?.name ?? "Uncategorized"}`;
        const c = by.get(k) ?? { type: t.type, total: 0, count: 0, budget: t.category?.monthlyBudget ?? null };
        c.total += t.amount; c.count++; by.set(k, c);
      }
      return [...by].map(([k, v]) => ({ category: k.split("|")[1], ...v, total: Math.round(v.total * 100) / 100 })).sort((a, b) => b.total - a.total);
    },
  },
  list_transactions: {
    name: "list_transactions",
    description: "List individual transactions (newest first). Filter by category name or type.",
    schema: { type: "object", properties: { days: { type: "number" }, category: { type: "string" }, type: { type: "string", enum: ["INCOME", "EXPENSE", "TRANSFER", "INTERNAL"] }, limit: { type: "number" } } },
    run: async (i) => {
      const rows = await db.transaction.findMany({
        where: { date: { gte: at(addDays(dayKey(), -num(i.days, 30))) }, ...(str(i.type) ? { type: str(i.type) as "EXPENSE" } : {}), ...(str(i.category) ? { category: { name: str(i.category) } } : {}) },
        include: { category: true }, orderBy: { date: "desc" }, take: Math.min(num(i.limit, 60), 150),
      });
      return rows.map((t) => ({ id: t.id, date: dayKey(t.date), name: t.name, amount: t.amount, type: t.type, category: t.category?.name ?? null, account: t.account }));
    },
  },
  propose_category: {
    name: "propose_category",
    description: "Ask Ateeb to approve moving a transaction to a different category. Category must be one of the existing names (see spending_summary).",
    schema: { type: "object", properties: { transaction_id: { type: "string" }, category: { type: "string" }, why: { type: "string" } }, required: ["transaction_id", "category", "why"] },
    run: async (i, ctx) => {
      const t = await db.transaction.findUnique({ where: { id: str(i.transaction_id) } });
      const cat = await db.category.findUnique({ where: { name: str(i.category) } });
      if (!t) return "No transaction with that id.";
      if (!cat) return `No category named "${str(i.category)}".`;
      return propose(ctx, "categorize", `Move "${t.name}" $${t.amount} → ${cat.name}`, { transactionId: t.id, category: cat.name }, str(i.why));
    },
  },

  // ---------- School ----------
  school_overview: {
    name: "school_overview",
    description: "Open assignments/quizzes due in the next 21 days (and overdue), upcoming exams, and lecture reviews due.",
    schema: { type: "object", properties: {} },
    run: async () => {
      const now = new Date();
      const [work, exams, reviews] = await Promise.all([
        db.assignment.findMany({ where: { completed: false, kind: { not: "exam" }, due: { lte: at(addDays(dayKey(), 21)) } }, include: { course: true }, orderBy: { due: "asc" }, take: 60 }),
        db.assignment.findMany({ where: { kind: "exam", due: { gte: now } }, include: { course: true }, orderBy: { due: "asc" }, take: 10 }),
        db.lectureReview.findMany({ where: { doneAt: null, due: { lt: at(addDays(dayKey(), 1)) } }, include: { lecture: { include: { course: true } } }, take: 40 }),
      ]);
      return {
        assignments: work.map((a) => ({ title: a.title, course: a.course?.code, due: a.due ? day(a.due) : null, overdue: !!a.due && a.due < now, kind: a.kind, url: a.url })),
        exams: exams.map((e) => ({ title: e.title, course: e.course?.code, at: day(e.due!), location: e.location })),
        lectureReviewsDue: reviews.map((r) => ({ course: r.lecture.course?.code, lecture: r.lecture.title, stage: r.stage, due: dayKey(r.due) })),
      };
    },
  },
  free_time: {
    name: "free_time",
    description: "Free windows on Ateeb's calendars for the next N days (between wake time and 22:45, with 15-min buffers around events).",
    schema: { type: "object", properties: { days_ahead: { type: "number", description: "1-10 (default 5)" } } },
    run: async (i) => {
      const s = await db.settings.findUnique({ where: { id: "me" } });
      const days = Array.from({ length: Math.min(Math.max(num(i.days_ahead, 5), 1), 10) }, (_, k) => addDays(dayKey(), k));
      const busy = await listMany([...BUSY_CALENDARS, "study", "gym"], at(days[0]), at(addDays(days[days.length - 1], 1)));
      return freeWindows(days, busy, s?.wakeTime ?? "06:00", "22:45");
    },
  },
  propose_study_block: {
    name: "propose_study_block",
    description: "Ask Ateeb to approve putting a study block on his Study calendar. start is Eastern local time 'YYYY-MM-DD HH:mm'; pick a slot from free_time.",
    schema: { type: "object", properties: { title: { type: "string" }, start: { type: "string" }, minutes: { type: "number" }, why: { type: "string" } }, required: ["title", "start", "minutes", "why"] },
    run: async (i, ctx) => {
      const m = str(i.start).match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/);
      if (!m) return "start must look like 2026-10-24 14:00";
      const start = at(m[1], m[2]), mins = Math.min(Math.max(num(i.minutes, 60), 15), 240);
      return propose(ctx, "calendar_block", `${str(i.title)} · ${fmt.day(start)} ${fmt.time(start)} (${mins} min)`, { title: str(i.title), start: start.toISOString(), end: new Date(start.getTime() + mins * 60_000).toISOString() }, str(i.why));
    },
  },

  // ---------- Shared ----------
  search_email: {
    name: "search_email",
    description: "Search Ateeb's Gmail (Gmail search syntax). Returns date, from, subject and a short snippet.",
    schema: { type: "object", properties: { query: { type: "string" }, max: { type: "number" } }, required: ["query"] },
    run: async (i) => (await searchMail(str(i.query), Math.min(num(i.max, 10), 20))).map((m) => ({ date: day(m.date), from: m.from, subject: m.subject, snippet: m.snippet.slice(0, 200) })),
  },
  propose_reminder: {
    name: "propose_reminder",
    description: "Ask Ateeb to approve adding a reminder to his Reminders list (optional due date YYYY-MM-DD).",
    schema: { type: "object", properties: { title: { type: "string" }, due_date: { type: "string" }, url: { type: "string" }, why: { type: "string" } }, required: ["title", "why"] },
    run: async (i, ctx) => propose(ctx, "reminder", `Reminder: ${str(i.title)}${str(i.due_date) ? ` (due ${str(i.due_date)})` : ""}`, { title: str(i.title), due: str(i.due_date) || null, url: str(i.url) || null, notes: str(i.why) || null }, str(i.why)),
  },
};
