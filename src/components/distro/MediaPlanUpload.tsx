"use client";

import { useState, useRef } from "react";
import { createClient } from "@/lib/supabase";
import { fetchPlanStats } from "@/lib/live-plan-stats-client";
import { FileSpreadsheet, Upload, Loader2, X, Check, AlertTriangle, Copy } from "lucide-react";
import {
  FIELDS, readWorkbook, autoMap, buildItems, norm, parseAmount,
  type FieldKey, type ParsedWorkbook,
} from "@/lib/media-plan-parser";

const supabase = createClient();

interface Props {
  /** Saves the brief if it is not saved yet and returns its id */
  ensureBrief: () => Promise<string | null>;
  onSaved?: (count: number) => void;
}

export default function MediaPlanUpload({ ensureBrief, onSaved }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [fileName, setFileName] = useState("");
  const [wb, setWb] = useState<ParsedWorkbook | null>(null);
  const [mapping, setMapping] = useState<Partial<Record<FieldKey, string>>>({});
  const [included, setIncluded] = useState<Set<string>>(new Set());
  // The same page listed under two tabs would otherwise be booked — and paid — twice
  const [skipDuplicates, setSkipDuplicates] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  function reset() {
    setFileName(""); setWb(null); setMapping({}); setIncluded(new Set()); setError("");
    setSkipDuplicates(true);
    if (fileRef.current) fileRef.current.value = "";
  }

  async function onFile(file: File) {
    setError("");
    try {
      const parsed = readWorkbook(await file.arrayBuffer());
      const itemTabs = parsed.sheets.filter(s => s.isItems);
      if (itemTabs.length === 0) {
        setError("Couldn't find a tab with a page / creator name column.");
        return;
      }
      setFileName(file.name);
      setWb(parsed);
      setMapping(autoMap(parsed.headerUnion));
      setIncluded(new Set(itemTabs.map(s => s.name)));
      setOpen(true);
    } catch (e) {
      setError(`Couldn't read that file: ${(e as Error).message}`);
    }
  }

  const all = wb ? buildItems(wb, mapping, included) : [];
  const duplicates = all.filter(i => i.duplicateOf !== undefined);
  const items = skipDuplicates ? all.filter(i => i.duplicateOf === undefined) : all;
  const totalCost = items.reduce((s, i) => s + (i.total_cost || 0), 0);
  const deliverables = items.reduce((s, i) => s + i.quantity, 0);
  const pages = new Set(items.map(i => (i.page_link || i.handle_name).toLowerCase())).size;
  const hasCosts = items.some(i => i.total_cost !== undefined);

  // Compare against what the overview tab claims, so a mismatch is caught here
  // rather than after the plan has gone to the client
  const summary = wb?.summary || {};
  const claimed = (re: RegExp) => {
    const k = Object.keys(summary).find(x => re.test(x));
    return k ? parseAmount(summary[k]) : undefined;
  };
  const claimedPages = claimed(/total\s*(no\.?\s*of\s*)?pages|no\.?\s*of\s*total\s*pages/i);
  const claimedDeliverables = claimed(/deliverables/i);
  const mismatch = (claimedPages !== undefined && claimedPages !== pages)
    || (claimedDeliverables !== undefined && claimedDeliverables !== deliverables);

  async function save() {
    if (items.length === 0) { setError("No line items found — check the Page / Creator column mapping."); return; }
    setSaving(true); setError("");

    const briefId = await ensureBrief();
    if (!briefId) { setSaving(false); setError("Save the brief first (it needs at least a brand name)."); return; }

    // Replacing an uploaded plan would wipe live links and payout status, so
    // refuse once any of that work exists.
    const { data: prior } = await supabase.from("media_plans")
      .select("id, media_plan_items(id, live_links, verified, paid)")
      .eq("brief_id", briefId).eq("source", "upload");
    const priorItems = (prior || []).flatMap(p =>
      (p.media_plan_items || []) as { live_links?: string[]; verified?: boolean; paid?: boolean }[]);
    if (priorItems.some(i => i.verified || i.paid)) {
      setSaving(false);
      setError("This brief already has a plan with verified or paid line items, so it can't be replaced. Update those rows in Live Media Plans instead.");
      return;
    }
    if (priorItems.some(i => Array.isArray(i.live_links) && i.live_links.some(Boolean)) &&
        !confirm("The existing uploaded plan has live links filled in. Replacing it will remove them. Continue?")) {
      setSaving(false);
      return;
    }
    if ((prior || []).length) {
      await supabase.from("media_plans").delete().in("id", (prior || []).map(p => p.id));
    }

    const { data: plan, error: planErr } = await supabase.from("media_plans").insert({
      brief_id: briefId,
      total_budget: totalCost || null,
      allocated_budget: totalCost || null,
      source: "upload",
      source_file_name: fileName,
      summary: {
        ...summary,
        _imported: { pages, deliverables, line_items: items.length, tabs: [...included] },
      },
      plan_notes: `Uploaded from ${fileName}`,
    }).select("id").single();
    if (planErr || !plan) {
      setSaving(false);
      setError(`Couldn't save the plan: ${planErr?.message || "unknown error"}`);
      return;
    }

    const rows = items.map(i => ({
      plan_id: plan.id,
      handle_name: i.handle_name,
      page_link: i.page_link || null,
      platform: i.platform || null,
      category: i.category || null,
      followers: i.followers !== undefined ? Math.round(i.followers) : null,
      deliverable_type: i.deliverable_type || null,
      quantity: i.quantity,
      rate: i.rate ?? null,
      total_cost: i.total_cost ?? null,
      deliverable_date: i.deliverable_date || null,
      live_links: i.live_link ? [i.live_link] : [],
      notes: i.notes || null,
    }));
    const { error: itemErr } = await supabase.from("media_plan_items").insert(rows);
    setSaving(false);
    if (itemErr) {
      await supabase.from("media_plans").delete().eq("id", plan.id);
      setError(`Couldn't save line items: ${itemErr.message}`);
      return;
    }
    // A link's first fetch happens when it's attached. The numbers are saved on the server, so nothing here waits for them.
    if (rows.some(r => r.live_links.length)) {
      fetchPlanStats({ planId: plan.id, mode: "attach", onLine: () => {} }).catch(err => console.error("Stats fetch after upload failed:", err));
    }
    onSaved?.(items.length);
    setOpen(false);
    reset();
  }

  const fmtNum = (n?: number) => n === undefined ? "—" : n.toLocaleString("en-IN");

  return (
    <>
      <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" className="hidden"
        onChange={e => { const f = e.target.files?.[0]; if (f) onFile(f); }} />
      <button type="button" onClick={() => fileRef.current?.click()}
        className="flex items-center gap-2 px-5 py-2.5 bg-emerald-600 text-white rounded-xl font-medium text-sm hover:bg-emerald-700 transition-colors">
        <Upload className="w-4 h-4" /> Upload Media Plan
      </button>
      {error && !open && <p className="w-full text-xs text-rose-600">{error}</p>}

      {open && wb && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-2 sm:p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-6xl max-h-[94vh] flex flex-col">
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
              <div className="flex items-center gap-2 min-w-0">
                <FileSpreadsheet className="w-4 h-4 text-emerald-600 shrink-0" />
                <h3 className="font-semibold text-slate-900 truncate">Import media plan · {fileName}</h3>
              </div>
              <button onClick={() => { setOpen(false); reset(); }} aria-label="Close"><X className="w-4 h-4 text-slate-400" /></button>
            </div>

            <div className="overflow-y-auto">
              {/* Summary + checks */}
              <div className="px-5 py-4 grid grid-cols-2 sm:grid-cols-4 gap-3 border-b border-slate-100">
                {[
                  { label: "Pages", value: fmtNum(pages), claim: claimedPages },
                  { label: "Deliverables", value: fmtNum(deliverables), claim: claimedDeliverables },
                  { label: "Line items", value: fmtNum(items.length) },
                  { label: "Total cost", value: hasCosts ? `₹${Math.round(totalCost).toLocaleString("en-IN")}` : "Not in file" },
                ].map(t => (
                  <div key={t.label} className="bg-slate-50 rounded-xl p-3 border border-slate-100">
                    <p className="text-xs text-slate-500">{t.label}</p>
                    <p className="text-lg font-bold text-slate-900 mt-0.5">{t.value}</p>
                    {t.claim !== undefined && (
                      <p className={`text-[11px] mt-0.5 ${String(t.claim) === t.value.replace(/,/g, "") ? "text-emerald-600" : "text-amber-600"}`}>
                        overview says {t.claim}
                      </p>
                    )}
                  </div>
                ))}
              </div>

              {Object.keys(summary).length > 0 && (
                <div className="px-5 py-3 border-b border-slate-100 flex flex-wrap gap-2">
                  {Object.entries(summary).map(([k, v]) => (
                    <span key={k} className="text-xs px-2.5 py-1 rounded-full bg-violet-50 text-violet-700 border border-violet-100">
                      {k}: <span className="font-semibold">{v}</span>
                    </span>
                  ))}
                </div>
              )}

              <div className="px-5 py-3 space-y-2 border-b border-slate-100">
                {mismatch && (
                  <p className="flex items-start gap-2 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                    <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                    The overview tab&apos;s totals don&apos;t match the pages in the category tabs. Worth fixing in the plan before it goes to the client.
                  </p>
                )}
                {duplicates.length > 0 && (
                  <label className="flex items-start gap-2 text-xs text-slate-700 bg-sky-50 border border-sky-200 rounded-lg px-3 py-2 cursor-pointer">
                    <input type="checkbox" checked={skipDuplicates} onChange={e => setSkipDuplicates(e.target.checked)} className="mt-0.5" />
                    <span>
                      <Copy className="w-3.5 h-3.5 inline mr-1 text-sky-600" />
                      <span className="font-semibold">{duplicates.length} page{duplicates.length === 1 ? " appears" : "s appear"} in more than one tab</span>
                      {" "}({[...new Set(duplicates.map(d => d.sheet))].join(", ")}). Keep only the first listing so nobody is booked or paid twice.
                    </span>
                  </label>
                )}
                {!hasCosts && (
                  <p className="text-xs text-slate-500">
                    No cost column found — that&apos;s normal for an indicative plan. Admins can enter each page&apos;s payout in Live Media Plans before marking it paid.
                  </p>
                )}
              </div>

              {/* Tabs */}
              <div className="px-5 py-3 border-b border-slate-100">
                <p className="text-xs font-medium text-slate-600 mb-2">Tabs to import — each tab becomes the category for its pages</p>
                <div className="flex flex-wrap gap-2">
                  {wb.sheets.map(sh => (
                    <label key={sh.name}
                      className={`flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg border ${sh.isItems ? "cursor-pointer" : "opacity-60"} ${included.has(sh.name) ? "bg-emerald-50 border-emerald-200 text-emerald-800" : "bg-white border-slate-200 text-slate-500"}`}>
                      <input type="checkbox" disabled={!sh.isItems} checked={included.has(sh.name)}
                        onChange={e => setIncluded(prev => {
                          const n = new Set(prev);
                          if (e.target.checked) n.add(sh.name); else n.delete(sh.name);
                          return n;
                        })} />
                      {sh.name}
                      <span className="text-slate-400">{sh.isItems ? `(${sh.rows.filter(r => r.some(c => String(c ?? "").trim())).length})` : "summary"}</span>
                    </label>
                  ))}
                </div>
              </div>

              {/* Mapping */}
              <div className="px-5 py-3 border-b border-slate-100 bg-slate-50/60">
                <p className="text-xs font-medium text-slate-600 mb-2">
                  Column mapping — detected automatically and applied to every tab. Correct anything that&apos;s wrong.
                </p>
                <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-2">
                  {FIELDS.map(f => (
                    <label key={f.key} className="block">
                      <span className="block text-[11px] text-slate-500 mb-0.5">
                        {f.label}{"required" in f && f.required && <span className="text-rose-500"> *</span>}
                      </span>
                      <select value={mapping[f.key] ?? ""}
                        onChange={e => setMapping(m => ({ ...m, [f.key]: e.target.value || undefined }))}
                        className="w-full px-2 py-1.5 border border-slate-200 rounded-lg text-xs bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500">
                        <option value="">— not in file —</option>
                        {wb.headerUnion.filter(Boolean).map(h => <option key={h} value={norm(h)}>{h}</option>)}
                      </select>
                    </label>
                  ))}
                </div>
              </div>

              {/* Preview */}
              {all.length === 0 ? (
                <div className="flex items-center gap-2 justify-center py-12 text-sm text-amber-700">
                  <AlertTriangle className="w-4 h-4" /> No line items — map the Page / Creator column, or tick a tab.
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs whitespace-nowrap">
                    <thead>
                      <tr className="border-b border-slate-100 bg-white">
                        {["#", "Category", "Page / Creator", "Platform", "Followers", "Deliverables", "Rate", "Total", "Page Link"].map(h => (
                          <th key={h} className="text-left px-3 py-2 font-semibold text-slate-500">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-50">
                      {all.map((it, i) => {
                        const dup = it.duplicateOf !== undefined;
                        const dropped = dup && skipDuplicates;
                        return (
                          <tr key={i} className={dropped ? "opacity-40 line-through" : dup ? "bg-sky-50/60" : ""}>
                            <td className="px-3 py-1.5 text-slate-400 tabular-nums">{i + 1}</td>
                            <td className="px-3 py-1.5 text-slate-600">{it.category}</td>
                            <td className="px-3 py-1.5 font-medium text-slate-900">
                              {it.handle_name}
                              {dup && <span className="ml-1.5 text-[10px] font-semibold text-sky-700 no-underline">duplicate</span>}
                            </td>
                            <td className="px-3 py-1.5 text-slate-600 capitalize">{it.platform || "—"}</td>
                            <td className="px-3 py-1.5 text-slate-600 tabular-nums">{fmtNum(it.followers)}</td>
                            <td className="px-3 py-1.5 text-slate-900 font-semibold tabular-nums">{it.quantity}</td>
                            <td className="px-3 py-1.5 text-slate-600 tabular-nums">{it.rate !== undefined ? `₹${Math.round(it.rate).toLocaleString("en-IN")}` : "—"}</td>
                            <td className="px-3 py-1.5 text-slate-600 tabular-nums">{it.total_cost !== undefined ? `₹${Math.round(it.total_cost).toLocaleString("en-IN")}` : "—"}</td>
                            <td className="px-3 py-1.5 max-w-[220px] truncate">
                              {it.page_link
                                ? <a href={it.page_link} target="_blank" rel="noopener noreferrer" className="text-sky-600 hover:underline">{it.page_link.replace(/^https?:\/\/(www\.)?/, "").split("?")[0]}</a>
                                : <span className="text-slate-300">—</span>}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div className="flex items-center justify-between gap-3 px-5 py-4 border-t border-slate-100 flex-wrap">
              {error ? <p className="text-xs text-rose-600 flex-1">{error}</p> : <span />}
              <div className="flex gap-2">
                <button onClick={() => { setOpen(false); reset(); }} className="px-4 py-2 text-sm text-slate-600 hover:bg-slate-100 rounded-lg">Cancel</button>
                <button onClick={save} disabled={saving || items.length === 0}
                  className="flex items-center gap-2 px-4 py-2 text-sm bg-emerald-600 text-white rounded-lg font-medium hover:bg-emerald-700 disabled:opacity-50">
                  {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                  {saving ? "Saving…" : `Import ${items.length} pages · ${deliverables} deliverables`}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
