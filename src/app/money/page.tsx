import { db } from "@/lib/db";
import { addDays, at, dayKey, fmt, mondayOf } from "@/lib/time";
import { addCategory, addTransaction, runJob, setCategory, uploadCsv } from "../actions";
import { Bars, Columns, Tile } from "@/components/ui";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // reading a PDF statement takes a minute

export default async function Money({ searchParams }: { searchParams: { days?: string } }) {
  const days = Number(searchParams.days ?? 30);
  const today = dayKey();
  const since = at(addDays(today, -days));
  const [tx, cats, imports] = await Promise.all([
    db.transaction.findMany({ where: { date: { gte: at(addDays(today, -7 * 12)) } }, include: { category: true }, orderBy: { date: "desc" } }),
    db.category.findMany({ orderBy: { name: "asc" }, include: { area: true } }),
    db.syncLog.findMany({ where: { job: "csv-import" }, orderBy: { startedAt: "desc" }, take: 3 }),
  ]);
  const lastSync = await db.syncLog.findFirst({ where: { job: "nightly-sync" }, orderBy: { startedAt: "desc" } });
  const inRange = tx.filter((t) => t.date >= since);
  const income = inRange.filter((t) => t.type === "INCOME").reduce((s, t) => s + t.amount, 0);
  const cuts = inRange.filter((t) => t.type === "INCOME" && t.category?.name === "AteebCuts Income").reduce((s, t) => s + t.amount, 0);
  const spent = inRange.filter((t) => t.type === "EXPENSE").reduce((s, t) => s + t.amount, 0);
  const invested = inRange.filter((t) => t.category?.name === "Robinhood / Investing").reduce((s, t) => s + t.amount, 0);

  const byCat = new Map<string, { value: number; color: string; budget: number | null }>();
  for (const t of inRange.filter((t) => t.type === "EXPENSE")) {
    const k = t.category?.name ?? "Uncategorized";
    const c = byCat.get(k) ?? { value: 0, color: t.category?.color ?? "#6b7280", budget: t.category?.monthlyBudget ? (t.category.monthlyBudget * days) / 30 : null };
    c.value += t.amount;
    byCat.set(k, c);
  }
  const catRows = [...byCat.entries()].map(([label, v]) => ({ label, ...v })).sort((a, b) => b.value - a.value);

  const weeks = Array.from({ length: 12 }, (_, i) => addDays(mondayOf(today), -7 * (11 - i)));
  const cols = weeks.map((w) => {
    const wk = tx.filter((t) => mondayOf(dayKey(t.date)) === w);
    return {
      label: fmt.short(at(w, "12:00")),
      segments: [
        { value: wk.filter((t) => t.type === "INCOME").reduce((s, t) => s + t.amount, 0), color: "var(--ok)" },
      ],
      spent: wk.filter((t) => t.type === "EXPENSE").reduce((s, t) => s + t.amount, 0),
    };
  });

  return (
    <>
      <h1>Money</h1>
      <p className="lede">Venmo, Zelle, Robinhood and card payments come in from your email every night. Card purchases come from bank CSVs: download one from Capital One 360 or Flagstar and drop it below, about once a month.</p>
      <form className="inline" style={{ marginTop: 12 }}>
        {[7, 30, 90].map((d) => <button key={d} name="days" value={d} className={d === days ? "primary" : ""}>{d} days</button>)}
      </form>
      <div className="tiles">
        <Tile label={`Money in, ${days}d`} value={fmt.money(income)} sub={`${fmt.money(cuts)} from AteebCuts`} />
        <Tile label={`Spent, ${days}d`} value={fmt.money(spent)} sub="purchases & payments to people" />
        <Tile label="Net" value={<span className={income - spent >= 0 ? "pos" : "neg"}>{fmt.money(income - spent)}</span>} sub="in minus spent" />
        <Tile label="Invested" value={fmt.money(invested)} sub="Robinhood & Roth IRA" />
      </div>

      <div className="grid" style={{ marginTop: 22 }}>
        <div className="card">
          <h3>Where it went</h3>
          <p className="note">Spending by category, last {days} days. The tick mark is your budget for the period.</p>
          <Bars rows={catRows} format={(n) => fmt.money(Math.round(n))} />
        </div>
        <div className="card">
          <h3>Weekly in vs. out</h3>
          <p className="note"><span className="dot" style={{ background: "var(--ok)" }} />Money in <span className="dot" style={{ background: "var(--bad)", marginLeft: 12 }} />Spent</p>
          <Columns cols={cols.map((c) => ({ label: c.label, segments: [c.segments[0]] }))} format={(n) => `$${Math.round(n)}`} />
          <Columns cols={cols.map((c) => ({ label: "", segments: [{ value: c.spent, color: "var(--bad)" }] }))} format={(n) => `$${Math.round(n)}`} />
        </div>
      </div>

      <h2>Add money data</h2>
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="inline" style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <form action={runJob}><input type="hidden" name="job" value="nightly-sync" /><input type="hidden" name="days" value="30" /><button className="primary">Sync Venmo, Zelle & card alerts (last 30 days)</button></form>
          <span className="note">{lastSync ? <>Last sync {fmt.short(lastSync.startedAt)} {fmt.time(lastSync.startedAt)}{lastSync.ok === false ? <span style={{ color: "var(--bad)", whiteSpace: "pre-line" }}>{"\n"}{lastSync.summary}</span> : lastSync.ok ? " · ok" : " · running…"}</> : "Never synced yet. Press the button."}</span>
        </div>
      </div>
      <div className="grid">
        <div className="card">
          <h3>Import a bank statement</h3>
          <p className="note">Capital One 360: Account → Download transactions → CSV. Flagstar: Activity → Export → CSV, or upload the monthly statement PDF as is (Flagstar Documents → Statements → download). Rows already in the app are skipped, so overlapping files are fine.</p>
          <form action={uploadCsv} className="inline">
            <input type="file" name="file" accept=".csv,text/csv,.pdf,application/pdf" required aria-label="Statement file (CSV or PDF)" />
            <select name="account" aria-label="Account"><option>360 Checking</option><option>Flagstar</option><option>Discover</option><option>Other</option></select>
            <button className="primary">Import</button>
          </form>
          {imports.map((l) => <p className="note" key={l.id} style={l.ok === false ? { color: "var(--bad)" } : undefined}>{fmt.short(l.startedAt)}: {l.ok === false ? "failed: " : ""}{l.summary}</p>)}
        </div>
        <div className="card">
          <h3>Add a transaction</h3>
          <form action={addTransaction} className="inline">
            <input name="name" placeholder="What" required aria-label="What" />
            <input type="number" step="0.01" name="amount" placeholder="$" required aria-label="Amount" />
            <select name="type" aria-label="Type"><option value="EXPENSE">Spent</option><option value="INCOME">Got paid</option><option value="TRANSFER">Transfer</option></select>
            <select name="category" aria-label="Category"><option value="">Auto category</option>{cats.map((c) => <option key={c.id}>{c.name}</option>)}</select>
            <input type="date" name="day" defaultValue={today} aria-label="Date" />
            <button>Add</button>
          </form>
          <h3 style={{ marginTop: 8 }}>Add a category or budget</h3>
          <form action={addCategory} className="inline">
            <input name="name" placeholder="Category name" required aria-label="Category name" />
            <input type="number" name="budget" placeholder="$/month" aria-label="Monthly budget" />
            <input type="color" name="color" defaultValue="#6b7280" aria-label="Color" />
            <button>Save</button>
          </form>
        </div>
      </div>

      <h2>Transactions</h2>
      <div className="card">
        <div className="scroll">
          <table>
            <thead><tr><th>Date</th><th>What</th><th>Category</th><th>Account</th><th className="num">Amount</th></tr></thead>
            <tbody>
              {inRange.map((t) => (
                <tr key={t.id}>
                  <td>{fmt.short(t.date)}</td>
                  <td>{t.name}</td>
                  <td>
                    <form action={setCategory} className="inline">
                      <input type="hidden" name="id" value={t.id} />
                      <select name="category" defaultValue={t.category?.name ?? ""} aria-label="Category">{cats.map((c) => <option key={c.id}>{c.name}</option>)}</select>
                      <button aria-label="Save category">✓</button>
                    </form>
                  </td>
                  <td>{t.account ?? t.source}</td>
                  <td className={`num ${t.type === "INCOME" ? "pos" : t.type === "EXPENSE" ? "neg" : ""}`}>{t.type === "EXPENSE" ? "−" : t.type === "INCOME" ? "+" : ""}{fmt.money(Math.abs(t.amount))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
