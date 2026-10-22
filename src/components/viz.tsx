/** Small SVG charts for the agent dashboard. Server-rendered, no chart library. */

export function Sparkline({ values, color = "var(--ok)", w = 120, h = 34 }: { values: number[]; color?: string; w?: number; h?: number }) {
  if (values.length < 2) return <svg width={w} height={h} aria-hidden />;
  const max = Math.max(...values, 1e-9);
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * w},${h - 2 - (v / max) * (h - 4)}`).join(" ");
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden>
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.8" strokeLinejoin="round" />
    </svg>
  );
}

export function Ring({ pct, label }: { pct: number; label: string }) {
  const r = 22, c = 2 * Math.PI * r, p = Math.max(0, Math.min(100, pct));
  const color = p >= 90 ? "var(--ok)" : p >= 60 ? "var(--warn)" : "var(--bad)";
  return (
    <svg width="58" height="58" viewBox="0 0 58 58" role="img" aria-label={label}>
      <circle cx="29" cy="29" r={r} fill="none" stroke="var(--line)" strokeWidth="5" />
      <circle cx="29" cy="29" r={r} fill="none" stroke={color} strokeWidth="5" strokeDasharray={`${(p / 100) * c} ${c}`} strokeLinecap="round" transform="rotate(-90 29 29)" />
      <text x="29" y="33" textAnchor="middle" fontSize="13" fontWeight="700" fill="var(--ink)">{Math.round(p)}</text>
    </svg>
  );
}

/** Vertical bars, e.g. events per time bucket. */
export function BarsV({ values, color = "var(--accent)", h = 70 }: { values: number[]; color?: string; h?: number }) {
  const max = Math.max(...values, 1), w = 100 / Math.max(values.length, 1);
  return (
    <svg className="fill-w" height={h} viewBox={`0 0 100 ${h}`} preserveAspectRatio="none" role="img" aria-label="Activity over time">
      {values.map((v, i) => <rect key={i} x={i * w + w * 0.15} width={w * 0.7} y={h - (v / max) * (h - 2)} height={(v / max) * (h - 2)} fill={color} rx="0.6" opacity={v ? 0.9 : 0.15} />)}
    </svg>
  );
}

/** Smooth-ish area line across the window. */
export function AreaLine({ values, color = "var(--accent)", h = 80 }: { values: number[]; color?: string; h?: number }) {
  if (values.length < 2) return null;
  const max = Math.max(...values, 1);
  const pts = values.map((v, i) => [(i / (values.length - 1)) * 100, h - 4 - (v / max) * (h - 10)] as const);
  const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(2)},${y.toFixed(2)}`).join(" ");
  return (
    <svg className="fill-w" height={h} viewBox={`0 0 100 ${h}`} preserveAspectRatio="none" role="img" aria-label="Activity over time">
      <defs><linearGradient id="ag" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor={color} stopOpacity="0.45" /><stop offset="1" stopColor={color} stopOpacity="0" /></linearGradient></defs>
      <path d={`${line} L100,${h} L0,${h} Z`} fill="url(#ag)" />
      <path d={line} fill="none" stroke={color} strokeWidth="1.2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export function StackBar({ parts }: { parts: { label: string; value: number; color: string }[] }) {
  const total = parts.reduce((s, p) => s + p.value, 0);
  if (!total) return <p className="empty">No tool calls yet.</p>;
  return (
    <>
      <div className="stack" role="img" aria-label="Tool mix">
        {parts.map((p) => <span key={p.label} style={{ width: `${(p.value / total) * 100}%`, background: p.color }} title={`${p.label} ${p.value}`} />)}
      </div>
      <div className="legend">{parts.map((p) => <span key={p.label}><i style={{ background: p.color }} />{p.label} {Math.round((p.value / total) * 100)}%</span>)}</div>
    </>
  );
}

export function Donut({ parts, center, sub }: { parts: { label: string; value: number; color: string }[]; center: string; sub: string }) {
  const total = parts.reduce((s, p) => s + p.value, 0) || 1, r = 46, c = 2 * Math.PI * r;
  let off = 0;
  return (
    <svg width="130" height="130" viewBox="0 0 130 130" role="img" aria-label={`${center} ${sub}`}>
      <circle cx="65" cy="65" r={r} fill="none" stroke="var(--line)" strokeWidth="14" />
      {parts.map((p) => {
        const len = (p.value / total) * c;
        const el = <circle key={p.label} cx="65" cy="65" r={r} fill="none" stroke={p.color} strokeWidth="14" strokeDasharray={`${Math.max(len - 1.5, 0)} ${c}`} strokeDashoffset={-off} transform="rotate(-90 65 65)" />;
        off += len;
        return el;
      })}
      <text x="65" y="64" textAnchor="middle" fontSize="17" fontWeight="700" fill="var(--ink)">{center}</text>
      <text x="65" y="80" textAnchor="middle" fontSize="9" fill="var(--muted)">{sub}</text>
    </svg>
  );
}

/** Radar: each dot is a run; angle = agent's sector, distance from centre = how long ago. */
export function Radar({ dots }: { dots: { angle: number; dist: number; color: string; title: string }[] }) {
  const R = 78;
  return (
    <svg width="190" height="190" viewBox="-95 -95 190 190" role="img" aria-label="Agent radar">
      {[1, 0.66, 0.33].map((k) => <circle key={k} r={R * k} fill="none" stroke="var(--line)" strokeDasharray="2 3" />)}
      {[0, 120, 240].map((a) => <line key={a} x1="0" y1="0" x2={R * Math.cos((a * Math.PI) / 180)} y2={R * Math.sin((a * Math.PI) / 180)} stroke="var(--line)" />)}
      <g className="sweep"><path d={`M0,0 L${R},0 A${R},${R} 0 0,0 ${R * Math.cos(-0.5)},${R * Math.sin(-0.5)} Z`} fill="var(--accent)" opacity="0.18" /></g>
      {dots.map((d, i) => <circle key={i} cx={Math.cos(d.angle) * d.dist * R} cy={Math.sin(d.angle) * d.dist * R} r="4" fill={d.color}><title>{d.title}</title></circle>)}
      <circle r="3" fill="var(--ink)" />
    </svg>
  );
}
