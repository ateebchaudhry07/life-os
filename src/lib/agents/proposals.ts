import { db } from "../db";
import { categoryId, upsertTransaction } from "../money";
import { createEvent } from "../google";
import { at } from "../time";

/** Carry out an approved proposal. Returns a short result line. */
export async function executeProposal(id: string): Promise<string> {
  const p = await db.proposal.findUniqueOrThrow({ where: { id } });
  const a = p.action as Record<string, unknown>;
  switch (p.kind) {
    case "mark_cut": {
      const status = String(a.status) as "COMPLETED" | "CANCELLED" | "NO_SHOW";
      const done = status === "COMPLETED";
      const amount = a.amount == null ? null : Number(a.amount);
      const method = a.method ? String(a.method) : null;
      const appt = await db.appointment.update({ where: { id: String(a.appointmentId) }, data: { status, amountPaid: done ? amount : null, paymentMethod: done ? method : null }, include: { client: true } });
      if (done && amount && /cash|apple/i.test(method ?? "")) {
        await upsertTransaction({ date: appt.start, name: `${method} from ${appt.client.name}`, amount, type: "INCOME", category: "AteebCuts Income", account: method ?? "Cash", source: "manual", externalId: "cut:" + appt.id, appointmentId: appt.id });
      }
      return `${appt.client.name} marked ${status.toLowerCase()}`;
    }
    case "categorize": {
      await db.transaction.update({ where: { id: String(a.transactionId) }, data: { categoryId: await categoryId(String(a.category)) } });
      return `Moved to ${a.category}`;
    }
    case "reminder": {
      await db.reminder.create({ data: { title: String(a.title), due: a.due ? at(String(a.due), "09:00") : null, url: (a.url as string) || null, notes: (a.notes as string) || null } });
      return "Added to Reminders";
    }
    case "calendar_block": {
      await createEvent("study", { title: String(a.title), start: new Date(String(a.start)), end: new Date(String(a.end)), description: "Added by your School agent in Life OS" });
      return "Added to your Study calendar";
    }
    case "message":
      return "Marked as sent";
    default:
      throw new Error(`Unknown proposal kind ${p.kind}`);
  }
}
