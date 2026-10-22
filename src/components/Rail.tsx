import Link from "next/link";
import { db } from "@/lib/db";
import { at, dayKey, addDays } from "@/lib/time";

export async function Rail() {
  const today = dayKey();
  const [unpaid, reviews, overdue] = await Promise.all([
    db.appointment.count({ where: { status: "BOOKED", start: { lt: at(today) } } }),
    db.lectureReview.count({ where: { doneAt: null, due: { lt: at(addDays(today, 1)) } } }),
    db.assignment.count({ where: { completed: false, kind: { not: "exam" }, due: { lt: new Date() } } }),
  ]).catch(() => [0, 0, 0]);
  const links: [string, string, number][] = [
    ["/", "Today", 0],
    ["/school", "School", reviews + overdue],
    ["/cuts", "AteebCuts", unpaid],
    ["/money", "Money", 0],
    ["/gym", "Gym", 0],
    ["/plan", "Week plan", 0],
    ["/settings", "Settings", 0],
  ];
  return (
    <nav className="rail" aria-label="Sections">
      <div className="brand">Life<span>·</span>OS</div>
      {links.map(([href, label, n]) => (
        <Link key={href} href={href}>
          {label}
          {n > 0 && <span className="badge">{n}</span>}
        </Link>
      ))}
    </nav>
  );
}
