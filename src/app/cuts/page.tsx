import Link from "next/link";
import { db } from "@/lib/db";
import { syncBookingsIfStale } from "@/lib/sync/bookings";
import { addDays, at, dayKey, fmt, mondayOf } from "@/lib/time";
import { addAppointment, completeCut, importCutsFile } from "../actions";
import { Chip, Columns, Tile } from "@/components/ui";

export const dynamic = "force-dynamic";
const METHODS = ["Cash", "Zelle", "Venmo", "Cash App", "Apple Cash"];

export default async function Cuts() {
  await syncBookingsIfStale().catch(() => undefined);
  const today = dayKey();
  const [past, upcoming, all, unmatched] = await Promise.all([
    db.appointment.findMany({ where: { status: "BOOKED", start: { lt: at(today) } }, include: { client: true }, orderBy: { start: "desc" } }),
    db.appointment.findMany({ where: { status: "BOOKED", start: { gte: at(today) } }, include: { client: true }, orderBy: { start: "asc" } }),
    db.appointment.findMany({ where: { start: { gte: at(addDays(mondayOf(today), -7 * 11)) }, status: { in: ["BOOKED", "COMPLETED"] } }, include: { client: true } }),
    db.transaction.findMany({ where: { category: { name: "AteebCuts Income" }, appointmentId: null, date: { gte: at(addDays(today, -30)) } }, orderBy: { date: "desc" } }),
  ]);
  const lastImport = await db.syncLog.findFirst({ where: { job: "cuts-import" }, orderBy: { startedAt: "desc" } });

  const weeks = Array.from({ length: 12 }, (_, i) => addDays(mondayOf(today), -7 * (11 - i)));
  const cols = weeks.map((w) => {
    const inWeek = all.filter((a) => mondayOf(dayKey(a.start)) === w);
    const done = inWeek.filter((a) => a.status === "COMPLETED").reduce((s, a) => s + (a.amountPaid ?? a.price ?? 0), 0);
    const booked = inWeek.filter((a) => a.status === "BOOKED").reduce((s, a) => s + (a.price ?? 0), 0);
    return { label: w === mondayOf(today) ? "This wk" : fmt.short(at(w, "12:00")), segments: [{ value: done, color: "var(--ok)" }, { value: booked, color: "var(--accent-2)" }] };
  });
  const month = all.filter((a) => a.status === "COMPLETED" && a.start >= at(addDays(today, -30)));
  const monthRev = month.reduce((s, a) => s + (a.amountPaid ?? 0), 0);
  const avg = month.length ? monthRev / month.length : 0;
  const clients = new Map<string, { name: string; visits: number; spent: number; last: Date }>();
  for (const a of all.filter((a) => a.status === "COMPLETED")) {
    const c = clients.get(a.clientId) ?? { name: a.client.name, visits: 0, spent: 0, last: a.start };
    c.visits++; c.spent += a.amountPaid ?? 0; if (a.start > c.last) c.last = a.start;
    clients.set(a.clientId, c);
  }
  const top = [...clients.values()].sort((a, b) => b.spent - a.spent).slice(0, 10);
  const upcomingRev = upcoming.reduce((s, a) => s + (a.price ?? 0), 0);

  return (
    <>
      <h1>AteebCuts</h1>
      <p><Link href="/cuts/all" className="chip">See and edit all cuts →</Link></p>
      <p className="lede">Bookings come in from Booksy and your Haircuts calendar. Venmo and Zelle payments mark cuts done automatically every night. Cash cuts are the only ones you confirm by hand.</p>
      <div className="card" style={{ margin: "12px 0" }}>
        <h3>Import cuts from Notion</h3>
        <form action={importCutsFile} className="inline">
          <input type="file" name="file" accept=".csv,text/csv" required aria-label="Cuts CSV file" />
          <button className="primary">Import cuts file</button>
        </form>
        <p className="note">Upload the ateebcuts-notion-cuts.csv file (or Notion Money Tracker → ••• → Export → CSV). Cuts already in the app aren&apos;t duplicated, so uploading twice is safe.</p>
        {lastImport ? <p className="note" style={lastImport.ok === false ? { color: "var(--bad)" } : undefined}>{fmt.short(lastImport.startedAt)}: {lastImport.summary}</p> : null}
      </div>
      <div className="tiles">
        <Tile label="Last 30 days" value={fmt.money(monthRev)} sub={`${month.length} cuts · ${fmt.money(avg)} avg`} />
        <Tile label="Booked ahead" value={fmt.money(upcomingRev)} sub={`${upcoming.length} appointments`} />
        <Tile label="To confirm" value={past.length} sub="past, no payment found" alert={past.length > 0} />
        <Tile label="Payments without a booking" value={unmatched.length} sub="last 30 days" />
      </div>

      <h2>Past cuts to confirm</h2>
      <div className="card">
        <p className="note">No Venmo or Zelle payment matched these. If they paid cash, enter the amount and press Done. You can also mark no-shows.</p>
        <ul className="list">
          {past.map((a) => (
            <li key={a.id}>
              <span className="when">{fmt.day(a.start)}</span>
              <span className="what">{a.client.name}<small>{a.service}{a.price ? ` · booked at ${fmt.money(a.price)}` : ""}</small></span>
              <form action={completeCut} className="inline">
                <input type="hidden" name="id" value={a.id} />
                <input type="number" name="amount" step="1" min="0" defaultValue={a.price ?? 30} aria-label="Amount paid" />
                <select name="method" defaultValue="Cash" aria-label="Paid how">{METHODS.map((m) => <option key={m}>{m}</option>)}</select>
                <button className="primary" name="status" value="COMPLETED">Done</button>
                <button name="status" value="NO_SHOW">No-show</button>
              </form>
            </li>
          ))}
          {!past.length ? <li className="empty">All caught up.</li> : null}
        </ul>
      </div>

      <div className="grid" style={{ marginTop: 14 }}>
        <div className="card">
          <h3>Revenue by week</h3>
          <p className="note"><span className="dot" style={{ background: "var(--ok)" }} />Paid <span className="dot" style={{ background: "var(--accent-2)", marginLeft: 12 }} />Booked, not yet paid</p>
          <Columns cols={cols} format={(n) => `$${Math.round(n)}`} />
        </div>
        <div className="card">
          <h3>Upcoming</h3>
          <ul className="list scroll">
            {upcoming.map((a) => (
              <li key={a.id}><span className="when">{fmt.day(a.start)}<br />{fmt.time(a.start)}</span><span className="what">{a.client.name}<small>{a.service} · {a.source}</small></span><span>{a.price ? fmt.money(a.price) : ""}</span></li>
            ))}
            {!upcoming.length ? <li className="empty">No upcoming bookings.</li> : null}
          </ul>
          <form action={addAppointment} className="inline">
            <input name="client" placeholder="Client name" required aria-label="Client name" />
            <input type="date" name="day" required aria-label="Day" />
            <input type="time" name="time" defaultValue="17:00" aria-label="Time" />
            <input type="number" name="price" defaultValue={30} aria-label="Price" />
            <button>Add booking</button>
          </form>
        </div>
      </div>

      <div className="grid" style={{ marginTop: 14 }}>
        <div className="card">
          <h3>Top clients (12 weeks)</h3>
          <table>
            <thead><tr><th>Client</th><th className="num">Visits</th><th className="num">Paid</th><th>Last cut</th></tr></thead>
            <tbody>{top.map((c) => <tr key={c.name}><td>{c.name}</td><td className="num">{c.visits}</td><td className="num">{fmt.money(c.spent)}</td><td>{fmt.short(c.last)}</td></tr>)}</tbody>
          </table>
        </div>
        <div className="card">
          <h3>Haircut payments with no booking</h3>
          <p className="note">Money that came in as haircut income but didn't match an appointment. The nightly sync adds a completed cut for clear haircut payments; these are the rest.</p>
          <ul className="list">
            {unmatched.map((t) => <li key={t.id}><span className="when">{fmt.short(t.date)}</span><span className="what">{t.name}</span><Chip tone="ok">{fmt.money(t.amount)}</Chip></li>)}
            {!unmatched.length ? <li className="empty">Everything matched.</li> : null}
          </ul>
        </div>
      </div>
    </>
  );
}
