// What happens to a link: saved answer or paid fetch, what gets believed, what gets saved, and what a person is told.
// Moved from the scraper's local server. Routes stay thin and call this.
import { createLimiter } from './queue';
import { config } from './config';
import { parseLink } from './links';
import { resolve, scrape } from './scrape';
import { RefusedLink, type Link, type Report } from './types';
import { numbersOf, type FetchKind, type LinkRecord, type RunSummary, type StatsStore } from './store';

const TABLE_METRICS = ['views', 'likes', 'comments', 'shares', 'reposts'];
const AT_ONCE = 125; // 5 Apify runs at once x 25 links each. More would only queue up, and couldn't be called off.
export const MAX_LINKS = 2000;
export const CLAIM_TTL_SECONDS = 600; // Longer than the first source and both backups can take. A crash frees the link after this.
const DAY_MS = 24 * 60 * 60_000;
const DAY_SECONDS = 86_400;

const LIMIT_REACHED = 'Daily limit reached. Try after 5:30 AM';
const NOT_FOUND = 'Post not found. May be private or deleted';
const NO_STORAGE = "Can't save right now. Please retry shortly";
const SERVICE_DOWN = 'Fetching unavailable right now. Please retry later';
const COULD_NOT_READ = "Couldn't fetch right now. Please retry";
const STUCK = 'Numbers keep changing sharply. Please check manually';
const NOT_A_POST = 'Profile link. Add a post or reel link';
const QUEUED = 'Many new links this hour. Numbers will be fetched automatically within a few hours';

/** A link that can never give stats: not Instagram, a Story, a profile. Retrying it can't help. */
export class UnusableLink extends RefusedLink {}
/** Someone else holds this link right now. Asking again shortly finds their answer. */
class StillRunning extends Error {}

export interface StatsLine {
  link: string;
  url?: string;
  key?: string;
  metrics?: Record<string, { value: number | null; note?: string; hidden?: boolean; notShown?: boolean }>;
  done: boolean;
  savedAt?: string;
  warning?: string;
  error?: string;
  unusable?: boolean; // Retrying can't help, so it's never flagged for Retry.
}

const plainError = (report: Report) => (report.budgetStopped ? LIMIT_REACHED : report.notFound ? NOT_FOUND : report.serviceDown ? SERVICE_DOWN : COULD_NOT_READ);
const when = (at?: string | null) => (at ? new Date(at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' }) : 'an earlier fetch');

const VIDEO_TYPES = ['clips', 'reel', 'video', 'igtv'];
const NOT_ON_PHOTOS = ['views', 'shares', 'reposts'];
/** A photo or carousel, known from the reply. Unknown type counts as not a photo, so a real gap is never passed off as normal. */
const isPhotoPost = (report: Report) => report.link.kind === 'post' && !!report.type && !VIDEO_TYPES.includes(report.type.toLowerCase());

/** One link's numbers, in the shape the table reads. Details of what failed go to the log: a person only needs to know what to do. */
function toLine(raw: string, report: Report, done: boolean, key: string | undefined, extra: { savedAt?: string | null; warning?: string } = {}): StatsLine {
  const metrics = Object.fromEntries(TABLE_METRICS.filter((m) => report.metrics[m]).map((m) => {
    const c = report.metrics[m];
    // Instagram doesn't show views, shares or reposts on photos and carousels, so their gap is normal there, not our fault.
    const notShown = c.value === null && !c.hidden && NOT_ON_PHOTOS.includes(m) && isPhotoPost(report);
    // The note then says so too, rather than a source failure that would happen on any photo.
    return [m, { value: c.value, note: notShown ? `Instagram doesn't show ${m} on photos and carousels` : c.note, ...(c.hidden && { hidden: true }), ...(notShown && { notShown: true }) }];
  }));
  const hasNumber = Object.values(metrics).some((m) => m.value !== null);
  return { link: raw, url: report.link.url, key, metrics, done, ...(extra.savedAt && { savedAt: extra.savedAt }), ...(done && extra.warning && { warning: extra.warning }), ...(done && !hasNumber && { error: plainError(report) }) };
}

const SUSPECT_DROP = 0.5; // Views, likes and the rest rarely fall by half, so that's more likely a bad reply than a real change.
const SUSPECT_JUMP = 100; // A hundred times more between fetches is more likely a bad reply than a post going viral.
const SAME_READING = 0.05; // Counts keep moving, so a second reading only has to be close to confirm the first.

/** Metrics that hit 0, fell by more than half, or jumped a hundredfold since the last answer. */
function changedSharply(saved: Report, fresh: Report): string[] {
  return TABLE_METRICS.filter((m) => {
    const before = saved.metrics[m]?.value;
    const now = fresh.metrics[m]?.value;
    return before != null && now != null && before > 0 && (now === 0 || now < before * SUSPECT_DROP || (before >= 10 && now > before * SUSPECT_JUMP));
  });
}

const allZero = (report: Report) => {
  const values = TABLE_METRICS.map((m) => report.metrics[m]?.value).filter((v) => v != null);
  return values.length > 0 && values.every((v) => v === 0);
};

/** A second fetch agreeing with the held one means the change is real. All zeros is never believed: a live post doesn't lose everything. */
function confirmed(suspect: LinkRecord['suspect'], report: Report): boolean {
  if (!suspect || allZero(report)) return false;
  return TABLE_METRICS.every((m) => {
    const held = suspect[m] ?? null;
    const now = report.metrics[m]?.value ?? null;
    if (held === null || now === null) return held === now;
    return Math.abs(now - held) <= Math.max(2, held * SAME_READING);
  });
}

/** Numbers that weren't believed or couldn't be read stay on screen from the last saved answer. */
function withKept(report: Report, record: LinkRecord | undefined, distrusted: string[] = []): Report {
  if (!record?.report) return report;
  const metrics = { ...report.metrics };
  for (const [name, old] of Object.entries(record.report.metrics)) {
    if (old.value != null && (metrics[name]?.value == null || distrusted.includes(name))) metrics[name] = { ...old, note: `From the fetch on ${when(record.lastFetchedAt)}. The latest fetch couldn't confirm it` };
  }
  return { ...report, metrics };
}

/** A link that just failed isn't paid for again each time someone asks. The wait is worked out when the failure is saved. */
function waitingToRetry(record: LinkRecord): string | undefined {
  const since = (at: string | null) => (at ? Date.now() - new Date(at).getTime() : Infinity);
  if (record.gaveUp) return record.lastError ?? 'Last fetch failed. Please retry';
  if (record.lastError === NOT_FOUND && since(record.lastFailedAt) < DAY_MS) return NOT_FOUND;
  if (config.retryFailedMs && since(record.startedAt) < config.retryFailedMs) return "Last fetch didn't finish. Please retry";
  if (config.retryFailedMs && record.retryAfter && Date.now() < new Date(record.retryAfter).getTime()) return record.lastError ?? 'Numbers changed sharply. Please retry';
  return undefined;
}

/** What to tell a person about an answer that isn't fully fresh. */
function warningFor(report: Report, record: LinkRecord | undefined, distrusted: string[]): string | undefined {
  if (distrusted.length) return allZero(report) ? 'Got all zeros. Showing older numbers' : 'Numbers changed sharply. Showing older ones. Please retry';
  if (report.budgetStopped) return record?.report ? 'Daily limit reached. Showing older numbers' : undefined;
  if (report.serviceDown) return record?.report ? 'Fetching unavailable. Showing older numbers. Retry later' : undefined;
  if (report.notFound) return record?.report ? 'Post not found. Showing older numbers' : undefined;
  if (report.warnings.length) return "Sources disagreed, so numbers weren't saved";
  if (report.complete !== true && record?.report) return 'Some numbers missing. Showing older ones. Please retry';
  if (report.complete !== true && Object.values(report.metrics).some((m) => m.value != null)) return 'Some numbers missing. Please retry';
  return undefined;
}

type Outcome = 'saved' | 'failed' | 'held' | 'service' | 'limit';
type Answer = { report: Report; key?: string; savedAt?: string | null; warning?: string; outcome?: Outcome };
type Running = { job: Promise<Answer>; latest?: Report; listeners: Set<(r: Report) => void> };

/** Who is asking, and which limit stops this request paying. A Refresh pays each link at most once; attaching has a per-user hourly cap. */
export type Payer =
  | { refresh: { id: string; since: string } }
  | { attach: { userId: string; limit: number; windowSeconds: number } };

export interface StatsDeps {
  store: StatsStore;
  scrapeFn?: typeof scrape;
  resolveLink?: typeof resolve;
  /** An outage or a pattern a person should hear about. Never throws into a fetch. */
  alert?: (kind: string, text: string) => Promise<void>;
}

export function createStatsService({ store, scrapeFn = scrape, resolveLink = resolve, alert = async () => {} }: StatsDeps) {
  // Within this process, identical requests at the same moment run once. Across processes, the database claim does the same job.
  const running = new Map<string, Running>();
  const limitShareLinks = createLimiter(5);
  const baseSeconds = Math.round(config.retryFailedMs / 1000);

  /** A storage problem after a fetch must never cost someone the numbers they just paid for, so it's logged and the request carries on. */
  async function stored<T>(what: string, call: () => Promise<T>): Promise<T | undefined> {
    try {
      return await call();
    } catch (e) {
      console.error(`Could not ${what}: ${(e as Error).message}`);
      return undefined;
    }
  }

  /** Fetches a link this caller holds the claim for, decides what to believe, and saves it. */
  function fetchClaimed(claimed: LinkRecord, link: Link, manual: boolean, onUpdate?: (r: Report) => void): Promise<Answer> {
    const { key } = claimed;
    const token = claimed.claimToken!;
    const record = claimed;
    const run: Running = { listeners: new Set(onUpdate ? [onUpdate] : []) } as Running;
    let storageDown = false;
    run.job = Promise.resolve()
      .then(() =>
        scrapeFn(link.url, {
          noAccount: true, // Followers come from the plan.
          // Every paid call is counted against the daily limit first. If the count can't be checked, nothing is paid for.
          budget: async (usd: number) => {
            try {
              return await store.reserveSpend(usd, config.dailyLimitUsd);
            } catch (e) {
              console.error(`Could not check the spending limit: ${(e as Error).message}`);
              storageDown = true;
              return false;
            }
          },
          onUpdate: (r: Report) => {
            // Numbers streamed over saved ones could be wrong, and would show before anything checks them. Saved numbers stay until the final answer.
            if (record.report) return;
            run.latest = r;
            run.listeners.forEach((l) => l(r));
          },
        }),
      )
      .then(async (report): Promise<Answer> => {
        if (storageDown) {
          await stored('let go of a link', () => store.release(key, token));
          throw new RefusedLink(NO_STORAGE);
        }
        // Out of money, a bad key or the service being down says nothing about this link, and wasn't charged.
        if (report.serviceDown) {
          await stored('let go of a link', () => store.release(key, token));
          void alert('service', 'Instagram stats could not fetch anything: the scraping service refused or failed. Nothing was charged and no link was marked as failed. Check the key and the account balance.');
          return { report: withKept(report, record), key, savedAt: record.lastFetchedAt, warning: warningFor(report, record, []), outcome: 'service' };
        }
        const hasNumber = Object.values(report.metrics).some((m) => m.value != null);
        // An answer that lost a number we already had isn't complete, whatever kind of post it looks like.
        const lost = record.report ? TABLE_METRICS.filter((m) => record.report!.metrics[m]?.value != null && report.metrics[m]?.value == null && !report.metrics[m]?.hidden) : [];
        const complete = hasNumber && report.complete === true && !lost.length;
        const changed = record.report ? changedSharply(record.report, report) : [];
        const distrusted = changed.length && !confirmed(record.suspect, report) ? changed : [];
        // A link's first good answer is its first automatic fetch, even if a person's Refresh is what got it.
        const kind: FetchKind = !record.autoFetches ? 'first' : manual ? 'manual' : 'auto';
        const shown = complete && !distrusted.length ? report : withKept(report, record, distrusted);
        let outcome: Outcome;
        if (distrusted.length && complete) {
          await stored('note the change', () => store.saveSuspect(key, token, numbersOf(report), kind, { baseSeconds, message: STUCK }));
          outcome = 'held';
        } else if (complete) {
          await stored('save the numbers', () => store.saveFetch(key, token, report, kind, true));
          outcome = 'saved';
        } else if (report.budgetStopped) {
          // Nothing was paid for, so nothing should wait because of it.
          await stored('let go of a link', () => store.release(key, token));
          void alert('daily-limit', `Instagram stats reached the daily spending limit ($${config.dailyLimitUsd}), so fetching has stopped until 5:30 AM IST. Saved numbers still show. If this wasn't expected, check who added links today.`);
          outcome = 'limit';
        } else {
          // A partial answer only fills an empty record, so it can never overwrite good numbers. An answer sources disagree on is never saved.
          if (hasNumber && !record.report && !report.warnings.length) await stored('save the numbers', () => store.saveFetch(key, token, report, kind, false));
          // A post not found gets one more try a day later, in case that answer was wrong.
          const secondNotFound = report.notFound === true && record.lastError === NOT_FOUND;
          await stored('note the failure', () => store.saveFailure(key, token, plainError(report), { giveUp: secondNotFound, baseSeconds, ...(report.notFound && { waitSeconds: DAY_SECONDS }) }));
          outcome = 'failed';
        }
        return {
          report: shown,
          key,
          outcome,
          warning: warningFor({ ...report, complete: complete || report.complete }, record, distrusted) ?? (lost.length ? 'Some numbers missing. Showing older ones. Please retry' : undefined),
        };
      })
      .finally(() => running.delete(key));
    running.set(key, run);
    return run.job;
  }

  /** The post a link points to, without paying for anything. A share link is opened first (free), so it lands on the same record as its post. */
  async function linkOf(raw: string): Promise<Link> {
    let parsed: Link;
    try {
      parsed = parseLink(raw);
    } catch (e) {
      if (e instanceof RefusedLink) throw new UnusableLink(e.message);
      throw e;
    }
    if (parsed.kind === 'profile') throw new UnusableLink(NOT_A_POST);
    if (parsed.kind !== 'share') return parsed;
    let link: Link;
    try {
      link = await limitShareLinks(() => resolveLink(raw));
    } catch (e) {
      if (e instanceof RefusedLink) throw new UnusableLink(e.message);
      throw e;
    }
    if (link.kind === 'profile') throw new UnusableLink(NOT_A_POST);
    return link;
  }

  /** After a claim, whether this request's limit lets it pay. If not, the claim is let go of for free. Fails closed when storage can't say. */
  async function mayPay(claimed: LinkRecord, payer: Payer): Promise<boolean> {
    const allowed = await stored('check the fetch limit', () =>
      'refresh' in payer ? store.markRefreshed(payer.refresh.id, claimed.key) : store.takeAttachFetch(payer.attach.userId, payer.attach.limit, payer.attach.windowSeconds),
    );
    if (allowed) return true;
    await stored('let go of a link', () => store.release(claimed.key, claimed.claimToken!));
    if (allowed === undefined) throw new RefusedLink(NO_STORAGE);
    return false;
  }

  /**
   * Answers one link. A saved complete answer costs nothing.
   * For a Refresh, `since` is when it began: anything saved before it was never refreshed and is paid for, anything saved after it isn't paid for twice.
   */
  async function lookup(raw: string, payer: Payer, onUpdate: (r: Report) => void): Promise<Answer> {
    const since = 'refresh' in payer ? payer.refresh.since : undefined;
    const link = await linkOf(raw);
    // Posts key on the ID alone, because /p/CODE and /reel/CODE are one post.
    const key = link.shortcode ?? link.url;
    const attached = await stored('record a link', () => store.attach([{ key, url: link.url, alias: raw }]));
    // Without storage the numbers couldn't be kept, and every open would pay again.
    if (!attached?.[0]) throw new RefusedLink(NO_STORAGE);
    const record = attached[0];
    const joined = running.get(key);
    if (joined) {
      if (joined.latest) onUpdate(joined.latest); // Someone joining late still sees the numbers so far.
      joined.listeners.add(onUpdate);
      return joined.job;
    }
    const before = (at: string | null) => !at || !since || new Date(at).getTime() < new Date(since).getTime();
    const pay = !!since && before(record.lastFetchedAt) && before(record.lastFailedAt) && before(record.startedAt);
    if (!pay && record.report && record.complete) return { report: record.report, key, savedAt: record.lastFetchedAt };
    const waiting = pay ? undefined : waitingToRetry(record);
    if (waiting) {
      if (record.report) return { report: record.report, key, savedAt: record.lastFetchedAt, warning: waiting };
      throw new RefusedLink(waiting);
    }
    const claimed = await stored('claim a link', () => store.claim(key, CLAIM_TTL_SECONDS));
    if (claimed === undefined) throw new RefusedLink(NO_STORAGE);
    if (claimed === null) throw new StillRunning();
    if (!(await mayPay(claimed, payer))) {
      // A resent Refresh that already paid for this link, or over the attach limit. Attached links are picked up by the scheduled job.
      const reason = since ? (waitingToRetry(record) ?? record.lastError ?? COULD_NOT_READ) : QUEUED;
      if (record.report) return { report: record.report, key, savedAt: record.lastFetchedAt, warning: reason };
      throw new RefusedLink(reason);
    }
    return fetchClaimed(claimed, link, !!since, onUpdate);
  }

  /** What's already saved for these links. It never pays, never creates a record, and never schedules anything. */
  async function readSaved(raws: string[]): Promise<StatsLine[]> {
    const parsed = raws.map((raw) => {
      try {
        const link = parseLink(raw);
        return link.kind === 'profile' ? { raw, unusable: NOT_A_POST } : { raw, link };
      } catch (e) {
        return { raw, unusable: e instanceof RefusedLink ? e.message : COULD_NOT_READ };
      }
    });
    const keys = parsed.flatMap((p) => (p.link?.shortcode ? [p.link.shortcode] : []));
    const shares = parsed.filter((p) => p.link?.kind === 'share').map((p) => p.raw);
    const records = await store.find(keys, shares);
    return parsed.map((p): StatsLine => {
      if (p.unusable) return { link: p.raw, done: true, error: p.unusable, unusable: true };
      const record = records.find((r) => (p.link!.shortcode ? r.key === p.link!.shortcode : r.aliases.includes(p.raw)));
      if (!record) return { link: p.raw, done: true };
      if (!record.report) return { link: p.raw, url: record.url, key: record.key, done: true, ...(record.lastError && { error: record.lastError }) };
      const warning = record.suspect ? 'Numbers changed sharply. Showing older ones. Please retry' : record.lastError ? record.lastError : !record.complete ? 'Some numbers missing. Please retry' : undefined;
      return toLine(p.raw, record.report, true, record.key, { savedAt: record.lastFetchedAt, warning });
    });
  }

  /** Links this plan is about to work on are recorded first, so a closed tab or a cut request can't lose the 24-hour fetch. Free. */
  async function attachAll(raws: string[]) {
    const links = raws.flatMap((raw) => {
      try {
        const link = parseLink(raw);
        return link.shortcode ? [{ key: link.shortcode, url: link.url, alias: raw }] : [];
      } catch {
        return [];
      }
    });
    await store.attach(links);
  }

  /**
   * One JSON object per line through `send`, as numbers arrive. A request starts links for a short while and answers before any host would cut it off.
   * The last line lists what's left, and the page asks again. Nothing depends on work continuing after the answer.
   */
  async function answerLinks(opts: { links: string[]; wait: string[]; payer: Payer; isGone: () => boolean; send: (line: object) => void }) {
    const { payer, isGone, send } = opts;
    const queue = [...new Set(opts.wait), ...new Set(opts.links)];
    const started = Date.now();
    const inFlight = new Set<string>();
    const askAgain = new Set<string>();
    let next = 0;
    const work = async () => {
      // Stops taking links when the page has left, so closing the tab stops the spending that hasn't started.
      while (next < queue.length && !isGone() && Date.now() - started < config.startWindowMs) {
        const raw = queue[next++];
        inFlight.add(raw);
        try {
          if (raw.length > 2048) throw new UnusableLink('This link is too long to be a real post link');
          const { report, key, savedAt, warning } = await lookup(raw, payer, (update) => send(toLine(raw, update, false, undefined)));
          send(toLine(raw, report, true, key, { savedAt, warning }));
        } catch (e) {
          if (e instanceof StillRunning) askAgain.add(raw);
          else send({ link: raw, done: true, error: e instanceof RefusedLink ? e.message : COULD_NOT_READ, ...(e instanceof UnusableLink && { unusable: true }) });
        }
        inFlight.delete(raw);
      }
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([Promise.all(Array.from({ length: AT_ONCE }, work)), new Promise((done) => (timer = setTimeout(done, config.responseMs)))]);
    clearTimeout(timer);
    const notStarted = queue.slice(next);
    if (notStarted.length || inFlight.size || askAgain.size) send({ more: notStarted, wait: [...inFlight, ...askAgain] });
  }

  /** One scheduled wake: takes what's due, fetches what fits, and answers on time. Anything left waits for the next wake. */
  async function runDue(opts: { limit: number; budgetMs: number }): Promise<RunSummary & { runId: number }> {
    const runId = await store.startRun();
    const summary: RunSummary = { claimed: 0, saved: 0, failed: 0, held: 0, unfinished: 0, backupLinks: 0, sources: {}, stopped: null };
    const claimed = await store.claimDue(opts.limit, CLAIM_TTL_SECONDS);
    summary.claimed = claimed.length;
    summary.unfinished = claimed.length;
    const jobs = claimed.map(async (record) => {
      try {
        const answer = await fetchClaimed(record, parseLink(record.url), false);
        summary.unfinished--;
        if (answer.outcome === 'service') summary.stopped = 'service';
        else if (answer.outcome === 'limit') summary.stopped ??= 'limit';
        else if (answer.outcome === 'saved') summary.saved++;
        else if (answer.outcome === 'held') summary.held++;
        else if (answer.outcome === 'failed') summary.failed++;
        const names = answer.report.sources.filter((s) => !s.error).map((s) => s.name);
        names.forEach((n) => (summary.sources[n] = (summary.sources[n] ?? 0) + 1));
        if (answer.report.sources.some((s) => s.name !== 'checker')) summary.backupLinks++;
      } catch (e) {
        summary.unfinished--;
        summary.failed++;
        console.error(`Scheduled fetch failed: ${(e as Error).message}`);
      }
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([Promise.all(jobs), new Promise((done) => (timer = setTimeout(done, opts.budgetMs)))]);
    clearTimeout(timer);
    // A snapshot for the answer: fetches past the budget keep changing `summary`, sources included.
    const answered = { ...summary, sources: { ...summary.sources } };
    const firstWrite = store.finishRun(runId, answered);
    // Those late fetches keep saving, so the record is written again once they end, after the first write, or it would undercount.
    if (answered.unfinished > 0) {
      void firstWrite
        .catch(() => undefined)
        .then(() => Promise.all(jobs))
        .then(() => store.finishRun(runId, summary))
        .catch((e) => console.error(`Could not update the scheduled run record: ${(e as Error).message}`));
    }
    await firstWrite;
    if (summary.backupLinks >= 5 && summary.backupLinks * 2 >= summary.claimed) void alert('backups', `Instagram stats: ${summary.backupLinks} of ${summary.claimed} links needed the backup scrapers in the last scheduled run, which costs several times more per link. The first scraper may have changed or broken.`);
    return { runId, ...answered };
  }

  /** Whether the scheduled job is running. It says nothing by itself when it stops, so this is how anyone finds out. */
  async function scheduleHealth() {
    // A wake that crashes never finishes, so only finished runs count. Otherwise a cron failing every time would look healthy.
    const last = await store.lastRun();
    const ageMs = last ? Date.now() - new Date(last.startedAt).getTime() : null;
    const stale = ageMs === null || ageMs > 3 * 60 * 60_000;
    if (stale && (await store.hasLinks())) void alert('cron-stale', 'Instagram stats: the scheduled refresh has not run for over 3 hours, so second fetches are not happening. Check the cron job in hPanel.');
    return { lastRunAt: last?.startedAt ?? null, stale, stopped: last?.stopped ?? null };
  }

  const takeRefresh = store.takeRefresh.bind(store);
  return { lookup, readSaved, attachAll, answerLinks, runDue, scheduleHealth, takeRefresh };
}

export type StatsService = ReturnType<typeof createStatsService>;
