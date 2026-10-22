import { z } from "zod";
import { db, getSettings, logEnd, logStart } from "../db";
import { createEvent, deleteEvent, listEvents, listMany, type CalEvent } from "../google";
import { ask } from "../claude";
import { notify } from "../notify";
import { BUSY_CALENDARS, PLANNER_TAG } from "../config";
import { addDays, at, dayKey, fmt, mondayOf } from "../time";

const Plan = z.object({
  blocks: z.array(
    z.object({
      day: z.string().describe("YYYY-MM-DD"),
      start: z.string().describe("HH:MM 24h Eastern"),
      end: z.string().describe("HH:MM 24h Eastern"),
      title: z.string().describe("Short, e.g. 'Physics 150 Exam 2 – practice problems'"),
      kind: z.enum(["study", "assignment", "review", "gym", "area"]),
      area: z.string().describe("One of the area names given"),
      reason: z.string().describe("One sentence: why this block, why now"),
    }),
  ),
  summary: z.string().describe("3-6 short lines for a phone notification: the week's shape, exams, anything that didn't fit"),
});

/** Free windows per day between wake and wind-down, minus busy events with 15-minute buffers. */
export function freeWindows(days: string[], busy: CalEvent[], wake: string, windDown: string) {
  const out: Record<string, string[]> = {};
  for (const day of days) {
    let free: [number, number][] = [[at(day, wake).getTime(), at(day, windDown).getTime()]];
    for (const e of busy) {
      if (e.allDay) continue;
      const s = e.start.getTime() - 15 * 60_000, en = e.end.getTime() + 15 * 60_000;
      free = free.flatMap(([a, b]) => (en <= a || s >= b ? [[a, b]] : [[a, Math.max(a, s)], [Math.min(b, en), b]]).filter(([x, y]) => y - x >= 30 * 60_000) as [number, number][]);
    }
    out[day] = free.map(([a, b]) => `${fmt.hhmm(new Date(a))}-${fmt.hhmm(new Date(b))}`);
  }
  return out;
}

export async function weeklyPlan(startDay?: string) {
  const log = await logStart("weekly-plan");
  try {
    const settings = await getSettings();
    const monday = startDay ?? addDays(mondayOf(dayKey()), 7); // run Sunday → plan the coming week
    const days = Array.from({ length: 7 }, (_, i) => addDays(monday, i));
    const from = at(monday), to = at(addDays(monday, 7));

    // Remove this week's previous plan (only events this app created).
    for (const key of ["study", "gym"] as const) {
      for (const e of await listEvents(key, from, to)) if (e.description?.includes(PLANNER_TAG)) await deleteEvent(key, e.id);
    }
    await db.planBlock.deleteMany({ where: { weekStart: from } });

    const busy = (await listMany([...BUSY_CALENDARS, "study", "gym"], from, to)).filter((e) => !e.description?.includes(PLANNER_TAG));
    const windDown = "22:45";
    const free = freeWindows(days, busy, settings.wakeTime, windDown);
    const areas = await db.area.findMany({ orderBy: { priority: "asc" } });
    const work = await db.assignment.findMany({
      where: { completed: false, due: { gte: at(addDays(monday, -7)), lte: at(addDays(monday, 21)) } },
      include: { course: true },
      orderBy: { due: "asc" },
    });
    const reminders = await db.reminder.findMany({ where: { done: false, OR: [{ due: null }, { due: { lte: at(addDays(monday, 14)) } }] }, orderBy: { due: "asc" } });
    const pendingReviews = await db.lectureReview.count({ where: { doneAt: null, due: { lt: to } } });

    const prompt = [
      `Plan the week ${monday} to ${days[6]} (Eastern time).`,
      `PRIORITIES (follow exactly; higher wins):\n${settings.priorities}`,
      `Gym target: ${settings.gymPerWeek} sessions of ${settings.gymMinutes} min.`,
      `AREAS (use these names): ${areas.map((a) => `${a.name}${a.weeklyGoalHours ? ` (goal ${a.weeklyGoalHours} h/week)` : ""}`).join(", ")}`,
      `FIXED EVENTS (never overlap):\n${busy.map((e) => `${dayKey(e.start)} ${e.allDay ? "all day" : fmt.hhmm(e.start) + "-" + fmt.hhmm(e.end)} ${e.title}`).join("\n")}`,
      `FREE WINDOWS (blocks must sit fully inside one):\n${days.map((d) => `${d}: ${free[d].join(", ") || "none"}`).join("\n")}`,
      `EXAMS, ASSIGNMENTS, QUIZZES (due; overdue ones still open first):\n${work.map((w) => `${w.due ? dayKey(w.due) + " " + fmt.hhmm(w.due) : "no date"} [${w.kind}] ${w.course?.code ?? ""} ${w.title}`).join("\n") || "none"}`,
      `REMINDERS / ERRANDS (give each one that needs real time a block before its due date, sized realistically, e.g. FAFSA ~60-90 min; skip quick ones):\n${reminders.map((r) => `${r.due ? dayKey(r.due) : "no date"} ${r.title}`).join("\n") || "none"}`,
      `Lecture reviews pending this week: ${pendingReviews}. Put a 30-min "Lecture review" block around 21:15 on each class day if free.`,
    ].join("\n\n");

    const plan = await ask({
      schema: Plan,
      effort: "high",
      system:
        "You are a planner grounded in learning science and sleep science. Use distributed practice (spread exam prep across the days before an exam), retrieval practice (practice problems, past exams, self-testing — never 'reread notes'), interleaving across topics, 60-90 minute focus blocks with breaks, harder work earlier in the day, and protect sleep. Only place blocks inside the free windows given. Never place anything over a fixed event. Be realistic: leave slack, do not fill every free minute.",
      prompt,
    });

    // Keep only blocks that really fit a free window.
    const fits = (day: string, s: string, e: string) => (free[day] ?? []).some((w) => { const [a, b] = w.split("-"); return s >= a && e <= b && s < e; });
    const placed: string[] = [];
    for (const b of plan.blocks.filter((b) => fits(b.day, b.start, b.end))) {
      const start = at(b.day, b.start), end = at(b.day, b.end);
      const cal = b.kind === "gym" ? "gym" : "study";
      const eventId = await createEvent(cal, { title: b.title, start, end, description: `${PLANNER_TAG}\n${b.reason}` });
      const area = areas.find((a) => a.name.toLowerCase() === b.area.toLowerCase());
      await db.planBlock.create({ data: { weekStart: from, start, end, title: b.title, kind: b.kind, areaId: area?.id, reason: b.reason, calendarEventId: eventId } });
      placed.push(b.title);
    }

    const msg = `${plan.summary}\n${placed.length} blocks added to your Study and Gym calendars.`;
    await notify(`Your week of ${fmt.short(from)} is planned`, msg, "/plan");
    await logEnd(log.id, true, msg);
    return { placed: placed.length, summary: plan.summary };
  } catch (e) {
    await logEnd(log.id, false, (e as Error).message);
    throw e;
  }
}
