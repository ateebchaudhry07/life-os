import { db, getSettings } from "@/lib/db";
import { fmt } from "@/lib/time";
import { hasClaude } from "@/lib/claude";
import { runJob, saveArea, saveCourseLink, saveSettings } from "../actions";
import { Chip } from "@/components/ui";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // imports and syncs can take a few minutes

export default async function Settings() {
  const [s, areas, google, logs, cats, courses] = await Promise.all([
    getSettings(),
    db.area.findMany({ orderBy: { priority: "asc" } }),
    db.account.findFirst({ where: { provider: "google" } }),
    db.syncLog.findMany({ where: { job: { not: "bookings-quick" } }, orderBy: { startedAt: "desc" }, take: 12 }),
    db.category.findMany({ include: { area: true }, orderBy: { name: "asc" } }),
    db.course.findMany({ orderBy: { code: "asc" } }),
  ]);
  const conn: [string, boolean, string][] = [
    ["Google (Gmail + Calendar)", Boolean(google?.refresh_token), "Sign in once with Google."],
    ["Claude API", hasClaude(), "Set ANTHROPIC_API_KEY."],
    ["Canvas", Boolean(process.env.CANVAS_TOKEN || s.canvasIcsUrl), "UMich may block access tokens. Instead: Canvas → Calendar → Calendar Feed (bottom right) → copy the link and paste it below."],
    ["Asana", Boolean(process.env.ASANA_TOKEN), "Set ASANA_TOKEN (Asana → Settings → Apps → Developer apps → personal access token)."],
    ["Phone notifications", Boolean(s.ntfyTopic), "Install the ntfy app, subscribe to a private topic, enter it below."],
    ["Notion import (one time)", Boolean(process.env.NOTION_TOKEN), "notion.so/my-integrations → New integration → copy the secret into NOTION_TOKEN in Vercel; then share Money Tracker, Transactions and Workout Log with it (••• → Connections)."],
  ];

  return (
    <>
      <h1>Settings</h1>

      <h2>Connections</h2>
      <div className="card">
        <ul className="list">
          {conn.map(([name, ok, how]) => <li key={name}><span className="when"><Chip tone={ok ? "ok" : "warn"}>{ok ? "on" : "off"}</Chip></span><span className="what">{name}{!ok ? <small>{how}</small> : null}</span><span /></li>)}
        </ul>
        <form action={saveSettings} className="inline">
          <input type="hidden" name="priorities" value={s.priorities} />
          <input type="hidden" name="gymPerWeek" value={s.gymPerWeek} />
          <input type="hidden" name="gymMinutes" value={s.gymMinutes} />
          <input type="hidden" name="wakeTime" value={s.wakeTime} />
          <input type="hidden" name="sleepStart" value={s.sleepStart} />
          <input name="ntfyTopic" defaultValue={s.ntfyTopic ?? ""} placeholder="ntfy topic (e.g. ateeb-life-7f3k)" aria-label="ntfy topic" style={{ flex: "1 1 220px" }} />
          <input name="canvasIcsUrl" defaultValue={s.canvasIcsUrl ?? ""} placeholder="Canvas calendar feed URL" aria-label="Canvas calendar feed URL" style={{ flex: "2 1 320px" }} />
          <input name="canvasBaseUrl" defaultValue={s.canvasBaseUrl ?? ""} aria-label="Canvas URL" style={{ flex: "1 1 220px" }} />
          <button className="primary">Save</button>
        </form>
      </div>

      <h2>Courses on Canvas</h2>
      <div className="card">
        <p className="note">Each night's lecture review links that day's slides. With a Canvas token it finds the exact file. Without one it links the course's Modules page, so paste each course's Canvas link here (open the course, copy the address bar). Links found in your calendar feed fill in automatically.</p>
        <ul className="list">
          {courses.map((c) => (
            <li key={c.id}>
              <span className="when"><Chip tone={c.canvasId ? "ok" : "warn"}>{c.canvasId ? "linked" : "no link"}</Chip></span>
              <span className="what">{c.code}{c.name ? <small>{c.name}</small> : null}</span>
              <form action={saveCourseLink} className="inline">
                <input type="hidden" name="id" value={c.id} />
                <input name="link" defaultValue={c.canvasId ? `${s.canvasBaseUrl ?? "https://umich.instructure.com"}/courses/${c.canvasId}` : ""} placeholder="https://umich.instructure.com/courses/…" aria-label={`${c.code} Canvas link`} style={{ flex: "1 1 260px" }} />
                <button>Save</button>
              </form>
            </li>
          ))}
        </ul>
      </div>

      <h2>Run automations now</h2>
      <div className="card">
        <p className="note">These run on their own: lecture review ~9:15 PM, AteebCuts & money sync ~10:50 PM, week plan Sunday afternoon. The first sync looks back 30 days.</p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <form action={runJob}><input type="hidden" name="job" value="nightly-sync" /><input type="hidden" name="days" value="30" /><button className="primary">Sync last 30 days</button></form>
          <form action={runJob}><input type="hidden" name="job" value="nightly-sync" /><button>Nightly sync</button></form>
          <form action={runJob}><input type="hidden" name="job" value="lecture-review" /><button>Tonight's lecture review</button></form>
          <form action={runJob}><input type="hidden" name="job" value="weekly-plan" /><button>Plan next week</button></form>
          <form action={runJob}><input type="hidden" name="job" value="import-notion" /><button disabled={!process.env.NOTION_TOKEN} title={process.env.NOTION_TOKEN ? "" : "Add NOTION_TOKEN in Vercel first"}>Import from Notion</button></form>
        </div>
        <ul className="list">
          {logs.map((l) => <li key={l.id}><span className="when">{fmt.short(l.startedAt)} {fmt.time(l.startedAt)}</span><span className="what">{l.job}<small style={{ whiteSpace: "pre-line" }}>{l.summary}</small></span><Chip tone={l.ok ? "ok" : l.ok === false ? "bad" : undefined}>{l.ok ? "ok" : l.ok === false ? "failed" : "…"}</Chip></li>)}
        </ul>
      </div>

      <h2>Areas of your life</h2>
      <div className="card">
        <p className="note">Areas group your time and money: the Today page shows hours per area, and the planner balances them. Words are matched against calendar event titles.</p>
        <table>
          <thead><tr><th>Area</th><th className="num">Priority</th><th className="num">Goal h/week</th><th>Matches words</th><th>Color</th><th /></tr></thead>
          <tbody>
            {areas.map((a) => (
              <tr key={a.id}>
                <td colSpan={6}>
                  <form action={saveArea} className="inline">
                    <input name="name" defaultValue={a.name} readOnly aria-label="Area" style={{ width: 150 }} />
                    <input type="number" name="priority" defaultValue={a.priority} aria-label="Priority" />
                    <input type="number" step="0.5" name="weeklyGoalHours" defaultValue={a.weeklyGoalHours ?? ""} aria-label="Weekly goal hours" />
                    <input name="matchWords" defaultValue={a.matchWords.join(", ")} aria-label="Match words" style={{ flex: "1 1 200px" }} />
                    <input type="color" name="color" defaultValue={a.color} aria-label="Color" />
                    <button>Save</button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <form action={saveArea} className="inline">
          <input name="name" placeholder="New area (e.g. MCAT prep)" required aria-label="New area name" />
          <input type="number" name="priority" defaultValue={50} aria-label="Priority" />
          <input type="number" step="0.5" name="weeklyGoalHours" placeholder="h/week" aria-label="Weekly goal hours" />
          <input name="matchWords" placeholder="words, comma separated" aria-label="Match words" />
          <input type="color" name="color" defaultValue="#7c3aed" aria-label="Color" />
          <button className="primary">Add area</button>
        </form>
      </div>

      <h2>Money categories</h2>
      <div className="card">
        <p className="note">Add or budget categories on the Money page. Categories linked to an area roll up under it.</p>
        <p>{cats.map((c) => <span key={c.id} className="chip" style={{ marginRight: 6, marginBottom: 6, display: "inline-block" }}><span className="dot" style={{ background: c.color }} />{c.name}{c.area ? ` · ${c.area.name}` : ""}{c.monthlyBudget ? ` · ${fmt.money(c.monthlyBudget)}/mo` : ""}</span>)}</p>
      </div>
    </>
  );
}
