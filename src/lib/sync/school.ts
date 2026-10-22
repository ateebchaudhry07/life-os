import ical from "node-ical";
import { db, getSettings } from "../db";
import { listEvents } from "../google";
import { courseFromTitle, COURSE_CODES } from "../config";

async function courseId(code: string) {
  if (code === "Other") return null;
  const c = await db.course.upsert({ where: { code }, update: {}, create: { code } });
  return c.id;
}

function kindOf(title: string) {
  if (/exam|midterm|final/i.test(title)) return "exam";
  if (/quiz/i.test(title)) return "quiz";
  return "assignment";
}

async function saveAssignment(a: { externalId: string; title: string; due: Date | null; course: string; source: string; url?: string; completed?: boolean; points?: number | null; score?: number | null; location?: string; kind?: string }) {
  const cid = await courseId(a.course);
  await db.assignment.upsert({
    where: { externalId: a.externalId },
    update: { title: a.title, due: a.due, url: a.url, points: a.points ?? undefined, score: a.score ?? undefined, location: a.location, ...(a.completed ? { completed: true } : {}) },
    create: { externalId: a.externalId, title: a.title, due: a.due, courseId: cid, source: a.source, url: a.url, completed: a.completed ?? false, points: a.points ?? null, score: a.score ?? null, location: a.location, kind: a.kind ?? kindOf(a.title) },
  });
}

// ---------------- Canvas ----------------
async function canvas(path: string) {
  const base = (await getSettings()).canvasBaseUrl ?? "https://umich.instructure.com";
  const res = await fetch(`${base}/api/v1${path}`, { headers: { Authorization: `Bearer ${process.env.CANVAS_TOKEN}` } });
  if (!res.ok) throw new Error(`Canvas ${path}: ${res.status}`);
  return res.json();
}

export async function syncCanvas() {
  if (!process.env.CANVAS_TOKEN) return syncCanvasIcs();
  const courses: { id: number; name: string; course_code: string }[] = await canvas("/courses?enrollment_state=active&per_page=50");
  for (const c of courses) {
    const code = COURSE_CODES.find((k) => (c.course_code + " " + c.name).toUpperCase().includes(k)) ?? c.course_code.toUpperCase();
    await db.course.upsert({ where: { code }, update: { canvasId: String(c.id), name: c.name }, create: { code, canvasId: String(c.id), name: c.name } });
  }
  const start = new Date(Date.now() - 14 * 86_400_000).toISOString();
  const items: any[] = await canvas(`/planner/items?start_date=${start}&per_page=100`);
  let n = 0;
  for (const it of items) {
    if (!["assignment", "quiz", "discussion_topic"].includes(it.plannable_type)) continue;
    const course = await db.course.findFirst({ where: { canvasId: String(it.course_id) } });
    const sub = it.submissions || {};
    await saveAssignment({
      externalId: `canvas:${it.plannable_type}:${it.plannable_id}`,
      title: it.plannable?.title ?? "Untitled",
      due: it.plannable_date ? new Date(it.plannable_date) : null,
      course: course?.code ?? "Other",
      source: "canvas",
      url: it.html_url ? `${(await getSettings()).canvasBaseUrl}${it.html_url}` : undefined,
      completed: Boolean(sub.submitted || sub.graded || it.planner_override?.marked_complete),
      points: it.plannable?.points_possible ?? null,
      kind: it.plannable_type === "quiz" ? "quiz" : undefined,
    });
    n++;
  }
  return n;
}

/** Canvas calendar feed (Calendar → Calendar Feed in Canvas). Works even when API tokens are disabled. */
export async function syncCanvasIcs() {
  const url = (await getSettings()).canvasIcsUrl;
  if (!url) return 0;
  const data = await ical.async.fromURL(url);
  let n = 0;
  for (const ev of Object.values(data)) {
    if (!ev || ev.type !== "VEVENT") continue;
    const title = String((ev as any).summary ?? "");
    const course = courseFromTitle(title + " " + String((ev as any).description ?? ""));
    const link = (ev as any).url ? String((ev as any).url?.val ?? (ev as any).url) : undefined;
    await saveAssignment({ externalId: "ics:" + ev.uid, title: title.replace(/\s*\[.*\]$/, ""), due: (ev as any).start ? new Date((ev as any).start) : null, course, source: "ics", url: link });
    // Feed links carry the Canvas course id (…/courses/123456/… or include_contexts=course_123456), which lets lectures link to the course page.
    const canvasId = link?.match(/courses\/(\d+)|course_(\d+)/)?.slice(1).find(Boolean);
    if (canvasId && course !== "Other") await db.course.updateMany({ where: { code: course, canvasId: null }, data: { canvasId } });
    n++;
  }
  return n;
}

// ---------------- Asana ----------------
export async function syncAsana() {
  if (!process.env.ASANA_TOKEN) return 0;
  const h = { Authorization: `Bearer ${process.env.ASANA_TOKEN}` };
  const me = await (await fetch("https://app.asana.com/api/1.0/users/me?opt_fields=workspaces", { headers: h })).json();
  let n = 0;
  for (const ws of me.data?.workspaces ?? []) {
    const url = `https://app.asana.com/api/1.0/tasks?assignee=me&workspace=${ws.gid}&completed_since=${new Date(Date.now() - 30 * 86_400_000).toISOString()}&opt_fields=name,due_on,completed,permalink_url&limit=100`;
    const res = await (await fetch(url, { headers: h })).json();
    for (const t of res.data ?? []) {
      await saveAssignment({ externalId: "asana:" + t.gid, title: t.name, due: t.due_on ? new Date(`${t.due_on}T23:59:00-04:00`) : null, course: courseFromTitle(t.name), source: "asana", url: t.permalink_url, completed: t.completed });
      n++;
    }
  }
  return n;
}

// ---------------- Exams calendar ----------------
export async function syncExams() {
  const evs = await listEvents("exams", new Date(Date.now() - 86_400_000), new Date(Date.now() + 120 * 86_400_000));
  for (const e of evs) {
    await saveAssignment({ externalId: "exam:" + e.id, title: e.title, due: e.start, course: courseFromTitle(e.title), source: "calendar", location: e.location, kind: "exam" });
  }
  return evs.length;
}

export async function syncSchool() {
  const results = await Promise.allSettled([syncCanvas(), syncAsana(), syncExams()]);
  return results.map((r, i) => `${["Canvas", "Asana", "Exams"][i]}: ${r.status === "fulfilled" ? r.value + " items" : "failed (" + (r.reason as Error).message + ")"}`).join(" · ");
}
