import { TZ } from "./config";

/** YYYY-MM-DD for a Date in Eastern time. */
export function dayKey(d: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(d);
}

/** Minutes east of UTC for Eastern time on a given date (e.g. -240 in summer). */
function tzOffsetMinutes(d: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: TZ, timeZoneName: "longOffset" }).formatToParts(d);
  const name = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT-05:00";
  const m = name.match(/GMT([+-])(\d{2}):?(\d{2})?/);
  if (!m) return -300;
  const sign = m[1] === "-" ? -1 : 1;
  return sign * (Number(m[2]) * 60 + Number(m[3] ?? 0));
}

/** The instant of a wall-clock time in Eastern time, e.g. at("2026-10-26", "09:30"). */
export function at(day: string, hhmm = "00:00"): Date {
  const guess = new Date(`${day}T${hhmm}:00Z`);
  const off = tzOffsetMinutes(guess);
  return new Date(guess.getTime() - off * 60_000);
}

export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Monday of the week containing `day`. */
export function mondayOf(day: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  return addDays(day, -((d.getUTCDay() + 6) % 7));
}

export function daysBetween(a: string, b: string): number {
  return Math.round((new Date(`${b}T12:00:00Z`).getTime() - new Date(`${a}T12:00:00Z`).getTime()) / 86_400_000);
}

export const fmt = {
  day: (d: Date) => d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: TZ }),
  longDay: (d: Date) => d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: TZ }),
  short: (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: TZ }),
  time: (d: Date) => d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: TZ }),
  hhmm: (d: Date) => d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: TZ }),
  money: (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: Number.isInteger(n) ? 0 : 2 }),
};

/** Parse a Google Calendar start/end ({dateTime} or all-day {date}). */
export function gcalTime(t?: { dateTime?: string | null; date?: string | null } | null): { at: Date; allDay: boolean } | null {
  if (!t) return null;
  if (t.dateTime) return { at: new Date(t.dateTime), allDay: false };
  if (t.date) return { at: at(t.date, "00:00"), allDay: true };
  return null;
}
