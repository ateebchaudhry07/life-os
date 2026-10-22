import Link from "next/link";
import { db, getSettings } from "@/lib/db";
import { AGENTS, providerFor } from "@/lib/agents/defs";
import { providerReady } from "@/lib/agents/runner";
import { CLAUDE_AGENT_MODEL } from "@/lib/agents/providers/claude";
import { OPENAI_AGENT_MODEL } from "@/lib/agents/providers/openai";
import { addDays, at, dayKey, daysBetween, fmt, mondayOf } from "@/lib/time";
import { decideProposal, runAgentNow, setAgentProvider } from "./actions";
import { AutoRefresh } from "@/components/AutoRefresh";
import { AreaLine, BarsV, Donut, Radar, Ring, Sparkline, StackBar } from "@/components/viz";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // agents started from this page keep running in the background

const WINDOWS = { "1h": 3_600_000, "24h": 86_400_000, "7d": 7 * 86_400_000, "30d": 30 * 86_400_000 } as const;
const PALETTE = ["#a78bfa", "#f472b6", "#22d3ee", "#34d399", "#fbbf24", "#60a5fa", "#fb7185", "#c084fc"];
const KIND_TONE: Record<string, string> = { tool: "ok", message: "accent", proposal: "warn", error: "bad", start: "muted", done: "muted" };
const money2 = (n: number) => `$${n.toFixed(n < 10 ? 2 : 0)}`;
const ago = (d: Date) => { const s = Math.round((Date.now() - d.getTime()) / 1000); return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`; };
const pct = (xs: number[], p: number) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };

export default async function Agents({ searchParams }: { searchParams: { w?: string; f?: string } }) {
  const wKey = (searchParams.w && searchParams.w in WINDOWS ? searchParams.w : "24h") as keyof typeof WINDOWS;
  const filter = searchParams.f ?? "all";
  const span = WINDOWS[wKey], since = new Date(Date.now() - span);
  const today = dayKey();

  const [settings, runs, events, pending, decided, latestEvents, cutsWeek, booked, spent30, nextExam, reminders] = await Promise.all([
    getSettings(),
    db.agentRun.findMany({ where: { startedAt: { gte: since } }, orderBy: { startedAt: "desc" } }),
    db.agentEvent.findMany({ where: { at: { gte: since } }, select: { at: true, kind: true, tool: true, ms: true, run: { select: { agent: true } } }, orderBy: { at: "desc" }, take: 3000 }),
    db.proposal.findMany({ where: { status: "pending" }, orderBy: { createdAt: "desc" }, take: 25 }),
    db.proposal.count({ where: { decidedAt: { gte: since } } }),
    db.agentEvent.findMany({
      where: filter === "tools" ? { kind: "tool" } : filter === "messages" ? { kind: { in: ["message", "proposal"] } } : filter === "errors" ? { kind: "error" } : {},
      include: { run: { select: { agent: true } } }, orderBy: { at: "desc" }, take: 40,
    }),
    db.appointment.aggregate({ _sum: { amountPaid: true }, _count: true, where: { status: "COMPLETED", start: { gte: at(mondayOf(today)) } } }),
    db.appointment.count({ where: { status: "BOOKED", start: { gte: new Date() } } }),
    db.transaction.aggregate({ _sum: { amount: true }, where: { type: "EXPENSE", date: { gte: at(addDays(today, -30)) } } }),
    db.assignment.findFirst({ where: { kind: "exam", due: { gte: new Date() } }, orderBy: { due: "asc" } }),
    db.reminder.count({ where: { done: false } }),
  ]);
  const lastRuns = await Promise.all(AGENTS.map((a) => db.agentRun.findFirst({ where: { agent: a.key }, orderBy: { startedAt: "desc" } })));

  const working = runs.filter((r) => r.status === "running");
  const finished = runs.filter((r) => r.status !== "running");
  const failed = finished.filter((r) => r.status === "error");
  const spend = runs.reduce((s, r) => s + r.costUsd, 0);
  const tokens = runs.reduce((s, r) => s + r.inputTokens + r.outputTokens, 0);
  const health = finished.length ? ((finished.length - failed.length) / finished.length) * 100 : 100;
  const toolEvents = events.filter((e) => e.kind === "tool");
  const perMin = events.filter((e) => e.at.getTime() > Date.now() - 10 * 60_000).length / 10;

  // Time buckets across the window
  const N = 40, bw = span / N, bucket = (d: Date) => Math.min(N - 1, Math.max(0, Math.floor((d.getTime() - since.getTime()) / bw)));
  const evBuckets = Array(N).fill(0), costBuckets = Array(N).fill(0);
  for (const e of events) evBuckets[bucket(e.at)]++;
  for (const r of runs) costBuckets[bucket(r.startedAt)] += r.costUsd;
  const peak = Math.max(...evBuckets) / (bw / 1000);

  const toolCounts = new Map<string, number>();
  for (const e of toolEvents) toolCounts.set(e.tool ?? "?", (toolCounts.get(e.tool ?? "?") ?? 0) + 1);
  const toolMix = [...toolCounts].sort((a, b) => b[1] - a[1]).slice(0, 7).map(([label, value], i) => ({ label, value, color: PALETTE[i % PALETTE.length] }));
  const perf = [...toolCounts.keys()].map((t) => { const ms = toolEvents.filter((e) => e.tool === t && e.ms != null).map((e) => e.ms!); return { tool: t, calls: ms.length, p50: pct(ms, 50), p95: pct(ms, 95) }; }).sort((a, b) => b.p95 - a.p95).slice(0, 5);
  const maxP95 = Math.max(...perf.map((p) => p.p95), 1);

  const byModel = new Map<string, { cost: number; tokens: number }>();
  for (const r of runs) { const m = byModel.get(r.model) ?? { cost: 0, tokens: 0 }; m.cost += r.costUsd; m.tokens += r.inputTokens + r.outputTokens; byModel.set(r.model, m); }
  const models = [...byModel].sort((a, b) => b[1].cost - a[1].cost).map(([label, v], i) => ({ label, value: v.cost, tokens: v.tokens, color: PALETTE[(i + 2) % PALETTE.length] }));

  const color = (agent: string) => AGENTS.find((a) => a.key === agent)?.color ?? "var(--muted)";
  const radarDots = runs.slice(0, 40).map((r, i) => {
    const sector = Math.max(0, AGENTS.findIndex((a) => a.key === r.agent));
    return { angle: ((sector * 120 + 20 + ((i * 37) % 80)) * Math.PI) / 180, dist: 0.15 + 0.85 * Math.min(1, (Date.now() - r.startedAt.getTime()) / span), color: r.status === "error" ? "var(--bad)" : r.status === "running" ? "var(--warn)" : color(r.agent), title: `${r.agent} · ${r.status} · ${ago(r.startedAt)}` };
  });
  const ready = { claude: providerReady("claude"), openai: providerReady("openai") };

  return (
    <div className="ops">
      <AutoRefresh live={working.length > 0} />

      <header className="opsbar">
        <div className="opsbrand"><span className="logo" aria-hidden>✦</span><div><b>Life OS</b><small>agents for Ateeb</small></div></div>
        <span className={`pill ${working.length ? "live" : ""}`}><i />{working.length ? "LIVE" : "IDLE"}</span>
        <nav className="seg" aria-label="Time window">{Object.keys(WINDOWS).map((k) => <Link key={k} href={`/?w=${k}&f=${filter}`} aria-current={k === wKey ? "true" : undefined}>{k}</Link>)}</nav>
        <span className={`pill ${ready.claude ? "ok" : "off"}`} title={CLAUDE_AGENT_MODEL}><i />Claude</span>
        <span className={`pill ${ready.openai ? "ok" : "off"}`} title={OPENAI_AGENT_MODEL}><i />OpenAI</span>
        <form action={runAgentNow} className="push"><input type="hidden" name="agent" value="all" /><button className="primary">▶ Run all agents</button></form>
      </header>

      <section className="tilebar">
        <div className="op span2">
          <span className="k">AI spend · {wKey}</span>
          <div className="row"><b className="big ok">{money2(spend)}</b><Sparkline values={costBuckets} /></div>
          <small>{tokens.toLocaleString()} tokens · {runs.length} runs</small>
        </div>
        <div className="op"><span className="k">Health</span><div className="row"><Ring pct={health} label="Share of runs without errors" /><small>{failed.length ? `${failed.length} failed` : "all nominal"}</small></div></div>
        <div className="op"><span className="k">Working</span><b className="big">{working.length}</b><small>live agents</small></div>
        <div className="op"><span className="k">Events / min</span><b className="big">{perMin.toFixed(1)}</b><small>{events.length} in window</small></div>
        <div className="op"><span className="k">Tools run</span><b className="big">{toolEvents.length}</b><small>{decided} decisions made</small></div>
        <div className={`op ${failed.length ? "hot" : ""}`}><span className="k">Failed</span><b className="big">{failed.length}</b><small>runs in window</small></div>
        <div className={`op ${pending.length ? "warm" : ""}`}><span className="k">Waiting on you</span><b className="big">{pending.length}</b><small>approvals</small></div>
      </section>

      <section className="lifebar" aria-label="Life snapshot">
        <Link href="/cuts">✂ This week <b>{fmt.money(cutsWeek._sum.amountPaid ?? 0)}</b> · {cutsWeek._count} cuts · {booked} booked ahead</Link>
        <Link href="/money">$ Spent 30d <b>{fmt.money(spent30._sum.amount ?? 0)}</b></Link>
        <Link href="/school">✎ Next exam <b>{nextExam?.due ? `${daysBetween(today, dayKey(nextExam.due))}d` : "—"}</b> {nextExam?.title ?? ""}</Link>
        <Link href="/reminders">◷ Reminders <b>{reminders}</b></Link>
        <Link href="/today">Today’s schedule →</Link>
      </section>

      <section className="opsgrid">
        <div className="panel sessions">
          <header><span className="k">Agents</span><h3>Every agent session</h3></header>
          {AGENTS.map((a, i) => {
            const last = lastRuns[i];
            const prov = providerFor(a.key, settings.agentProviders);
            const status = last?.status ?? "idle";
            return (
              <article key={a.key} className="agent" style={{ borderLeftColor: a.color }}>
                <div className="arow"><span className={`dot ${status}`} /><b>{a.name}</b>
                  <form action={setAgentProvider} className="provsel">
                    <input type="hidden" name="agent" value={a.key} />
                    <button name="provider" value="claude" aria-pressed={prov === "claude"}>Claude</button>
                    <button name="provider" value="openai" aria-pressed={prov === "openai"}>OpenAI</button>
                  </form>
                </div>
                <small className="muted">{a.blurb}</small>
                {last ? <p className={`sum ${last.status === "error" ? "err" : ""}`}>{last.status === "error" ? last.error : last.status === "running" ? "Working…" : last.summary}</p> : <p className="sum muted">Hasn’t run yet.</p>}
                <div className="arow foot">
                  <small>{last ? `${last.model} · ${(last.inputTokens + last.outputTokens).toLocaleString()} tok · ${money2(last.costUsd)} · ${ago(last.startedAt)}` : "never run"}</small>
                  <form action={runAgentNow}><input type="hidden" name="agent" value={a.key} /><button disabled={status === "running"}>{status === "running" ? "Running…" : "Run"}</button></form>
                </div>
              </article>
            );
          })}
        </div>

        <div className="panel throughput">
          <header><span className="k">Throughput</span><h3>How busy the agents are</h3><b className="mono">{peak.toFixed(2)}<small> events/s peak</small></b></header>
          <BarsV values={evBuckets} />
        </div>

        <div className="panel toolmix">
          <header><span className="k">Tool mix</span><h3>What the agents are doing</h3><small className="mono">{toolEvents.length} calls</small></header>
          <StackBar parts={toolMix} />
        </div>

        <div className="panel radar">
          <header><span className="k">Radar</span><h3>Live radar</h3><small className="mono">centre = now</small></header>
          <div className="center"><Radar dots={radarDots} /></div>
          <div className="legend">{AGENTS.map((a) => <span key={a.key}><i style={{ background: a.color }} />{a.name.replace(" agent", "")}</span>)}<span><i style={{ background: "var(--bad)" }} />errored</span></div>
        </div>

        <div className="panel events">
          <header><span className="k">Live</span><h3>Live events</h3>
            <nav className="seg small" aria-label="Event filter">{["all", "tools", "messages", "errors"].map((f) => <Link key={f} href={`/?w=${wKey}&f=${f}`} aria-current={f === filter ? "true" : undefined}>{f}</Link>)}</nav>
          </header>
          <ol className="feed">
            {latestEvents.map((e) => (
              <li key={e.id} style={{ borderLeftColor: color(e.run.agent) }}>
                <time>{fmt.hhmm(e.at)}</time>
                <span className={`tag ${KIND_TONE[e.kind] ?? ""}`}>{e.kind === "tool" ? e.tool : e.kind}</span>
                <span className="txt">{e.detail}</span>
                <span className="who">{e.run.agent}{e.ms != null ? ` · ${e.ms}ms` : ""}</span>
              </li>
            ))}
            {!latestEvents.length ? <li className="empty">No events yet. Press “Run all agents”.</li> : null}
          </ol>
        </div>

        <div className="panel needs">
          <header><span className="k">Alerts</span><h3>What needs you</h3><small className="mono">{pending.length} open</small></header>
          {pending.map((p) => {
            const a = p.action as Record<string, unknown>;
            return (
              <article key={p.id} className="ask" style={{ borderColor: color(p.agent) }}>
                <div className="arow"><b>{p.title}</b><small className="muted">{p.agent}</small></div>
                {p.detail ? <small className="muted">{p.detail}</small> : null}
                {p.kind === "message" ? <pre className="msg">{String(a.text ?? "")}</pre> : null}
                <form action={decideProposal} className="arow">
                  <input type="hidden" name="id" value={p.id} />
                  <button name="decision" value="approve" className="approve">✓ {p.kind === "message" ? "Sent it" : "Approve"}</button>
                  <button name="decision" value="deny" className="deny">✕ Deny</button>
                </form>
              </article>
            );
          })}
          {!pending.length ? <p className="empty">Nothing waiting. Agents ask here before they change anything.</p> : null}
        </div>

        <div className="panel cost">
          <header><span className="k">Cost</span><h3>Where the AI money goes</h3><small className="mono">by model</small></header>
          <div className="costrow">
            <Donut parts={models.length ? models : [{ label: "none", value: 1, color: "var(--line)" }]} center={money2(spend)} sub="total spend" />
            <ul className="legendlist">{models.map((m) => <li key={m.label}><i style={{ background: m.color }} />{m.label}<span className="mono">{(m.tokens / 1000).toFixed(1)}k tok · {money2(m.value)}</span></li>)}{!models.length ? <li className="muted">No runs in this window.</li> : null}</ul>
          </div>
          <small className="muted">OpenAI costs are estimates.</small>
        </div>

        <div className="panel perf">
          <header><span className="k">Performance</span><h3>Which tools are slow</h3><small className="mono">p50 · p95</small></header>
          {perf.map((p) => (
            <div key={p.tool} className="perfrow">
              <div className="arow"><span>{p.tool} <small className="muted">{p.calls} calls</small></span><small className="mono">{p.p50}ms / {p.p95}ms</small></div>
              <div className="track"><span style={{ width: `${(p.p50 / maxP95) * 100}%` }} /><i style={{ left: `${(p.p95 / maxP95) * 100}%` }} /></div>
            </div>
          ))}
          {!perf.length ? <p className="empty">No tool timings yet.</p> : null}
        </div>

        <div className="panel timeline">
          <header><span className="k">Timeline</span><h3>Runs over time</h3><small className="mono">{runs.length} runs</small></header>
          {runs.slice(0, 8).map((r) => {
            const s = r.startedAt.getTime(), e = (r.finishedAt ?? new Date()).getTime();
            const left = ((s - since.getTime()) / span) * 100, width = Math.max(((e - s) / span) * 100, 0.8);
            return (
              <div key={r.id} className="tlrow">
                <small className="mono">{r.agent}</small>
                <div className="track"><span style={{ left: `${left}%`, width: `${width}%`, background: r.status === "error" ? "var(--bad)" : color(r.agent) }} title={`${fmt.time(r.startedAt)} · ${Math.round((e - s) / 1000)}s`} /></div>
                <small className="mono">{money2(r.costUsd)}</small>
              </div>
            );
          })}
          {!runs.length ? <p className="empty">No runs in this window.</p> : null}
        </div>

        <div className="panel activity">
          <header><span className="k">Mission timeline</span><h3>Activity over time</h3></header>
          <AreaLine values={evBuckets} />
          <div className="axis mono">{[0, 0.25, 0.5, 0.75, 1].map((k) => <small key={k}>{fmt.hhmm(new Date(since.getTime() + k * span))}</small>)}</div>
        </div>
      </section>
    </div>
  );
}
