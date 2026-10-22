"use server";

import { revalidatePath } from "next/cache";
import { getServerSession } from "next-auth";
import type { TransactionType } from "@prisma/client";
import { authOptions } from "@/lib/auth";
import { db } from "@/lib/db";
import { categoryId, guessCategory, hashId, importCsv, importStatementPdf, upsertTransaction } from "@/lib/money";
import { upsertClient } from "@/lib/sync/match";
import { nightlySync } from "@/lib/jobs/nightly";
import { lectureReview } from "@/lib/jobs/lectureReview";
import { weeklyPlan } from "@/lib/jobs/weeklyPlan";
import { importCutRows, importNotion, parseCutsCsv } from "@/lib/importNotion";
import { at, dayKey } from "@/lib/time";

async function guard() {
  const s = await getServerSession(authOptions);
  if (!s?.user) throw new Error("Not signed in");
}

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const num = (f: FormData, k: string) => (str(f, k) === "" ? null : Number(str(f, k)));

// ---------- AteebCuts ----------
export async function completeCut(f: FormData) {
  await guard();
  const id = str(f, "id");
  const amount = num(f, "amount");
  const method = str(f, "method") || "Cash";
  const status = (str(f, "status") || "COMPLETED") as "COMPLETED" | "NO_SHOW" | "CANCELLED";
  const appt = await db.appointment.update({ where: { id }, data: { status, amountPaid: status === "COMPLETED" ? amount : null, paymentMethod: status === "COMPLETED" ? method : null }, include: { client: true } });
  // Cash isn't in any bank feed, so record it here. Venmo/Zelle arrive from email.
  if (status === "COMPLETED" && amount && /cash|apple/i.test(method)) {
    await upsertTransaction({ date: appt.start, name: `${method} from ${appt.client.name}`, amount, type: "INCOME", category: "AteebCuts Income", account: method, source: "manual", externalId: "cut:" + appt.id, appointmentId: appt.id });
  }
  revalidatePath("/cuts");
  revalidatePath("/");
}

export async function addAppointment(f: FormData) {
  await guard();
  const client = await upsertClient(str(f, "client"));
  await db.appointment.create({
    data: { clientId: client.id, start: at(str(f, "day"), str(f, "time") || "17:00"), service: str(f, "service") || "Haircut", price: num(f, "price") ?? 30, source: "manual" },
  });
  revalidatePath("/cuts");
}

export async function importCutsFile(f: FormData) {
  await guard();
  const file = f.get("file") as File | null;
  if (!file) return;
  try {
    const r = await importCutRows(parseCutsCsv(await file.text()));
    await db.syncLog.create({ data: { job: "cuts-import", ok: true, finishedAt: new Date(), summary: `${file.name}: ${r.appointments} cuts for ${r.clients} clients imported (re-uploading is safe)` } });
  } catch (e) {
    await db.syncLog.create({ data: { job: "cuts-import", ok: false, finishedAt: new Date(), summary: `${file.name}: ${(e as Error).message}` } });
  }
  revalidatePath("/cuts");
  revalidatePath("/money");
  revalidatePath("/");
}

// ---------- Money ----------
export async function addTransaction(f: FormData) {
  await guard();
  const type = (str(f, "type") || "EXPENSE") as TransactionType;
  const name = str(f, "name");
  await upsertTransaction({
    date: at(str(f, "day") || dayKey(), "12:00"),
    name,
    amount: Math.abs(num(f, "amount") ?? 0),
    type,
    category: str(f, "category") || guessCategory(name, type),
    account: str(f, "account") || undefined,
    source: "manual",
    externalId: "manual:" + hashId(name, Date.now()),
  });
  revalidatePath("/money");
}

export async function setCategory(f: FormData) {
  await guard();
  await db.transaction.update({ where: { id: str(f, "id") }, data: { categoryId: await categoryId(str(f, "category")) } });
  revalidatePath("/money");
}

export async function uploadCsv(f: FormData) {
  await guard();
  const file = f.get("file") as File | null;
  if (!file) return;
  const account = str(f, "account") || "Bank";
  try {
    const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
    const r = isPdf ? await importStatementPdf(Buffer.from(await file.arrayBuffer()), account) : await importCsv(await file.text(), account);
    const found = "found" in r ? `${r.found} found, ` : "";
    await db.syncLog.create({ data: { job: "csv-import", ok: true, finishedAt: new Date(), summary: `${file.name}: ${found}${r.added} added, ${r.skipped} already there` } });
  } catch (e) {
    await db.syncLog.create({ data: { job: "csv-import", ok: false, finishedAt: new Date(), summary: `${file.name}: ${(e as Error).message}` } });
  }
  revalidatePath("/money");
}

export async function addCategory(f: FormData) {
  await guard();
  const name = str(f, "name");
  if (!name) return;
  const area = str(f, "area");
  await db.category.upsert({
    where: { name },
    update: { monthlyBudget: num(f, "budget") },
    create: { name, kind: (str(f, "kind") || "EXPENSE") as "EXPENSE", monthlyBudget: num(f, "budget"), color: str(f, "color") || "#6b7280", areaId: area ? (await db.area.findUnique({ where: { name: area } }))?.id : undefined },
  });
  revalidatePath("/money");
  revalidatePath("/settings");
}

// ---------- School ----------
export async function markReview(f: FormData) {
  await guard();
  const confidence = num(f, "confidence");
  await db.lectureReview.update({ where: { id: str(f, "id") }, data: { doneAt: new Date(), confidence: confidence ?? undefined } });
  revalidatePath("/school");
  revalidatePath("/");
}

export async function toggleAssignment(f: FormData) {
  await guard();
  const a = await db.assignment.findUniqueOrThrow({ where: { id: str(f, "id") } });
  await db.assignment.update({ where: { id: a.id }, data: { completed: !a.completed } });
  revalidatePath("/school");
  revalidatePath("/");
}

// ---------- Reminders ----------
export async function addReminder(f: FormData) {
  await guard();
  const title = str(f, "title");
  if (!title) return;
  const day = str(f, "day");
  await db.reminder.create({ data: { title, due: day ? at(day, str(f, "time") || "09:00") : null, url: str(f, "url") || null, notes: str(f, "notes") || null } });
  revalidatePath("/reminders");
  revalidatePath("/", "layout");
}

export async function updateReminder(f: FormData) {
  await guard();
  const id = str(f, "id");
  const op = str(f, "op");
  if (op === "toggle") {
    const r = await db.reminder.findUniqueOrThrow({ where: { id } });
    await db.reminder.update({ where: { id }, data: { done: !r.done, doneAt: r.done ? null : new Date() } });
  } else if (op === "delete") {
    // Seeded reminders are marked done instead, so the next deploy doesn't add them back.
    const r = await db.reminder.findUniqueOrThrow({ where: { id } });
    if (r.seedKey) await db.reminder.update({ where: { id }, data: { done: true, doneAt: new Date() } });
    else await db.reminder.delete({ where: { id } });
  } else {
    const day = str(f, "day");
    await db.reminder.update({ where: { id }, data: { due: day ? at(day, str(f, "time") || "09:00") : null } });
  }
  revalidatePath("/reminders");
  revalidatePath("/", "layout");
}

// ---------- Gym ----------
export async function logWorkout(f: FormData) {
  await guard();
  const exercises = f.getAll("exercise").map(String);
  const weights = f.getAll("weight").map(String);
  const reps = f.getAll("reps").map(String);
  const sets = f.getAll("sets").map(String);
  const rows = exercises
    .map((e, i) => ({ exercise: e.trim(), weight: weights[i] ? Number(weights[i]) : null, reps: reps[i] ? Number(reps[i]) : null, sets: sets[i] ? Number(sets[i]) : 1 }))
    .filter((r) => r.exercise);
  const day = str(f, "day") || dayKey();
  await db.workout.create({
    data: { date: at(day, "12:00"), type: str(f, "type") || "Full Body", minutes: num(f, "minutes") ?? undefined, notes: str(f, "notes") || undefined, sets: { create: rows } },
  });
  const bw = num(f, "bodyweight");
  if (bw) await db.bodyWeight.upsert({ where: { date: at(day, "12:00") }, update: { pounds: bw }, create: { date: at(day, "12:00"), pounds: bw } });
  revalidatePath("/gym");
  revalidatePath("/");
}

// ---------- Plan & settings ----------
export async function saveSettings(f: FormData) {
  await guard();
  await db.settings.update({
    where: { id: "me" },
    data: {
      priorities: str(f, "priorities"),
      gymPerWeek: num(f, "gymPerWeek") ?? 4,
      gymMinutes: num(f, "gymMinutes") ?? 75,
      ntfyTopic: str(f, "ntfyTopic") || null,
      canvasIcsUrl: str(f, "canvasIcsUrl") || null,
      canvasBaseUrl: str(f, "canvasBaseUrl") || "https://umich.instructure.com",
      wakeTime: str(f, "wakeTime") || "06:00",
      sleepStart: str(f, "sleepStart") || "23:00",
    },
  });
  revalidatePath("/settings");
  revalidatePath("/plan");
}

export async function saveArea(f: FormData) {
  await guard();
  const name = str(f, "name");
  if (!name) return;
  const data = {
    color: str(f, "color") || "#6b7280",
    priority: num(f, "priority") ?? 50,
    weeklyGoalHours: num(f, "weeklyGoalHours"),
    matchWords: str(f, "matchWords").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
  };
  await db.area.upsert({ where: { name }, update: data, create: { name, ...data } });
  revalidatePath("/settings");
}

export async function saveCourseLink(f: FormData) {
  await guard();
  const canvasId = str(f, "link").match(/courses\/(\d+)/)?.[1] ?? (/^\d+$/.test(str(f, "link")) ? str(f, "link") : null);
  await db.course.update({ where: { id: str(f, "id") }, data: { canvasId } });
  revalidatePath("/settings");
}

export async function runJob(f: FormData) {
  await guard();
  const job = str(f, "job");
  try {
    if (job === "nightly-sync") await nightlySync(Number(str(f, "days") || 3));
    if (job === "lecture-review") await lectureReview();
    if (job === "weekly-plan") await weeklyPlan(str(f, "week") || undefined);
    if (job === "import-notion") {
      const log = await db.syncLog.create({ data: { job: "import-notion" } });
      try {
        await db.syncLog.update({ where: { id: log.id }, data: { ok: true, finishedAt: new Date(), summary: await importNotion() } });
      } catch (e) {
        await db.syncLog.update({ where: { id: log.id }, data: { ok: false, finishedAt: new Date(), summary: (e as Error).message } });
      }
    }
  } catch {
    // the error is saved in the sync log and shown on the page
  }
  revalidatePath("/", "layout");
}
