// A row's totals, as the table and both exports show them.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rowStat, planExportRows, lineToMetrics, currentLinks, missingKind } from '../src/lib/live-plan-metrics';

const A = 'https://www.instagram.com/reel/AAAAAAAAAAA/';
const B = 'https://www.instagram.com/p/BBBBBBBBBBB/';
const row = (live_links: string[], metrics: object) => ({ live_links, metrics: metrics as never });
const full = { key: 'A', views: 1000, likes: 100, comments: 10, shares: 5, reposts: 1 };

test('a row with no stats shows why', () => {
  assert.deepEqual(rowStat(row([A], {}), 'views'), { value: null, reason: 'Stats not fetched yet', kind: 'retry' });
});
test('a real 0 stays 0, and missing is never counted as 0', () => {
  assert.equal(rowStat(row([A], { [A]: { ...full, shares: 0 } }), 'shares').value, 0);
  assert.equal(rowStat(row([A], { [A]: { ...full, shares: null } }), 'shares').value, null);
});
test('two links add up, and a missing one marks the total as partial', () => {
  const m = { [A]: full, [B]: { key: 'B', views: null, likes: 50, comments: 5, shares: 1, reposts: 0 } };
  assert.deepEqual(rowStat(row([A, B], m), 'likes'), { value: 150 });
  assert.deepEqual(rowStat(row([A, B], m), 'views'), { value: 1000, partial: true, reason: '1 of 2 links missing' });
  assert.deepEqual(rowStat(row([A, B], { [A]: full }), 'likes'), { value: 100, partial: true, reason: '1 of 2 links missing' });
});
test('the same post on one row counts once', () => {
  const other = A.replace('/reel/', '/p/');
  assert.equal(rowStat(row([A, other], { [A]: full, [other]: full }), 'likes').value, 100);
});
test('links no longer on the row are ignored', () => {
  assert.equal(rowStat(row([A], { [A]: full, [B]: { key: 'B', likes: 999999 } }), 'likes').value, 100);
});
test('engagement is likes + comments + shares, leaves out reposts, and says when a part is missing', () => {
  assert.equal(rowStat(row([A], { [A]: full }), 'engagement').value, 115);
  const photo = rowStat(row([A], { [A]: { key: 'A', likes: 100, comments: 10, shares: null } }), 'engagement');
  assert.deepEqual([photo.value, photo.partial], [110, true]);
  assert.match(photo.reason!, /Incomplete: shares/);
  assert.equal(rowStat(row([A], {}), 'engagement').value, null);
});
test('a flagged number is marked and says why, and a failure explains the dash', () => {
  const flagged = rowStat(row([A], { [A]: { ...full, warning: 'kept from before' } }), 'likes');
  assert.deepEqual([flagged.value, flagged.partial, flagged.reason], [100, true, 'kept from before']);
  assert.equal(rowStat(row([A], { [A]: { error: 'Could not read' } }), 'likes').reason, 'Could not read');
});
test('a line from the route becomes metrics, with notes', () => {
  const m = lineToMetrics({ link: A, key: 'X', done: true, savedAt: 'T', metrics: { views: { value: 5 }, shares: { value: null, note: 'hidden' } } });
  assert.deepEqual([m.key, m.views, m.shares, m.notes?.shares, m.fetched_at], ['X', 5, null, 'hidden', 'T']);
});
test('the export follows the table: order, columns, blanks for missing, and a real 0', () => {
  const items = [
    { handle_name: 'b', category: 'Y', quantity: 1, verified: false, paid: false, live_links: [], metrics: {} },
    { handle_name: 'a', category: 'X', followers: 0, quantity: 2, total_cost: 5, verified: true, paid: true, live_links: [A, B], metrics: { [A]: { ...full, reposts: 0 } } },
    { handle_name: 'c', category: 'Y', quantity: 1, verified: false, paid: false, live_links: [], metrics: {} },
  ];
  const rows = planExportRows(items as never);
  assert.deepEqual(rows.map((r) => r['Page / Creator']), ['b', 'c', 'a']);
  assert.deepEqual(Object.keys(rows[0]), ['#', 'Page / Creator', 'Followers', 'Deliv.', 'Payout', 'Live Links', 'Views', 'Likes', 'Comments', 'Shares', 'Reposts', 'Engagement', 'Verified', 'Paid']);
  assert.deepEqual([rows[2].Followers, rows[2].Reposts, rows[2]['Live Links'], rows[0].Views], [0, 0, `${A}\n${B}`, '']);
});

test('a live_links value that is not a text link is skipped, not a crash', () => {
  const bad = { live_links: [A, 123, null, { x: 1 }, '   '] as never, metrics: { [A]: full } as never };
  assert.deepEqual(currentLinks(bad), [A]);
  assert.equal(rowStat(bad, 'views').value, 1000);
  assert.equal(currentLinks({ live_links: 'not a list' as never }).length, 0);
});

test('only the first quantity links count, since only those slots can be seen or edited', () => {
  const r = { live_links: [A, B], quantity: 1, metrics: { [A]: full, [B]: { ...full, key: 'B' } } as never };
  assert.deepEqual(currentLinks(r), [A]);
  assert.equal(rowStat(r, 'views').value, 1000);
  assert.deepEqual(currentLinks({ live_links: [A, B] }), [A, B]);
});

test('each missing stat gets the kind its icon shows, and the reason comes from the same link', () => {
  const line = (metrics: object, extra: object = {}) => lineToMetrics({ link: A, done: true, metrics, ...extra } as never);
  // The owner hid likes: flagged by the server, even if the wording changes.
  const hid = row([A], { [A]: line({ likes: { value: null, note: 'the owner has hidden the like count', hidden: true } }) });
  assert.deepEqual(rowStat(hid, 'likes'), { value: null, reason: 'the owner has hidden the like count', kind: 'hidden' });
  // Views on a photo or carousel: Instagram doesn't show them.
  const photo = row([A], { [A]: line({ views: { value: null, note: 'no views returned. Sources only report views on reels and videos' } }) });
  assert.equal(rowStat(photo, 'views').kind, 'na');
  // Shares on a photo: the server marks it, so the wording doesn't matter.
  const photoShares = row([A], { [A]: line({ shares: { value: null, note: "our sources didn't return the share count for this post", notShown: true } }) });
  assert.equal(rowStat(photoShares, 'shares').kind, 'na');
  // The post is gone: a real failure.
  const gone = row([A], { [A]: line({}, { error: 'Post not found. May be private or deleted' }) });
  assert.equal(rowStat(gone, 'views').kind, 'failed');
  // A link that can never give stats is a failure, whatever its wording.
  const bad = row([A], { [A]: line({}, { error: 'This is a Reels audio page. Open the reel and copy its own link.', unusable: true }) });
  assert.equal(rowStat(bad, 'likes').kind, 'failed');
  // Our side: a source failed, or the daily limit. Retrying or waiting helps.
  const ours = row([A], { [A]: line({ shares: { value: null, note: 'could not be checked, because a source failed' } }) });
  assert.equal(rowStat(ours, 'shares').kind, 'retry');
  const limit = row([A], { [A]: line({}, { error: 'Daily limit reached. Try after 5:30 AM' }) });
  assert.equal(rowStat(limit, 'views').kind, 'retry');
  // Engagement with no parts follows likes, like its reason does.
  assert.equal(rowStat(hid, 'engagement').kind, 'hidden');
  // A number never carries a kind, and a real 0 stays a number.
  assert.equal(rowStat(row([A], { [A]: { ...full, shares: 0 } }), 'shares').kind, undefined);
});

test('wording nobody planned for is never shown as a red failure', () => {
  assert.equal(missingKind('some new message from a source'), 'retry');
  assert.equal(missingKind(undefined), 'retry');
  assert.equal(missingKind('not applicable: this is a profile link'), 'na');
});

test('a row with no live link shows a plain dash, not a waiting icon', () => {
  assert.deepEqual(rowStat(row([], {}), 'views'), { value: null, reason: 'No live link yet' });
  assert.deepEqual(rowStat(row([], {}), 'engagement'), { value: null, reason: 'No live link yet', kind: undefined });
  assert.equal(rowStat({ live_links: [A], quantity: 0, metrics: {} as never }, 'likes').kind, undefined);
});
