"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { createClient } from "@/lib/supabase";
import { STATS, rowStat, rowFetchedAt, planExportRows, lineToMetrics, currentLinks, type LinkMetrics, type MetricsByLink, type MissingKind, type StatsLine } from "@/lib/live-plan-metrics";
import { fetchPlanStats, NO_ANSWER } from "@/lib/live-plan-stats-client";
import {
  Radar, Loader2, ExternalLink, ShieldCheck, Wallet, Lock, Search,
  CheckCircle2, Circle, Link2, AlertTriangle, FileSpreadsheet, Download, CloudUpload, RefreshCw, RotateCcw,
  XCircle, EyeOff, MinusCircle, Clock,
} from "lucide-react";

const supabase = createClient();

const READ_SAVED_EVERY_MS = 60_000;

interface Item {
  id: string;
  plan_id: string;
  handle_name: string;
  page_link?: string;
  platform?: string;
  category?: string;
  followers?: number;
  deliverable_type?: string;
  quantity: number;
  rate?: number;
  total_cost?: number;
  live_links: string[];
  verified: boolean;
  verified_at?: string;
  paid: boolean;
  paid_at?: string;
}

interface Plan {
  id: string;
  source_file_name?: string;
  summary?: Record<string, unknown>;
  created_at: string;
  media_plan_items: Item[];
}

interface Brief {
  id: string;
  brand_name: string;
  status: string;
  media_plans: Plan[];
}

type Stage = "all" | "needs_links" | "to_verify" | "to_pay" | "paid";

const STAGES: { key: Stage; label: string }[] = [
  { key: "all", label: "All" },
  { key: "needs_links", label: "Needs links" },
  { key: "to_verify", label: "To verify" },
  { key: "to_pay", label: "Verified · unpaid" },
  { key: "paid", label: "Paid" },
];

const filled = (i: Item) => (i.live_links || []).filter(l => l && l.trim()).length;
const complete = (i: Item) => filled(i) >= i.quantity;

function stageOf(i: Item): Exclude<Stage, "all"> {
  if (i.paid) return "paid";
  if (i.verified) return "to_pay";
  if (complete(i)) return "to_verify";
  return "needs_links";
}

const rupees = (n?: number) => n ? `₹${Math.round(n).toLocaleString("en-IN")}` : "—";
const compact = (n?: number) => {
  if (!n) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K`;
  return String(n);
};

// compact() turns a real 0 into a dash, so stats only dash a missing value
const COUNTED = ["views", "likes", "comments", "shares", "reposts"] as const;
const hasNumbers = (m?: LinkMetrics) => !!m && COUNTED.some(k => typeof m[k] === "number");
const fetchedLabel = (at?: string) => at ? `Fetched ${new Date(at).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" })}` : undefined;
const formatStat = (n: number | null) => n === null ? "—" : n === 0 ? "0" : compact(n);

// One icon per reason a stat is missing, so a count the owner hid doesn't look like our fetch failing. The hover text gives the detail.
const MISSING_ICON: Record<MissingKind, { Icon: typeof Clock; className: string; label: string }> = {
  failed: { Icon: XCircle, className: "text-red-500", label: "Failed" },
  hidden: { Icon: EyeOff, className: "text-slate-500", label: "Hidden by the owner" },
  na: { Icon: MinusCircle, className: "text-slate-300", label: "Not shown for this type of post" },
  retry: { Icon: Clock, className: "text-amber-500", label: "Waiting or needs a retry" },
};

function MissingStat({ kind }: { kind: MissingKind }) {
  const { Icon, className, label } = MISSING_ICON[kind];
  return (
    <span className="inline-flex justify-end cursor-help">
      <Icon className={`w-3.5 h-3.5 ${className}`} aria-hidden="true" />
      <span className="sr-only">{label}</span>
    </span>
  );
}

function normaliseUrl(raw: string) {
  const v = raw.trim();
  if (!v) return "";
  return /^https?:\/\//i.test(v) ? v : `https://${v}`;
}

interface Props {
  userId: string;
  isAdmin: boolean;
  canVerify: boolean;
  /** Rendered as a tab inside Distribution Hub — skip the page header */
  embedded?: boolean;
}

export default function LiveMediaPlans({ userId, isAdmin, canVerify, embedded }: Props) {
  const [briefs, setBriefs] = useState<Brief[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeId, setActiveId] = useState("");
  const [stage, setStage] = useState<Stage>("all");
  const [category, setCategory] = useState("");
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [exporting, setExporting] = useState(false);
  const [stats, setStats] = useState<MetricsByLink>({});
  const [pending, setPending] = useState<Set<string>>(new Set());
  // Per plan, so one client's fetch never blocks another's or shows on its page. A count, because a paste can overlap a Refresh.
  const [fetchCounts, setFetchCounts] = useState<Record<string, number>>({});
  const [statusByPlan, setStatusByPlan] = useState<Record<string, { text: string; isError: boolean }>>({});
  const [schedule, setSchedule] = useState<{ lastRunAt: string | null; stale: boolean } | null>(null);
  const pendingRef = useRef(pending); // Lets the timed read skip links being fetched without restarting its timer.
  const [readTick, setReadTick] = useState(0);
  const [savingToDrive, setSavingToDrive] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from("client_briefs")
      .select("id, brand_name, status, media_plans(id, source, source_file_name, summary, created_at, media_plan_items(*))")
      .in("status", ["approved", "live"])
      .order("updated_at", { ascending: false });
    if (error) setError(error.message);
    // Only briefs that actually carry an uploaded plan with line items
    const list = ((data || []) as unknown as Brief[])
      .map(b => ({
        ...b,
        media_plans: (b.media_plans || [])
          .filter(p => (p as unknown as { source?: string }).source === "upload" && (p.media_plan_items || []).length > 0)
          .map(p => ({ ...p, media_plan_items: p.media_plan_items.map(i => ({ ...i, live_links: Array.isArray(i.live_links) ? (i.live_links as unknown[]).map(l => (typeof l === "string" ? l : "")) : [] })) })),
      }))
      .filter(b => b.media_plans.length > 0);
    setBriefs(list);
    setActiveId(prev => prev && list.some(b => b.id === prev) ? prev : list[0]?.id || "");
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const brief = briefs.find(b => b.id === activeId);
  const plan = brief?.media_plans[0];
  const items = useMemo(() => plan?.media_plan_items || [], [plan]);

  function patchLocal(id: string, patch: Partial<Item>) {
    setBriefs(prev => prev.map(b => ({
      ...b,
      media_plans: b.media_plans.map(p => ({
        ...p,
        media_plan_items: p.media_plan_items.map(i => i.id === id ? { ...i, ...patch } : i),
      })),
    })));
  }

  /** Only says true once the database has the change, so nothing paid starts on a change that didn't land. */
  async function update(item: Item, patch: Partial<Item>, dbPatch: Record<string, unknown>): Promise<boolean> {
    setError("");
    setBusy(item.id);
    const before = { ...item };
    patchLocal(item.id, patch);
    const { error } = await supabase.from("media_plan_items").update(dbPatch).eq("id", item.id);
    setBusy(null);
    if (error) {
      // Database rules are the source of truth — roll back and say why
      patchLocal(item.id, before);
      setError(error.message);
      return false;
    }
    return true;
  }

  async function setLink(item: Item, idx: number, value: string) {
    const links = [...(item.live_links || [])];
    while (links.length < item.quantity) links.push("");
    links[idx] = normaliseUrl(value);
    if (links[idx] === (item.live_links || [])[idx]) return;
    const saved = await update(item, { live_links: links }, { live_links: links });
    // A link's first fetch happens when it's attached. A link with saved numbers costs nothing here.
    if (saved && links[idx] && plan) fetchStats("attach", [links[idx]]);
  }

  function toggleVerified(item: Item) {
    if (!canVerify || item.paid) return;
    const next = !item.verified;
    if (next && !complete(item)) {
      setError(`${item.handle_name} needs all ${item.quantity} live link${item.quantity === 1 ? "" : "s"} before it can be verified.`);
      return;
    }
    const at = next ? new Date().toISOString() : null;
    update(item, { verified: next, verified_at: at || undefined },
      { verified: next, verified_by: next ? userId : null, verified_at: at });
  }

  function togglePaid(item: Item) {
    if (!isAdmin) return;
    const next = !item.paid;
    if (next && !item.verified) { setError("Verify the live links before marking a payout as paid."); return; }
    if (next && !(item.total_cost && item.total_cost > 0)) {
      setError(`Enter ${item.handle_name}'s payout amount before marking it paid.`);
      return;
    }
    if (next && !confirm(`Mark ${rupees(item.total_cost)} to ${item.handle_name} as paid?`)) return;
    const at = next ? new Date().toISOString() : null;
    update(item, { paid: next, paid_at: at || undefined },
      { paid: next, paid_by: next ? userId : null, paid_at: at });
  }

  function setCost(item: Item, raw: string) {
    const v = raw.trim() === "" ? null : Number(raw.replace(/[^0-9.]/g, ""));
    if (v === (item.total_cost ?? null)) return;
    update(item, { total_cost: v ?? undefined, rate: v ? v / item.quantity : undefined },
      { total_cost: v, rate: v ? v / item.quantity : null });
  }

  const planLinks = useMemo(() => [...new Set(items.flatMap(i => currentLinks(i)))], [items]);
  const planId = plan?.id;
  const fetching = !!planId && (fetchCounts[planId] ?? 0) > 0;
  const status = planId ? statusByPlan[planId] : undefined;

  useEffect(() => { pendingRef.current = pending; }, [pending]);

  // Saved numbers only: reading never pays for anything, and never schedules anything.
  // Runs on every card click, then on a timer while the tab is visible, so one person's fetch reaches everyone.
  useEffect(() => {
    if (!planId) return;
    let active = true;
    let reading = false;
    const read = async (showProblems: boolean) => {
      if (reading) return;
      reading = true;
      try {
        const res = await fetch("/api/distro/live-plan-stats", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ planId, mode: "read" }),
        });
        const data = await res.json() as { lines?: StatsLine[]; notice?: string; error?: string; schedule?: { lastRunAt: string | null; stale: boolean } };
        if (!res.ok) throw new Error(data.error);
        if (!active) return;
        // A link being fetched here keeps its live state, so an older saved answer can't overwrite it.
        const saved = (data.lines ?? []).filter(l => !pendingRef.current.has(l.link));
        setStats(prev => ({ ...prev, ...Object.fromEntries(saved.map(l => [l.link, lineToMetrics(l)])) }));
        if (data.schedule) setSchedule(data.schedule);
        if (data.notice && showProblems) setStatusByPlan(prev => ({ ...prev, [planId]: { text: data.notice as string, isError: true } }));
      } catch (err) {
        // A failed timed read stays quiet: the numbers on screen remain and the next read tries again.
        if (active && showProblems) {
          const text = err instanceof Error && err.message ? err.message : "Saved stats couldn't be loaded. Please try again.";
          setStatusByPlan(prev => ({ ...prev, [planId]: { text, isError: true } }));
        }
      } finally {
        reading = false;
      }
    };
    read(true);
    const timer = setInterval(() => { if (document.visibilityState === "visible") read(false); }, READ_SAVED_EVERY_MS);
    return () => { active = false; clearInterval(timer); };
  }, [planId, readTick]);

  function setPlanStatus(forPlan: string, next: { text: string; isError: boolean }) {
    setStatusByPlan(prev => ({ ...prev, [forPlan]: next }));
  }

  function applyLine(line: StatsLine) {
    setStats(prev => {
      const before = prev[line.link];
      let next: LinkMetrics;
      // After a failed fetch the last good numbers stay on screen, and say so.
      if (line.error && hasNumbers(before)) next = { ...before, error: undefined, warning: "Refresh failed. Showing last numbers" };
      else if (!line.done && before) next = { ...before, ...lineToMetrics(line), notes: { ...before.notes, ...lineToMetrics(line).notes } };
      else next = lineToMetrics(line);
      if (line.done && !line.savedAt && hasNumbers(next) && !line.error) next = { ...next, fetched_at: new Date().toISOString() };
      return { ...prev, [line.link]: next };
    });
    if (line.done) setPending(prev => { const copy = new Set(prev); copy.delete(line.link); return copy; });
  }

  /** Says what actually happened, link by link. A failure never reads as a success. */
  function describe(forPlan: string, results: Map<string, StatsLine>) {
    const lines = [...results.values()];
    const failed = lines.filter(l => l.error && !l.unusable).length;
    const unusable = lines.filter(l => l.unusable).length;
    const flagged = lines.filter(l => !l.error && l.warning).length;
    const saved = lines.filter(l => !l.error && !l.warning && l.savedAt).length;
    const updated = lines.length - failed - unusable - flagged - saved;
    const parts = [
      updated && `${updated} updated at ${new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}`,
      saved && `${saved} showing saved numbers`,
      failed && `${failed} could not be read`,
      flagged && `${flagged} need a look (hover the row)`,
      unusable && `${unusable} can't give stats`,
    ].filter(Boolean);
    setPlanStatus(forPlan, parts.length ? { text: `${parts.join(", ")}.`, isError: failed + flagged > 0 } : { text: "This plan has no links yet.", isError: false });
  }

  async function fetchStats(mode: "attach" | "refresh", links?: string[]) {
    if (!planId) return;
    const forPlan = planId; // The user can switch clients mid-fetch, so this run stays tied to the plan it started on.
    const targets = links ?? planLinks;
    setPending(prev => new Set([...prev, ...targets]));
    setFetchCounts(prev => ({ ...prev, [forPlan]: (prev[forPlan] ?? 0) + 1 }));
    setPlanStatus(forPlan, { text: `Fetching ${targets.length} link${targets.length === 1 ? "" : "s"}…`, isError: false });
    const results = new Map<string, StatsLine>();
    try {
      const unanswered = await fetchPlanStats({
        planId: forPlan, mode, links,
        onLine: line => {
          applyLine(line);
          if (line.done) {
            results.set(line.link, line);
            setPlanStatus(forPlan, { text: `Fetched ${results.size} of ${targets.length} links…`, isError: false });
          }
        },
      });
      unanswered.forEach(link => { const line = { link, done: true, error: NO_ANSWER }; results.set(link, line); applyLine(line); });
      describe(forPlan, results);
    } catch (err) {
      setPlanStatus(forPlan, { text: err instanceof Error && err.message ? err.message : "Stats could not be fetched. Please try again.", isError: true });
    } finally {
      setPending(prev => { const copy = new Set(prev); targets.forEach(t => copy.delete(t)); return copy; });
      setFetchCounts(prev => ({ ...prev, [forPlan]: Math.max(0, (prev[forPlan] ?? 1) - 1) }));
    }
  }

  // Links worth paying to try again. A link that can never give stats isn't one of them.
  const flagged = planLinks.filter(l => (stats[l]?.error || stats[l]?.warning) && !stats[l]?.unusable);

  const categories = useMemo(() => [...new Set(items.map(i => i.category || "Uncategorised"))], [items]);

  // Exports the whole plan, ignoring the filters, in the table's order so # matches what's on screen
  async function exportExcel() {
    if (!brief) return;
    setError("");
    setExporting(true);
    try {
      // Loaded on click to keep xlsx out of the page's initial bundle
      const XLSX = await import("xlsx");
      const rows = planExportRows(items.map(i => ({ ...i, metrics: stats })));
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), "Live Media Plan");
      XLSX.writeFile(workbook, `${brief.brand_name} - Live Media Plan.xlsx`);
    } catch {
      setError("Could not create the Excel file. Please try again.");
    } finally {
      setExporting(false);
    }
  }

  async function saveToDrive() {
    if (!plan) return;
    setError("");
    // Opened before the request, because browsers block a new tab opened after one finishes
    const tab = window.open("", "_blank");
    if (!tab) {
      setError("Your browser blocked the new tab. Allow pop-ups for this site and try again.");
      return;
    }
    tab.opener = null;
    setSavingToDrive(true);
    try {
      const res = await fetch("/api/distro/export-live-plan-sheet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planId: plan.id }),
      });
      const data = await res.json() as { url?: string; error?: string };
      if (!res.ok || !data.url) throw new Error(data.error || "Could not save to Google Drive. Please try again.");
      tab.location.href = data.url;
    } catch (err) {
      tab.close();
      setError(err instanceof Error ? err.message : "Could not save to Google Drive. Please try again.");
    } finally {
      setSavingToDrive(false);
    }
  }

  const visible = items.filter(i => {
    if (stage !== "all" && stageOf(i) !== stage) return false;
    if (category && (i.category || "Uncategorised") !== category) return false;
    if (search && !`${i.handle_name} ${i.page_link || ""}`.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const totals = useMemo(() => {
    const deliverables = items.reduce((s, i) => s + i.quantity, 0);
    const linked = items.reduce((s, i) => s + Math.min(filled(i), i.quantity), 0);
    const verified = items.filter(i => i.verified).length;
    const paid = items.filter(i => i.paid);
    const owed = items.filter(i => i.verified && !i.paid).reduce((s, i) => s + (i.total_cost || 0), 0);
    return {
      deliverables, linked, verified, paidCount: paid.length,
      paidAmount: paid.reduce((s, i) => s + (i.total_cost || 0), 0), owed,
      byStage: Object.fromEntries(STAGES.map(s => [s.key, s.key === "all" ? items.length : items.filter(i => stageOf(i) === s.key).length])),
    };
  }, [items]);

  // Group by category in the order categories first appear in the plan
  const grouped = categories
    .map(c => ({ category: c, rows: visible.filter(i => (i.category || "Uncategorised") === c) }))
    .filter(g => g.rows.length > 0);

  let serial = 0;

  return (
    <div className={embedded ? "-m-5 flex flex-col bg-slate-50 min-h-full" : "flex-1 overflow-hidden flex flex-col bg-slate-50"}>
      <div className="bg-white border-b border-slate-200 px-4 sm:px-6 py-4">
        <div className={`flex items-center justify-between gap-3 flex-wrap ${embedded ? "hidden" : ""}`}>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-emerald-600 rounded-xl flex items-center justify-center shadow-sm">
              <Radar className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-slate-900">Live Media Plans</h1>
              <p className="text-sm text-slate-400">Track live links, verify placements, and settle creator payouts</p>
            </div>
          </div>
          <div className="flex items-center gap-2 text-[11px]">
            <span className={`px-2 py-1 rounded-full font-medium ${canVerify ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-500"}`}>
              {canVerify ? "You can verify" : "View & add links"}
            </span>
            {isAdmin && <span className="px-2 py-1 rounded-full font-medium bg-violet-100 text-violet-700">Admin · payouts</span>}
          </div>
        </div>

        {briefs.length > 0 && (
          <div className={`flex gap-2 overflow-x-auto pb-1 ${embedded ? "" : "mt-4"}`}>
            {briefs.map(b => {
              const its = b.media_plans[0]?.media_plan_items || [];
              const done = its.filter(i => i.verified).length;
              return (
                <button key={b.id} onClick={() => { setActiveId(b.id); setCategory(""); setStage("all"); setReadTick(t => t + 1); }}
                  className={`shrink-0 text-left px-3 py-2 rounded-xl border transition-colors ${b.id === activeId ? "bg-emerald-50 border-emerald-300" : "bg-white border-slate-200 hover:border-slate-300"}`}>
                  <p className="text-sm font-semibold text-slate-900">{b.brand_name}</p>
                  <p className="text-[11px] text-slate-500">
                    <span className="capitalize">{b.status}</span> · {done}/{its.length} verified
                  </p>
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className={embedded ? "p-4 sm:p-6" : "flex-1 overflow-y-auto p-4 sm:p-6"}>
        {loading ? (
          <div className="flex justify-center py-20"><Loader2 className="w-6 h-6 animate-spin text-emerald-500" /></div>
        ) : !brief || !plan ? (
          <div className="max-w-md mx-auto text-center py-20">
            <Radar className="w-12 h-12 mx-auto text-slate-200 mb-3" />
            <p className="font-semibold text-slate-700">No live media plans yet</p>
            <p className="text-sm text-slate-400 mt-1">
              Upload a media plan on a campaign brief in Distribution Hub. Once the brief is approved or live, its plan shows up here.
            </p>
          </div>
        ) : (
          <div className="max-w-7xl mx-auto space-y-4">
            {/* Progress */}
            <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
              {[
                { label: "Deliverables live", value: `${totals.linked}/${totals.deliverables}`, icon: Link2, cls: "text-sky-700" },
                { label: "Pages verified", value: `${totals.verified}/${items.length}`, icon: ShieldCheck, cls: "text-emerald-700" },
                { label: "Pages paid", value: `${totals.paidCount}/${items.length}`, icon: Wallet, cls: "text-violet-700" },
                ...(isAdmin ? [
                  { label: "Paid out", value: rupees(totals.paidAmount), icon: CheckCircle2, cls: "text-violet-700" },
                  { label: "Verified, awaiting payout", value: rupees(totals.owed), icon: AlertTriangle, cls: totals.owed ? "text-amber-700" : "text-slate-400" },
                ] : []),
              ].map(t => (
                <div key={t.label} className="bg-white rounded-xl p-3 border border-slate-200">
                  <p className="text-xs text-slate-500 flex items-center gap-1.5"><t.icon className="w-3.5 h-3.5" />{t.label}</p>
                  <p className={`text-lg font-bold mt-0.5 ${t.cls}`}>{t.value}</p>
                </div>
              ))}
            </div>

            {plan.summary && Object.keys(plan.summary).filter(k => !k.startsWith("_")).length > 0 && (
              <div className="flex flex-wrap items-center gap-2">
                <FileSpreadsheet className="w-3.5 h-3.5 text-slate-400" />
                <span className="text-xs text-slate-400">{plan.source_file_name}</span>
                {Object.entries(plan.summary).filter(([k]) => !k.startsWith("_")).map(([k, v]) => (
                  <span key={k} className="text-xs px-2.5 py-1 rounded-full bg-violet-50 text-violet-700 border border-violet-100">
                    {k}: <span className="font-semibold">{String(v)}</span>
                  </span>
                ))}
              </div>
            )}

            {/* Filters */}
            <div className="flex items-center gap-2 flex-wrap">
              <div className="flex gap-1 p-1 bg-white border border-slate-200 rounded-lg overflow-x-auto">
                {STAGES.map(s => (
                  <button key={s.key} onClick={() => setStage(s.key)}
                    className={`px-3 py-1 rounded-md text-xs font-medium whitespace-nowrap transition-colors ${stage === s.key ? "bg-emerald-600 text-white" : "text-slate-600 hover:bg-slate-100"}`}>
                    {s.label} <span className="opacity-70">{totals.byStage[s.key]}</span>
                  </button>
                ))}
              </div>
              <select value={category} onChange={e => setCategory(e.target.value)}
                className="px-3 py-1.5 border border-slate-200 rounded-lg text-xs bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500">
                <option value="">All categories</option>
                {categories.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
              <div className="relative">
                <Search className="absolute left-2.5 top-2 w-3.5 h-3.5 text-slate-400" />
                <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search pages…"
                  className="pl-8 pr-3 py-1.5 border border-slate-200 rounded-lg text-xs bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500 w-44" />
              </div>
              <button onClick={() => fetchStats("refresh")} disabled={fetching}
                title="Fetch new numbers for every link on this plan"
                className="sm:ml-auto inline-flex items-center gap-1.5 px-3 py-1.5 border border-slate-200 rounded-lg text-xs font-medium text-slate-700 bg-white hover:bg-slate-50 disabled:opacity-60 focus:outline-none focus:ring-2 focus:ring-emerald-500">
                <RefreshCw className={`w-3.5 h-3.5 ${fetching ? "animate-spin" : ""}`} />
                Refresh
              </button>
              {flagged.length > 0 && (
                <button onClick={() => fetchStats("refresh", flagged)} disabled={fetching}
                  title="Fetch only the links that failed or need a look"
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 border border-amber-200 rounded-lg text-xs font-medium text-amber-800 bg-amber-50 hover:bg-amber-100 disabled:opacity-60 focus:outline-none focus:ring-2 focus:ring-amber-400">
                  <RotateCcw className="w-3.5 h-3.5" />
                  Retry {flagged.length} flagged
                </button>
              )}
              <button onClick={exportExcel} disabled={exporting}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 border border-slate-200 rounded-lg text-xs font-medium text-slate-700 bg-white hover:bg-slate-50 disabled:opacity-60 focus:outline-none focus:ring-2 focus:ring-emerald-500">
                {exporting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
                Export Excel
              </button>
              <button onClick={saveToDrive} disabled={savingToDrive}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 border border-slate-200 rounded-lg text-xs font-medium text-slate-700 bg-white hover:bg-slate-50 disabled:opacity-60 focus:outline-none focus:ring-2 focus:ring-emerald-500">
                {savingToDrive ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CloudUpload className="w-3.5 h-3.5" />}
                Save to Drive
              </button>
            </div>

            {status && (
              <p role="status" className={`text-xs ${status.isError ? "text-rose-700" : "text-slate-500"}`}>{status.text}</p>
            )}

            {schedule?.stale && (
              <div className="flex items-start gap-2 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                {schedule.lastRunAt ? `The scheduled refresh last ran ${fetchedLabel(schedule.lastRunAt)?.replace("Fetched ", "")}, so second fetches may be late. Check the cron job.` : "The scheduled refresh hasn't run yet, so second fetches won't happen until the cron job is set up."}
              </div>
            )}

            {error && (
              <div className="flex items-start gap-2 text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">
                <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" /> {error}
              </div>
            )}

            {/* What each missing-stat icon means. Hovering a cell gives the exact reason. */}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500">
              {(Object.keys(MISSING_ICON) as MissingKind[]).map(k => {
                const { Icon, className, label } = MISSING_ICON[k];
                return <span key={k} className="inline-flex items-center gap-1"><Icon className={`w-3.5 h-3.5 ${className}`} aria-hidden="true" />{label}</span>;
              })}
              <span className="inline-flex items-center gap-1"><span className="text-slate-400">—</span>No live link yet</span>
            </div>

            {/* Table */}
            <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-100 bg-slate-50/60 text-[11px] uppercase tracking-wide text-slate-500">
                      <th className="text-left px-4 py-2.5 font-semibold w-10">#</th>
                      <th className="text-left px-3 py-2.5 font-semibold">Page / Creator</th>
                      <th className="text-right px-3 py-2.5 font-semibold">Followers</th>
                      <th className="text-center px-3 py-2.5 font-semibold">Deliv.</th>
                      <th className="text-right px-3 py-2.5 font-semibold">Payout</th>
                      <th className="text-left px-3 py-2.5 font-semibold min-w-[260px]">Live Links</th>
                      {STATS.map(s => <th key={s.key} className="text-right px-3 py-2.5 font-semibold">{s.label}</th>)}
                      <th className="text-center px-3 py-2.5 font-semibold">Verified</th>
                      <th className="text-center px-4 py-2.5 font-semibold">Paid</th>
                    </tr>
                  </thead>
                  {grouped.length === 0 ? (
                    <tbody><tr><td colSpan={14} className="text-center py-12 text-sm text-slate-400">Nothing matches these filters.</td></tr></tbody>
                  ) : grouped.map(g => (
                    <tbody key={g.category} className="divide-y divide-slate-50">
                      <tr className="bg-slate-50">
                        <td colSpan={14} className="px-4 py-1.5 text-xs font-semibold text-slate-600">
                          {g.category} <span className="font-normal text-slate-400">· {g.rows.length}</span>
                        </td>
                      </tr>
                      {g.rows.map(item => {
                        serial++;
                        const locked = item.verified && !isAdmin;
                        const links = Array.from({ length: item.quantity }, (_, k) => item.live_links?.[k] || "");
                        return (
                          <tr key={item.id} className={`align-top ${item.paid ? "bg-violet-50/30" : item.verified ? "bg-emerald-50/30" : ""}`}>
                            <td className="px-4 py-3 text-xs text-slate-400 tabular-nums">{serial}</td>
                            <td className="px-3 py-3">
                              <p className="font-medium text-slate-900">{item.handle_name}</p>
                              <p className="text-[11px] text-slate-400 capitalize flex items-center gap-1">
                                {item.platform || "—"}
                                {item.page_link && (
                                  <a href={item.page_link} target="_blank" rel="noopener noreferrer"
                                    className="text-sky-600 hover:text-sky-700 inline-flex items-center gap-0.5 normal-case">
                                    · profile <ExternalLink className="w-2.5 h-2.5" />
                                  </a>
                                )}
                              </p>
                            </td>
                            <td className="px-3 py-3 text-right text-slate-600 tabular-nums">{compact(item.followers)}</td>
                            <td className="px-3 py-3 text-center">
                              <span className={`text-xs font-semibold tabular-nums ${complete(item) ? "text-emerald-700" : "text-slate-500"}`}>
                                {Math.min(filled(item), item.quantity)}/{item.quantity}
                              </span>
                            </td>
                            <td className="px-3 py-3 text-right">
                              {isAdmin && !item.paid ? (
                                <input key={`${item.id}-${item.total_cost ?? ""}`} defaultValue={item.total_cost ?? ""}
                                  onBlur={e => setCost(item, e.target.value)}
                                  onKeyDown={e => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                                  inputMode="decimal" placeholder="₹ amount"
                                  className="w-24 px-2 py-1 text-right text-xs border border-slate-200 rounded-md focus:outline-none focus:ring-2 focus:ring-violet-400 tabular-nums" />
                              ) : (
                                <span className="text-xs font-medium text-slate-700 tabular-nums">{rupees(item.total_cost)}</span>
                              )}
                            </td>
                            <td className="px-3 py-3">
                              <div className="space-y-1.5">
                                {links.map((l, k) => (
                                  <div key={k} className="flex items-center gap-1.5">
                                    {item.quantity > 1 && <span className="text-[10px] text-slate-400 w-3 tabular-nums">{k + 1}</span>}
                                    {locked ? (
                                      l ? (
                                        <a href={l} target="_blank" rel="noopener noreferrer"
                                          className="flex-1 min-w-0 text-xs text-sky-600 hover:underline truncate inline-flex items-center gap-1">
                                          <Lock className="w-3 h-3 text-slate-300 shrink-0" />
                                          {l.replace(/^https?:\/\/(www\.)?/, "")}
                                        </a>
                                      ) : <span className="text-xs text-slate-300">—</span>
                                    ) : (
                                      <>
                                        <input key={`${item.id}-${k}-${l}`} defaultValue={l}
                                          onBlur={e => setLink(item, k, e.target.value)}
                                          onKeyDown={e => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                                          placeholder="Paste live post link"
                                          className="flex-1 min-w-0 px-2 py-1 text-xs border border-slate-200 rounded-md focus:outline-none focus:ring-2 focus:ring-emerald-400" />
                                        {l && (
                                          <a href={l} target="_blank" rel="noopener noreferrer" title="Open link"
                                            className="text-slate-400 hover:text-sky-600 shrink-0">
                                            <ExternalLink className="w-3.5 h-3.5" />
                                          </a>
                                        )}
                                      </>
                                    )}
                                  </div>
                                ))}
                                {currentLinks(item).filter(l => stats[l]?.error || stats[l]?.warning).map(l => (
                                  <p key={l} className={`text-[11px] leading-snug ${stats[l]?.unusable ? "text-slate-400" : "text-amber-700 whitespace-nowrap"}`}>{stats[l]?.error || stats[l]?.warning}</p>
                                ))}
                              </div>
                            </td>
                            {STATS.map(s => {
                              const row = { ...item, metrics: stats };
                              const stat = rowStat(row, s.key);
                              const loadingCell = stat.value === null && currentLinks(item).some(l => pending.has(l));
                              return (
                                <td key={s.key} title={[stat.reason, stat.value !== null ? fetchedLabel(rowFetchedAt(row)) : undefined].filter(Boolean).join(". ") || undefined} className="px-3 py-3 text-right text-slate-600 tabular-nums">
                                  {loadingCell
                                    ? <span className="inline-block w-8 h-3 rounded bg-slate-200 animate-pulse" />
                                    : stat.value === null && stat.kind
                                      ? <MissingStat kind={stat.kind} />
                                      : <span className={stat.partial ? "underline decoration-dotted underline-offset-2 cursor-help" : ""}>{formatStat(stat.value)}</span>}
                                </td>
                              );
                            })}
                            <td className="px-3 py-3 text-center">
                              <button onClick={() => toggleVerified(item)}
                                disabled={!canVerify || item.paid || busy === item.id}
                                title={!canVerify ? "You can see verification but not change it" : item.paid ? "Paid rows stay verified" : item.verified ? "Un-verify" : "Verify"}
                                className="inline-flex disabled:cursor-not-allowed">
                                {item.verified
                                  ? <ShieldCheck className={`w-5 h-5 ${canVerify && !item.paid ? "text-emerald-600" : "text-emerald-400"}`} />
                                  : <Circle className={`w-5 h-5 ${canVerify ? (complete(item) ? "text-slate-400 hover:text-emerald-500" : "text-slate-200") : "text-slate-200"}`} />}
                              </button>
                            </td>
                            <td className="px-4 py-3 text-center">
                              <button onClick={() => togglePaid(item)}
                                disabled={!isAdmin || !item.verified || busy === item.id}
                                title={!isAdmin ? "Only admins mark payouts" : !item.verified ? "Verify first" : item.paid ? "Mark unpaid" : "Mark paid"}
                                className="inline-flex disabled:cursor-not-allowed">
                                {item.paid
                                  ? <CheckCircle2 className={`w-5 h-5 ${isAdmin ? "text-violet-600" : "text-violet-400"}`} />
                                  : <Circle className={`w-5 h-5 ${isAdmin && item.verified ? "text-slate-400 hover:text-violet-500" : "text-slate-200"}`} />}
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  ))}
                </table>
              </div>
              <p className="px-4 py-2.5 text-[11px] text-slate-400 border-t border-slate-100">
                Every deliverable needs its own live link before a page can be verified. Verified links lock; paid rows stay verified.
                {!canVerify && " You can add links — verification is done by someone with Verify access."}
                {!isAdmin && " Payouts are marked by admins."}
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
