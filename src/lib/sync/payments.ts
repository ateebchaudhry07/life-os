import { z } from "zod";
import { db } from "../db";
import { searchMail, type Mail } from "../google";
import { ask, hasClaude } from "../claude";
import { hashId, upsertTransaction } from "../money";
import { findClientAppointment, upsertClient } from "./match";

const num = (s: string) => Number(s.replace(/[,\s$]/g, ""));
const HAIRCUT_NOTE = /cut|hair|fade|trim|✂|💈|barber|line ?up|taper/i;

const ZelleSchema = z.object({
  direction: z.enum(["received", "sent", "unknown"]),
  person: z.string().describe("The other person's full name as written"),
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
      await upsertTransaction({ date: m.date, name: `Zelle to ${parsed.person}`, amount: parsed.amount, type: "EXPENSE", category: "Payments to People", account: "360 Checking", source: "email", externalId: "gmail:" + m.id });
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

  // ---- Credit card payments ----
  for (const m of await searchMail(`subject:("Your payment of") newer_than:${days}d`)) {
    const amt = m.subject.match(/\$([\d,]+\.\d{2})/);
    if (amt) await upsertTransaction({ date: m.date, name: "Credit card payment", amount: num(amt[1]), type: "TRANSFER", category: "Credit Card Payment", source: "email", externalId: "gmail:" + m.id });
  }

  if (completed.length) report.push(`Marked done: ${completed.join(", ")}`);
  return { completed, report };
}

function regexZelle(m: Mail) {
  const t = `${m.subject} ${m.text}`;
  const rec = t.match(/([A-Z][A-Za-z.'-]+(?: [A-Z][A-Za-z.'-]+){0,3}) sent you \$([\d,]+\.\d{2})/);
  if (rec) return { direction: "received" as const, person: rec[1], amount: num(rec[2]) };
  const sent = t.match(/You sent \$([\d,]+\.\d{2}) to ([A-Z][A-Za-z.'-]+(?: [A-Z][A-Za-z.'-]+){0,3})/);
  if (sent) return { direction: "sent" as const, person: sent[2], amount: num(sent[1]) };
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
