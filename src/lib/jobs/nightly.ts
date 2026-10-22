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
    const bookings = await syncBookings(days);
    const payments = await syncPayments(days);
    const school = await syncSchool();

    const today = dayKey();
    const weekStart = at(mondayOf(today));
    const income = await db.transaction.aggregate({ _sum: { amount: true }, where: { type: "INCOME", date: { gte: weekStart }, category: { name: "AteebCuts Income" } } });
    const spent = await db.transaction.aggregate({ _sum: { amount: true }, where: { type: "EXPENSE", date: { gte: weekStart } } });
    const unpaid = await db.appointment.findMany({
      where: { status: "BOOKED", start: { lt: at(today) } },
      include: { client: true },
      orderBy: { start: "asc" },
    });
    const tomorrow = await db.appointment.count({ where: { status: "BOOKED", start: { gte: at(addDays(today, 1)), lt: at(addDays(today, 2)) } } });

    const lines = [
      bookings.added ? `${bookings.added} new booking${bookings.added > 1 ? "s" : ""} added` : null,
      bookings.cancelled ? `${bookings.cancelled} cancellation${bookings.cancelled > 1 ? "s" : ""}` : null,
      payments.completed.length ? `Paid & marked done: ${payments.completed.join(", ")}` : null,
      `This week: ${fmt.money(income._sum.amount ?? 0)} from cuts, ${fmt.money(spent._sum.amount ?? 0)} spent`,
      tomorrow ? `${tomorrow} cut${tomorrow > 1 ? "s" : ""} tomorrow` : null,
      unpaid.length ? `${unpaid.length} past cut${unpaid.length > 1 ? "s" : ""} with no payment found (cash?): ${unpaid.slice(0, 5).map((a) => a.client.name).join(", ")}${unpaid.length > 5 ? "…" : ""}` : null,
    ].filter(Boolean) as string[];
    await notify("AteebCuts & money", lines.join("\n"), "/cuts");
    await logEnd(log.id, true, lines.join("\n") + "\n" + school);
    return lines;
  } catch (e) {
    await logEnd(log.id, false, (e as Error).message);
    throw e;
  }
}
