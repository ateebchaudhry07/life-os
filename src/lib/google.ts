import { google, type calendar_v3, type gmail_v1 } from "googleapis";
import { db } from "./db";
import { CALENDARS, IGNORE_EVENT_TITLES, type CalendarKey } from "./config";

/** OAuth client for the owner's Google account, usable from cron jobs (no browser session). */
export async function googleAuth() {
  const account = await db.account.findFirst({ where: { provider: "google" }, orderBy: { expires_at: "desc" } });
  if (!account?.refresh_token) throw new Error("Google isn't connected. Sign in to the app once to connect Gmail and Calendar.");
  const client = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
  client.setCredentials({
    refresh_token: account.refresh_token,
    access_token: account.access_token ?? undefined,
    expiry_date: account.expires_at ? account.expires_at * 1000 : undefined,
  });
  client.on("tokens", async (t) => {
    await db.account.update({
      where: { id: account.id },
      data: {
        access_token: t.access_token ?? undefined,
        expires_at: t.expiry_date ? Math.floor(t.expiry_date / 1000) : undefined,
        refresh_token: t.refresh_token ?? undefined,
      },
    });
  });
  return client;
}

// ---------------- Gmail ----------------
export interface Mail {
  id: string;
  date: Date;
  from: string;
  subject: string;
  snippet: string;
  text: string;
}

function decode(data?: string | null) {
  return data ? Buffer.from(data, "base64url").toString("utf8") : "";
}

function bodyText(part?: gmail_v1.Schema$MessagePart): string {
  if (!part) return "";
  if (part.mimeType === "text/plain" && part.body?.data) return decode(part.body.data);
  if (part.parts?.length) {
    const plain = part.parts.map(bodyText).find((t) => t.trim());
    if (plain) return plain;
  }
  if (part.mimeType === "text/html" && part.body?.data) {
    return decode(part.body.data)
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;|&#160;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, " ");
  }
  return "";
}

export async function searchMail(q: string, max = 50): Promise<Mail[]> {
  const gmail = google.gmail({ version: "v1", auth: await googleAuth() });
  const list = await gmail.users.messages.list({ userId: "me", q, maxResults: max });
  const out: Mail[] = [];
  for (const m of list.data.messages ?? []) {
    const full = await gmail.users.messages.get({ userId: "me", id: m.id!, format: "full" });
    const h = (name: string) => full.data.payload?.headers?.find((x) => x.name?.toLowerCase() === name)?.value ?? "";
    out.push({
      id: m.id!,
      date: new Date(Number(full.data.internalDate)),
      from: h("from"),
      subject: h("subject"),
      snippet: full.data.snippet ?? "",
      text: bodyText(full.data.payload ?? undefined).replace(/[͏‌­]/g, "").replace(/\s+/g, " ").slice(0, 6000),
    });
  }
  return out;
}

export async function unreadInbox(max = 25) {
  const gmail = google.gmail({ version: "v1", auth: await googleAuth() });
  const list = await gmail.users.messages.list({
    userId: "me",
    q: "in:inbox is:unread -category:promotions -category:social newer_than:7d",
    maxResults: max,
  });
  const out: { id: string; from: string; subject: string; date: Date; threadId: string }[] = [];
  for (const m of list.data.messages ?? []) {
    const full = await gmail.users.messages.get({ userId: "me", id: m.id!, format: "metadata", metadataHeaders: ["From", "Subject"] });
    const h = (name: string) => full.data.payload?.headers?.find((x) => x.name === name)?.value ?? "";
    out.push({ id: m.id!, threadId: full.data.threadId!, from: h("From").replace(/<.*>/, "").trim(), subject: h("Subject"), date: new Date(Number(full.data.internalDate)) });
  }
  return { items: out, estimate: list.data.resultSizeEstimate ?? out.length };
}

// ---------------- Calendar ----------------
export interface CalEvent {
  id: string;
  calendar: CalendarKey | string;
  title: string;
  start: Date;
  end: Date;
  allDay: boolean;
  location?: string;
  description?: string;
}

function toEvent(cal: string, e: calendar_v3.Schema$Event): CalEvent | null {
  const s = e.start?.dateTime ?? e.start?.date;
  const en = e.end?.dateTime ?? e.end?.date;
  if (!s || !en || e.status === "cancelled") return null;
  return {
    id: e.id!,
    calendar: cal,
    title: e.summary ?? "(no title)",
    start: new Date(e.start?.dateTime ?? `${e.start?.date}T05:00:00Z`),
    end: new Date(e.end?.dateTime ?? `${e.end?.date}T05:00:00Z`),
    allDay: !e.start?.dateTime,
    location: e.location ?? undefined,
    description: e.description ?? undefined,
  };
}

export async function listEvents(key: CalendarKey, from: Date, to: Date): Promise<CalEvent[]> {
  const cal = google.calendar({ version: "v3", auth: await googleAuth() });
  const out: CalEvent[] = [];
  let pageToken: string | undefined;
  do {
    const res = await cal.events.list({
      calendarId: CALENDARS[key],
      timeMin: from.toISOString(),
      timeMax: to.toISOString(),
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 250,
      pageToken,
    });
    for (const e of res.data.items ?? []) {
      const ev = toEvent(key, e);
      if (ev && !IGNORE_EVENT_TITLES.includes(ev.title.trim().toLowerCase())) out.push(ev);
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  return out;
}

export async function listMany(keys: CalendarKey[], from: Date, to: Date) {
  const all = await Promise.all(keys.map((k) => listEvents(k, from, to).catch(() => [] as CalEvent[])));
  return all.flat().sort((a, b) => a.start.getTime() - b.start.getTime());
}

export async function createEvent(key: CalendarKey, ev: { title: string; start: Date; end: Date; description?: string }) {
  const cal = google.calendar({ version: "v3", auth: await googleAuth() });
  const res = await cal.events.insert({
    calendarId: CALENDARS[key],
    requestBody: {
      summary: ev.title,
      description: ev.description,
      start: { dateTime: ev.start.toISOString(), timeZone: "America/New_York" },
      end: { dateTime: ev.end.toISOString(), timeZone: "America/New_York" },
    },
  });
  return res.data.id!;
}

export async function deleteEvent(key: CalendarKey, id: string) {
  const cal = google.calendar({ version: "v3", auth: await googleAuth() });
  await cal.events.delete({ calendarId: CALENDARS[key], eventId: id }).catch(() => undefined);
}
