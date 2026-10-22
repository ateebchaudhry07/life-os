import { PrismaClient } from "@prisma/client";

const g = globalThis as unknown as { prisma?: PrismaClient };
export const db = g.prisma ?? new PrismaClient();
if (process.env.NODE_ENV !== "production") g.prisma = db;

export const DEFAULT_PRIORITIES = `1. Sleep: in bed by 11 PM, up at 6 AM. Nothing is scheduled outside 6 AM – 10:45 PM. Sleep is when memory consolidates.
2. Fixed commitments never move: classes, labs, exams, prayer times and Jummah, booked haircuts, and anything already on my calendars.
3. Exams: distributed practice over the 7 days before each exam (about 1 hour a day, 2 hours a day in the last 3 days), using practice problems and past exams (retrieval), not rereading. No new material the night before.
4. Assignments and quizzes: a 60–90 minute block 1–2 days before each due date. Big ones (case studies, writing assignments, presentations) get two blocks on different days.
5. Lecture review: 30 minutes each class day around 9:15 PM — closed-notes recall of today's lectures plus the spaced reviews that are due.
6. AteebCuts: keep my "Haircuts" availability blocks open; don't put study or gym on top of them.
7. Wolverine Shifa and PhiDE: never schedule over their meetings or events.
8. Gym: 4 sessions a week, 75 minutes, afternoons preferred, not on an exam day.
9. Downtime: keep Friday after Jummah and Saturday night light, and keep Michigan football games free.

Rules for blocks: 60–90 minutes, 15 minutes between blocks, hardest work earlier in the day, no more than 5 hours of planned study per day.`;

export async function getSettings() {
  return (
    (await db.settings.findUnique({ where: { id: "me" } })) ??
    (await db.settings.create({ data: { id: "me", priorities: DEFAULT_PRIORITIES } }))
  );
}

export async function logStart(job: string) {
  return db.syncLog.create({ data: { job } });
}

export async function logEnd(id: string, ok: boolean, summary: string) {
  await db.syncLog.update({ where: { id }, data: { ok, summary, finishedAt: new Date() } });
}
