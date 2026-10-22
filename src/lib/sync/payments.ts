import { z } from "zod";
import { db } from "../db";
import { searchMail, type Mail } from "../google";
import { ask, hasClaude } from "../claude";
import { guessCategory, hashId, upsertTransaction } from "../money";
import { findClientAppointment, upsertClient } from "./match";

const num = (s: string) => Number(s.replace(/[,\s$]/g, ""));
const HAIRCUT_NOTE = /cut|hair|fade|trim|✂|💈|barber|line ?up|taper/i;

const ZelleSchema = z.object({
  direction: z.enum(["received", "sent", "unknown"]),
  person: z.string().describe("The other person's full name as written (or their email/phone if no name)"),
  amount: z.number().describe("Dollar amount, positive"),
  memo: z.string().describe("The memo or note, empty if none"),
});

const PurchaseSchema = z.object({
  isPurchase: z.boolean().describe("true only for a card purchase/charge alert"),
  merchant: z.string(),
  amount: z.number().describe("Dollar amount, positive"),
});

/** Read Venmo, Zelle, Robinhood and card-payment emails from the last `days` days into Transactions and match haircut payments. */
export async function syncPayments(days = 3) {
  const report: string[] = [];
  const completed: string[] = [];

  // ---- Venmo payments received ----
  for (const m of await searchMail(`from:venmo@venmo.com "paid you" newer_than:${days}d`)) {
    const s = m.subject.match(/^(.+?) paid (?:you )?\$([\d,.]+)/i);
    if (!s) continue;
    const person = s[1].trim(), amount = num(s[2]);
    const note = (m.text.match(/paid you \$\s*[\d,]+\s*\.\s*\d{2}\s+(.*?)\s+See transaction/i)?.[1] ?? "").trim();
    const known = await db.client.findFirst({ where: { OR: [{ name: { equals: person, mode: "insensitive" } }, { aliases: { has: person } }] } });
    const isCut = HAIRCUT_NOTE.test(note) || Boolean(known);
    const done = await handleIncome(m, person, amount, "Venmo", isCut, note);
    if (done) completed.push(done);
  }

  // ---- Zelle (Capital One alerts) ----
  for (const m of await searchMail(`from:capitalone@notification.capitalone.com subject:Zelle newer_than:${days}d`)) {
    let parsed: z.infer<typeof ZelleSchema> | null = regexZelle(m);
    if (!parsed && hasClaude()) {
      parsed = await ask({
        schema: ZelleSchema,
        effort: "low",
        system: "Extract the Zelle payment from this bank alert email. Answer only from the email text.",
        prompt: `Subject: ${m.subject}\n\n${m.text}`,
      }).catch(() => null);
    }
    if (!parsed || !parsed.amount) continue;
    if (parsed.direction === "sent" || /you sent/i.test(m.subject)) {
      const name = `Zelle to ${parsed.person}${parsed.memo ? ` (${parsed.memo.slice(0, 40)})` : ""}`;
      const guess = guessCategory(name, "EXPENSE");
      await upsertTransaction({ date: m.date, name, amount: parsed.amount, type: "EXPENSE", category: guess === "Other" || guess === "Uncategorized" ? "Payments to People" : guess, account: "360 Checking", source: "email", externalId: "gmail:" + m.id });
    } else {
      const isCut = parsed.amount >= 15 && parsed.amount <= 120;
      const done = await handleIncome(m, parsed.person, parsed.amount, "Zelle", isCut, "");
      if (done) completed.push(done);
    }
  }

  // ---- Venmo payments you sent, and cash-outs ----
  for (const m of await searchMail(`from:venmo@venmo.com ("You paid" OR "Standard transfer" OR "Instant transfer") newer_than:${days}d`)) {
    const paid = m.subject.match(/^You paid (.+?) \$([\d,.]+)/i);
    if (paid) {
      await upsertTransaction({ date: m.date, name: `Venmo to ${paid[1]}`, amount: num(paid[2]), type: "EXPENSE", category: "Payments to People", account: "Venmo", source: "email", externalId: "gmail:" + m.id });
      continue;
    }
    const xfer = m.text.match(/Transfer Amount \$([\d,.]+)/i);
    if (xfer) await upsertTransaction({ date: m.date, name: "Venmo Cashout", amount: num(xfer[1]), type: "INTERNAL", account: "Venmo", source: "email", externalId: "gmail:" + m.id });
  }

  // ---- Robinhood transfers ----
  for (const m of await searchMail(`from:noreply@robinhood.com ("transfer to your Robinhood" OR "IRA contribution is complete") newer_than:${days}d`)) {
    const amt = m.text.match(/\$([\d,]+\.\d{2})/);
    if (!amt) continue;
    const ira = /IRA/i.test(m.subject);
    await upsertTransaction({ date: m.date, name: ira ? "Robinhood - Roth IRA" : "Robinhood - Investing Transfer", amount: num(amt[1]), type: "TRANSFER", category: "Robinhood / Investing", account: "Flagstar", source: "email", externalId: "gmail:" + m.id });
  }

  // ---- Debit/credit card purchase alerts (turn these on in the Capital One / Flagstar apps) ----
  for (const m of await searchMail(`(from:capitalone OR from:flagstar) (subject:(transaction OR purchase OR charged OR "debit card") OR "was charged" OR "purchase in the amount") -subject:Zelle newer_than:${days}d`)) {
    let p: z.infer<typeof PurchaseSchema> | null = regexPurchase(m);
    if (!p && hasClaude()) {
      p = await ask({ schema: PurchaseSchema, effort: "low", system: "Decide whether this bank email is a card purchase alert and extract it. Answer only from the email text.", prompt: `Subject: ${m.subject}\n\n${m.text}` }).catch(() => null);
    }
    if (!p?.isPurchase || !p.amount) continue;
    const account = /flagstar/i.test(m.from) ? "Flagstar" : "360 Checking";
    await upsertTransaction({ date: m.date, name: p.merchant.slice(0, 80), amount: p.amount, type: "EXPENSE", account, source: "email", externalId: "gmail:" + m.id });
  }

  // ---- Credit card payments ----
  for (const m of await searchMail(`subject:("Your payment of") newer_than:${days}d`)) {
    const amt = m.subject.match(/\$([\d,]+\.\d{2})/);
    if (amt) await upsertTransaction({ date: m.date, name: "Credit card payment", amount: num(amt[1]), type: "TRANSFER", category: "Credit Card Payment", source: "email", externalId: "gmail:" + m.id });
  }

  if (completed.length) report.push(`Marked done: ${completed.join(", ")}`);
  return { completed, report };
}

const titleCase = (s: string) => (s === s.toUpperCase() ? s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()) : s).trim();

function regexZelle(m: Mail) {
  const t = `${m.subject} ${m.text}`.replace(/®/g, "");
  // Capital One: "LEUL NEBIYELEUL has just sent you money with Zelle in the amount of $30.00."
  const rec = t.match(/([A-Z][A-Za-z.'-]*(?: [A-Z][A-Za-z.'-]*){0,3}) has just sent you money with Zelle in the amount of \$([\d,]+\.\d{2})/)
    ?? t.match(/([A-Z][A-Za-z.'-]+(?: [A-Z][A-Za-z.'-]+){0,3}) sent you \$([\d,]+\.\d{2})/);
  if (rec) return { direction: "received" as const, person: titleCase(rec[1].split(/\.\s/).pop()!), amount: num(rec[2]), memo: "" };
  // Capital One: "You sent money with Zelle … To: name-or-email Amount: $235.00 Payment ID: … Memo: F26 Dues …"
  const to = t.match(/\bTo: (.+?) Amount: \$([\d,]+\.\d{2})/);
  if (to && /you sent/i.test(t)) return { direction: "sent" as const, person: titleCase(to[1]), amount: num(to[2]), memo: t.match(/Memo: (.+?)(?: Congratulations:| If you didn| Thanks for|$)/)?.[1]?.trim() ?? "" };
  const sent = t.match(/You sent \$([\d,]+\.\d{2}) to ([A-Z][A-Za-z.'-]+(?: [A-Z][A-Za-z.'-]+){0,3})/);
  if (sent) return { direction: "sent" as const, person: sent[2], amount: num(sent[1]), memo: "" };
  return null;
}

function regexPurchase(m: Mail) {
  // Capital One: "…on October 21, 2026, at CHIPOTLE 1234, a pending authorization or purchase in the amount of $12.34 was placed…"
  const t = m.text;
  const c1 = t.match(/, at (.+?), a pending authorization or purchase in the amount of \$([\d,]+\.\d{2})/i);
  if (c1) return { isPurchase: true, merchant: titleCase(c1[1]), amount: num(c1[2]) };
  const c2 = t.match(/\$([\d,]+\.\d{2}) (?:was charged|purchase|transaction) (?:at|with|to) ([A-Za-z0-9 &'*.#-]{2,40}?)(?:\.| on | using)/i);
  if (c2) return { isPurchase: true, merchant: titleCase(c2[2]), amount: num(c2[1]) };
  return null;
}

/** Record income; if it's a haircut, complete the matching appointment (or create one). Returns a summary line when a cut was completed. */
async function handleIncome(m: Mail, person: string, amount: number, method: "Venmo" | "Zelle", isCut: boolean, note: string) {
  let appointmentId: string | undefined;
  let summary: string | null = null;
  if (isCut) {
    const appt = await findClientAppointment(person, m.date);
    if (appt) {
      await db.appointment.update({ where: { id: appt.id }, data: { status: "COMPLETED", amountPaid: amount, paymentMethod: method } });
      appointmentId = appt.id;
      summary = `${appt.client.name} $${amount} (${method})`;
    } else if (!(await db.transaction.findUnique({ where: { externalId: "gmail:" + m.id } }))) {
      const client = await upsertClient(person);
      const created = await db.appointment.create({
        data: { clientId: client.id, start: m.date, status: "COMPLETED", amountPaid: amount, price: amount, paymentMethod: method, source: "payment", externalId: "pay:" + hashId(m.id), notes: note ? `Payment note: ${note}` : "Added from a payment with no booking" },
      });
      appointmentId = created.id;
      summary = `${person} $${amount} (${method}, added from payment)`;
    }
  }
  await upsertTransaction({
    date: m.date,
    name: `${method} from ${person}`,
    amount,
    type: "INCOME",
    category: isCut ? "AteebCuts Income" : "Income",
    account: method === "Venmo" ? "Venmo" : "360 Checking",
    source: "email",
    externalId: "gmail:" + m.id,
    appointmentId,
  });
  return summary;
}
