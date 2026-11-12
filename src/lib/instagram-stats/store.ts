// Saved numbers for each post. Everything goes through StatsStore. Server only: uses the service key, and holds scraper details users must not see.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Report } from './types';

export type FetchKind = 'first' | 'auto' | 'manual';
export interface FetchEntry {
  at: string;
  kind: FetchKind;
  complete: boolean;
  numbers: Record<string, number | null>;
  sources: string[]; // Which sources answered.
  held?: boolean; // The numbers looked wrong, so they weren't shown or saved as the answer.
}

export interface LinkRecord {
  key: string; // The post's ID, so /p/CODE and /reel/CODE are one record.
  url: string;
  aliases: string[]; // Every form of this link as written on a plan row.
  attachedAt: string; // The first time this link came in. Never changes.
  report: Report | null; // The best answer so far. null until one with a number arrives.
  complete: boolean; // false means report has a gap from a failed source.
  lastFetchedAt: string | null; // When report arrived.
  autoFetches: number; // Completed automatic fetches. A person's Refresh isn't one, unless it's the link's first good answer.
  startedAt: string | null; // A paid fetch began and hasn't ended. If this survives a crash, the next open won't pay again straight away.
  claimedUntil: string | null; // Nobody else may fetch this link until then.
  claimToken: string | null; // Only the holder may save an answer.
  lastFailedAt: string | null; // The latest fetch that didn't complete. Cleared by a complete one.
  lastError: string | null;
  failCount: number; // Failures in a row.
  gaveUp: boolean; // No automatic try will pay for this link again. Only Refresh will.
  retryAfter: string | null; // The wait before the next automatic try.
  heldCount: number; // Replies in a row that weren't believed.
  suspect: Record<string, number | null> | null; // Numbers that changed sharply and aren't believed yet.
  history: FetchEntry[]; // Every saved fetch, so a number shown to a client can be traced back.
}

export interface NewLink { key: string; url: string; alias: string }
const URL_BUDGET = 6000; // Characters of values per read, well under the 16 KB URL limit.
const MAX_ALIAS_LENGTH = 2048;

export interface RunSummary { claimed: number; saved: number; failed: number; held: number; unfinished: number; backupLinks: number; sources: Record<string, number>; stopped: string | null }
export interface LastRun { startedAt: string; finishedAt: string | null; stopped: string | null }
export interface RefreshTicket { allowed: boolean; at: string | null; retrySeconds: number }

/** Async throughout, and every state change is one atomic database call, because the app can run more than one process. */
export interface StatsStore {
  /** Records links the first time they're seen, and returns their records either way. */
  attach(links: NewLink[]): Promise<LinkRecord[]>;
  /** Saved records for these post IDs and these written forms of a link. Never creates one, so reading costs nothing and schedules nothing. */
  find(keys: string[], aliases: string[]): Promise<LinkRecord[]>;
  /** Takes the link for one fetch, or null if someone else holds it. */
  claim(key: string, ttlSeconds: number): Promise<LinkRecord | null>;
  /** Takes the links due for an automatic fetch. */
  claimDue(limit: number, ttlSeconds: number): Promise<LinkRecord[]>;
  /** The fetch ended without being paid for, so nothing should wait because of it. */
  release(key: string, token: string): Promise<void>;
  /** Replaces the saved answer. Says false if the claim was lost. */
  saveFetch(key: string, token: string, report: Report, kind: FetchKind, complete: boolean): Promise<boolean>;
  /** Notes a fetch that didn't complete. Saved numbers stay. */
  saveFailure(key: string, token: string, message: string, opts: { giveUp?: boolean; waitSeconds?: number; baseSeconds: number }): Promise<boolean>;
  /** Notes numbers that changed sharply. Saved numbers stay, and it counts as an attempt. */
  saveSuspect(key: string, token: string, numbers: Record<string, number | null>, kind: FetchKind, opts: { baseSeconds: number; message: string }): Promise<boolean>;
  /** Adds to today's estimated spend, unless that would pass the limit. */
  reserveSpend(usd: number, limitUsd: number): Promise<boolean>;
  /** Notes that this Refresh pays for this link. False if it already did, so a resent Refresh can't pay twice. */
  markRefreshed(refreshId: string, key: string): Promise<boolean>;
  /** Uses up one paid fetch started by attaching links, or false if this user's hourly limit is used up. */
  takeAttachFetch(userId: string, limit: number, windowSeconds: number): Promise<boolean>;
  /** Uses up one Refresh. Sending the same id again resumes it without using another. */
  takeRefresh(id: string, userId: string, planId: string, limit: number, windowSeconds: number, resumeSeconds: number): Promise<RefreshTicket>;
  startRun(): Promise<number>;
  finishRun(id: number, summary: RunSummary): Promise<void>;
  lastRun(): Promise<LastRun | null>;
  hasLinks(): Promise<boolean>;
  /** Says whether this alert may go out now, and if so marks it sent. */
  alertDue(kind: string, everySeconds: number): Promise<boolean>;
}

const HISTORY_LIMIT = 100;
export const MAX_HOLDS = 3; // Replies in a row not believed before only a person can try again.
export const MAX_FAILURES = 5; // Failures in a row before only a person can try again.
const RUNS_KEPT_DAYS = 90;

export const numbersOf = (report: Report) => Object.fromEntries(Object.entries(report.metrics).map(([m, c]) => [m, c.value]));

interface Row {
  key: string; url: string; aliases: string[]; attached_at: string; report: Report | null; complete: boolean; last_fetched_at: string | null;
  auto_fetches: number; started_at: string | null; claimed_until: string | null; claim_token: string | null; last_failed_at: string | null;
  last_error: string | null; fail_count: number; gave_up: boolean; retry_after: string | null; held_count: number;
  suspect: Record<string, number | null> | null; history: FetchEntry[];
}

const toRecord = (r: Row): LinkRecord => ({
  key: r.key, url: r.url, aliases: r.aliases ?? [], attachedAt: r.attached_at, report: r.report, complete: r.complete, lastFetchedAt: r.last_fetched_at,
  autoFetches: r.auto_fetches, startedAt: r.started_at, claimedUntil: r.claimed_until, claimToken: r.claim_token, lastFailedAt: r.last_failed_at,
  lastError: r.last_error, failCount: r.fail_count, gaveUp: r.gave_up, retryAfter: r.retry_after, heldCount: r.held_count, suspect: r.suspect, history: r.history ?? [],
});

export function createSupabaseStore(db: SupabaseClient): StatsStore {
  const call = async <T>(fn: string, args: Record<string, unknown>): Promise<T> => {
    const { data, error } = await db.rpc(fn, args);
    if (error) throw new Error(`${fn}: ${error.message}`);
    return data as T;
  };
  const entry = (kind: FetchKind, complete: boolean, numbers: Record<string, number | null>, sources: string[], held?: boolean): FetchEntry => ({
    at: new Date().toISOString(), kind, complete, numbers, sources, ...(held && { held }),
  });

  // overlaps() joins values without quotes, so a link with a comma, brace or quote breaks the filter. Each value is quoted here.
  // Every value goes into the request URL, and servers refuse long URLs (Node's limit is 16 KB), so big plans are read in parts.
  const byUrlSize = (values: string[]) => {
    const parts: string[][] = [];
    let part: string[] = [];
    let size = 0;
    for (const v of values) {
      const cost = encodeURIComponent(v).length + 6;
      if (part.length && size + cost > URL_BUDGET) { parts.push(part); part = []; size = 0; }
      part.push(v);
      size += cost;
    }
    if (part.length) parts.push(part);
    return parts;
  };
  const pgArray = (values: string[]) => `{${values.map((v) => `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(',')}}`;

  return {
    async attach(links) {
      if (!links.length) return [];
      return (await call<Row[]>('instagram_stats_attach', { p_links: links })).map(toRecord);
    },
    async find(keys, aliases) {
      if (!keys.length && !aliases.length) return [];
      const found: Row[] = [];
      for (const part of byUrlSize(keys)) {
        const { data, error } = await db.from('instagram_link_stats').select('*').in('key', part);
        if (error) throw new Error(error.message || `Could not read saved stats (${error.code ?? 'no code'})`);
        found.push(...(data as Row[]));
      }
      // A link longer than any real one can't match a saved form, and would only make the request too long.
      for (const part of byUrlSize(aliases.filter((a) => a.length <= MAX_ALIAS_LENGTH))) {
        const { data, error } = await db.from('instagram_link_stats').select('*').filter('aliases', 'ov', pgArray(part));
        if (error) throw new Error(error.message || `Could not read saved stats (${error.code ?? 'no code'})`);
        for (const row of data as Row[]) if (!found.some((f) => f.key === row.key)) found.push(row);
      }
      return found.map(toRecord);
    },
    async claim(key, ttlSeconds) {
      const rows = await call<Row[]>('instagram_stats_claim', { p_key: key, p_ttl_seconds: ttlSeconds });
      return rows[0] ? toRecord(rows[0]) : null;
    },
    async claimDue(limit, ttlSeconds) {
      return (await call<Row[]>('instagram_stats_claim_due', { p_limit: limit, p_ttl_seconds: ttlSeconds })).map(toRecord);
    },
    async release(key, token) {
      await call('instagram_stats_release', { p_key: key, p_token: token });
    },
    saveFetch(key, token, report, kind, complete) {
      return call<boolean>('instagram_stats_save_fetch', {
        p_key: key, p_token: token, p_report: report, p_kind: kind, p_complete: complete,
        p_entry: entry(kind, complete, numbersOf(report), report.sources.filter((s) => !s.error).map((s) => s.name)), p_history_limit: HISTORY_LIMIT,
      });
    },
    saveFailure(key, token, message, opts) {
      return call<boolean>('instagram_stats_save_failure', {
        p_key: key, p_token: token, p_message: message, p_give_up: opts.giveUp === true, p_base_seconds: opts.baseSeconds, p_wait_seconds: opts.waitSeconds ?? null, p_max_failures: MAX_FAILURES,
      });
    },
    saveSuspect(key, token, numbers, kind, opts) {
      return call<boolean>('instagram_stats_save_suspect', {
        p_key: key, p_token: token, p_numbers: numbers, p_entry: entry(kind, false, numbers, [], true), p_base_seconds: opts.baseSeconds, p_max_holds: MAX_HOLDS, p_message: opts.message, p_history_limit: HISTORY_LIMIT,
      });
    },
    reserveSpend(usd, limitUsd) {
      return call<boolean>('instagram_stats_reserve_spend', { p_usd: usd, p_limit: limitUsd });
    },
    markRefreshed(refreshId, key) {
      return call<boolean>('instagram_stats_mark_refreshed', { p_refresh: refreshId, p_key: key });
    },
    takeAttachFetch(userId, limit, windowSeconds) {
      return call<boolean>('instagram_stats_take_attach_fetch', { p_user: userId, p_limit: limit, p_window_seconds: windowSeconds });
    },
    async takeRefresh(id, userId, planId, limit, windowSeconds, resumeSeconds) {
      const rows = await call<{ allowed: boolean; at: string | null; retry_seconds: number }[]>('instagram_stats_take_refresh', {
        p_id: id, p_user: userId, p_plan: planId, p_limit: limit, p_window_seconds: windowSeconds, p_resume_seconds: resumeSeconds,
      });
      return { allowed: rows[0].allowed, at: rows[0].at, retrySeconds: rows[0].retry_seconds };
    },
    async startRun() {
      const { data, error } = await db.from('instagram_stats_runs').insert({}).select('id').single();
      if (error) throw new Error(error.message);
      return (data as { id: number }).id;
    },
    async finishRun(id, s) {
      const { error } = await db.from('instagram_stats_runs').update({
        finished_at: new Date().toISOString(), claimed: s.claimed, saved: s.saved, failed: s.failed, held: s.held, unfinished: s.unfinished, backup_links: s.backupLinks, sources: s.sources, stopped: s.stopped,
      }).eq('id', id);
      if (error) throw new Error(error.message);
      await db.from('instagram_stats_runs').delete().lt('started_at', new Date(Date.now() - RUNS_KEPT_DAYS * 86_400_000).toISOString());
    },
    async lastRun() {
      const { data, error } = await db.from('instagram_stats_runs').select('started_at, finished_at, stopped').not('finished_at', 'is', null).order('started_at', { ascending: false }).limit(1);
      if (error) throw new Error(error.message);
      const row = (data as { started_at: string; finished_at: string | null; stopped: string | null }[])[0];
      return row ? { startedAt: row.started_at, finishedAt: row.finished_at, stopped: row.stopped } : null;
    },
    async hasLinks() {
      const { data, error } = await db.from('instagram_link_stats').select('key').limit(1);
      if (error) throw new Error(error.message);
      return (data as unknown[]).length > 0;
    },
    alertDue(kind, everySeconds) {
      return call<boolean>('instagram_stats_alert_due', { p_kind: kind, p_every_seconds: everySeconds });
    },
  };
}
