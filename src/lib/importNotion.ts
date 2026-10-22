/**
 * One-time import of Notion history (Money Tracker, Transactions, Workout Log) into Life OS.
 * Needs NOTION_TOKEN from notion.so/my-integrations, with the three databases shared to that integration.
 * Safe to run more than once: rows are keyed by Notion page id and merged with cuts the app already found.
 */
import type { TransactionType } from "@prisma/client";
import { db } from "./db";

const TOKEN = process.env.NOTION_TOKEN;
const TRACKER = process.env.NOTION_TRACKER_DB ?? "41cf827e04b14280a05a9ba5d1a70b44";
const TRANSACTIONS = process.env.NOTION_TRANSACTIONS_DB ?? "59937db3e30842e0afba1d1f5b9d6850";
const WORKOUTS = process.env.NOTION_WORKOUTS_DB ?? "67be1bef5e8741c4bd4608b6932f5769";

async function queryAll(dbId: string) {
  const rows: any[] = [];
  let cursor: string | undefined;
  do {
    const res = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Notion-Version": "2022-06-28", "Content-Type": "application/json" },
      body: JSON.stringify({ page_size: 100, start_cursor: cursor }),
    });
    if (!res.ok) throw new Error(`Notion ${dbId}: ${res.status} ${await res.text()} — is the database shared with your integration?`);
    const j = await res.json();
    rows.push(...j.results);
    cursor = j.has_more ? j.next_cursor : undefined;
  } while (cursor);
  return rows;
}

const title = (p: any) => (p?.title ?? []).map((t: any) => t.plain_text).join("").trim();
const text = (p: any) => (p?.rich_text ?? []).map((t: any) => t.plain_text).join("").trim();
const sel = (p: any) => p?.select?.name ?? null;
const date = (p: any) => (p?.date?.start ? new Date(p.date.start.length === 10 ? `${p.date.start}T16:00:00Z` : p.date.start) : null);

const CATEGORY_MAP: Record<string, string> = {
  "Venmo Payment": "Payments to People",
  "Robinhood Transfer": "Robinhood / Investing",
};
const CLOTHING = /uniqlo|zara|h&m|h m fashion|abercrombie|express|tpob/i;

async function catId(name: string) {
  return (await db.category.findUnique({ where: { name } }))?.id ?? null;
}

export async function importNotion(): Promise<string> {
  if (!TOKEN) throw new Error("Add NOTION_TOKEN in Vercel first (see Settings for how).");

  // ---- Clients & appointments ----
  const tracker = await queryAll(TRACKER);
  const clientIds = new Map<string, string>();
  let appts = 0;
  for (const r of tracker) {
    const name = title(r.properties.Client);
    const start = date(r.properties.Date);
    if (!name || !start) continue;
    const key = name.toLowerCase();
    let clientId = clientIds.get(key);
    if (!clientId) {
      const c = (await db.client.findFirst({ where: { name: { equals: name, mode: "insensitive" } } })) ?? (await db.client.create({ data: { name } }));
      clientId = c.id;
      clientIds.set(key, clientId);
    }
    const notionStatus = sel(r.properties.Status);
    const status = notionStatus === "Completed" ? "COMPLETED" : notionStatus === "Cancelled" ? "CANCELLED" : "BOOKED";
    const amount = r.properties.Amount?.number ?? null;
    const method = sel(r.properties["Payment Method"]);
    const fields = { status, amountPaid: status === "COMPLETED" ? amount : null, paymentMethod: method } as const;
    // If the nightly sync already created this cut from Booksy/Calendar/a payment, update that one instead of duplicating it.
    const first = name.toLowerCase().split(" ")[0];
    const twin = (await db.appointment.findUnique({ where: { externalId: "notion:" + r.id } })) ??
      (await db.appointment.findMany({
        where: { start: { gte: new Date(start.getTime() - 36 * 3_600_000), lte: new Date(start.getTime() + 36 * 3_600_000) } },
        include: { client: true },
      })).find((a) => a.client.name.toLowerCase().split(" ")[0] === first);
    const appt = twin
      ? await db.appointment.update({ where: { id: twin.id }, data: fields })
      : await db.appointment.create({ data: { externalId: "notion:" + r.id, clientId, start, service: sel(r.properties.Service) ?? "Haircut", price: amount, source: "notion", ...fields } });
    appts++;
    // Income for completed cuts that no bank feed will ever show: cash-type payments, and everything before the bank history starts.
    if (status === "COMPLETED" && amount && (/cash|apple/i.test(method ?? "") || start < new Date("2026-09-21"))) {
      if (await db.transaction.findFirst({ where: { appointmentId: appt.id } })) continue;
      await db.transaction.upsert({
        where: { externalId: "notion-cut:" + r.id },
        update: {},
        create: { externalId: "notion-cut:" + r.id, date: start, name: `${method ?? "Cut"} from ${name}`, amount, type: "INCOME", categoryId: await catId("AteebCuts Income"), account: method ?? "Cash", source: "notion", appointmentId: appt.id },
      });
    }
  }

  // ---- Bank transactions (skip the old per-haircut rows; cuts come from the tracker above) ----
  const txs = await queryAll(TRANSACTIONS);
  let tx = 0;
  for (const r of txs) {
    const name = title(r.properties.Name);
    const d = date(r.properties.Date);
    const notionType = sel(r.properties.Type);
    const notionCat = sel(r.properties.Category);
    const amount = r.properties.Amount?.number;
    if (!name || !d || amount == null || !notionType || notionCat === "AteebCuts Income" && /^haircut/i.test(name)) continue;
    let type: TransactionType = notionType === "Income" ? "INCOME" : notionType === "Expense" ? "EXPENSE" : notionType === "Transfer" ? "TRANSFER" : "INTERNAL";
    if (/venmo cashout/i.test(name)) type = "INTERNAL"; // the income was the person paying you, not the cash-out
    const category = CLOTHING.test(name) ? "Clothing" : CATEGORY_MAP[notionCat ?? ""] ?? notionCat ?? "Income";
    await db.transaction.upsert({
      where: { externalId: "notion:" + r.id },
      update: {},
      create: { externalId: "notion:" + r.id, date: d, name, amount, type, categoryId: await catId(category), source: "notion", account: /zelle|360/i.test(name) ? "360 Checking" : "Flagstar" },
    });
    tx++;
  }

  // ---- Workouts ----
  const wrows = await queryAll(WORKOUTS).catch(() => []);
  const byDay = new Map<string, any[]>();
  for (const r of wrows) {
    const d = date(r.properties.Date);
    if (!d) continue;
    const k = d.toISOString().slice(0, 10);
    byDay.set(k, [...(byDay.get(k) ?? []), r]);
  }
  for (const [day, rows] of byDay) {
    if (await db.workout.findFirst({ where: { date: new Date(`${day}T16:00:00Z`) } })) continue;
    await db.workout.create({
      data: {
        date: new Date(`${day}T16:00:00Z`),
        type: sel(rows[0].properties.Workout) ?? "Full Body",
        notes: text(rows[0].properties.Notes) || undefined,
        sets: { create: rows.filter((r) => title(r.properties.Exercise)).map((r) => ({ exercise: title(r.properties.Exercise), weight: r.properties["Weight (lb)"]?.number ?? null, reps: r.properties.Reps?.number ?? null, sets: r.properties.Sets?.number ?? 1 })) },
      },
    });
    const bw = rows.map((r) => r.properties["Bodyweight (lb)"]?.number).find(Boolean);
    if (bw) await db.bodyWeight.upsert({ where: { date: new Date(`${day}T16:00:00Z`) }, update: { pounds: bw }, create: { date: new Date(`${day}T16:00:00Z`), pounds: bw } });
  }

  return `Imported ${clientIds.size} clients, ${appts} appointments, ${tx} transactions, ${byDay.size} workout days.`;
}

