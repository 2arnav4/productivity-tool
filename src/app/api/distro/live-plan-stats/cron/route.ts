import { createHash, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { fetchProblem, getStatsService } from "@/lib/instagram-stats";

// CORE ARCH: no signed-in user here, so the secret is the only thing between the internet and paid runs. It uses the service key, and writes only the stats tables.
export const dynamic = "force-dynamic";

const LINKS_PER_WAKE = 100; // Past that, the rest waits for the next wake, so a backlog spreads out.
const ANSWER_WITHIN_MS = 100_000; // Counted from here. Hostinger stops a request at 120 seconds, and a sleeping app uses part of that to start.

const sameSecret = (given: string, real: string) => {
  // Hashing first means the comparison takes the same time whatever the lengths.
  const hash = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(hash(given), hash(real));
};

export async function POST(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  // An empty or missing secret refuses every call, so a lost setting can't open this up.
  if (!secret) return NextResponse.json({ error: "The scheduled refresh isn't set up on this server." }, { status: 503 });
  if (!sameSecret(req.headers.get("x-cron-secret") ?? "", secret)) return NextResponse.json({ error: "Not allowed." }, { status: 401 });

  const problem = fetchProblem();
  if (problem) return NextResponse.json({ error: problem }, { status: 503 });
  try {
    const summary = await getStatsService().runDue({ limit: LINKS_PER_WAKE, budgetMs: ANSWER_WITHIN_MS });
    // Fails the curl call when the whole service is out, so hPanel's output shows it. The daily limit is working as meant, so it isn't a failure.
    return NextResponse.json(summary, { status: summary.stopped === "service" ? 503 : 200 });
  } catch (err) {
    console.error("live-plan-stats cron error:", err);
    return NextResponse.json({ error: "The scheduled refresh could not run." }, { status: 500 });
  }
}
