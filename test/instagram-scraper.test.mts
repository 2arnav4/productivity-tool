/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars -- test replies, and helpers kept for the parked tests */
// The scraper: links, sources, backups and what protects the numbers and keys. No test touches a real service.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { MockNet } from './helpers/mock-net';

process.env.APIFY_TOKEN = 'SECRET-APIFY';
process.env.SCRAPECREATORS_KEY = 'SECRET-SC';
process.env.CACHE_MS = '0';
process.env.BATCH_WINDOW_MS = '1';

const { parseLink } = await import('../src/lib/instagram-stats/links');
const { parseCount } = await import('../src/lib/instagram-stats/sources');
const { scrape } = await import('../src/lib/instagram-stats/scrape');
const { RefusedLink } = await import('../src/lib/instagram-stats/types');

const CODE = 'DZN3mhZBQ_Q';
const REEL = `https://www.instagram.com/reel/${CODE}/`;
let net: MockNet;
beforeEach(() => {
  net = new MockNet();
});
afterEach(() => net.close());

const actors = () => net.get('https://api.apify.com');
const sc = () => net.get('https://api.scrapecreators.com');
const LIVE = { shortCode: CODE, ownerUsername: 'owner1', likesCount: 127, commentsCount: 16, videoPlayCount: 7497 };
const SHARES = { code: CODE, user: { username: 'owner1' }, metrics: { like_count: 100, comment_count: 10, share_count: 44, repost_count: 5, save_count: 5, play_count: 7000 } };
const ACCOUNT = { data: { user: { username: 'owner1', edge_followed_by: { count: 1437 }, edge_follow: { count: 198 }, edge_owner_to_timeline_media: { count: 352 } } } };
const live = (body: unknown = [LIVE], status = 200) => actors().intercept({ path: /instagram-scraper/, method: 'POST' }).reply(status, body as object);
const shares = (body: unknown = [SHARES], status = 200) => actors().intercept({ path: /data-slayer/, method: 'POST' }).reply(status, body as object);
const account = (body: unknown = ACCOUNT, status = 200) => sc().intercept({ path: /\/profile\?/, method: 'GET' }).reply(status, body as object);
const noAccount = { noAccount: true };

// ---- Links ----
for (const form of [
  REEL, `https://www.instagram.com/reel/${CODE}`, `https://instagram.com/reel/${CODE}/`, `www.instagram.com/reel/${CODE}/`, `instagram.com/reel/${CODE}`,
  `https://WWW.INSTAGRAM.COM/reel/${CODE}/`, `https://www.instagram.com/reels/${CODE}/`, `https://m.instagram.com/reel/${CODE}/`,
  `${REEL}?igsh=MzRlODBiNWFlZA==`, `${REEL}?utm_source=ig_web_copy_link#c`, `https://www.instagram.com/natgeo/reel/${CODE}/`, `${REEL}c/1789/`, `${REEL}liked_by/`,
  `https://www.instagram.com/accounts/login/?next=/reel/${CODE}/`, `https://l.instagram.com/?u=${encodeURIComponent(REEL)}&e=a`,
  `  ${REEL}  `, `​${REEL}​`, `<${REEL}>`, `"${REEL}"`, `Check this ${REEL}?igsh=abc so good!`, `see (${REEL}).`, `reel/${CODE}`,
]) {
  test(`same reel: ${JSON.stringify(form)}`, () => {
    const link = parseLink(form);
    assert.deepEqual([link.shortcode, link.url, link.kind], [CODE, REEL, 'reel']);
  });
}

test('posts, profiles and share links', () => {
  for (const f of ['https://www.instagr.am/p/DZxvMgyH8yR/', 'https://www.instagram.com/p/DZxvMgyH8yR/?img_index=2']) assert.equal(parseLink(f).url, 'https://www.instagram.com/p/DZxvMgyH8yR/');
  for (const f of ['natgeo', '@natgeo', 'https://www.instagram.com/NatGeo/?hl=en', 'https://www.instagram.com/natgeo/reels/', 'https://www.instagram.com/_u/natgeo/']) assert.equal(parseLink(f).username, 'natgeo', f);
  for (const f of ['instagram', 'natgeo_instagram', 'https://www.instagram.com/constructor/']) assert.equal(parseLink(f).kind, 'profile', f);
  assert.equal(parseLink('https://www.instagram.com/share/reel/BAC6cDeb_-/?igsh=x').url, 'https://www.instagram.com/share/reel/BAC6cDeb_-/');
});

for (const [form, why] of [
  ['https://www.instagram.com/stories/natgeo/123/', /Story link/], ['https://www.instagram.com/stories/highlights/1/', /Highlight/], ['https://www.instagram.com/natgeo/live/', /Live video/],
  ['https://www.instagram.com/reels/audio/1/', /audio page/], ['https://www.instagram.com/explore/tags/x/', /Explore/], ['https://www.instagram.com/', /home page/], ['https://www.linkedin.com/posts/a', /Only Instagram/],
] as const) test(`refused with the reason: ${form}`, () => assert.throws(() => parseLink(form), why));

test('lookalikes, tricks and huge input are refused quickly', () => {
  const start = Date.now();
  for (const bad of [
    'https://notinstagram.com/p/abcdefghijk/', 'https://instagram.com.evil.io/p/abcdefghijk/', 'https://evil.io/?x=instagram.com/p/abcdefghijk', 'https://evil.example#instagram.com/p/AAAAAAAAAAA/',
    'https://evil.example/,instagram.com/p/ABCDE/', 'https://evil.example/(instagram.com/p/ABCDE/', 'https://www.instagram.com/p/AAAAA/%2e%2e/%2e%2e/p/BBBBB/', 'https://www.instagram.com/.../', '..', 'hello world',
    'https://www.instagram.com/p/<script>/', 'https://www.instagram.com/challenge/', 'https://www.instagram.com/login/', `https://www.instagram.com/p/${'a'.repeat(5000)}/`, `https://instagram.com/${'.'.repeat(400000)}x`,
    `https://www.instagram.com/accounts?next=${'/accounts?next='.repeat(10)}/natgeo`,
  ]) assert.throws(() => parseLink(bad), RefusedLink, bad.slice(0, 60));
  assert.ok(Date.now() - start < 300);
});

// ---- Counts ----
test('only a real count passes, and 0 is a real count', () => {
  for (const [v, want] of [[0, 0], ['0', 0], [5, 5], ['12', 12]] as const) assert.equal(parseCount(v), want);
  for (const v of [-1, '', 'abc', '12abc', 1.5, NaN, Infinity, '9'.repeat(400), null, undefined, {}, [], false]) assert.equal(parseCount(v), undefined, String(v));
  assert.ok(Object.is(parseCount(-0), 0));
});

test('a real 0 stays 0, empty stays empty, and a hidden count is not shown even as 0', async () => {
  live([{ ...LIVE, likesCount: 0, commentsCount: 0 }]);
  shares([{ ...SHARES, metrics: { share_count: '0', repost_count: 0 } }]);
  let r = await scrape(REEL, noAccount);
  for (const m of ['likes', 'comments', 'shares', 'reposts']) assert.equal(r.metrics[m].value, 0, m);

  live();
  shares([{ ...SHARES, metrics: { share_count: null, repost_count: 'many' } }]);
  r = await scrape(REEL, noAccount);
  assert.equal(r.metrics.shares.value, null);
  assert.match(r.metrics.shares.note!, /may still show on Instagram/);
  assert.equal(r.metrics.reposts.value, null);

  live();
  shares([{ ...SHARES, share_count_disabled: true, metrics: { share_count: 0, repost_count: 3 } }]);
  r = await scrape(REEL, noAccount);
  assert.equal(r.metrics.shares.value, null);
  assert.match(r.metrics.shares.note!, /hidden/);
  assert.equal(r.metrics.reposts.value, 3);
});

// ---- The route ----
// PARKED: scrapecreators, PARKED: followers
// test('live likes from Apify, shares from the actor, followers from ScrapeCreators', async () => {
//   live();
//   shares();
//   account();
//   const r = await scrape(REEL);
//   assert.deepEqual([r.metrics.likes.value, r.metrics.likes.source, r.metrics.likes.mayLag], [127, 'apify', undefined]);
//   assert.deepEqual([r.metrics.shares.value, r.metrics.shares.source, r.metrics.shares.mayLag], [44, 'postdetails', true]);
//   assert.deepEqual([r.metrics.followers.value, r.metrics.followers.source], [1437, 'scrapecreators']);
//   assert.equal(r.owner, 'owner1');
//   assert.equal(r.metrics.shares.source, 'postdetails');
// });

test('live likes from Apify, shares from the actor', async () => {
  live();
  shares();
  const r = await scrape(REEL);
  assert.deepEqual([r.metrics.likes.value, r.metrics.likes.source, r.metrics.likes.mayLag], [127, 'apify', undefined]);
  assert.deepEqual([r.metrics.shares.value, r.metrics.shares.source, r.metrics.shares.mayLag], [44, 'postdetails', true]);
  assert.equal(r.metrics.followers, undefined);
  assert.equal(r.owner, 'owner1');
  assert.equal(r.metrics.shares.source, 'postdetails');
});

// PARKED: scrapecreators, PARKED: followers
// test('backups: each job falls through in order, and a total failure says so', async () => {
//   live({ error: { message: 'down' } }, 500);
//   sc().intercept({ path: /\/post/, method: 'GET' }).reply(200, { data: { xdt_shortcode_media: { shortcode: CODE, owner: { username: 'owner1' }, edge_media_preview_like: { count: 127 }, comment_count: 16 } } });
//   shares({ error: { message: 'actor down' } }, 500);
//   actors().intercept({ path: /patient_discovery/, method: 'POST' }).reply(200, [SHARES]);
//   let r = await scrape(REEL, noAccount);
//   assert.deepEqual([r.metrics.likes.source, r.metrics.shares.source], ['scrapecreators', 'postmetrics']);
//   assert.ok(r.sources.some((s) => s.error === 'actor down'));
// 
//   live([], 200);
//   sc().intercept({ path: /\/post/, method: 'GET' }).reply(500, { message: 'down' });
//   shares();
//   r = await scrape(REEL, noAccount);
//   assert.deepEqual([r.metrics.likes.value, r.metrics.likes.mayLag], [100, true]);
//   assert.match(r.metrics.likes.note!, /behind/);
// 
//   actors().intercept({ path: /run-sync/, method: 'POST' }).reply(500, { error: { message: 'down' } }).persist();
//   sc().intercept({ path: /\/post/, method: 'GET' }).reply(500, { message: 'down' });
//   r = await scrape(REEL);
//   assert.equal(r.metrics.shares.value, null);
//   assert.match(r.metrics.shares.note!, /could not be checked/);
//   assert.ok(r.warnings.some((w) => /owner could not/.test(w)));
// });

test('backups: the shares job falls through in order, likes fall back to an actor marked, and a total failure says so', async () => {
  live({ error: { message: 'down' } }, 400);
  shares({ error: { message: 'actor down' } }, 400);
  actors().intercept({ path: /patient_discovery/, method: 'POST' }).reply(200, [SHARES]);
  let r = await scrape(REEL, noAccount);
  assert.deepEqual([r.metrics.likes.source, r.metrics.likes.mayLag, r.metrics.shares.source], ['postmetrics', true, 'postmetrics']);
  assert.ok(r.sources.some((s) => s.error === 'actor down'));

  live([], 200);
  shares();
  r = await scrape(REEL, noAccount);
  assert.deepEqual([r.metrics.likes.value, r.metrics.likes.mayLag], [100, true]);
  assert.match(r.metrics.likes.note!, /behind/);

  actors().intercept({ path: /run-sync/, method: 'POST' }).reply(400, { error: { message: 'down' } }).persist();
  r = await scrape(REEL);
  assert.equal(r.metrics.shares.value, null);
  assert.match(r.metrics.shares.note!, /could not be checked/);
});

// PARKED: scrapecreators, PARKED: followers
// test('a reply for a different post or account is rejected, even with one link', async () => {
//   live([{ ...LIVE, shortCode: 'OTHERPOST99', likesCount: 999999 }]);
//   shares([{ ...SHARES, code: 'OTHERPOST99' }]);
//   actors().intercept({ path: /patient_discovery/, method: 'POST' }).reply(200, []);
//   sc().intercept({ path: /\/post/, method: 'GET' }).reply(200, { data: { xdt_shortcode_media: { shortcode: 'OTHERPOST99', edge_media_preview_like: { count: 1 } } } });
//   assert.equal((await scrape(REEL, noAccount)).metrics.likes.value, null);
// 
//   account({ data: { user: { username: 'someoneelse', edge_followed_by: { count: 42 } } } });
//   actors().intercept({ path: /instagram-scraper/, method: 'POST' }).reply(200, [{ username: 'someoneelse', followersCount: 42 }]);
//   assert.equal((await scrape('natgeo')).metrics.followers.value, null);
// });

test('a reply for a different post is rejected, even with one link', async () => {
  live([{ ...LIVE, shortCode: 'OTHERPOST99', likesCount: 999999 }]);
  shares([{ ...SHARES, code: 'OTHERPOST99' }]);
  actors().intercept({ path: /patient_discovery/, method: 'POST' }).reply(200, []);
  assert.equal((await scrape(REEL, noAccount)).metrics.likes.value, null);
});

test('a profile link is refused with the reason, and no paid call runs', async () => {
  await assert.rejects(scrape('natgeo'), RefusedLink);
  await assert.rejects(scrape('https://www.instagram.com/natgeo/'), /Followers and following are switched off/);
});

test('links arriving together share one run, and each keeps its own numbers', async () => {
  let runs = 0;
  actors().intercept({ path: /data-slayer/, method: 'POST' }).reply(() => (runs++, { statusCode: 200, data: JSON.stringify([{ code: 'BBBBBBBBBBB', metrics: { share_count: 20 } }, null, { code: 'AAAAAAAAAAA', metrics: { share_count: 10 } }]) }));
  actors().intercept({ path: /instagram-scraper/, method: 'POST' }).reply(200, []);
  sc().intercept({ path: /\/post/, method: 'GET' }).reply(200, {}).persist();
  const [a, b] = await Promise.all([scrape('https://www.instagram.com/p/AAAAAAAAAAA/', noAccount), scrape('https://www.instagram.com/reel/BBBBBBBBBBB/', noAccount)]);
  assert.equal(runs, 1);
  assert.deepEqual([a.metrics.shares.value, b.metrics.shares.value], [10, 20]);
});

// PARKED: scrapecreators, PARKED: followers
// test('a typed username never decides whose followers are shown, and owner conflicts hide them', async () => {
//   live([{ ...LIVE, ownerUsername: 'realowner' }]);
//   shares([{ ...SHARES, user: { username: 'realowner' } }]);
//   let asked = '';
//   sc().intercept({ path: (p) => ((asked = p), p.includes('/profile')), method: 'GET' }).reply(200, { data: { user: { username: 'realowner', edge_followed_by: { count: 7 } } } });
//   const r = await scrape(`https://www.instagram.com/victim/reel/${CODE}/`);
//   assert.equal(r.owner, 'realowner');
//   assert.ok(asked.includes('realowner'));
// 
//   live([{ ...LIVE, ownerUsername: 'bob' }]);
//   shares([{ ...SHARES, user: { username: 'alice' } }]);
//   account({ data: { user: { username: 'alice', edge_followed_by: { count: 111 } } } });
//   const c = await scrape(REEL);
//   assert.equal(c.owner, undefined);
//   assert.equal(c.metrics.followers.value, null);
//   assert.ok(c.warnings.some((w) => /disagree/.test(w)));
// });

test('a typed username never decides the owner, and owners that disagree are not shown', async () => {
  live([{ ...LIVE, ownerUsername: 'realowner' }]);
  shares([{ ...SHARES, user: { username: 'realowner' } }]);
  assert.equal((await scrape(`https://www.instagram.com/victim/reel/${CODE}/`)).owner, 'realowner');

  live([{ ...LIVE, ownerUsername: 'bob' }]);
  shares([{ ...SHARES, user: { username: 'alice' } }]);
  const c = await scrape(REEL);
  assert.equal(c.owner, undefined);
  assert.ok(c.warnings.some((w) => /disagree/.test(w)));
});

test('a share link follows same-site redirects, and system pages are never read as accounts', async () => {
  const ig = net.get('https://www.instagram.com');
  ig.intercept({ path: '/share/abcde/', method: 'GET' }).reply(302, '', { headers: { location: `/reel/${CODE}/` } });
  ig.intercept({ path: `/reel/${CODE}/`, method: 'GET' }).reply(200, 'ok');
  live();
  shares();
  assert.equal((await scrape('https://www.instagram.com/share/abcde', noAccount)).link.shortcode, CODE);

  ig.intercept({ path: '/share/abcde/', method: 'GET' }).reply(302, '', { headers: { location: '/somebody/' } });
  ig.intercept({ path: '/somebody/', method: 'GET' }).reply(200, '<html></html>');
  await assert.rejects(scrape('https://www.instagram.com/share/abcde'), /did not reveal/);

  ig.intercept({ path: '/share/abcde/', method: 'GET' }).reply(302, '', { headers: { location: 'https://evil.example/x' } });
  await assert.rejects(scrape('https://www.instagram.com/share/abcde'), /did not reveal/);
});

test('keys, escape codes and huge errors from a service never reach the output', async () => {
  live({ error: { message: `bad token SECRET-APIFY \u001b[2J\nWARNING: forged ${'x'.repeat(5000)}` } }, 400);
  sc().intercept({ path: /\/post/, method: 'GET' }).reply(400, { message: 'bad secret-sc' });
  shares([{ ...SHARES, product_type: 'clips\n\nfake row\u001b[2J' }]);
  const r = await scrape(REEL, noAccount);
  const text = JSON.stringify(r);
  assert.ok(!/SECRET/i.test(text), text.slice(0, 200));
  assert.ok(!text.includes('\\u001b') && !/\\nfake row/.test(text) && !/\\nWARNING: forged/.test(text));
  assert.ok(r.sources.every((s) => (s.error ?? '').length <= 300));
});

test('a very large reply is cut off', async () => {
  live('x'.repeat(11 * 1024 * 1024));
  shares();
  const r = await scrape(REEL, noAccount);
  assert.match(r.sources.find((s) => s.name === 'apify')!.error!, /too large/);
});

test('numbers arrive as sources answer, and an actor likes number never flashes up', async () => {
  actors().intercept({ path: /data-slayer/, method: 'POST' }).reply(200, [SHARES]);
  actors().intercept({ path: /instagram-scraper/, method: 'POST' }).reply(200, [LIVE]).delay(40);
  // PARKED: followers
  // account();
  const updates: any[] = [];
  const final = await scrape(REEL, { onUpdate: (r) => updates.push(r) });
  assert.ok(updates.length >= 2);
  assert.equal(updates[0].metrics.shares.value, 44);
  assert.equal(updates[0].metrics.likes, undefined, 'the actor said 100, and that must not show');
  assert.ok(updates.every((u) => u.metrics.likes === undefined || u.metrics.likes.value === 127));
  // PARKED: followers
  // assert.ok(updates.some((u) => u.metrics.followers?.value === 1437 && u.metrics.likes === undefined), 'followers must not wait for the slowest source');
  assert.equal(final.metrics.likes.value, 127);
});

test('if the live sources fail, the actor likes number appears only at the end, marked', async () => {
  live([], 200);
  sc().intercept({ path: /\/post/, method: 'GET' }).reply(400, { message: 'down' });
  shares();
  const updates: any[] = [];
  const final = await scrape(REEL, { noAccount: true, onUpdate: (r) => updates.push(r) });
  assert.ok(updates.every((u) => u.metrics.likes === undefined));
  assert.deepEqual([final.metrics.likes.value, final.metrics.likes.mayLag], [100, true]);
});

// ---- The checker: one source for all five numbers, with backups only on failure ----
const CHECKED = { url: REEL, shortCode: CODE, inputUrl: REEL, type: 'reel', productType: 'clips', ownerUsername: 'owner1', takenAt: '2026-01-01T00:00:00Z', views: 7498, likes: 127, comments: 16, shares: 44, reposts: 5, saves: 5, likesHidden: false };
const checked = (body: unknown = [CHECKED], status = 200) => actors().intercept({ path: /reel-views-checker/, method: 'POST' }).reply(status, body as object);
const values = (r: any) => ['views', 'likes', 'comments', 'shares', 'reposts'].map((m) => r.metrics[m]?.value);

test('the checker gives all five numbers, on a pinned build with a spending cap, and no backup runs', async () => {
  let path = '';
  actors().intercept({ path: (p) => /reel-views-checker/.test(p) && ((path = p), true), method: 'POST' }).reply(200, [CHECKED]);
  const r = await scrape(REEL, noAccount);
  assert.deepEqual(values(r), [7498, 127, 16, 44, 5]);
  assert.deepEqual(r.sources.map((s) => s.name), ['checker']); // Any backup call would show here, and would fail: none is mocked.
  assert.equal(r.complete, true);
  assert.match(path, /build=1\.0\.27/);
  assert.match(path, /maxTotalChargeUsd=0\.015/);
});

test('a real 0 from the checker stays 0, and a photo with no views or shares is a dash with no backup paid for', async () => {
  const photo = `https://www.instagram.com/p/${CODE}/`;
  checked([{ ...CHECKED, url: photo, type: 'photo', productType: 'feed', views: null, shares: null, likes: 0, reposts: 0 }]);
  const r = await scrape(photo, noAccount);
  assert.deepEqual(values(r), [null, 0, 16, null, 0]);
  assert.deepEqual(r.sources.map((s) => s.name), ['checker']);
  assert.equal(r.complete, true);
});

for (const [why, reply] of [
  ['a run that fails', () => checked({ error: { message: 'capped' } }, 400)],
  ['a row with some other error', () => checked([{ input: REEL, error: 'blocked' }])],
  ['a reply for a different post', () => checked([{ ...CHECKED, shortCode: 'XXXXXXXXXXX' }])],
  ['a reel with no views', () => checked([{ ...CHECKED, views: null }])],
  ['a row with no likes or comments', () => checked([{ ...CHECKED, likes: null, comments: null }])],
  ['a reel with likes and views but nothing else', () => checked([{ ...CHECKED, comments: null, shares: null, reposts: null }])],
  ['a reel missing only shares', () => checked([{ ...CHECKED, shares: null }])],
  ['a row with numbers but no post ID, only an input echoing the link', () => checked([{ input: REEL, likes: 999999, comments: 1, views: 1, shares: 1, reposts: 1 }])],
  ['an empty reply, as from a used-up daily cap', () => checked([])],
] as const) {
  test(`the backups take over after ${why}, and the answer counts as complete`, async () => {
    reply();
    live();
    shares();
    const r = await scrape(REEL, noAccount);
    assert.deepEqual(values(r).slice(1), [127, 16, 44, 5]);
    assert.ok([7497, 7498].includes(r.metrics.views.value!));
    assert.deepEqual(r.sources.filter((s) => !s.error).map((s) => s.name), ['apify', 'postdetails']);
    assert.equal(r.complete, true);
  });
}

test('if the first source and part of the backups fail, the answer is not complete', async () => {
  checked({ error: { message: 'down' } }, 400);
  live();
  shares({ error: { message: 'down' } }, 400);
  actors().intercept({ path: /patient_discovery/, method: 'POST' }).reply(400, { error: { message: 'down' } });
  const r = await scrape(REEL, noAccount);
  assert.deepEqual(values(r), [7497, 127, 16, null, null]);
  assert.equal(r.complete, false);
});

test('when everything fails no number is invented, and the keys stay out of the message', async () => {
  checked({ error: { message: 'token SECRET-APIFY refused' } }, 400);
  live({ error: { message: 'down' } }, 400);
  shares({ error: { message: 'down' } }, 400);
  actors().intercept({ path: /patient_discovery/, method: 'POST' }).reply(400, { error: { message: 'down' } });
  const r = await scrape(REEL, noAccount);
  assert.deepEqual(values(r), [null, null, null, null, null]);
  assert.equal(r.complete, false);
  assert.ok(!JSON.stringify(r).includes('SECRET-APIFY'));
});

test('hidden likes from the checker show as hidden, never 0, and no backup runs', async () => {
  checked([{ ...CHECKED, likes: 0, views: null, likesHidden: true }]);
  const r = await scrape(REEL, noAccount);
  assert.equal(r.metrics.likes.value, null);
  assert.match(r.metrics.likes.note!, /hidden/);
  assert.deepEqual(r.sources.map((s) => s.name), ['checker']);
});

test('30 links at once go out as two checker runs of at most 25, and each row reaches its own link', async () => {
  const codes = Array.from({ length: 30 }, (_, i) => `DZN3mhZBQ${String(i).padStart(2, '0')}`);
  const sizes: number[] = [];
  actors().intercept({ path: /reel-views-checker/, method: 'POST' }).reply(200, (opts: any) => {
    const { urls } = JSON.parse(opts.body);
    sizes.push(urls.length);
    return urls.map((u: string) => ({ ...CHECKED, url: u, shortCode: u.split('/').filter(Boolean).pop(), likes: Number(u.slice(-3, -1)) }));
  }).persist();
  const reports = await Promise.all(codes.map((c) => scrape(`https://www.instagram.com/reel/${c}/`, noAccount)));
  assert.deepEqual(sizes.sort((a, b) => b - a), [25, 5]);
  reports.forEach((r, i) => assert.equal(r.metrics.likes.value, i));
});

test('a post the checker says is not found costs no backup, and is never shown as 0', async () => {
  checked([{ input: `${REEL}?igsh=1`, error: 'not_found', scrapedAt: 'x' }]);
  const r = await scrape(REEL, noAccount);
  assert.deepEqual(r.sources.map((s) => s.name), ['checker']); // Any backup call would show here.
  assert.deepEqual(values(r), [null, null, null, null, null]);
  assert.deepEqual([r.notFound, r.complete], [true, false]);
  assert.match(r.sources[0].error!, /could not be found/);
});


test('a hidden count beats a number from any other source, for likes and views', async () => {
  shares([{ ...SHARES, like_and_view_counts_disabled: true, metrics: { comment_count: 10, share_count: 44, repost_count: 5 } }]);
  checked({ error: { message: 'down' } }, 400);
  live([{ ...LIVE, likesCount: 0, videoPlayCount: 0 }]);
  const r = await scrape(REEL, noAccount);
  assert.deepEqual([r.metrics.likes.value, r.metrics.views.value], [null, null]);
  assert.match(r.metrics.likes.note!, /hidden/);
  assert.equal(r.complete, true);
});

test('backups giving one number each are not complete', async () => {
  checked({ error: { message: 'down' } }, 400);
  live([{ shortCode: CODE, ownerUsername: 'owner1', likesCount: 127 }]);
  shares([{ code: CODE, user: { username: 'owner1' }, metrics: { share_count: 44 } }]);
  const r = await scrape(REEL, noAccount);
  assert.equal(r.complete, false);
});

test('the daily limit stops a link before anything is paid, and stops backups too', async () => {
  const none = await scrape(REEL, { ...noAccount, budget: () => false });
  assert.deepEqual([none.sources, none.budgetStopped, none.complete], [[], true, false]);

  checked({ error: { message: 'down' } }, 400);
  let asked = 0;
  const some = await scrape(REEL, { ...noAccount, budget: () => asked++ === 0 });
  assert.deepEqual(some.sources.map((s) => s.name), ['checker']);
  assert.equal(some.budgetStopped, true);
});

for (const [what, status] of [['out of money', 402], ['a bad key', 401], ['too many runs', 429], ['the service down', 500]] as const) {
  test(`${what} stops the fetch: no backups run, no number is invented, and the report says so`, async () => {
    checked({ error: { message: 'no' } }, status);
    const r = await scrape(REEL, noAccount);
    assert.equal(r.serviceDown, true);
    assert.equal(r.complete, false);
    assert.equal(net.count(/instagram-scraper|data-slayer|patient_discovery/), 0);
    assert.ok(Object.values(r.metrics).every((m) => m.value === null));
  });
}

test('a network failure reaching the service stops the fetch the same way', async () => {
  actors().intercept({ path: /reel-views-checker/, method: 'POST' }).replyWithError(new TypeError('fetch failed'));
  const r = await scrape(REEL, noAccount);
  assert.equal(r.serviceDown, true);
  assert.equal(net.count(/data-slayer/), 0);
});

test('a key split by invisible characters or base64-encoded never gets out', async () => {
  const { removeKeys } = await import('../src/lib/instagram-stats/config');
  assert.equal(removeKeys('bad SECRET​-API\u0000FY here'), '[removed]');
  assert.ok(!removeKeys(`x ${Buffer.from('SECRET-APIFY').toString('base64')} y`).includes(Buffer.from('SECRET-APIFY').toString('base64')));
  assert.equal(removeKeys('nothing here'), 'nothing here');
});

test('numbers the checker did return are kept when the backups are down', async () => {
  checked([{ ...CHECKED, shares: null, reposts: null }]);
  live({ error: { message: 'down' } }, 400);
  shares({ error: { message: 'down' } }, 400);
  actors().intercept({ path: /patient_discovery/, method: 'POST' }).reply(400, { error: { message: 'down' } });
  const r = await scrape(REEL, noAccount);
  assert.deepEqual(values(r), [7498, 127, 16, null, null]);
  assert.equal(r.complete, false);
});

test('a hidden count from the checker still wins when its reply had a gap', async () => {
  checked([{ ...CHECKED, likes: 0, views: null, comments: null, likesHidden: true }]);
  live([{ ...LIVE, likesCount: 0, videoPlayCount: 0 }]);
  shares();
  const r = await scrape(REEL, noAccount);
  assert.deepEqual([r.metrics.likes.value, r.metrics.views.value], [null, null]);
});

test('a /p/ link with no post type is not trusted as a photo', async () => {
  const photo = `https://www.instagram.com/p/${CODE}/`;
  checked([{ ...CHECKED, url: photo, type: undefined, productType: undefined, views: null, shares: null, reposts: null }]);
  live();
  shares();
  const r = await scrape(photo, noAccount);
  assert.deepEqual(r.sources.filter((s) => !s.error).map((s) => s.name), ['apify', 'postdetails']);
});
