import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase-server";
import { getValidGoogleToken } from "@/lib/google-token";
import { canAccess } from "@/lib/access";
import { currentLinks, lineToMetrics, planExportRows, type MetricsByLink, type StatsLine } from "@/lib/live-plan-metrics";
import { getStatsService, storageProblem } from "@/lib/instagram-stats";
import type { Profile } from "@/lib/types";

const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";

async function sheetsRequest(url: string, accessToken: string, method: string, body: unknown) {
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Sheets API ${res.status}: ${await res.text()}`);
  return res.json();
}

/** Saved numbers only, and never a paid fetch. A stats problem shouldn't stop the export, so those columns stay blank. */
async function withStats(items: Parameters<typeof planExportRows>[0]) {
  const metrics: MetricsByLink = {};
  try {
    if (!storageProblem()) {
      const lines = await getStatsService().readSaved([...new Set(items.flatMap(i => currentLinks(i)))]);
      for (const line of lines) metrics[line.link] = lineToMetrics(line as StatsLine);
    }
  } catch (err) {
    console.error("export-live-plan-sheet stats error:", err);
  }
  return items.map(i => ({ ...i, metrics }));
}

export async function POST(req: NextRequest) {
  try {
    const supabase = await createServerSupabaseClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

    const { data: profile } = await supabase.from("profiles").select("*").eq("id", user.id).single();
    const allowed = canAccess(profile as Profile | null, "live_media_plans") || canAccess(profile as Profile | null, "verify_live_links");
    if (!allowed) return NextResponse.json({ error: "You don't have access to Live Media Plans." }, { status: 403 });

    const body = await req.json().catch(() => null) as { planId?: unknown } | null;
    const planId = body?.planId;
    if (typeof planId !== "string" || !planId) return NextResponse.json({ error: "Missing plan." }, { status: 400 });

    // Rows come from the database, never from the browser
    const { data: plan, error: planError } = await supabase
      .from("media_plans")
      .select("id, client_briefs(brand_name), media_plan_items(*)")
      .eq("id", planId)
      .maybeSingle();
    if (planError) throw new Error(planError.message);
    const items = (plan?.media_plan_items || []) as Parameters<typeof planExportRows>[0];
    if (!plan || items.length === 0) return NextResponse.json({ error: "Plan not found." }, { status: 404 });

    const google = await getValidGoogleToken();
    if (!google) {
      return NextResponse.json({ error: "Google account not connected. Please connect your Google account in Profile settings." }, { status: 401 });
    }

    const brief = plan.client_briefs as unknown as { brand_name?: string } | null;
    const title = `${brief?.brand_name || "Campaign"} - Live Media Plan ${new Date().toLocaleDateString("en-IN")}`;
    const rows = planExportRows(await withStats(items));
    const header = Object.keys(rows[0]);
    const values = [header, ...rows.map(r => header.map(h => r[h]))];

    const sheet = await sheetsRequest(SHEETS_API, google.access_token, "POST", { properties: { title } }) as { spreadsheetId: string };
    const { spreadsheetId } = sheet;

    // RAW, because USER_ENTERED would run a pasted "=..." as a formula and turn "1/2" into a date
    await sheetsRequest(`${SHEETS_API}/${spreadsheetId}/values/A1?valueInputOption=RAW`, google.access_token, "PUT", { values });
    await sheetsRequest(`${SHEETS_API}/${spreadsheetId}:batchUpdate`, google.access_token, "POST", {
      requests: [
        { repeatCell: { range: { sheetId: 0, startRowIndex: 0, endRowIndex: 1 }, cell: { userEnteredFormat: { textFormat: { bold: true } } }, fields: "userEnteredFormat.textFormat" } },
        { updateSheetProperties: { properties: { sheetId: 0, gridProperties: { frozenRowCount: 1 } }, fields: "gridProperties.frozenRowCount" } },
      ],
    });

    return NextResponse.json({ url: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit` });
  } catch (err) {
    console.error("export-live-plan-sheet error:", err);
    return NextResponse.json({ error: "Could not save to Google Drive. Please try again." }, { status: 500 });
  }
}
