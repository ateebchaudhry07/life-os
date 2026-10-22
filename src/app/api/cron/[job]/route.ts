import { NextResponse } from "next/server";
import { nightlySync } from "@/lib/jobs/nightly";
import { lectureReview } from "@/lib/jobs/lectureReview";
import { weeklyPlan } from "@/lib/jobs/weeklyPlan";
import { runAllAgents } from "@/lib/agents/runner";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

const JOBS: Record<string, () => Promise<unknown>> = {
  "nightly-sync": () => nightlySync(),
  "lecture-review": () => lectureReview(),
  "weekly-plan": () => weeklyPlan(),
  agents: () => runAllAgents(),
};

// Vercel Cron calls these with "Authorization: Bearer $CRON_SECRET".
export async function GET(req: Request, { params }: { params: { job: string } }) {
  if (req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const run = JOBS[params.job];
  if (!run) return NextResponse.json({ error: "unknown job" }, { status: 404 });
  try {
    return NextResponse.json({ ok: true, result: await run() });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
