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

type Material = { name: string; url: string; pdf?: string };

/**
 * Find the day's lecture material in the course's Canvas files: the newest slides/notes uploaded around the
 * lecture, preferring names that mention the date or "lecture". Returns a Canvas link and, for PDFs, the file
 * itself so Claude can write recall questions from the actual slides.
 */
async function findLectureMaterial(courseCanvasId: string | null, lectureDay: string): Promise<Material | null> {
  if (!courseCanvasId || !process.env.CANVAS_TOKEN) return null;
  const base = (await getSettings()).canvasBaseUrl ?? "https://umich.instructure.com";
  const auth = { Authorization: `Bearer ${process.env.CANVAS_TOKEN}` };
  const res = await fetch(`${base}/api/v1/courses/${courseCanvasId}/files?sort=created_at&order=desc&per_page=30`, { headers: auth }).catch(() => null);
  if (!res?.ok) return null;
  const files: { id: number; display_name: string; created_at: string; updated_at: string; size: number; url: string; "content-type": string }[] = await res.json();
  const day = new Date(`${lectureDay}T12:00:00Z`);
  const [y, m, d] = lectureDay.split("-").map(Number);
  const datePatterns = [`${m}-${d}`, `${m}.${d}`, `${m}_${d}`, `${String(m).padStart(2, "0")}${String(d).padStart(2, "0")}`, day.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).toLowerCase(), `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`];
  const scored = files
    .filter((f) => /pdf|presentation|powerpoint|document|word/i.test(f["content-type"] ?? "") || /\.(pdf|pptx?|docx?)$/i.test(f.display_name))
    .map((f) => {
      const name = f.display_name.toLowerCase();
      const hoursOff = Math.abs(new Date(f.created_at).getTime() - day.getTime()) / 3_600_000;
      let score = 0;
      if (hoursOff <= 36) score += 3; else if (hoursOff <= 96) score += 1; else return { f, score: -1 };
      if (datePatterns.some((p) => name.includes(p))) score += 4;
      if (/lecture|slides|notes|class|lec\b|\bl\d+/i.test(name)) score += 1;
      if (/syllabus|exam key|solutions?|answer/i.test(name)) score -= 3;
      return { f, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  const best = scored[0]?.f;
  if (!best) return null;
  const material: Material = { name: best.display_name, url: `${base}/courses/${courseCanvasId}/files/${best.id}` };
  if (/\.pdf$/i.test(best.display_name) && best.size < 15_000_000) {
    const pdf = await fetch(best.url, { headers: auth }).catch(() => null);
    if (pdf?.ok) material.pdf = Buffer.from(await pdf.arrayBuffer()).toString("base64");
  }
  return material;
}

async function recallQuestions(course: string, title: string, material: Material | null): Promise<string[]> {
  const fallback = [`Without notes: what were the 3 main ideas of today's ${course} class (${title})?`, "Explain the hardest one out loud as if teaching a friend.", "What's one question you'd expect on the exam from today?"];
  if (!hasClaude()) return fallback;
  try {
    const out = await ask({
      schema: Questions,
      effort: "low",
      system: "You write free-recall practice prompts for a college student's nightly review. Short, specific, answerable from today's lecture. Include one 'explain why/how' prompt; for physics include one problem-type prompt (no numbers needed). Never include answers.",
      prompt: material?.pdf
        ? `Course: ${course}. Lecture: ${title}. Today's slides are attached (${material.name}).`
        : `Course: ${course}. Lecture: "${title}"${material ? `. Today's file on Canvas is named "${material.name}"` : ""}. The slides weren't readable, so base the prompts on what this lecture most likely covered and keep them general.`,
      documents: material?.pdf ? [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: material.pdf } }] : undefined,
    });
    return out.questions.slice(0, 5);
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
    const newToday: { title: string; course: string; questions: string[]; material: Material | null }[] = [];
    for (const ev of classes) {
      if (/journal club presentation/i.test(ev.title) && !/lecture/i.test(ev.title)) continue;
      const code = courseFromTitle(ev.title);
      const course = code === "Other" ? null : await db.course.upsert({ where: { code }, update: {}, create: { code } });
      const existing = await db.lecture.findUnique({ where: { calendarEventId: ev.id } });
      if (existing) continue;
      const shortTitle = ev.title.replace(/^[A-Z]+ \d+\s*-\s*/i, "");
      const found = await findLectureMaterial(course?.canvasId ?? null, dayKey(ev.start));
      const questions = await recallQuestions(code, shortTitle, found);
      // Without a Canvas token the files can't be searched, so link the course's Modules page (opens since you're signed in to Canvas).
      const material = found ?? (course?.canvasId ? { name: `${code} modules on Canvas`, url: `${(await getSettings()).canvasBaseUrl ?? "https://umich.instructure.com"}/courses/${course.canvasId}/modules` } : null);
      await db.lecture.create({
        data: {
          title: shortTitle,
          date: ev.start,
          courseId: course?.id,
          calendarEventId: ev.id,
          recallQuestions: questions,
          materialName: material?.name,
          materialUrl: material?.url,
          reviews: { create: REVIEW_STAGES.map((stage) => ({ stage, due: at(addDays(today, stage), "21:15") })) },
        },
      });
      newToday.push({ title: shortTitle, course: code, questions, material });
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
      for (const l of newToday) lines.push(`• ${l.course} – ${l.title}${l.material ? `\n  Slides: ${l.material.name}\n  ${l.material.url}` : ""}\n  - ${l.questions.slice(0, 3).join("\n  - ")}`);
    }
    if (due.length) {
      lines.push("SPACED REVIEWS DUE:");
      for (const r of due.slice(0, 6)) {
        const late = daysBetween(dayKey(r.due), today);
        lines.push(`• ${r.lecture.course?.code ?? ""} ${r.lecture.title} — day ${r.stage}${late > 0 ? ` (${late}d late)` : ""}${r.lecture.materialUrl ? `\n  ${r.lecture.materialUrl}` : ""}`);
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
