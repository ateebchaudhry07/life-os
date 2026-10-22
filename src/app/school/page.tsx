import { db } from "@/lib/db";
import { addDays, at, dayKey, daysBetween, fmt } from "@/lib/time";
import { markReview, toggleAssignment } from "../actions";
import { Chip, Tile } from "@/components/ui";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // planning and reviews can take a few minutes

export default async function School() {
  const today = dayKey();
  const now = new Date();
  const [work, exams, due, recent, courses] = await Promise.all([
    db.assignment.findMany({ where: { kind: { not: "exam" }, OR: [{ completed: false }, { due: { gte: at(addDays(today, -3)) } }], due: { lte: at(addDays(today, 21)) } }, include: { course: true }, orderBy: { due: "asc" } }),
    db.assignment.findMany({ where: { kind: "exam", due: { gte: now } }, include: { course: true }, orderBy: { due: "asc" } }),
    db.lectureReview.findMany({ where: { doneAt: null, due: { lt: at(addDays(today, 1)) } }, include: { lecture: { include: { course: true } } }, orderBy: { due: "asc" } }),
    db.lecture.findMany({ where: { date: { gte: at(addDays(today, -14)) } }, include: { course: true, reviews: true }, orderBy: { date: "desc" } }),
    db.course.findMany({ include: { assignments: { where: { score: { not: null } } } } }),
  ]);
  const open = work.filter((w) => !w.completed);
  const overdue = open.filter((w) => w.due && w.due < now);
  const reviewedWeek = await db.lectureReview.count({ where: { doneAt: { gte: at(addDays(today, -7)) } } });

  return (
    <>
      <h1>School</h1>
      <p className="lede">Assignments come from Canvas and Asana, exams from your Exams calendar. Each lecture gets reviewed the night of, then again 1, 3, 7 and 21 days later. That's spaced retrieval practice, the most reliable way to not fall behind.</p>
      <div className="tiles">
        <Tile label="Reviews due tonight" value={due.length} sub="closed-notes recall" alert={due.length > 5} />
        <Tile label="Reviewed this week" value={reviewedWeek} sub="spaced reviews done" />
        <Tile label="Open work" value={open.length} sub={`${overdue.length} overdue`} alert={overdue.length > 0} />
        <Tile label="Next exam" value={exams[0]?.due ? `${daysBetween(today, dayKey(exams[0].due))}d` : "—"} sub={exams[0]?.title ?? "none"} />
      </div>

      <h2>Tonight's review</h2>
      <div className="card">
        <p className="note">For each one: close your notes, write or say everything you remember (use the prompts), then open the slides and fix what you missed. Rate how well you knew it. Finish by 10:45 so sleep can lock it in.</p>
        <ul className="list">
          {due.map((r) => {
            const late = daysBetween(dayKey(r.due), today);
            return (
              <li key={r.id}>
                <span className="when">{r.stage === 0 ? "Same day" : `Day ${r.stage}`}{late > 0 ? <><br /><Chip tone="bad">{late}d late</Chip></> : null}</span>
                <span className="what">
                  {r.lecture.course?.code ?? ""} – {r.lecture.title}
                  <small>{fmt.day(r.lecture.date)}{r.lecture.materialUrl ? <> · <a href={r.lecture.materialUrl} target="_blank" rel="noreferrer">Open slides: {r.lecture.materialName}</a></> : null}</small>
                  {r.lecture.recallQuestions.length ? <small>{r.lecture.recallQuestions.map((q, i) => <span key={i} style={{ display: "block" }}>• {q}</span>)}</small> : null}
                </span>
                <form action={markReview} className="inline">
                  <input type="hidden" name="id" value={r.id} />
                  <select name="confidence" defaultValue="3" aria-label="How well did you know it"><option value="1">1 blank</option><option value="2">2 shaky</option><option value="3">3 okay</option><option value="4">4 solid</option><option value="5">5 nailed it</option></select>
                  <button className="primary">Reviewed</button>
                </form>
              </li>
            );
          })}
          {!due.length ? <li className="empty">No reviews due. Lectures are added every night at 9:15 PM from your Classes calendar.</li> : null}
        </ul>
      </div>

      <div className="grid" style={{ marginTop: 14 }}>
        <div className="card">
          <h3>Assignments & quizzes</h3>
          <ul className="list scroll">
            {work.map((a) => {
              const late = a.due && a.due < now && !a.completed;
              const soon = a.due && !late && a.due.getTime() - now.getTime() < 2 * 86_400_000;
              return (
                <li key={a.id} style={{ opacity: a.completed ? 0.5 : 1 }}>
                  <span className="when">{a.due ? fmt.day(a.due) : "—"}</span>
                  <span className="what">{a.url ? <a href={a.url} target="_blank" rel="noreferrer">{a.title}</a> : a.title}<small>{a.course?.code ?? ""} · {a.source}</small></span>
                  <form action={toggleAssignment} className="inline">
                    <input type="hidden" name="id" value={a.id} />
                    <button aria-label={a.completed ? "Mark not done" : "Mark done"}>{a.completed ? "↺" : late ? "Late ✓" : soon ? "Soon ✓" : "✓"}</button>
                  </form>
                </li>
              );
            })}
            {!work.length ? <li className="empty">Nothing due in the next 3 weeks.</li> : null}
          </ul>
        </div>
        <div className="card">
          <h3>Exams</h3>
          <ul className="list">
            {exams.map((e) => {
              const d = daysBetween(today, dayKey(e.due!));
              return <li key={e.id}><span className="when">{fmt.day(e.due!)}</span><span className="what">{e.title}<small>{fmt.time(e.due!)}{e.location ? ` · ${e.location}` : ""}</small></span><Chip tone={d <= 7 ? "bad" : d <= 14 ? "warn" : undefined}>{d}d</Chip></li>;
            })}
          </ul>
          <h3>Recent lectures</h3>
          <ul className="list">
            {recent.map((l) => {
              const done = l.reviews.filter((r) => r.doneAt).length;
              return <li key={l.id}><span className="when">{fmt.short(l.date)}</span><span className="what">{l.course?.code ?? ""} – {l.title}{l.materialUrl ? <small><a href={l.materialUrl} target="_blank" rel="noreferrer">{l.materialName}</a></small> : null}</span><Chip tone={done >= l.reviews.filter((r) => r.due <= now).length ? "ok" : "warn"}>{done}/{l.reviews.length}</Chip></li>;
            })}
          </ul>
        </div>
      </div>

      {courses.some((c) => c.assignments.length) ? (
        <>
          <h2>Grades from Canvas</h2>
          <div className="card">
            <table>
              <thead><tr><th>Course</th><th className="num">Graded</th><th className="num">Points</th><th className="num">%</th></tr></thead>
              <tbody>
                {courses.filter((c) => c.assignments.length).map((c) => {
                  const got = c.assignments.reduce((s, a) => s + (a.score ?? 0), 0), of = c.assignments.reduce((s, a) => s + (a.points ?? 0), 0);
                  return <tr key={c.id}><td>{c.code}</td><td className="num">{c.assignments.length}</td><td className="num">{got} / {of}</td><td className="num">{of ? ((got / of) * 100).toFixed(1) : "—"}</td></tr>;
                })}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </>
  );
}
