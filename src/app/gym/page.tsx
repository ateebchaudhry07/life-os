import { db } from "@/lib/db";
import { addDays, at, dayKey, fmt, mondayOf } from "@/lib/time";
import { logWorkout } from "../actions";
import { Chip, Columns, Tile } from "@/components/ui";

export const dynamic = "force-dynamic";
const TYPES = ["Push", "Pull", "Legs", "Upper", "Lower", "Full Body", "Cardio"];

/** Epley estimated one-rep max — a standard way to compare sets with different reps. */
const e1rm = (w: number, r: number) => w * (1 + r / 30);

export default async function Gym() {
  const today = dayKey();
  const [workouts, weights, settings] = await Promise.all([
    db.workout.findMany({ where: { date: { gte: at(addDays(today, -7 * 26)) } }, include: { sets: true }, orderBy: { date: "desc" } }),
    db.bodyWeight.findMany({ orderBy: { date: "asc" } }),
    db.settings.findUnique({ where: { id: "me" } }),
  ]);
  const goal = settings?.gymPerWeek ?? 4;
  const weeks = Array.from({ length: 12 }, (_, i) => addDays(mondayOf(today), -7 * (11 - i)));
  const cols = weeks.map((w) => {
    const n = new Set(workouts.filter((x) => mondayOf(dayKey(x.date)) === w).map((x) => dayKey(x.date))).size;
    return { label: fmt.short(at(w, "12:00")), segments: [{ value: n, color: n >= goal ? "var(--ok)" : "var(--accent)" }] };
  });
  const thisWeek = cols.at(-1)!.segments[0].value;
  let streak = 0;
  for (let i = cols.length - 2; i >= 0 && cols[i].segments[0].value >= goal; i--) streak++;

  const lifts = new Map<string, { date: Date; best: number; w: number; r: number }[]>();
  for (const wo of [...workouts].reverse()) for (const s of wo.sets) {
    if (!s.weight || !s.reps) continue;
    const arr = lifts.get(s.exercise) ?? [];
    const v = e1rm(s.weight, s.reps);
    const last = arr.at(-1);
    if (last && dayKey(last.date) === dayKey(wo.date)) { if (v > last.best) Object.assign(last, { best: v, w: s.weight, r: s.reps }); }
    else arr.push({ date: wo.date, best: v, w: s.weight, r: s.reps });
    lifts.set(s.exercise, arr);
  }
  const progress = [...lifts.entries()].map(([name, h]) => ({ name, sessions: h.length, now: h.at(-1)!, first: h[0], change: h.at(-1)!.best - h[0].best })).sort((a, b) => b.sessions - a.sessions);
  const bwNow = weights.at(-1), bw30 = weights.find((w) => w.date >= at(addDays(today, -30)));

  return (
    <>
      <h1>Gym</h1>
      <p className="lede">Log each workout here. Progress is measured as estimated one-rep max (Epley), so a set of 8 and a set of 5 compare fairly. Aim for small, steady gains: that's progressive overload.</p>
      <div className="tiles">
        <Tile label="This week" value={`${thisWeek}/${goal}`} sub="workout days" />
        <Tile label="Streak" value={streak} sub={`weeks hitting ${goal}+`} />
        <Tile label="Bodyweight" value={bwNow ? `${bwNow.pounds} lb` : "—"} sub={bwNow && bw30 && bw30 !== bwNow ? `${(bwNow.pounds - bw30.pounds >= 0 ? "+" : "") + (bwNow.pounds - bw30.pounds).toFixed(1)} lb in 30 days` : "log it with a workout"} />
        <Tile label="Exercises tracked" value={progress.length} />
      </div>

      <h2>Log a workout</h2>
      <div className="card">
        <form action={logWorkout} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div className="inline" style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <input type="date" name="day" defaultValue={today} aria-label="Date" />
            <select name="type" aria-label="Workout type">{TYPES.map((t) => <option key={t}>{t}</option>)}</select>
            <input type="number" name="minutes" placeholder="min" aria-label="Minutes" />
            <input type="number" step="0.1" name="bodyweight" placeholder="bodyweight lb" aria-label="Bodyweight" style={{ width: 130 }} />
          </div>
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <input name="exercise" placeholder={i === 0 ? "Exercise (e.g. Bench press)" : "Exercise"} list="exercises" aria-label={`Exercise ${i + 1}`} style={{ flex: "1 1 180px" }} />
              <input type="number" step="2.5" name="weight" placeholder="lb" aria-label="Weight" />
              <input type="number" name="reps" placeholder="reps" aria-label="Reps" />
              <input type="number" name="sets" placeholder="sets" aria-label="Sets" />
            </div>
          ))}
          <datalist id="exercises">{progress.map((p) => <option key={p.name} value={p.name} />)}</datalist>
          <input name="notes" placeholder="Notes (optional)" aria-label="Notes" />
          <div><button className="primary">Save workout</button></div>
        </form>
      </div>

      <div className="grid" style={{ marginTop: 14 }}>
        <div className="card">
          <h3>Workout days per week</h3>
          <Columns cols={cols} goal={goal} />
        </div>
        <div className="card">
          <h3>Strength progress</h3>
          <ul className="list">
            {progress.map((p) => (
              <li key={p.name}>
                <span className="when">{fmt.short(p.now.date)}</span>
                <span className="what">{p.name}<small>best {p.now.w} lb × {p.now.r} · est. 1RM {Math.round(p.now.best)} lb · {p.sessions} sessions</small></span>
                <Chip tone={p.change > 0 ? "ok" : p.change < 0 ? "bad" : undefined}>{p.sessions > 1 ? `${p.change >= 0 ? "+" : ""}${Math.round(p.change)} lb` : "first"}</Chip>
              </li>
            ))}
            {!progress.length ? <li className="empty">Log weight and reps to see progress.</li> : null}
          </ul>
        </div>
      </div>

      <h2>Recent workouts</h2>
      <div className="card">
        <ul className="list">
          {workouts.slice(0, 10).map((w) => <li key={w.id}><span className="when">{fmt.day(w.date)}</span><span className="what">{w.type}<small>{w.sets.map((s) => `${s.exercise}${s.weight ? ` ${s.weight}×${s.reps ?? ""}` : ""}${s.sets > 1 ? ` (${s.sets} sets)` : ""}`).join(" · ")}</small></span><span>{w.minutes ? `${w.minutes} min` : ""}</span></li>)}
          {!workouts.length ? <li className="empty">No workouts yet.</li> : null}
        </ul>
      </div>
    </>
  );
}
