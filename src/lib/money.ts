import { createHash } from "crypto";
import type { TransactionType } from "@prisma/client";
import { db } from "./db";
import { nameScore } from "./sync/match";

/** Default money categories (created on first run). Area links let spending show up under Wolverine Shifa / PhiDE. */
export const DEFAULT_CATEGORIES: { name: string; kind: "INCOME" | "EXPENSE" | "TRANSFER"; color: string; area?: string }[] = [
  { name: "AteebCuts Income", kind: "INCOME", color: "#16a34a", area: "AteebCuts" },
  { name: "Income", kind: "INCOME", color: "#22c55e" },
  { name: "Food & Dining", kind: "EXPENSE", color: "#f97316" },
  { name: "Groceries", kind: "EXPENSE", color: "#84cc16" },
  { name: "Amazon/Shopping", kind: "EXPENSE", color: "#3b82f6" },
  { name: "Clothing", kind: "EXPENSE", color: "#6366f1" },
  { name: "Subscriptions & Software", kind: "EXPENSE", color: "#a855f7" },
  { name: "AteebCuts Supplies", kind: "EXPENSE", color: "#0d9488", area: "AteebCuts" },
  { name: "Transportation", kind: "EXPENSE", color: "#eab308" },
  { name: "Laundry", kind: "EXPENSE", color: "#94a3b8" },
  { name: "Wolverine Shifa", kind: "EXPENSE", color: "#0ea5e9", area: "Wolverine Shifa" },
  { name: "PhiDE", kind: "EXPENSE", color: "#be123c", area: "PhiDE" },
  { name: "Payments to People", kind: "EXPENSE", color: "#ec4899" },
  { name: "Overseas Charges & Fees", kind: "EXPENSE", color: "#ef4444" },
  { name: "Robinhood / Investing", kind: "TRANSFER", color: "#7c3aed" },
  { name: "Credit Card Payment", kind: "TRANSFER", color: "#78716c" },
  { name: "Internal Transfer", kind: "TRANSFER", color: "#a8a29e" },
];

export const DEFAULT_AREAS = [
  { name: "School", color: "#2563eb", priority: 10, matchWords: ["lecture", "exam", "quiz", "homework", "biology", "physics", "psych", "anthrcul"] },
  { name: "AteebCuts", color: "#16a34a", priority: 20, matchWords: ["haircut", "cut", "booksy", "barber"] },
  { name: "Faith", color: "#0f766e", priority: 5, matchWords: ["jummah", "prayer", "pray", "masjid"] },
  { name: "Wolverine Shifa", color: "#0ea5e9", priority: 30, matchWords: ["shifa"] },
  { name: "PhiDE", color: "#be123c", priority: 30, matchWords: ["phide", "phi delta", "pde"] },
  { name: "Gym", color: "#f59e0b", priority: 40, matchWords: ["gym", "workout", "lift"] },
  { name: "Personal", color: "#6b7280", priority: 60, matchWords: [] },
];

const RULES: [RegExp, string][] = [
  [/booksy|barber|clipper|andis|wahl|babyliss|sally beauty/i, "AteebCuts Supplies"],
  [/shifa/i, "Wolverine Shifa"],
  [/phide|phi delta epsilon/i, "PhiDE"],
  [/amazon groc|whole foods|kroger|meijer|trader joe|aldi|walmart groc|dashmart/i, "Groceries"],
  [/amazon|amzn|target|best buy|walmart|ebay|temu|tiktok shop/i, "Amazon/Shopping"],
  [/uniqlo|zara|h ?& ?m|h m fashion|abercrombie|express|nike|adidas|gap|pacsun|tpob/i, "Clothing"],
  [/doordash|uber ?eats|grubhub|halal|pizza|cafe|coffee|creamery|frita|darwin|bert|cha |chipotle|mcdonald|starbucks|levy|restaurant|grill|kitchen|7-eleven|market/i, "Food & Dining"],
  [/apple\.com|apple com|spotify|netflix|google \*|google o|youtube|openai|claude|anthropic|tradingview|undetectable|icloud|hulu|subscription/i, "Subscriptions & Software"],
  [/lyft|uber(?! ?eats)|amtrak|greyhound|shell|bp |speedway|marathon|parking|theride/i, "Transportation"],
  [/laundry|continental|cantaloupe|ctlp/i, "Laundry"],
  [/international fee|foreign/i, "Overseas Charges & Fees"],
  [/robinhood/i, "Robinhood / Investing"],
  [/discover|cap one.*pmt|capital one.*payment|card payment|mobile pmt/i, "Credit Card Payment"],
];

export function guessCategory(text: string, type: TransactionType): string {
  if (type === "INTERNAL") return "Internal Transfer";
  for (const [re, cat] of RULES) if (re.test(text)) return cat;
  if (type === "INCOME") return "Income";
  if (type === "TRANSFER") return "Internal Transfer";
  return "Amazon/Shopping";
}

let categoryCache: Map<string, string> | null = null;
export async function categoryId(name: string) {
  if (!categoryCache) categoryCache = new Map((await db.category.findMany()).map((c) => [c.name, c.id]));
  return categoryCache.get(name) ?? categoryCache.get("Amazon/Shopping") ?? null;
}

export function hashId(...parts: (string | number)[]) {
  return createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 24);
}

/** Insert a transaction unless one with the same externalId — or the same day/amount/type from another source — exists. */
export async function upsertTransaction(t: {
  date: Date;
  name: string;
  amount: number;
  type: TransactionType;
  category?: string;
  account?: string;
  source: string;
  externalId: string;
  appointmentId?: string;
}) {
  if (await db.transaction.findUnique({ where: { externalId: t.externalId } })) return null;
  const dayMs = 86_400_000;
  const twins = await db.transaction.findMany({
    where: {
      amount: t.amount,
      type: t.type,
      date: { gte: new Date(t.date.getTime() - 2 * dayMs), lte: new Date(t.date.getTime() + 2 * dayMs) },
      source: { not: t.source },
    },
  });
  // Same money already recorded from another source (email vs CSV vs Notion). When both name a person, they must match.
  const person = (n: string) => n.match(/\b(?:from|to)\s+(.+)$/i)?.[1];
  if (twins.some((x) => { const a = person(x.name), b = person(t.name); return !a || !b || nameScore(a, b) >= 0.5; })) return null;
  return db.transaction.create({
    data: {
      date: t.date,
      name: t.name,
      amount: t.amount,
      type: t.type,
      categoryId: await categoryId(t.category ?? guessCategory(t.name, t.type)),
      account: t.account,
      source: t.source,
      externalId: t.externalId,
      appointmentId: t.appointmentId,
    },
  });
}

// ---------------- CSV import (Capital One 360, Flagstar, or any bank CSV) ----------------
function splitCsv(line: string): string[] {
  const out: string[] = [];
  let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
    else if (c === "," && !q) { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function parseDate(s: string): Date | null {
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) {
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return new Date(Date.UTC(y, Number(m[1]) - 1, Number(m[2]), 16));
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 16));
}

const money = (s?: string) => (s ? Number(s.replace(/[$,\s]/g, "").replace(/^\((.*)\)$/, "-$1")) : NaN);

export function classify(desc: string, signedAmount: number): { type: TransactionType; name: string } {
  const d = desc.replace(/\s+/g, " ").trim();
  if (/zelle money received from|zelle.*from/i.test(d)) return { type: "INCOME", name: "Zelle from " + titleCase(d.replace(/.*from /i, "")) };
  if (/zelle money sent to|zelle.*to /i.test(d)) return { type: "EXPENSE", name: "Zelle to " + titleCase(d.replace(/.*to /i, "")) };
  if (/venmo.*cashout|preauthorized deposit from|transfer from|external deposit.*transfer|internal transfer/i.test(d)) return { type: "INTERNAL", name: d.slice(0, 80) };
  if (/robinhood|discover|cap one|capital one.*pmt|mobile pmt/i.test(d)) return { type: "TRANSFER", name: d.slice(0, 80) };
  if (/payroll|direct dep|interest paid|cash app/i.test(d)) return { type: "INCOME", name: d.slice(0, 80) };
  if (/adjustment|refund|return/i.test(d) && signedAmount > 0) return { type: "EXPENSE", name: "Refund: " + d.slice(0, 70) };
  if (signedAmount > 0) return { type: "INCOME", name: d.slice(0, 80) };
  return { type: "EXPENSE", name: d.replace(/^(digital|debit|pos signature) card purchase - |^pos signature purchase /i, "").slice(0, 80) };
}

function titleCase(s: string) {
  return s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()).trim();
}

export async function importCsv(csv: string, account: string) {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim());
  const head = splitCsv(lines[0]).map((h) => h.toLowerCase());
  const col = (...names: string[]) => head.findIndex((h) => names.some((n) => h.includes(n)));
  const iDate = col("transaction date", "posted date", "post date", "date");
  const iDesc = col("description", "memo", "payee", "name");
  const iAmt = col("transaction amount", "amount");
  const iType = col("transaction type", "type");
  const iDebit = col("debit");
  const iCredit = col("credit");
  if (iDate < 0 || iDesc < 0 || (iAmt < 0 && iDebit < 0)) throw new Error("Couldn't find date, description and amount columns in this CSV.");
  let added = 0, skipped = 0;
  const seen = new Map<string, number>();
  for (const line of lines.slice(1)) {
    const c = splitCsv(line);
    const date = parseDate(c[iDate] ?? "");
    if (!date) continue;
    let signed: number;
    if (iDebit >= 0 || iCredit >= 0) signed = (money(c[iCredit]) || 0) - (money(c[iDebit]) || 0);
    else {
      signed = money(c[iAmt]);
      const t = (c[iType] ?? "").toLowerCase();
      if (t === "debit" && signed > 0) signed = -signed;
    }
    if (!isFinite(signed) || signed === 0) continue;
    const desc = c[iDesc] ?? "";
    const { type, name } = classify(desc, signed);
    const amount = name.startsWith("Refund:") ? -Math.abs(signed) : Math.abs(signed);
    const key = hashId(account, date.toISOString().slice(0, 10), desc, signed);
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    const row = await upsertTransaction({
      date, name, amount, type, account, source: "csv", externalId: hashId(key, n),
      category: name.startsWith("Zelle from") && amount >= 15 && amount <= 120 ? "AteebCuts Income" : name.startsWith("Zelle to") ? "Payments to People" : guessCategory(desc + " " + name, type),
    });
    if (row) added++; else skipped++;
  }
  return { added, skipped };
}
