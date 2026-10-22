import Link from "next/link";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { dayKey, fmt } from "@/lib/time";
import { updateCut } from "../../actions";

export const dynamic = "force-dynamic";
const STATUSES = ["COMPLETED", "BOOKED", "CANCELLED", "NO_SHOW"] as const;
const LABEL: Record<string, string> = { COMPLETED: "Completed", BOOKED: "Booked", CANCELLED: "Cancelled", NO_SHOW: "No-show" };
const METHODS = ["Cash", "Zelle", "Venmo", "Cash App", "Apple Cash", "Cash + Cash App", "Cash + Venmo"];

export default async function AllCuts({ searchParams }: { searchParams: { q?: string; status?: string } }) {
  const q = (searchParams.q ?? "").trim();
  const status = STATUSES.find((s) => s === searchParams.status);
  const where: Prisma.AppointmentWhereInput = {
    ...(q ? { client: { name: { contains: q, mode: "insensitive" } } } : {}),
    ...(status ? { status } : {}),
  };
  const cuts = await db.appointment.findMany({ where, include: { client: true }, orderBy: { start: "desc" } });
  const done = cuts.filter((c) => c.status === "COMPLETED");
  const total = done.reduce((s, c) => s + (c.amountPaid ?? 0), 0);

  // Possible duplicates: same first name, both not cancelled, within 2 days of each other.
  const first = (n: string) => n.toLowerCase().replace(/\(.*?\)/g, "").trim().split(/\s+/)[0];
  const live = cuts.filter((c) => c.status !== "CANCELLED").sort((a, b) => a.start.getTime() - b.start.getTime());
  const dupes: [typeof cuts[number], typeof cuts[number]][] = [];
  for (let i = 0; i < live.length; i++)
    for (let j = i + 1; j < live.length && live[j].start.getTime() - live[i].start.getTime() <= 2 * 86_400_000; j++)
      if (first(live[i].client.name) === first(live[j].client.name)) dupes.push([live[i], live[j]]);

  return (
    <>
      <p className="note"><Link href="/cuts">← AteebCuts</Link></p>
      <h1>All cuts</h1>
      <p className="lede">Every cut the app knows about. Change anything in a row and press Save. Income on the Money page updates to match.</p>

      <form className="inline card" style={{ margin: "12px 0" }}>
        <input name="q" defaultValue={q} placeholder="Search client" aria-label="Search client" style={{ flex: "2 1 200px" }} />
        <select name="status" defaultValue={status ?? ""} aria-label="Status filter">
          <option value="">All statuses</option>
          {STATUSES.map((s) => <option key={s} value={s}>{LABEL[s]}</option>)}
        </select>
        <button className="primary">Filter</button>
        <span className="note">{cuts.length} cuts · {done.length} completed · {fmt.money(total)} collected</span>
      </form>

      {dupes.length ? (
        <div className="card" style={{ marginBottom: 14, borderColor: "var(--warn)" }}>
          <h3>Possible duplicates ({dupes.length})</h3>
          <p className="note">Same first name within 2 days. If it&apos;s really one cut, set the extra one to Cancelled or delete it below.</p>
          <ul className="list">
            {dupes.map(([a, b]) => (
              <li key={a.id + b.id}><span className="what">{a.client.name} · {fmt.short(a.start)} {a.amountPaid != null ? fmt.money(a.amountPaid) : ""} {a.paymentMethod ?? ""}<small>vs {b.client.name} · {fmt.short(b.start)} {b.amountPaid != null ? fmt.money(b.amountPaid) : ""} {b.paymentMethod ?? ""}</small></span><span /></li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="card" style={{ overflowX: "auto" }}>
        <table>
          <thead>
            <tr><th>Client</th><th>Date</th><th>Time</th><th>Status</th><th className="num">Paid</th><th>Method</th><th>Service</th><th>From</th><th /></tr>
          </thead>
          <tbody>
            {cuts.map((c) => {
              const f = `cut-${c.id}`;
              return (
                <tr key={c.id}>
                  <td><input form={f} name="client" defaultValue={c.client.name} aria-label="Client" style={{ minWidth: 140 }} /></td>
                  <td><input form={f} type="date" name="day" defaultValue={dayKey(c.start)} aria-label="Date" /></td>
                  <td><input form={f} type="time" name="time" defaultValue={fmt.hhmm(c.start)} aria-label="Time" /></td>
                  <td>
                    <select form={f} name="status" defaultValue={c.status} aria-label="Status">
                      {STATUSES.map((s) => <option key={s} value={s}>{LABEL[s]}</option>)}
                    </select>
                  </td>
                  <td className="num"><input form={f} type="number" step="0.01" name="amount" defaultValue={c.amountPaid ?? c.price ?? ""} aria-label="Amount paid" style={{ width: 80 }} /></td>
                  <td>
                    <select form={f} name="method" defaultValue={c.paymentMethod ?? ""} aria-label="Payment method">
                      <option value="">—</option>
                      {[...new Set([...METHODS, ...(c.paymentMethod ? [c.paymentMethod] : [])])].map((m) => <option key={m}>{m}</option>)}
                    </select>
                  </td>
                  <td><input form={f} name="service" defaultValue={c.service} aria-label="Service" style={{ minWidth: 110 }} /></td>
                  <td><small>{c.source}</small></td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    <form id={f} action={updateCut} className="inline">
                      <input type="hidden" name="id" value={c.id} />
                      <button name="op" value="save" className="primary">Save</button>
                      <button name="op" value="delete" aria-label={`Delete ${c.client.name} on ${fmt.short(c.start)}`}>Delete</button>
                    </form>
                  </td>
                </tr>
              );
            })}
            {!cuts.length ? <tr><td colSpan={9} className="empty">No cuts match.</td></tr> : null}
          </tbody>
        </table>
      </div>
    </>
  );
}
