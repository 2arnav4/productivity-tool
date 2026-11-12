import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase-server";
import { canAccess } from "@/lib/access";
import { currentLinks } from "@/lib/live-plan-metrics";
import { fetchProblem, getStatsService, storageProblem } from "@/lib/instagram-stats";
import { MAX_LINKS, type Payer } from "@/lib/instagram-stats/service";
import type { Profile } from "@/lib/types";

// CORE ARCH: this route spends money. Sign-in, access, plan scope and the Refresh limit all run before any fetch.
export const dynamic = "force-dynamic";

const REFRESH_LIMIT = 6; // Per user, per plan, per hour. Retry counts too, because it pays the same way.
const REFRESH_WINDOW_SECONDS = 3600;
const REFRESH_RESUME_SECONDS = 900; // How long a cut Refresh can be resumed.
const ATTACH_LIMIT = 100; // Paid fetches started by attaching links, per user per hour. Links past it get their first fetch from the scheduled job.
const ATTACH_WINDOW_SECONDS = 3600;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail = (status: number, error: string) => NextResponse.json({ error }, { status });
const isList = (l: unknown): l is string[] => Array.isArray(l) && l.every(x => typeof x === "string" && x);

export async function POST(req: NextRequest) {
  try {
    // Cookies travel with cross-site requests in some cases, and this can spend money, so only this site's own pages may call it.
    const site = req.headers.get("sec-fetch-site");
    if (site && site !== "same-origin") return fail(403, "This only accepts requests from the dashboard.");
    // A plain form from another site can't send JSON, which covers older browsers that don't send the header above.
    if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return fail(415, "Send JSON.");

    const supabase = await createServerSupabaseClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return fail(401, "Not signed in.");

    const body = await req.json().catch(() => null) as { planId?: unknown; mode?: unknown; links?: unknown; wait?: unknown; refreshId?: unknown } | null;
    const { planId, mode, links: asked, wait: waiting = [], refreshId } = body ?? {};
    if (typeof planId !== "string" || !UUID.test(planId)) return fail(400, "Missing plan.");
    if (mode !== "read" && mode !== "attach" && mode !== "refresh") return fail(400, "Unknown request.");
    if ((asked !== undefined && !isList(asked)) || !isList(waiting)) return fail(400, "Unknown links.");
    if (mode === "refresh" && (typeof refreshId !== "string" || !UUID.test(refreshId))) return fail(400, "Unknown refresh.");

    const { data: profile } = await supabase.from("profiles").select("*").eq("id", user.id).single();
    const p = profile as Profile | null;
    const onThePage = canAccess(p, "live_media_plans") || canAccess(p, "verify_live_links");
    // Excel import happens in the Campaign Brief screen, which Distribution Hub users can open without the Live Media Plans page.
    if (!onThePage && !(mode === "attach" && canAccess(p, "distribution_hub"))) return fail(403, "You don't have access to Live Media Plans.");

    // Only links on this plan, read from the database with the user's own access. A user can't fetch arbitrary links through this route.
    const { data: plan, error: planError } = await supabase.from("media_plans").select("id, media_plan_items(live_links, quantity)").eq("id", planId).maybeSingle();
    if (planError) throw new Error(planError.message);
    if (!plan) return fail(404, "Plan not found.");
    const onPlan = [...new Set((plan.media_plan_items as { live_links: string[]; quantity: number }[]).flatMap(i => currentLinks(i)))];
    if (onPlan.length > MAX_LINKS) return fail(400, `This plan has more than ${MAX_LINKS} links.`);
    const allowed = new Set(onPlan);
    const links = (asked ?? onPlan).filter(l => allowed.has(l));
    const wait = waiting.filter(l => allowed.has(l));

    if (mode === "read") {
      const problem = storageProblem();
      if (problem) return NextResponse.json({ lines: [], notice: problem });
      const service = getStatsService();
      const lines = await service.readSaved(onPlan);
      const schedule = p?.role === "admin" ? await service.scheduleHealth() : undefined;
      return NextResponse.json({ lines, schedule });
    }

    const problem = fetchProblem();
    if (problem) return fail(503, problem);
    const service = getStatsService();

    let payer: Payer;
    if (mode === "refresh") {
      const ticket = await service.takeRefresh(refreshId as string, user.id, planId, REFRESH_LIMIT, REFRESH_WINDOW_SECONDS, REFRESH_RESUME_SECONDS);
      if (!ticket.allowed) {
        const minutes = Math.max(1, Math.ceil(ticket.retrySeconds / 60));
        return fail(429, ticket.retrySeconds ? `Refresh limit reached for this plan (${REFRESH_LIMIT} an hour). Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.` : "This refresh has ended. Click Refresh to start a new one.");
      }
      payer = { refresh: { id: refreshId as string, since: ticket.at as string } };
    } else {
      await service.attachAll(links);
      payer = { attach: { userId: user.id, limit: ATTACH_LIMIT, windowSeconds: ATTACH_WINDOW_SECONDS } };
    }

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const send = (line: object) => {
          try {
            controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
          } catch {
            // The page has left. Work already started still saves.
          }
        };
        try {
          await service.answerLinks({ links, wait, payer, isGone: () => req.signal.aborted, send });
        } catch (e) {
          console.error("live-plan-stats stream error:", e);
        }
        try {
          controller.close();
        } catch {
          // Already closed by the page leaving.
        }
      },
    });
    return new Response(stream, { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store", "X-Accel-Buffering": "no" } });
  } catch (err) {
    console.error("live-plan-stats error:", err);
    return fail(500, "Stats aren't available right now. Please try again.");
  }
}
