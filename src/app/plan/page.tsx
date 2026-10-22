import { db, getSettings } from "@/lib/db";
import { addDays, at, dayKey, fmt, mondayOf } from "@/lib/time";
import { runJob, saveSettings } from "../actions";

export const dynamic = "force-dynamic";

export default async function Plan() {
  const settings = await getSettings();
  const today = dayKey();
  const thisWeek = mondayOf(today), nextWeek = addDays(thisWeek, 7);
  const blocks = await db.planBlock.findMany({ where: { start: { gte: at(thisWeek) }, end: { lte: at(addDays(nextWeek, 7)) } }, include: { area: true }, orderBy: { start: "asc" } });
  const lastRun = await db.syncLog.findFirst({ where: { job: "weekly-plan" }, orderBy: { startedAt: "desc" } });
  const byDay = new Map<string, typeof blocks>();
  for (const b of blocks) byDay.set(dayKey(b.start), [...(byDay.get(dayKey(b.start)) ?? []), b]);
  const hours = new Map<string, { h: number; color: string }>();
  for (const b of blocks.filter((b) => b.start >= at(nextWeek) || dayKey(b.start) >= thisWeek)) {
    const k = b.area?.name ?? b.kind;
    hours.set(k, { h: (hours.get(k)?.h ?? 0) + (b.end.getTime() - b.start.getTime()) / 3_600_000, color: b.area?.color ?? "#6b7280" });
  }

  return (
    <>
      <h1>Week plan</h1>
      <p className="lede">Every Sunday afternoon the planner reads your calendars, Canvas, Asana and exams, then fits study, assignment, review and gym blocks into your free time, following your priorities below. Blocks go on your Study and Gym calendars, and it only ever removes events it created itself.</p>
      {lastRun ? <p className="note" style={{ marginTop: 8 }}>Last run {fmt.day(lastRun.startedAt)} {fmt.time(lastRun.startedAt)}: {lastRun.ok === false ? "failed: " : ""}{lastRun.summary}</p> : null}
      <div className="inline" style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
        <form action={runJob}><input type="hidden" name="job" value="weekly-plan" /><input type="hidden" name="week" value={thisWeek} /><button>Re-plan the rest of this week</button></form>
        <form action={runJob}><input type="hidden" name="job" value="weekly-plan" /><input type="hidden" name="week" value={nextWeek} /><button className="primary">Plan next week now</button></form>
      </div>

      <h2>Planned blocks</h2>
      <div className="grid">
        {[...byDay.entries()].map(([d, bs]) => (
          <div className="card" key={d}>
            <h3>{fmt.longDay(at(d, "12:00"))}</h3>
            <ul className="list">
              {bs.map((b) => <li key={b.id}><span className="when">{fmt.time(b.start)}–{fmt.time(b.end)}</span><span className="what"><span className="dot" style={{ background: b.area?.color ?? "#6b7280" }} />{b.title}<small>{b.reason}</small></span><span /></li>)}
            </ul>
          </div>
        ))}
        {!blocks.length ? <div className="card"><p className="empty">No plan yet. Press "Plan next week now" or wait for Sunday.</p></div> : null}
      </div>
      {hours.size ? <p className="note" style={{ marginTop: 10 }}>Planned hours: {[...hours.entries()].map(([k, v]) => `${k} ${v.h.toFixed(1)} h`).join(" · ")}</p> : null}

      <h2>Your priorities</h2>
      <form action={saveSettings} className="card">
        <p className="note">Plain English, most important first. The planner follows these exactly.</p>
        <textarea name="priorities" defaultValue={settings.priorities} aria-label="Priorities" />
        <div className="inline" style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <label>Wake <input type="time" name="wakeTime" defaultValue={settings.wakeTime} /></label>
          <label>Bed <input type="time" name="sleepStart" defaultValue={settings.sleepStart} /></label>
          <label>Gym/week <input type="number" name="gymPerWeek" defaultValue={settings.gymPerWeek} /></label>
          <label>Gym min <input type="number" name="gymMinutes" defaultValue={settings.gymMinutes} /></label>
          <input type="hidden" name="ntfyTopic" value={settings.ntfyTopic ?? ""} />
          <input type="hidden" name="canvasIcsUrl" value={settings.canvasIcsUrl ?? ""} />
          <input type="hidden" name="canvasBaseUrl" value={settings.canvasBaseUrl ?? ""} />
          <button className="primary">Save priorities</button>
        </div>
      </form>
    </>
  );
}
