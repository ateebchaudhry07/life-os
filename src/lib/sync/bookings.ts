import { db } from "../db";
import { listEvents, searchMail } from "../google";
import { hashId } from "../money";
import { upsertClient } from "./match";
import { at } from "../time";

const MONTHS = "January|February|March|April|May|June|July|August|September|October|November|December";

/** New Booksy bookings (and cancellations) from Gmail, plus client appointments on the Haircuts calendar. */
export async function syncBookings(days = 3) {
  let added = 0, cancelled = 0;

  for (const m of await searchMail(`from:booksy.com newer_than:${days}d`)) {
    const sub = m.subject;
    const when = sub.match(new RegExp(`(?:${MONTHS}) \\d{1,2}, \\d{4},? \\d{1,2}:\\d{2} ?[AP]M`, "i"))?.[0];
    const name = sub.split(":")[0]?.trim();
    if (!when || !name) continue;
    const start = parseBooksyDate(when);
    if (!start) continue;
    const externalId = "booksy:" + hashId(name.toLowerCase(), start.toISOString());
    if (/cancel/i.test(sub)) {
      const r = await db.appointment.updateMany({ where: { externalId, status: "BOOKED" }, data: { status: "CANCELLED" } });
      cancelled += r.count;
      continue;
    }
    if (!/new booking|booked|reschedul/i.test(sub)) continue;
    const price = Number(m.text.match(/\$\s?(\d+(?:\.\d{2})?)/)?.[1] ?? NaN);
    const service = /beard/i.test(m.text) ? "Haircut + Beard" : "Haircut";
    const phone = m.text.match(/\(\d{3}\) \d{3}-\d{4}/)?.[0];
    const email = m.text.match(/[\w.+-]+@[\w-]+\.[\w.]+/)?.[0];
    if (await db.appointment.findUnique({ where: { externalId } })) continue;
    if (await sameSlot(name, start)) continue;
    const client = await upsertClient(name, { phone, email: email?.includes("booksy") ? undefined : email });
    await db.appointment.create({ data: { clientId: client.id, start, service, price: isFinite(price) ? price : null, source: "booksy", externalId } });
    added++;
  }

  // Haircuts calendar: "Mens Haircut - Name", "Name Haircut", "akhi haircut"; skip the open "Haircuts" availability blocks.
  const now = new Date();
  const events = await listEvents("haircuts", new Date(now.getTime() - days * 86_400_000), new Date(now.getTime() + 21 * 86_400_000));
  for (const e of events) {
    const t = e.title.trim();
    if (/^haircuts?$/i.test(t)) continue;
    const name = t.replace(/^(mens )?haircut\s*-\s*/i, "").replace(/\s*(mens )?haircut$/i, "").trim();
    if (!name || /^\(\d{3}\)/.test(name)) continue;
    const externalId = "gcal:" + e.id;
    if (await db.appointment.findUnique({ where: { externalId } })) continue;
    if (await sameSlot(name, e.start)) continue;
    const price = Number(e.description?.match(/Price: \$(\d+(?:\.\d{2})?)/)?.[1] ?? NaN);
    const client = await upsertClient(name);
    await db.appointment.create({ data: { clientId: client.id, start: e.start, price: isFinite(price) ? price : 30, service: /beard/i.test(t) ? "Haircut + Beard" : "Haircut", source: "calendar", externalId } });
    added++;
  }
  return { added, cancelled };
}

async function sameSlot(name: string, start: Date) {
  const near = await db.appointment.findMany({
    where: { start: { gte: new Date(start.getTime() - 12 * 3_600_000), lte: new Date(start.getTime() + 12 * 3_600_000) } },
    include: { client: true },
  });
  const first = name.toLowerCase().split(" ")[0];
  return near.some((a) => a.client.name.toLowerCase().split(" ")[0] === first);
}

function parseBooksyDate(s: string): Date | null {
  const m = s.match(new RegExp(`(${MONTHS}) (\\d{1,2}), (\\d{4}),? (\\d{1,2}):(\\d{2}) ?([AP]M)`, "i"));
  if (!m) return null;
  const month = MONTHS.split("|").findIndex((x) => x.toLowerCase() === m[1].toLowerCase());
  let h = Number(m[4]) % 12;
  if (m[6].toUpperCase() === "PM") h += 12;
  const day = `${m[3]}-${String(month + 1).padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  return at(day, `${String(h).padStart(2, "0")}:${m[5]}`);
}
