import { db } from "../db";

const norm = (s: string) => s.toLowerCase().replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();
const parts = (s: string) => norm(s).split(" ").filter((p) => p.length > 1);

/** 0..1 how likely two names are the same person (handles "Rigo A." vs "Rigo Almanza", "Sid" vs "Siddharth"). */
export function nameScore(a: string, b: string): number {
  const A = parts(a), B = parts(b);
  if (!A.length || !B.length) return 0;
  if (norm(a) === norm(b)) return 1;
  let score = 0;
  const firstA = A[0], firstB = B[0];
  if (firstA === firstB) score += 0.6;
  else if (firstA.startsWith(firstB) || firstB.startsWith(firstA)) score += 0.45;
  if (A.length > 1 && B.length > 1) {
    const restA = A.slice(1), restB = B.slice(1);
    const sameLast = restA.some((p) => restB.includes(p));
    const initial = restA.some((p) => restB.some((q) => (p.length === 1 || q.length === 1) && p[0] === q[0]));
    if (sameLast) score += 0.4;
    else if (initial) score += 0.25;
    else return 0; // different last names = different people
  } else score += 0.15;
  return Math.min(score, 1);
}

/** Booked appointment for this payer within 4 days of the payment, best name match, nearest date. */
export async function findClientAppointment(payer: string, when: Date) {
  const d = 4 * 86_400_000;
  const candidates = await db.appointment.findMany({
    where: { status: "BOOKED", start: { gte: new Date(when.getTime() - d), lte: new Date(when.getTime() + d) } },
    include: { client: true },
  });
  let best: (typeof candidates)[number] | null = null, bestScore = 0;
  for (const c of candidates) {
    const names = [c.client.name, ...c.client.aliases];
    let s = Math.max(...names.map((n) => nameScore(payer, n)));
    // same last name, different first name = probably a parent paying
    if (s < 0.5) {
      const lp = parts(payer).at(-1), lc = parts(c.client.name).at(-1);
      if (lp && lc && lp === lc && lp.length > 2) s = 0.56;
    }
    s -= Math.abs(c.start.getTime() - when.getTime()) / (30 * d); // prefer closer dates
    if (s > bestScore) { bestScore = s; best = c; }
  }
  return bestScore >= 0.5 ? best : null;
}

export async function upsertClient(name: string, extra: { phone?: string; email?: string } = {}) {
  const all = await db.client.findMany();
  const hit = all.find((c) => nameScore(name, c.name) >= 0.9 || c.aliases.some((a) => nameScore(name, a) >= 0.9));
  if (hit) {
    if ((extra.phone && !hit.phone) || (extra.email && !hit.email)) {
      await db.client.update({ where: { id: hit.id }, data: { phone: hit.phone ?? extra.phone, email: hit.email ?? extra.email } });
    }
    return hit;
  }
  return db.client.create({ data: { name: name.trim(), ...extra } });
}
