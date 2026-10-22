import { z } from "zod";
import { db, getSettings, logEnd, logStart } from "../db";
import { listMany } from "../google";
import { ask, hasClaude } from "../claude";
import { notify } from "../notify";
import { courseFromTitle, REVIEW_STAGES } from "../config";
import { addDays, at, dayKey, daysBetween } from "../time";

/*
 * The method, from the learning-science literature:
 * - Review the same day: forgetting is steepest in the first 24 hours (Ebbinghaus; Murre & Dros, 2015).
 * - Retrieve, don't reread: closed-notes recall beats rereading for long-term retention
 *   (Roediger & Karpicke, 2006; Karpicke & Blunt, 2011). Dunlosky et al. (2013) rate practice testing
 *   and distributed practice the two highest-utility techniques.
 * - Space it out on expanding intervals — 1, 3, 7, 21 days (Cepeda et al., 2006, 2008).
 * - Interleave courses in a session (Rohrer & Taylor, 2007), and stop before bed: sleep consolidates
 *   what was just reviewed (Diekelmann & Born, 2010).
 */

const Questions = z.object({ questions: z.array(z.string()).describe("3-5 free-recall prompts, no answers") });

async function canvasPdfForToday(courseCanvasId: string | null): Promise<{ data: string; name: string } | null> {
  if (!courseCanvasId || !process.env.CANVAS_TOKEN) return null;
  const base = (await getSettings()).canvasBaseUrl ?? "https://umich.instructure.com";
  const res = await fetch(`${base}/api/v1/courses/${courseCanvasId}/files?sort=updated_at&order=desc&per_page=5&content_types[]=application/pdf`, {
    headers: { Authorization: `Bearer ${process.env.CANVAS_TOKEN}` },
  }).catch(() => null);
  if (!res?.ok) return null;
  const files: { url: string; display_name: string; updated_at: string; size: number }[] = await res.json();
  const recent = files.find((f) => Date.now() - new Date(f.updated_at).getTime() < 3 * 86_400_000 && f.size < 15_000_000);
  if (!recent) return null;
  const pdf = await fetch(recent.url, { headers: { Authorization: `Bearer ${process.env.CANVAS_TOKEN}` } }).catch(() => null);
  if (!pdf?.ok) return null;
  return { data: Buffer.from(await pdf.arrayBuffer()).toString("base64"), name: recent.display_name };
}

async function recallQuestions(course: string, title: string, canvasId: string | null): Promise<{ questions: string[]; from: string }> {
  const fallback = { questions: [`Without notes: what were the 3 main ideas of today's ${course} class (${title})?`, "Explain the hardest one out loud as if teaching a friend.", "What's one question you'd expect on the exam from today?"], from: "title" };
  if (!hasClaude()) return fallback;
  const pdf = await canvasPdfForToday(canvasId);
  try {
    const out = await ask({
      schema: Questions,
      effort: "low",
      system: "You write free-recall practice prompts for a college student's nightly review. Short, specific, answerable from today's lecture. Include one 'explain why/how' prompt; for physics include one problem-type prompt (no numbers needed). Never include answers.",
      prompt: pdf ? `Course: ${course}. Lecture: ${title}. Slides attached (${pdf.name}).` : `Course: ${course}. Lecture title from the calendar: "${title}". No slides were available, so base the prompts on what this lecture title most likely covered and keep them general.`,
      documents: pdf ? [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: pdf.data } }] : undefined,
    });
    return { questions: out.questions.slice(0, 5), from: pdf ? "slides" : "title" };
  } catch {
    return fallback;
  }
}

export async function lectureReview() {
  const log = await logStart("lecture-review");
  try {
    const today = dayKey();
    // 1) Today's lectures, labs and discussions become Lectures with 5 spaced reviews.
    const classes = await listMany(["classes", "lab"], at(today), at(addDays(today, 1)));
    const newToday: { title: string; course: string; questions: string[] }[] = [];
    for (const ev of classes) {
      if (/journal club presentation/i.test(ev.title) && !/lecture/i.test(ev.title)) continue;
      const code = courseFromTitle(ev.title);
      const course = code === "Other" ? null : await db.course.upsert({ where: { code }, update: {}, create: { code } });
      const existing = await db.lecture.findUnique({ where: { calendarEventId: ev.id } });
      if (existing) continue;
      const shortTitle = ev.title.replace(/^[A-Z]+ \d+\s*-\s*/i, "");
      const q = await recallQuestions(code, shortTitle, course?.canvasId ?? null);
      await db.lecture.create({
        data: {
          title: shortTitle,
          date: ev.start,
          courseId: course?.id,
          calendarEventId: ev.id,
          recallQuestions: q.questions,
          reviews: { create: REVIEW_STAGES.map((stage) => ({ stage, due: at(addDays(today, stage), "21:15") })) },
        },
      });
      newToday.push({ title: shortTitle, course: code, questions: q.questions });
    }

    // 2) Spaced reviews due tonight (or overdue), courses with an exam in the next 10 days first.
    const due = await db.lectureReview.findMany({
      where: { doneAt: null, stage: { gt: 0 }, due: { lt: at(addDays(today, 1)) } },
      include: { lecture: { include: { course: true } } },
      orderBy: { due: "asc" },
    });
    const exams = await db.assignment.findMany({ where: { kind: "exam", due: { gte: new Date(), lte: at(addDays(today, 10)) } }, include: { course: true }, orderBy: { due: "asc" } });
    const examCourses = new Set(exams.map((e) => e.course?.code));
    due.sort((a, b) => Number(examCourses.has(b.lecture.course?.code)) - Number(examCourses.has(a.lecture.course?.code)));

    const minutes = newToday.length * 8 + Math.min(due.length, 6) * 5;
    const lines: string[] = [];
    if (newToday.length) {
      lines.push(`TODAY (~${minutes} min, notes closed, write what you remember, then check):`);
      for (const l of newToday) lines.push(`• ${l.course} – ${l.title}\n  - ${l.questions.slice(0, 3).join("\n  - ")}`);
    }
    if (due.length) {
      lines.push("SPACED REVIEWS DUE:");
      for (const r of due.slice(0, 6)) {
        const late = daysBetween(dayKey(r.due), today);
        lines.push(`• ${r.lecture.course?.code ?? ""} ${r.lecture.title} — day ${r.stage}${late > 0 ? ` (${late}d late)` : ""}`);
      }
      if (due.length > 6) lines.push(`…and ${due.length - 6} more in the app`);
    }
    if (exams[0]) lines.push(`Next exam: ${exams[0].title} in ${daysBetween(today, dayKey(exams[0].due!))} days`);
    if (!lines.length) lines.push("No lectures today and no reviews due. Rest up.");
    lines.push("Done by 10:45 so sleep locks it in. Tick reviews off in the app.");

    await notify("Tonight's lecture review", lines.join("\n"), "/school");
    await logEnd(log.id, true, lines.join("\n"));
    return lines;
  } catch (e) {
    await logEnd(log.id, false, (e as Error).message);
    throw e;
  }
}
