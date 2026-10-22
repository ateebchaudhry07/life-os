import { PrismaClient } from "@prisma/client";
import { DEFAULT_AREAS, DEFAULT_CATEGORIES } from "../src/lib/money";
import { DEFAULT_PRIORITIES } from "../src/lib/db";
import { COURSE_CODES } from "../src/lib/config";

const db = new PrismaClient();

async function main() {
  // Runs on every deploy: only creates what's missing, never overwrites your edits.
  for (const a of DEFAULT_AREAS) {
    const goal = a.name === "Wolverine Shifa" || a.name === "PhiDE" ? 2 : null; // starting weekly goals, edit in Settings
    await db.area.upsert({ where: { name: a.name }, update: {}, create: { ...a, weeklyGoalHours: goal } });
  }
  for (const c of DEFAULT_CATEGORIES) {
    const area = c.area ? await db.area.findUnique({ where: { name: c.area } }) : null;
    await db.category.upsert({ where: { name: c.name }, update: {}, create: { name: c.name, kind: c.kind, color: c.color, areaId: area?.id } });
  }
  for (const code of COURSE_CODES) await db.course.upsert({ where: { code }, update: {}, create: { code } });
  await db.settings.upsert({ where: { id: "me" }, update: {}, create: { id: "me", priorities: DEFAULT_PRIORITIES } });
  console.log("Seeded areas, categories, courses and settings.");
}

main().finally(() => db.$disconnect());
