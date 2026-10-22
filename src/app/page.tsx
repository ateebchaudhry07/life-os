import Link from "next/link";
import { db } from "@/lib/db";
import { syncBookingsIfStale } from "@/lib/sync/bookings";
import { listMany, unreadInbox, type CalEvent } from "@/lib/google";
import { addDays, at, dayKey, daysBetween, fmt, mondayOf } from "@/lib/time";
import { Chip, Tile } from "@/components/ui";
import { updateReminder } from "./actions";

export const dynamic = "force-dynamic";

const CAL_LABEL: Record<string, string> = { classes: "Class", lab: "Lab", exams: "Exam", haircuts: "Cut", personal: "Personal", clubs: "Club", study: "Study", gym: "Gym", volunteer: "Volunteer", pray: "Prayer" };

export default async function Today() {
  await syncBookingsIfStale().catch(() => undefined);
  const today = dayKey();
  const now = new Date();
  const weekStart = at(mondayOf(today));
  const in7 = at(addDays(today, 8));

  const [cutsWeek, unpaid, dueSoon, overdue, exams, reviewsDue, workoutsWeek, spent30, areas, logs, reminders] = await Promise.all([
    db.appointment.findMany({ where: { start: { gte: weekStart, lt: at(addDays(mondayOf(today), 7)) }, status: { in: ["BOOKED", "COMPLETED"] } } }),
    db.appointment.findMany({ where: { status: "BOOKED", start: { lt: at(today) } }, include: { client: true }, orderBy: { start: "desc" } }),
    db.assignment.findMany({ where: { completed: false, kind: { not: "exam" }, due: { gte: now, lt: in7 } }, include: { course: true }, orderBy: { due: "asc" } }),
    db.assignment.findMany({ where: { completed: false, kind: { not: "exam" }, due: { lt: now } }, include: { course: true }, orderBy: { due: "desc" } }),
    db.assignment.findMany({ where: { kind: "exam", due: { gte: now } }, orderBy: { due: "asc" }, take: 3 }),
    db.lectureReview.findMany({ where: { doneAt: null, due: { lt: at(addDays(today, 1)) } }, include: { lecture: { include: { course: true } } } }),
    db.workout.count({ where: { date: { gte: weekStart } } }),
    db.transaction.aggregate({ _sum: { amount: true }, where: { type: "EXPENSE", date: { gte: at(addDays(today, -30)) } } }),
    db.area.findMany({ orderBy: { priority: "asc" } }),
    db.syncLog.findMany({ where: { job: { not: "bookings-quick" } }, orderBy: { startedAt: "desc" }, take: 3 }),
    db.reminder.findMany({ where: { done: false, OR: [{ due: null }, { due: { lt: in7 } }] }, orderBy: [{ due: { sort: "asc", nulls: "last" } }], take: 6 }),
  ]);

  let events: CalEvent[] = [];
  let calError = "";
  try {
    events = await listMany(["personal", "classes", "lab", "exams", "haircuts", "clubs", "study", "gym", "volunteer"], new Date(now.getTime() - 3_600_000), at(addDays(today, 2)));
  } catch (e) {
    calError = (e as Error).message;
  }
  const inbox = await unreadInbox(6).catch(() => null);

  const cutRevenue = cutsWeek.reduce((s, a) => s + (a.amountPaid ?? a.price ?? 0), 0);
  const nextExam = exams[0];
  const examDays = nextExam?.due ? daysBetween(today, dayKey(nextExam.due)) : null;
  const hour = Number(fmt.hhmm(now).slice(0, 2));
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";

  const focus = [
    nextExam && examDays !== null && examDays <= 10 ? `${nextExam.title} is in ${examDays} day${examDays === 1 ? "" : "s"}` : null,
    reviewsDue.length ? `${reviewsDue.length} lecture review${reviewsDue.length > 1 ? "s" : ""} due tonight` : null,
    dueSoon.length ? `${dueSoon.length} assignment${dueSoon.length > 1 ? "s" : ""} due this week` : null,
    unpaid.length ? `${unpaid.length} past cut${unpaid.length > 1 ? "s" : ""} to confirm` : null,
  ].filter(Boolean);

  // Hours this week per area, from calendar events matched by the area's words.
  const weekEvents = await listMany(["personal", "classes", "lab", "clubs", "study", "gym", "volunteer", "haircuts"], weekStart, at(addDays(mondayOf(today), 7))).catch(() => [] as CalEvent[]);
  const areaHours = areas.map((a) => {
    const hours = weekEvents.filter((e) => !e.allDay && a.matchWords.some((w) => e.title.toLowerCase().includes(w)) || (a.name === "School" && ["classes", "lab", "study"].includes(String(e.calendar))) || (a.name === "Gym" && e.calendar === "gym") || (a.name === "AteebCuts" && e.calendar === "haircuts" && !/^haircuts?$/i.test(e.title)))
      .reduce((s, e) => s + (e.end.getTime() - e.start.getTime()) / 3_600_000, 0);
    return { ...a, hours };
  });

  let lastDay = "";
  return (
    <>
      <h1>{greeting}, Ateeb.</h1>
      <p className="lede">{fmt.longDay(now)}. {focus.length ? focus.join(" · ") + "." : "Nothing urgent. Good time to get ahead."}</p>

      <div className="tiles">
        <Tile label="AteebCuts this week" value={fmt.money(cutRevenue)} sub={`${cutsWeek.length} cuts booked or done`} href="/cuts" />
        <Tile label="Cuts to confirm" value={unpaid.length} sub="past, no payment matched" href="/cuts" alert={unpaid.length > 0} />
        <Tile label="Due in 7 days" value={dueSoon.length} sub={overdue.length ? `${overdue.length} overdue` : "nothing overdue"} href="/school" alert={overdue.length > 0} />
        <Tile label="Next exam" value={examDays === null ? "—" : `${examDays}d`} sub={nextExam?.title ?? "none scheduled"} href="/school" />
        <Tile label="Reviews tonight" value={reviewsDue.length} sub="spaced lecture recall" href="/school" />
        <Tile label="Workouts this week" value={workoutsWeek} sub="goal 4" href="/gym" />
        <Tile label="Spent, 30 days" value={fmt.money(spent30._sum.amount ?? 0)} sub="purchases & payments" href="/money" />
      </div>

      <h2>Next 48 hours</h2>
      <div className="grid">
        <div className="card">
          <h3>Schedule</h3>
          {calError ? <p className="note">Calendar unavailable: {calError}</p> : null}
          <ul className="list">
            {events.map((e) => {
              const d = dayKey(e.start);
              const head = d !== lastDay ? <li key={d + "h"} className="daylabel">{d === today ? "Today" : fmt.longDay(e.start)}</li> : null;
              lastDay = d;
              return [
                head,
                <li key={e.calendar + e.id}>
                  <span className="when">{e.allDay ? "All day" : fmt.time(e.start)}</span>
                  <span className="what">{e.title}{e.location ? <small>{e.location}</small> : null}</span>
                  <Chip>{CAL_LABEL[String(e.calendar)] ?? "Event"}</Chip>
                </li>,
              ];
            })}
            {!events.length && !calError ? <li className="empty">Nothing scheduled.</li> : null}
          </ul>
        </div>

        <div className="card">
          <h3>Needs you</h3>
          <ul className="list">
            {overdue.slice(0, 4).map((a) => (
              <li key={a.id}><span className="when">{a.due ? fmt.short(a.due) : ""}</span><span className="what">{a.title}<small>{a.course?.code ?? ""} · overdue — finish or check it off</small></span><Chip tone="bad">late</Chip></li>
            ))}
            {dueSoon.slice(0, 5).map((a) => (
              <li key={a.id}><span className="when">{a.due ? fmt.day(a.due) : ""}</span><span className="what">{a.title}<small>{a.course?.code ?? a.source}</small></span><Chip tone={a.due && a.due.getTime() - now.getTime() < 2 * 86_400_000 ? "warn" : undefined}>due</Chip></li>
            ))}
            {unpaid.slice(0, 4).map((a) => (
              <li key={a.id}><span className="when">{fmt.short(a.start)}</span><span className="what"><Link href="/cuts">{a.client.name}</Link><small>haircut — confirm payment</small></span><Chip tone="warn">cut</Chip></li>
            ))}
            {reminders.map((r) => (
              <li key={r.id}><span className="when">{r.due ? fmt.day(r.due) : ""}</span><span className="what">{r.url ? <a href={r.url} target="_blank" rel="noreferrer">{r.title}</a> : r.title}<small><Link href="/reminders">reminder</Link></small></span>
                <form action={updateReminder}><input type="hidden" name="id" value={r.id} /><button name="op" value="toggle" aria-label={`Mark ${r.title} done`}>✓</button></form></li>
            ))}
            {!overdue.length && !dueSoon.length && !unpaid.length && !reminders.length ? <li className="empty">All clear.</li> : null}
          </ul>
        </div>

        <div className="card">
          <h3>Inbox</h3>
          <p className="note">{inbox ? `${inbox.estimate} unread in the last 7 days (not promotions or social).` : "Gmail unavailable."}</p>
          <ul className="list">
            {inbox?.items.map((m) => (
              <li key={m.id}><span className="when">{fmt.short(m.date)}</span><span className="what"><a href={`https://mail.google.com/mail/u/0/#all/${m.threadId}`} target="_blank" rel="noreferrer">{m.subject || "(no subject)"}</a><small>{m.from}</small></span><span /></li>
            ))}
          </ul>
        </div>
      </div>

      <h2>Balance this week</h2>
      <div className="card">
        <p className="note">Hours on your calendars this week, by area. Edit areas and weekly goals in Settings.</p>
        <div className="bars">
          {areaHours.map((a) => (
            <div className="bar" key={a.id}>
              <span><span className="dot" style={{ background: a.color }} />{a.name}</span>
              <div className="track"><div className="fill" style={{ width: `${Math.min(100, (a.hours / Math.max(...areaHours.map((x) => Math.max(x.hours, x.weeklyGoalHours ?? 0)), 1)) * 100)}%`, background: a.color }} />{a.weeklyGoalHours ? <div className="budget" style={{ left: `${Math.min(100, (a.weeklyGoalHours / Math.max(...areaHours.map((x) => Math.max(x.hours, x.weeklyGoalHours ?? 0)), 1)) * 100)}%` }} /> : null}</div>
              <span className="v">{a.hours.toFixed(1)} h</span>
            </div>
          ))}
        </div>
      </div>

      <h2>Automations</h2>
      <div className="card">
        <ul className="list">
          {logs.map((l) => (
            <li key={l.id}><span className="when">{fmt.short(l.startedAt)} {fmt.time(l.startedAt)}</span><span className="what">{l.job}<small style={{ whiteSpace: "pre-line" }}>{l.summary?.slice(0, 300)}</small></span><Chip tone={l.ok ? "ok" : l.ok === false ? "bad" : undefined}>{l.ok ? "ok" : l.ok === false ? "failed" : "running"}</Chip></li>
          ))}
          {!logs.length ? <li className="empty">No runs yet. They start tonight, or run them now from Settings.</li> : null}
        </ul>
      </div>
    </>
  );
}
