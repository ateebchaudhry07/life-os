import { db } from "@/lib/db";
import { addDays, at, dayKey, daysBetween, fmt } from "@/lib/time";
import { addReminder, updateReminder } from "../actions";
import { Chip } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function Reminders() {
  const today = dayKey();
  const now = new Date();
  const [open, done] = await Promise.all([
    db.reminder.findMany({ where: { done: false }, orderBy: [{ due: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }] }),
    db.reminder.findMany({ where: { done: true, doneAt: { gte: at(addDays(today, -14)) } }, orderBy: { doneAt: "desc" } }),
  ]);

  return (
    <>
      <h1>Reminders</h1>
      <p className="lede">Anything that isn&apos;t a class assignment: forms, errands, deadlines. Due ones show on Today and in your nightly phone summary, and the Sunday planner blocks time for the bigger ones.</p>

      <div className="card" style={{ marginTop: 14 }}>
        <form action={addReminder} className="inline">
          <input name="title" placeholder="What do you need to do?" required aria-label="Reminder" style={{ flex: "2 1 260px" }} />
          <input type="date" name="day" aria-label="Due date" />
          <input type="time" name="time" aria-label="Due time" />
          <input name="url" placeholder="Link (optional)" aria-label="Link" style={{ flex: "1 1 180px" }} />
          <button className="primary">Add reminder</button>
        </form>
      </div>

      <h2>To do</h2>
      <div className="card">
        <ul className="list">
          {open.map((r) => {
            const late = r.due && r.due < now;
            const days = r.due ? daysBetween(today, dayKey(r.due)) : null;
            return (
              <li key={r.id}>
                <span className="when">{r.due ? <>{fmt.day(r.due)}<br /><Chip tone={late ? "bad" : days !== null && days <= 2 ? "warn" : undefined}>{late ? "overdue" : days === 0 ? "today" : `${days}d`}</Chip></> : <Chip>no date</Chip>}</span>
                <span className="what">
                  {r.url ? <a href={r.url} target="_blank" rel="noreferrer">{r.title}</a> : r.title}
                  {r.notes ? <small>{r.notes}</small> : null}
                  <form action={updateReminder} className="inline" style={{ marginTop: 6 }}>
                    <input type="hidden" name="id" value={r.id} />
                    <input type="date" name="day" defaultValue={r.due ? dayKey(r.due) : ""} aria-label={`Due date for ${r.title}`} />
                    <button name="op" value="date">Set date</button>
                    <button name="op" value="delete" aria-label={`Remove ${r.title}`}>Remove</button>
                  </form>
                </span>
                <form action={updateReminder}>
                  <input type="hidden" name="id" value={r.id} />
                  <button name="op" value="toggle" className="primary" aria-label={`Mark ${r.title} done`}>Done ✓</button>
                </form>
              </li>
            );
          })}
          {!open.length ? <li className="empty">Nothing to do. Add something above.</li> : null}
        </ul>
      </div>

      {done.length ? (
        <>
          <h2>Done recently</h2>
          <div className="card">
            <ul className="list">
              {done.map((r) => (
                <li key={r.id} style={{ opacity: 0.6 }}>
                  <span className="when">{r.doneAt ? fmt.short(r.doneAt) : ""}</span>
                  <span className="what"><s>{r.title}</s></span>
                  <form action={updateReminder}><input type="hidden" name="id" value={r.id} /><button name="op" value="toggle" aria-label={`Undo ${r.title}`}>↺</button></form>
                </li>
              ))}
            </ul>
          </div>
        </>
      ) : null}
    </>
  );
}
