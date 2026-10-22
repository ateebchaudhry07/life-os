import { db, logEnd, logStart } from "../db";
import { syncBookings } from "../sync/bookings";
import { syncPayments } from "../sync/payments";
import { syncSchool } from "../sync/school";
import { notify } from "../notify";
import { addDays, at, dayKey, fmt, mondayOf } from "../time";

/** Every night: bookings → payments → school, then a short summary to the phone. */
export async function nightlySync(days = 3) {
  const log = await logStart("nightly-sync");
  try {
    // Each step runs on its own so one failure doesn't stop the others; failures are listed in the summary.
    const errors: string[] = [];
    const step = async <T,>(name: string, fn: () => Promise<T>, fallback: T) => {
      try { return await fn(); } catch (e) { errors.push(`${name} failed: ${explain(e)}`); return fallback; }
    };
    const bookings = await step("Bookings", () => syncBookings(days), { added: 0, cancelled: 0 } as Awaited<ReturnType<typeof syncBookings>>);
    const payments = await step("Payments", () => syncPayments(days), { completed: [] as string[], report: [] as string[] });
    const school = await step("School", () => syncSchool(), "");

    const today = dayKey();
    const weekStart = at(mondayOf(today));
    const income = await db.transaction.aggregate({ _sum: { amount: true }, where: { type: "INCOME", date: { gte: weekStart }, category: { name: "AteebCuts Income" } } });
    const spent = await db.transaction.aggregate({ _sum: { amount: true }, where: { type: "EXPENSE", date: { gte: weekStart } } });
    const unpaid = await db.appointment.findMany({
      where: { status: "BOOKED", start: { lt: at(today) } },
      include: { client: true },
      orderBy: { start: "asc" },
    });
    const reminders = await db.reminder.findMany({ where: { done: false, due: { lt: at(addDays(today, 2)) } }, orderBy: { due: "asc" }, take: 5 });
    const tomorrow = await db.appointment.count({ where: { status: "BOOKED", start: { gte: at(addDays(today, 1)), lt: at(addDays(today, 2)) } } });

    const lines = [
      bookings.added ? `${bookings.added} new booking${bookings.added > 1 ? "s" : ""} added` : null,
      bookings.cancelled ? `${bookings.cancelled} cancellation${bookings.cancelled > 1 ? "s" : ""}` : null,
      payments.completed.length ? `Paid & marked done: ${payments.completed.join(", ")}` : null,
      `This week: ${fmt.money(income._sum.amount ?? 0)} from cuts, ${fmt.money(spent._sum.amount ?? 0)} spent`,
      reminders.length ? `Reminders: ${reminders.map((r) => `${r.title}${r.due && r.due < new Date() ? " (overdue)" : r.due ? ` (${fmt.short(r.due)})` : ""}`).join(", ")}` : null,
      tomorrow ? `${tomorrow} cut${tomorrow > 1 ? "s" : ""} tomorrow` : null,
      unpaid.length ? `${unpaid.length} past cut${unpaid.length > 1 ? "s" : ""} with no payment found (cash?): ${unpaid.slice(0, 5).map((a) => a.client.name).join(", ")}${unpaid.length > 5 ? "…" : ""}` : null,
      ...errors,
    ].filter(Boolean) as string[];
    await notify("AteebCuts & money", lines.join("\n"), "/cuts");
    await logEnd(log.id, errors.length === 0, lines.join("\n") + "\n" + school);
    return lines;
  } catch (e) {
    await logEnd(log.id, false, (e as Error).message);
    throw e;
  }
}

function explain(e: unknown) {
  const msg = (e as Error)?.message ?? String(e);
  if (/invalid_grant|No Google account|refresh token/i.test(msg)) return "Google sign-in expired. Sign out and sign in again (needed about weekly while the Google app is in Testing).";
  return msg;
}
