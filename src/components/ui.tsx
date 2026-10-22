import Link from "next/link";

export function Tile({ label, value, sub, href, alert }: { label: string; value: React.ReactNode; sub?: React.ReactNode; href?: string; alert?: boolean }) {
  const body = (
    <>
      <span className="label">{label}</span>
      <span className="value">{value}</span>
      {sub && <span className="sub">{sub}</span>}
    </>
  );
  return href ? <Link className={`tile${alert ? " alert" : ""}`} href={href}>{body}</Link> : <div className={`tile${alert ? " alert" : ""}`}>{body}</div>;
}

export function Bars({ rows, format = (n) => String(n) }: { rows: { label: string; value: number; color?: string; budget?: number | null }[]; format?: (n: number) => string }) {
  if (!rows.length) return <p className="empty">Nothing here yet.</p>;
  const max = Math.max(...rows.map((r) => Math.max(r.value, r.budget ?? 0)), 1);
  return (
    <div className="bars">
      {rows.map((r) => (
        <div className="bar" key={r.label}>
          <span>{r.label}</span>
          <div className="track">
            <div className="fill" style={{ width: `${(Math.max(r.value, 0) / max) * 100}%`, background: r.color ?? "var(--accent)" }} />
            {r.budget ? <div className="budget" style={{ left: `${(r.budget / max) * 100}%` }} title={`Budget ${format(r.budget)}`} /> : null}
          </div>
          <span className="v">{format(r.value)}</span>
        </div>
      ))}
    </div>
  );
}

/** Stacked weekly columns. Each segment: value + color. */
export function Columns({ cols, format = (n) => String(n), goal }: { cols: { label: string; segments: { value: number; color: string }[] }[]; format?: (n: number) => string; goal?: number }) {
  const max = Math.max(...cols.map((c) => c.segments.reduce((s, x) => s + x.value, 0)), goal ?? 0, 1);
  return (
    <div className="cols" role="img" aria-label="Weekly chart">
      {cols.map((c) => {
        const total = c.segments.reduce((s, x) => s + x.value, 0);
        return (
          <div className="col" key={c.label}>
            <span className="num">{total ? format(total) : ""}</span>
            <div className="stack" style={{ height: `${(total / max) * 100}%` }}>
              {c.segments.map((s, i) => (
                <div key={i} style={{ height: total ? `${(s.value / total) * 100}%` : 0, background: s.color }} />
              ))}
            </div>
            <span className="lbl">{c.label}</span>
          </div>
        );
      })}
    </div>
  );
}

export function Chip({ tone, children }: { tone?: "ok" | "warn" | "bad"; children: React.ReactNode }) {
  return <span className={`chip${tone ? " " + tone : ""}`}>{children}</span>;
}
