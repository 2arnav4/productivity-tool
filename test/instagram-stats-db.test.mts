/* eslint-disable @typescript-eslint/no-explicit-any -- test replies and rows */
// The stats service against a real Postgres and PostgREST, with every scraper call mocked.
// Refuses to run against anything but this machine, because the real database holds real data.
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { createClient } from '@supabase/supabase-js';
import { MockNet } from './helpers/mock-net';

const url = process.env.TEST_SUPABASE_URL ?? 'http://localhost:54399';
const key = process.env.TEST_SUPABASE_SERVICE_KEY ?? '';
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:|\/)/.test(url)) throw new Error('These tests only run against a local database.');
const skip = !key && 'Set TEST_SUPABASE_SERVICE_KEY for a local Postgres and PostgREST with the repo schema';

process.env.APIFY_TOKEN = 'SECRET-APIFY';
process.env.BATCH_WINDOW_MS = '1';
process.env.RETRY_FAILED_MS = '1800000';
const { createStatsService, UnusableLink } = await import('../src/lib/instagram-stats/service');
const { createSupabaseStore, MAX_FAILURES } = await import('../src/lib/instagram-stats/store');

const db = key ? createClient(url, key, { auth: { persistSession: false } }) : (null as never);
const realFetch = globalThis.fetch;
const CODE = 'DZN3mhZBQ_Q';
const REEL = `https://www.instagram.com/reel/${CODE}/`;
const BRIEF = '10000000-0000-4000-8000-0000000000aa';
const PLAN = '20000000-0000-4000-8000-0000000000aa';
const CHECKED = { shortCode: CODE, ownerUsername: 'owner1', type: 'reel', productType: 'clips', likes: 127, comments: 16, shares: 44, reposts: 5, views: 7497 };
let net: MockNet;
let store: ReturnType<typeof createSupabaseStore>;
let alerts: string[];
let service: ReturnType<typeof createStatsService>;
const actors = () => net.get('https://api.apify.com');
const checked = (body: unknown = [CHECKED], status = 200) => actors().intercept({ path: /reel-views-checker/, method: 'POST' }).reply(status, body);
const paid = () => net.count(/api\.apify\.com/);
const fresh = () => {
  store = createSupabaseStore(db);
  alerts = [];
  service = createStatsService({ store, resolveLink: async () => { throw new Error('no share links here'); }, alert: async (k) => { alerts.push(k); } });
  return service;
};
const USER = '30000000-0000-4000-8000-0000000000aa';
const refreshIds = new Map<string, string>(); // One Refresh per start time, so resending a start resends the same Refresh.
/** A Refresh row the way the route makes one, so what it paid for can be noted against it. */
const refreshFor = async (since: string) => {
  if (!refreshIds.has(since)) {
    const id = crypto.randomUUID();
    await db.from('instagram_stats_refreshes').insert({ id, user_id: USER, plan_id: PLAN, at: since });
    refreshIds.set(since, id);
  }
  return refreshIds.get(since)!;
};
/** Sends one request through the service, the way the route does. Attaching gets a limit no test reaches unless it sets one. */
const ask = async (s: typeof service, links: string[], since?: string, wait: string[] = [], attachLimit = 1000) => {
  const lines: any[] = [];
  if (since) await new Promise((r) => setTimeout(r, 5)); // Anything saved before a Refresh began must be older than it.
  const payer = since ? { refresh: { id: await refreshFor(since), since } } : { attach: { userId: USER, limit: attachLimit, windowSeconds: 3600 } };
  await s.answerLinks({ links, wait, payer, isGone: () => false, send: (l) => lines.push(l) });
  return lines;
};
const row = async (k = CODE) => (await db.from('instagram_link_stats').select('*').eq('key', k).single()).data as any;
const set = (patch: object, k = CODE) => db.from('instagram_link_stats').update(patch).eq('key', k);
const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();
const planRow = (links: string[]) => db.from('media_plan_items').insert({ plan_id: PLAN, handle_name: 'test_row', quantity: links.length || 1, live_links: links });
const refresh = () => new Date(Date.now() + 2).toISOString();

before(async () => {
  if (skip) return;
  globalThis.fetch = realFetch;
});
beforeEach(async () => {
  if (skip) return;
  // The database client must keep working while scraper calls are mocked, so the mock lets local calls through.
  net?.close();
  net = new MockNet();
  const mocked = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => (String(input instanceof Request ? input.url : input).startsWith(url) ? realFetch(input, init) : mocked(input, init))) as typeof fetch;
  await db.from('media_plan_items').delete().eq('plan_id', PLAN);
  // Its own brief and plan, so these tests don't depend on what the database was seeded with.
  await db.from('client_briefs').upsert({ id: BRIEF, brand_name: 'Stats test brief', status: 'live' });
  await db.from('media_plans').upsert({ id: PLAN, brief_id: BRIEF, source: 'upload' });
  await db.from('instagram_link_stats').delete().like('url', '%');
  await db.from('instagram_stats_refreshes').delete().gt('at', '2000-01-01');
  await db.from('instagram_stats_runs').delete().gt('started_at', '2000-01-01');
  await db.from('instagram_stats_spend').delete().gt('day', '2000-01-01');
  await db.from('instagram_stats_attach_fetches').delete().gt('at', '2000-01-01');
  refreshIds.clear();
  fresh();
});
after(async () => {
  if (skip) return;
  await db.from('media_plan_items').delete().eq('plan_id', PLAN);
  await db.from('media_plans').delete().eq('id', PLAN);
  await db.from('client_briefs').delete().eq('id', BRIEF);
  await db.from('instagram_link_stats').delete().like('url', '%');
  await db.from('instagram_stats_runs').delete().gt('started_at', '2000-01-01');
  await db.from('instagram_stats_refreshes').delete().gt('at', '2000-01-01');
  await db.from('instagram_stats_spend').delete().gt('day', '2000-01-01');
  await db.from('instagram_stats_attach_fetches').delete().gt('at', '2000-01-01');
  net?.close();
  globalThis.fetch = realFetch;
});

test('a link is attached once, and keeps its first time and every written form', { skip }, async () => {
  const [a] = await store.attach([{ key: CODE, url: REEL, alias: REEL }]);
  await new Promise((r) => setTimeout(r, 20));
  const [b] = await store.attach([{ key: CODE, url: REEL, alias: `${REEL}?igsh=x` }]);
  assert.equal(a.attachedAt, b.attachedAt);
  assert.deepEqual(b.aliases, [REEL, `${REEL}?igsh=x`]);
});

test('reading never pays, never creates a record, and says when a link can never give stats', { skip }, async () => {
  const lines = await service.readSaved([REEL, 'https://www.youtube.com/watch?v=abc', 'https://www.instagram.com/stories/natgeo/123/', 'natgeo']);
  assert.equal(paid(), 0);
  assert.equal(await row(), null);
  assert.deepEqual(lines[0], { link: REEL, done: true });
  assert.equal(lines[1].unusable, true);
  assert.match(lines[1].error!, /Only Instagram/);
  assert.match(lines[2].error!, /Story/);
  assert.match(lines[3].error!, /Profile/);
});

test('the first fetch counts as automatic, a real 0 stays 0, and reopening costs nothing', { skip }, async () => {
  checked([{ ...CHECKED, reposts: 0 }]);
  const [line] = await ask(service, [REEL]);
  assert.equal(line.metrics.reposts.value, 0);
  assert.equal(line.metrics.views.value, 7497);
  const saved = await row();
  assert.equal(saved.auto_fetches, 1);
  assert.equal(saved.complete, true);
  assert.equal(saved.claim_token, null);
  assert.equal(saved.history[0].kind, 'first');
  assert.equal(paid(), 1);
  const [again] = await ask(fresh(), [REEL.replace('/reel/', '/p/')]);
  assert.equal(paid(), 1);
  assert.ok(again.savedAt);
  assert.equal(again.metrics.reposts.value, 0);
});

test('a count the owner hid is flagged as hidden, fresh and when read back from storage', { skip }, async () => {
  checked([{ ...CHECKED, likes: 0, likesHidden: true }]);
  const [line] = await ask(service, [REEL]);
  assert.equal(line.metrics.likes.value, null);
  assert.equal(line.metrics.likes.hidden, true);
  assert.equal(line.metrics.views.hidden, true); // Hiding likes on Instagram hides the view count too.
  assert.equal(line.metrics.comments.hidden, undefined);
  const [again] = await ask(fresh(), [REEL]);
  assert.ok(again.savedAt);
  assert.equal(again.metrics.likes.hidden, true);
});

test('views, shares and reposts missing on a photo are marked as not shown', { skip }, async () => {
  const PHOTO = `https://www.instagram.com/p/${CODE}/`;
  checked([{ ...CHECKED, type: 'photo', productType: undefined, views: undefined, shares: undefined, reposts: undefined }]);
  const line = (await ask(service, [PHOTO])).at(-1); // The final line: earlier ones are partial while the fetch runs.
  assert.equal(line.done, true);
  assert.equal(line.metrics.likes.value, 127);
  for (const m of ['views', 'shares', 'reposts']) {
    assert.equal(line.metrics[m]?.notShown, true, m);
    assert.equal(line.metrics[m]?.note, `Instagram doesn't show ${m} on photos and carousels`);
  }
  assert.equal(line.metrics.likes.notShown, undefined);
});

test('no scraper name reaches a person, whatever fails', { skip }, async () => {
  checked({ error: { message: 'apify token SECRET-APIFY' } }, 400);
  actors().intercept({ path: /instagram-scraper/, method: 'POST' }).reply(400, { error: { message: 'apify broke' } });
  actors().intercept({ path: /data-slayer/, method: 'POST' }).reply(400, { error: { message: 'data-slayer broke' } });
  actors().intercept({ path: /patient_discovery/, method: 'POST' }).reply(400, { error: { message: 'x' } });
  const lines = await ask(service, [REEL]);
  const text = JSON.stringify(lines);
  assert.ok(!/apify|checker|data-slayer|patient_discovery|SECRET|postdetails|postmetrics/i.test(text), text);
  assert.ok(!/apify|checker|SECRET/i.test(JSON.stringify(await service.readSaved([REEL]))));
});

test('Refresh pays again and updates the numbers without counting as automatic', { skip }, async () => {
  checked();
  await ask(service, [REEL]);
  checked([{ ...CHECKED, likes: 200 }]);
  const [line] = await ask(service, [REEL], refresh());
  assert.equal(line.metrics.likes.value, 200);
  const saved = await row();
  assert.equal(saved.auto_fetches, 1);
  assert.equal(saved.history[1].kind, 'manual');
  assert.equal(paid(), 2);
});

test('a Refresh resumed with the same start never pays twice, and a link that never ran still gets refreshed', { skip }, async () => {
  checked();
  await ask(service, [REEL]);
  const since = refresh();
  await new Promise((r) => setTimeout(r, 15));
  checked([{ ...CHECKED, likes: 200 }]);
  await ask(service, [REEL], since);
  assert.equal(paid(), 2);
  const [resumed] = await ask(service, [REEL], since);
  assert.equal(paid(), 2);
  assert.equal(resumed.metrics.likes.value, 200);
});

test('a failed fetch keeps the good numbers, says so, and waits before another automatic try', { skip }, async () => {
  checked();
  await ask(service, [REEL]);
  checked({ error: { message: 'no' } }, 400);
  const [line] = await ask(service, [REEL], refresh());
  assert.equal(line.metrics.likes.value, 127);
  assert.match(line.warning, /Some numbers missing/);
  const saved = await row();
  assert.equal(saved.report.metrics.likes.value, 127);
  assert.equal(saved.fail_count, 1);
  assert.ok(new Date(saved.retry_after).getTime() > Date.now());
});

test('a link that just failed is not paid for again on another ask, but Refresh tries', { skip }, async () => {
  checked({ error: { message: 'no' } }, 400);
  const [first] = await ask(service, [REEL]);
  assert.match(first.error, /Please retry/);
  const count = paid();
  const [second] = await ask(service, [REEL]);
  assert.equal(paid(), count);
  assert.match(second.error, /Please retry/);
  checked();
  const [third] = await ask(service, [REEL], refresh());
  assert.equal(third.metrics.likes.value, 127);
  const saved = await row();
  assert.equal(saved.fail_count, 0);
  assert.equal(saved.last_error, null);
});

test('failures wait longer each time, and five in a row stop automatic tries', { skip }, async () => {
  const waits: number[] = [];
  await store.attach([{ key: CODE, url: REEL, alias: REEL }]);
  for (let i = 0; i < MAX_FAILURES; i++) {
    const claimed = await store.claim(CODE, 600);
    await store.saveFailure(CODE, claimed!.claimToken!, 'nope', { baseSeconds: 1800 });
    const r = await row();
    waits.push(Math.round((new Date(r.retry_after).getTime() - new Date(r.last_failed_at).getTime()) / 60000));
    assert.equal(r.gave_up, i === MAX_FAILURES - 1);
  }
  assert.deepEqual(waits, [30, 60, 120, 240, 480]);
});

test('a post not found costs no backup, gets one more try a day later, then only a person can try', { skip }, async () => {
  checked([{ input: REEL, error: 'not_found' }]);
  const [first] = await ask(service, [REEL]);
  assert.match(first.error, /not found/);
  assert.equal(paid(), 1);
  let saved = await row();
  assert.ok(new Date(saved.retry_after).getTime() - Date.now() > 23 * 3600_000);
  assert.equal(saved.gave_up, false);
  await ask(service, [REEL]);
  assert.equal(paid(), 1);
  await set({ last_failed_at: hoursAgo(25), retry_after: hoursAgo(1), started_at: null });
  checked([{ input: REEL, error: 'not_found' }]);
  await ask(service, [REEL]);
  assert.equal(paid(), 2);
  saved = await row();
  assert.equal(saved.gave_up, true);
  await set({ last_failed_at: hoursAgo(100), retry_after: hoursAgo(50) });
  await ask(service, [REEL]);
  assert.equal(paid(), 2);
});

test('an all-zero reply never replaces real numbers, and counts as an attempt until a person has to look', { skip }, async () => {
  checked();
  await ask(service, [REEL]);
  const zero = { ...CHECKED, likes: 0, comments: 0, shares: 0, reposts: 0, views: 0 };
  for (let i = 1; i <= 3; i++) {
    checked([zero]);
    const [line] = await ask(service, [REEL], refresh());
    assert.equal(line.metrics.likes.value, 127);
    assert.match(line.warning, /all zeros/);
    const saved = await row();
    assert.equal(saved.held_count, i);
    assert.equal(saved.gave_up, i === 3);
    assert.equal(saved.history.at(-1).held, true);
    assert.equal(saved.report.metrics.likes.value, 127);
    await new Promise((r) => setTimeout(r, 5));
  }
});

test('a sharp drop is held once, then accepted when a second fetch agrees', { skip }, async () => {
  checked();
  await ask(service, [REEL]);
  const low = { ...CHECKED, views: 1000 };
  checked([low]);
  const [held] = await ask(service, [REEL], refresh());
  assert.equal(held.metrics.views.value, 7497);
  assert.match(held.warning, /changed sharply/);
  await new Promise((r) => setTimeout(r, 5));
  checked([{ ...low, views: 1010 }]);
  const [accepted] = await ask(service, [REEL], refresh());
  assert.equal(accepted.metrics.views.value, 1010);
  const saved = await row();
  assert.equal(saved.held_count, 0);
  assert.equal(saved.suspect, null);
});

test('a partial first answer is kept, not counted, and flagged', { skip }, async () => {
  checked([{ ...CHECKED, shares: undefined, reposts: undefined }]);
  actors().intercept({ path: /instagram-scraper/, method: 'POST' }).reply(200, []);
  actors().intercept({ path: /data-slayer/, method: 'POST' }).reply(200, []);
  actors().intercept({ path: /patient_discovery/, method: 'POST' }).reply(200, []);
  const [line] = await ask(service, [REEL]);
  assert.equal(line.metrics.likes.value, 127);
  assert.match(line.warning, /numbers missing/);
  const saved = await row();
  assert.equal(saved.complete, false);
  assert.equal(saved.auto_fetches, 0);
  assert.equal(saved.fail_count, 1);
});

test('an account-wide stop blames no link, charges nothing, and alerts', { skip }, async () => {
  checked({ error: { message: 'no money' } }, 402);
  const [line] = await ask(service, [REEL]);
  assert.match(line.error, /unavailable/);
  const saved = await row();
  assert.equal(saved.fail_count, 0);
  assert.equal(saved.gave_up, false);
  assert.equal(saved.claim_token, null);
  assert.equal(saved.started_at, null);
  assert.deepEqual(alerts, ['service']);
  assert.equal(net.count(/instagram-scraper|data-slayer/), 0);
});

test('two processes cannot pay for one link: the second is told to ask again', { skip }, async () => {
  await store.attach([{ key: CODE, url: REEL, alias: REEL }]);
  const held = await store.claim(CODE, 600);
  assert.ok(held?.claimToken);
  assert.equal(await store.claim(CODE, 600), null);
  await set({ started_at: hoursAgo(2) });
  const lines = await ask(fresh(), [REEL]);
  assert.equal(paid(), 0);
  assert.deepEqual(lines, [{ more: [], wait: [REEL] }]);
});

test('many claims at once: exactly one wins', { skip }, async () => {
  await store.attach([{ key: CODE, url: REEL, alias: REEL }]);
  const results = await Promise.all(Array.from({ length: 20 }, () => store.claim(CODE, 600)));
  assert.equal(results.filter(Boolean).length, 1);
});

test('a late answer cannot overwrite a newer one, because its claim was lost', { skip }, async () => {
  await store.attach([{ key: CODE, url: REEL, alias: REEL }]);
  const old = await store.claim(CODE, 600);
  await set({ claimed_until: hoursAgo(1) });
  const newer = await store.claim(CODE, 600);
  const report = { link: { kind: 'reel', url: REEL }, metrics: { likes: { value: 1 } }, sources: [], warnings: [] } as any;
  assert.equal(await store.saveFetch(CODE, old!.claimToken!, report, 'first', true), false);
  assert.equal((await row()).report, null);
  assert.equal(await store.saveFetch(CODE, newer!.claimToken!, report, 'first', true), true);
});

// ---- The scheduled job ----
const due = async (patch: object = {}, k = CODE, link = REEL) => {
  await store.attach([{ key: k, url: link, alias: link }]);
  await set({ attached_at: hoursAgo(25), ...patch }, k);
  await planRow([link]);
};
const wake = () => service.runDue({ limit: 100, budgetMs: 5000 });

test('a link becomes due 24 hours after attaching, gets its second fetch, then stops', { skip }, async () => {
  await store.attach([{ key: CODE, url: REEL, alias: REEL }]);
  await planRow([REEL]);
  checked();
  await ask(service, [REEL]); // First fetch, just now.
  assert.equal((await wake()).claimed, 0);
  await set({ attached_at: hoursAgo(23) });
  assert.equal((await wake()).claimed, 0);
  await set({ attached_at: hoursAgo(25), last_fetched_at: hoursAgo(25) });
  checked([{ ...CHECKED, likes: 150 }]);
  const run = await wake();
  assert.deepEqual([run.claimed, run.saved, run.failed], [1, 1, 0]);
  const saved = await row();
  assert.equal(saved.auto_fetches, 2);
  assert.equal(saved.report.metrics.likes.value, 150);
  assert.equal(saved.history.at(-1).kind, 'auto');
  await set({ attached_at: hoursAgo(100), last_fetched_at: hoursAgo(50) });
  assert.equal((await wake()).claimed, 0);
  assert.equal(paid(), 2);
});

test('a link whose first fetch never happened is picked up', { skip }, async () => {
  await due();
  checked();
  assert.equal((await wake()).saved, 1);
  assert.equal((await row()).history[0].kind, 'first');
});

test('what stops a link from being due', { skip }, async () => {
  for (const [why, patch] of [
    ['gave up', { gave_up: true }],
    ['two fetches done', { auto_fetches: 2 }],
    ['still waiting after a failure', { retry_after: new Date(Date.now() + 3600_000).toISOString() }],
    ['claimed', { claimed_until: new Date(Date.now() + 3600_000).toISOString() }],
    ['fetched under 12 hours ago', { last_fetched_at: hoursAgo(11) }],
  ] as const) {
    await db.from('instagram_link_stats').delete().eq('key', CODE);
    await due(patch);
    assert.equal((await wake()).claimed, 0, why);
  }
  assert.equal(paid(), 0);
});

test('a link no longer on any plan row stops costing money', { skip }, async () => {
  await store.attach([{ key: CODE, url: REEL, alias: REEL }]);
  await set({ attached_at: hoursAgo(25) });
  assert.equal((await wake()).claimed, 0);
});

test('a claim left by a crash expires, and the link is picked up again', { skip }, async () => {
  await due({ claimed_until: hoursAgo(1), started_at: hoursAgo(2), claim_token: '00000000-0000-4000-8000-00000000abcd' });
  checked();
  assert.equal((await wake()).saved, 1);
});

test('running twice at once never pays twice for a link', { skip }, async () => {
  await due();
  actors().intercept({ path: /reel-views-checker/, method: 'POST' }).reply(200, [CHECKED]).persist();
  const [a, b] = await Promise.all([wake(), wake()]);
  assert.equal(a.claimed + b.claimed, 1);
  assert.equal(paid(), 1);
});

test('an account-wide failure stops the run without counting against any link', { skip }, async () => {
  await due();
  checked({ error: { message: 'no money' } }, 402);
  const run = await wake();
  assert.equal(run.stopped, 'service');
  assert.equal(run.failed, 0);
  const saved = await row();
  assert.deepEqual([saved.fail_count, saved.gave_up, saved.claim_token], [0, false, null]);
  assert.deepEqual(alerts, ['service']);
  const { data } = await db.from('instagram_stats_runs').select('stopped').order('id', { ascending: false }).limit(1);
  assert.equal((data as any)[0].stopped, 'service');
});

test('a held reply on a wake counts as an attempt, so it stops paying', { skip }, async () => {
  checked();
  await ask(service, [REEL]);
  await planRow([REEL]);
  const zero = { ...CHECKED, likes: 0, comments: 0, shares: 0, reposts: 0, views: 0 };
  for (let i = 1; i <= 3; i++) {
    await set({ attached_at: hoursAgo(25), last_fetched_at: hoursAgo(25), retry_after: null });
    checked([zero]);
    assert.equal((await wake()).held, 1);
  }
  const saved = await row();
  assert.equal(saved.gave_up, true);
  await set({ retry_after: null });
  assert.equal((await wake()).claimed, 0);
});

test('a wake answers on time even if a fetch is still running', { skip }, async () => {
  await due();
  actors().intercept({ path: /reel-views-checker/, method: 'POST' }).reply(200, [CHECKED]).delay(300);
  const started = Date.now();
  const run = await service.runDue({ limit: 100, budgetMs: 50 });
  assert.ok(Date.now() - started < 280);
  assert.equal(run.unfinished, 1);
  await new Promise((r) => setTimeout(r, 400));
  // The fetch saved after the answer, so the run record must say so.
  const record = (await db.from('instagram_stats_runs').select('saved, unfinished').eq('id', run.runId).single()).data as any;
  assert.deepEqual([record.saved, record.unfinished], [1, 0]);
});

test('a backlog waits for the next wake', { skip }, async () => {
  const links = ['AAAAAAAAAAA', 'BBBBBBBBBBB', 'CCCCCCCCCCC'].map((c) => [c, `https://www.instagram.com/reel/${c}/`]);
  for (const [c, u] of links) await due({}, c, u);
  actors().intercept({ path: /reel-views-checker/, method: 'POST' }).reply(200, ({ body }: { body: string }) => JSON.parse(body).urls.map((u: string) => ({ ...CHECKED, shortCode: u.split('/').filter(Boolean).pop() }))).persist();
  const first = await service.runDue({ limit: 2, budgetMs: 5000 });
  assert.equal(first.claimed, 2);
  const second = await service.runDue({ limit: 2, budgetMs: 5000 });
  assert.equal(second.claimed, 1);
});

test('the schedule warning shows once the last run is over 3 hours old, and alerts only if there are links', { skip }, async () => {
  let health = await service.scheduleHealth();
  assert.deepEqual([health.stale, health.lastRunAt], [true, null]);
  assert.deepEqual(alerts, []);
  await store.attach([{ key: CODE, url: REEL, alias: REEL }]);
  await service.scheduleHealth();
  assert.deepEqual(alerts, ['cron-stale']);
  await wake();
  alerts.length = 0;
  health = await service.scheduleHealth();
  assert.equal(health.stale, false);
  assert.deepEqual(alerts, []);
  await db.from('instagram_stats_runs').update({ started_at: hoursAgo(4) }).gt('id', 0);
  assert.equal((await service.scheduleHealth()).stale, true);
});

test('Refresh limit: 6 per user per plan per hour, a resume costs nothing, and another plan or user is separate', { skip }, async () => {
  const user = '00000000-0000-4000-8000-000000000001';
  const other = '00000000-0000-4000-8000-000000000002';
  const id = (n: number) => `40000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  for (let i = 1; i <= 6; i++) assert.equal((await store.takeRefresh(id(i), user, PLAN, 6, 3600, 900)).allowed, true);
  const seventh = await store.takeRefresh(id(7), user, PLAN, 6, 3600, 900);
  assert.equal(seventh.allowed, false);
  assert.ok(seventh.retrySeconds > 3500 && seventh.retrySeconds <= 3600);
  const resumed = await store.takeRefresh(id(1), user, PLAN, 6, 3600, 900);
  assert.equal(resumed.allowed, true);
  assert.equal((await store.takeRefresh(id(8), other, PLAN, 6, 3600, 900)).allowed, true);
  assert.equal((await store.takeRefresh(id(9), user, '20000000-0000-4000-8000-000000000002', 6, 3600, 900)).allowed, true);
  // Another user can't resume someone's refresh.
  assert.equal((await store.takeRefresh(id(1), other, PLAN, 6, 3600, 900)).allowed, false);
});

test('at the limit, many refreshes at once still only let through what fits', { skip }, async () => {
  const user = '00000000-0000-4000-8000-000000000001';
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => store.takeRefresh(`50000000-0000-4000-8000-${String(i).padStart(12, '0')}`, user, PLAN, 6, 3600, 900)));
  assert.equal(results.filter((r) => r.allowed).length, 6);
});

test('history keeps a trace of every fetch and stops at its limit', { skip }, async () => {
  await store.attach([{ key: CODE, url: REEL, alias: REEL }]);
  await set({ history: Array.from({ length: 100 }, (_, i) => ({ at: 'x', kind: 'auto', n: i })) });
  checked();
  await ask(service, [REEL]);
  const saved = await row();
  assert.equal(saved.history.length, 100);
  assert.equal(saved.history[0].n, 1);
  assert.equal(saved.history.at(-1).kind, 'first');
  assert.deepEqual(saved.history.at(-1).sources, ['checker']);
});

test('nothing in the stats flow writes to a plan row', { skip }, async () => {
  await due();
  const before = (await db.from('media_plan_items').select('*').eq('plan_id', PLAN)).data;
  checked();
  await wake();
  await ask(service, [REEL], refresh());
  assert.deepEqual((await db.from('media_plan_items').select('*').eq('plan_id', PLAN)).data, before);
});

test('a profile link is refused and creates nothing', { skip }, async () => {
  const [line] = await ask(service, ['https://www.instagram.com/natgeo/']);
  assert.equal(line.unusable, true);
  assert.equal(paid(), 0);
  assert.ok(UnusableLink);
});

test('a saved link is still found by a written form with a comma, brace or quote', { skip }, async () => {
  await store.attach([{ key: CODE, url: REEL, alias: REEL }]);
  const odd = `${REEL}?a={"b",c}\\d`;
  await set({ aliases: [REEL, odd] });
  const found = await store.find([], [odd]);
  assert.deepEqual(found.map((r) => r.key), [CODE]);
});

test('resuming a Refresh answers with one row, not two', { skip }, async () => {
  const args = { p_id: '60000000-0000-4000-8000-000000000001', p_user: '30000000-0000-4000-8000-000000000001', p_plan: PLAN, p_limit: 6, p_window_seconds: 3600, p_resume_seconds: 900 };
  assert.equal((await db.rpc('instagram_stats_take_refresh', args)).data.length, 1);
  const again = await db.rpc('instagram_stats_take_refresh', args);
  assert.deepEqual(again.data.map((r: any) => r.allowed), [true]);
});

test('a big plan still reads its saved stats, in parts that fit in a URL', { skip }, async () => {
  await store.attach([{ key: CODE, url: REEL, alias: REEL }]);
  const share = (i: number) => `https://www.instagram.com/share/reel/${'x'.repeat(60)}${i}/?igsh=${'y'.repeat(20)}`;
  const aliases = [...Array.from({ length: 500 }, (_, i) => share(i)), REEL, 'z'.repeat(20_000)];
  const keys = [...Array.from({ length: 2000 }, (_, i) => `K${i}`), CODE];
  assert.deepEqual((await store.find(keys, [])).map((r) => r.key), [CODE]);
  assert.deepEqual((await store.find([], aliases)).map((r) => r.key), [CODE]);
});

test('a wake that never finished does not count as the cron running', { skip }, async () => {
  await store.attach([{ key: CODE, url: REEL, alias: REEL }]);
  await db.from('instagram_stats_runs').insert({ started_at: new Date().toISOString() });
  assert.equal((await service.scheduleHealth()).stale, true);
  const id = await store.startRun();
  await store.finishRun(id, { claimed: 0, saved: 0, failed: 0, held: 0, unfinished: 0, backupLinks: 0, sources: {}, stopped: null });
  assert.equal((await service.scheduleHealth()).stale, false);
});

test('the daily limit is on by default: past it nothing is paid, no link is blamed, and admins hear', { skip }, async () => {
  await db.from('instagram_stats_spend').insert({ day: new Date().toISOString().slice(0, 10), usd: 0.9995 });
  checked();
  const [line] = await ask(service, [REEL]);
  assert.equal(paid(), 0);
  assert.match(line.error, /Daily limit reached/);
  assert.ok(alerts.includes('daily-limit'));
  const saved = await row();
  assert.deepEqual([saved.claim_token, saved.last_failed_at, saved.fail_count], [null, null, 0]);
});

test('a resent Refresh never pays again for a link whose numbers were held', { skip }, async () => {
  checked();
  await ask(service, [REEL]);
  const since = refresh();
  checked([{ ...CHECKED, likes: 10 }]);
  const [held] = await ask(service, [REEL], since);
  assert.match(held.warning, /changed sharply/);
  assert.equal(paid(), 2);
  for (let i = 0; i < 3; i++) {
    const [again] = await ask(fresh(), [REEL], since);
    assert.equal(again.metrics.likes.value, 127);
    assert.ok(again.warning);
  }
  assert.equal(paid(), 2);
  assert.equal((await row()).held_count, 1);
  // A new Refresh may still try it.
  checked([{ ...CHECKED, likes: 10 }]);
  await ask(fresh(), [REEL], refresh());
  assert.equal(paid(), 3);
});

test('attaching pays for at most the hourly limit per user, and the scheduled job fetches the rest soon', { skip }, async () => {
  const links = ['AAAAAAAAAAA', 'BBBBBBBBBBB', 'CCCCCCCCCCC'].map((c) => `https://www.instagram.com/reel/${c}/`);
  await planRow(links);
  actors().intercept({ path: /reel-views-checker/, method: 'POST' }).reply(200, ({ body }: { body: string }) => JSON.parse(body).urls.map((u: string) => ({ ...CHECKED, shortCode: u.split('/').filter(Boolean).pop() }))).persist();
  const lines = await ask(service, links, undefined, [], 1);
  assert.equal(lines.filter((l) => l.done && l.metrics?.views).length, 1);
  assert.equal(lines.filter((l) => /fetched automatically/.test(l.error ?? '')).length, 2);
  const queued = await db.from('instagram_link_stats').select('claim_token, last_failed_at').is('last_fetched_at', null);
  assert.deepEqual(queued.data, [{ claim_token: null, last_failed_at: null }, { claim_token: null, last_failed_at: null }]);
  // Another ask in the same hour doesn't pay either.
  await ask(fresh(), links, undefined, [], 1);
  assert.equal((await db.from('instagram_stats_attach_fetches').select('id')).data!.length, 1);
  const run = await wake();
  assert.deepEqual([run.claimed, run.saved], [2, 2]);
  assert.equal((await row('BBBBBBBBBBB')).history[0].kind, 'first');
  // Fetched once, so now it waits for its 24-hour fetch.
  assert.equal((await wake()).claimed, 0);
});

test('a link whose attach fetch failed is not picked up early by the scheduled job', { skip }, async () => {
  await planRow([REEL]);
  checked({ error: { message: 'no' } }, 400);
  await ask(service, [REEL]);
  assert.ok((await row()).last_failed_at);
  await set({ retry_after: null });
  assert.equal((await wake()).claimed, 0);
});

test('the attach limit counts per user and holds when many ask at once', { skip }, async () => {
  const other = '30000000-0000-4000-8000-0000000000bb';
  const results = await Promise.all(Array.from({ length: 30 }, () => store.takeAttachFetch(USER, 10, 3600)));
  assert.equal(results.filter(Boolean).length, 10);
  assert.equal(await store.takeAttachFetch(other, 10, 3600), true);
});

test('the scheduled job never pays for a link past a row\'s quantity, the slots the page hides', { skip }, async () => {
  const hidden = 'https://www.instagram.com/reel/HHHHHHHHHHH/';
  await db.from('media_plan_items').insert({ plan_id: PLAN, handle_name: 'test_row', quantity: 1, live_links: [REEL, hidden] });
  // Not due(), which adds a row of its own for each link.
  for (const [k, u] of [[CODE, REEL], ['HHHHHHHHHHH', hidden]]) {
    await store.attach([{ key: k, url: u, alias: u }]);
    await set({ attached_at: hoursAgo(25) }, k);
  }
  actors().intercept({ path: /reel-views-checker/, method: 'POST' }).reply(200, ({ body }: { body: string }) => JSON.parse(body).urls.map((u: string) => ({ ...CHECKED, shortCode: u.split('/').filter(Boolean).pop() }))).persist();
  const run = await wake();
  assert.equal(run.claimed, 1);
  assert.equal((await row('HHHHHHHHHHH')).auto_fetches, 0);
  // A bad value in a slot doesn't break the query for everyone else.
  await db.from('media_plan_items').insert({ plan_id: PLAN, handle_name: 'bad_row', quantity: 3, live_links: [{ x: 1 }, 5, null] });
  assert.equal((await wake()).claimed, 0);
});
