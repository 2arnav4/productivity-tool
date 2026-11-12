// The services that get us the numbers. A reply for a different post or account is always rejected.
/* eslint-disable @typescript-eslint/no-explicit-any -- replies from outside services are checked field by field here */
import { config } from './config';
import { requestJson } from './http';
import { createBatcher, createLimiter } from './queue';
import type { Count, Link, SourceAnswer } from './types';

/** The source is sure the post doesn't exist or can't be seen. Backups would charge for the same answer, so they don't run. */
export class PostNotFound extends Error {}

/** A reply with a gap: backups run to fill it, but the numbers it did give were paid for and are kept. */
export class PartialAnswer extends Error {
  constructor(message: string, readonly answer: SourceAnswer) {
    super(message);
  }
}

export interface Source {
  ready: () => boolean;
  post?: (link: Link) => Promise<SourceAnswer>;
  // PARKED: followers
  // account?: (username: string) => Promise<SourceAnswer>;
}

/** A whole number of 0 or more, as a number or plain digits. Anything else is not a count. */
export function parseCount(v: unknown): number | undefined {
  const n = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v;
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n + 0 : undefined;
}

const count = (v: unknown, note: string, extra: Partial<Count> = {}): Count => {
  const n = parseCount(v);
  return n === undefined ? { value: null, note } : { value: n, ...extra };
};
const optional = (v: unknown, extra: Partial<Count> = {}): Count | undefined => (parseCount(v) === undefined ? undefined : count(v, '', extra));
const hidden = (what: string): Count => ({ value: null, hidden: true, note: `the owner has hidden the ${what} count` });
const NOT_READ = 'hidden or not available';
const NOT_RETURNED = (what: string) => `our sources didn't return the ${what} count for this post. It may still show on Instagram`;
const seconds = (v: unknown) => (typeof v === 'number' && !isNaN(new Date(v * 1000).getTime()) ? new Date(v * 1000).toISOString() : undefined);
const codeOf = (url: string) => url.split('/').filter(Boolean).pop()!;

const apifyReady = () => !!config.apifyToken;
const limitRuns = createLimiter(5); // Apify's free plan allows 5 runs at once.

function runActor(actor: string, input: object, results: number, build = ''): Promise<any[]> {
  return limitRuns(async () => {
    // A spending cap per run, so a changed actor can't run up the bill.
    const url = `https://api.apify.com/v2/acts/${actor}/run-sync-get-dataset-items?timeout=90&maxTotalChargeUsd=${(0.01 + results * 0.005).toFixed(3)}${build && `&build=${build}`}`;
    const data = await requestJson(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apifyToken}` }, body: JSON.stringify(input) }, 105_000);
    if (!Array.isArray(data)) throw new Error('Apify sent something other than a list');
    return data;
  });
}

function match(keys: string[], items: any[], idOf: (item: any) => unknown, idOfKey = (k: string) => k) {
  const found = new Map<string, any>();
  for (const key of keys) {
    const item = items.find((it) => it && typeof it === 'object' && idOf(it) === idOfKey(key));
    if (item) found.set(key, item);
  }
  return found;
}

// ---- Apify's own scraper: live numbers ----
const apifyPosts = createBatcher<any>(
  config.batchWindowMs,
  25,
  async (urls) => match(urls, await runActor('apify~instagram-scraper', { directUrls: urls, resultsType: 'posts', resultsLimit: 1, addParentData: false }, urls.length), (it) => it.shortCode, codeOf),
  'Apify returned no result (private or deleted post?)',
);
// PARKED: followers
// const apifyAccounts = createBatcher<any>(
//   config.batchWindowMs,
//   25,
//   async (names) => match(names, await runActor('apify~instagram-scraper', { directUrls: names.map((n) => `https://www.instagram.com/${n}/`), resultsType: 'details', resultsLimit: 1 }, names.length), (it) => (typeof it.username === 'string' ? it.username.toLowerCase() : undefined)),
//   'Apify returned no account',
// );
const apify: Source = {
  ready: apifyReady,
  post: async (link) => {
    const it = await apifyPosts(link.url);
    return { owner: it.ownerUsername, type: it.productType ?? it.type, posted: it.timestamp, counts: { likes: it.likesCount === -1 ? hidden('like') : count(it.likesCount, NOT_READ), comments: count(it.commentsCount, NOT_READ), ...(optional(it.videoPlayCount) && { views: optional(it.videoPlayCount) }) } };
  },
// PARKED: followers
//   account: async (username) => {
//     const u = await apifyAccounts(username);
//     return { owner: u.username, counts: { followers: count(u.followersCount, NOT_READ), following: count(u.followsCount, NOT_READ), postsCount: count(u.postsCount, NOT_READ) } };
//   },
};

// ---- The checker: first choice. One run gives all five numbers, so nothing else runs when it answers ----
const CHECKER = createBatcher<any>(
  config.batchWindowMs,
  25,
  async (urls) => match(urls, await runActor('instagram-data-api~instagram-reel-views-checker', { urls, returnWithinSecs: 75 }, urls.length, '1.0.27'), (it) => it.shortCode ?? (it.error && typeof it.input === 'string' ? codeOf(it.input.split(/[?#]/)[0]) : undefined), codeOf), // Only an error row may go by its input: numbers need the post's own ID.
  'The first source returned no result for this link',
);
const checker: Source = {
  ready: apifyReady,
  post: async (link) => {
    const it = await CHECKER(link.url);
    if (it.error === 'not_found') throw new PostNotFound('This post could not be found. It may be private or deleted');
    if (it.error) throw new Error('The first source could not read this post');
    const isVideo = link.kind === 'reel' || it.type === 'reel' || it.type === 'video' || it.productType === 'clips';
    const off = it.likesHidden === true;
    // Failing here starts the backups, because a gap on a number we expect is a failure and not an answer. Photos and carousels often lack views and shares, so those gaps are accepted.
    const needed = [['comments', it.comments], ...(off ? [] : [['likes', it.likes]]), ...(isVideo ? [['shares', it.shares], ['reposts', it.reposts], ...(off ? [] : [['views', it.views]])] : [])];
    const missing = needed.filter(([, v]) => parseCount(v) === undefined).map(([name]) => name);
    if (!it.type && !it.productType) missing.push('post type'); // Without it, a video could pass as a photo and its gaps as normal.
    const answer: SourceAnswer = {
      owner: it.ownerUsername,
      type: it.productType ?? it.type,
      posted: it.takenAt,
      counts: {
        likes: off ? hidden('like') : count(it.likes, NOT_READ),
        comments: count(it.comments, NOT_READ),
        shares: count(it.shares, NOT_RETURNED('share')),
        reposts: count(it.reposts, NOT_RETURNED('repost')),
        ...(off ? { views: hidden('view') } : optional(it.views) && { views: optional(it.views) }),
        ...(optional(it.saves) && { saves: optional(it.saves) }),
      },
    };
    if (missing.length) throw new PartialAnswer(`The first source returned no ${missing.join(', ')} for this link`, answer);
    return answer;
  },
};

// ---- Third-party actors: the only source of shares and reposts. They can lag on busy posts ----
function actorSource(actor: string, build: string): Source {
  const lookup = createBatcher<any>(config.batchWindowMs, 25, async (urls) => match(urls, await runActor(actor, { postUrls: urls }, urls.length, build), (it) => it.code, codeOf), 'No result for this link (private or deleted post?)');
  const lag = { mayLag: true };
  return {
    ready: apifyReady,
    post: async (link) => {
      const it = await lookup(link.url);
      const m = it.metrics ?? {};
      const likesOff = it.like_and_view_counts_disabled === true; // A count flagged as hidden isn't real, even if a 0 came with it.
      return {
        owner: it.user?.username,
        type: it.product_type,
        posted: seconds(it.taken_at),
        counts: {
          likes: likesOff ? hidden('like') : count(m.like_count, NOT_READ, lag),
          comments: count(m.comment_count, NOT_READ, lag),
          shares: it.share_count_disabled === true ? hidden('share') : count(m.share_count, NOT_RETURNED('share'), lag),
          reposts: count(m.repost_count, NOT_RETURNED('repost'), lag),
          ...(likesOff ? { views: hidden('view') } : optional(m.play_count, lag) && { views: optional(m.play_count, lag) }),
          ...(optional(m.save_count, lag) && { saves: optional(m.save_count, lag) }),
        },
      };
    },
  };
}

// PARKED: scrapecreators (and the account lookup in it, PARKED: followers)
// // ---- ScrapeCreators: fastest for accounts, and the backup for live numbers ----
// const limitCalls = createLimiter(5);
// const scrapeCreators = (path: string) => limitCalls(() => requestJson(`https://api.scrapecreators.com/v1/instagram${path}`, { headers: { 'x-api-key': config.scrapeCreatorsKey } }, 60_000));
// const scReady = () => !!config.scrapeCreatorsKey;
// const sc: Source = {
//   ready: scReady,
//   post: async (link) => {
//     const m = (await scrapeCreators(`/post?url=${encodeURIComponent(link.url)}`))?.data?.xdt_shortcode_media;
//     if (m?.shortcode !== link.shortcode) throw new Error('ScrapeCreators returned no result for this post');
//     const hide = m.like_and_view_counts_disabled === true;
//     return { owner: m.owner?.username, type: m.product_type, posted: seconds(m.taken_at_timestamp), counts: { likes: hide ? hidden('like') : count(m.edge_media_preview_like?.count, NOT_READ), comments: count(m.edge_media_to_parent_comment?.count ?? m.comment_count, NOT_READ), ...(!hide && optional(m.video_play_count) && { views: optional(m.video_play_count) }) } };
//   },
//   account: async (username) => {
//     // A saved copy up to a day old: 0.4-2.7 s and no credit, against 9 s live. A new account is still fetched live.
//     const u = (await scrapeCreators(`/profile?handle=${encodeURIComponent(username)}&cache_max_age=1d`))?.data?.user;
//     if (typeof u?.username !== 'string' || u.username.toLowerCase() !== username) throw new Error('ScrapeCreators returned no result for this account');
//     return { owner: u.username, counts: { followers: count(u.edge_followed_by?.count, NOT_READ), following: count(u.edge_follow?.count, NOT_READ), postsCount: count(u.edge_owner_to_timeline_media?.count, NOT_READ) } };
//   },
// };

export const SOURCES: Record<string, Source> = {
  checker,
  apify,
  // PARKED: scrapecreators
  // scrapecreators: sc,
  // Third-party actors stay on a known version, so a change on their side can't reach us unnoticed.
  postdetails: actorSource('data-slayer~instagram-post-details', '1.0.37'),
  postmetrics: actorSource('patient_discovery~instagram-reel-analytics-by-url', '1.0.6'),
};

// `first` runs alone. Only if it fails do the backups run: each list is a job, all jobs run together, and in a list the next source only runs if one fails.
// PARKED: scrapecreators, PARKED: followers
// export const ROUTE = { post: [['apify', 'scrapecreators'], ['postdetails', 'postmetrics']], account: ['scrapecreators', 'apify'] };
export const ROUTE = { first: 'checker', backup: [['apify'], ['postdetails', 'postmetrics']] };
// Live sources first, so an actor's number is only used if nothing live answered.
// PARKED: scrapecreators
// export const TRUST = ['apify', 'scrapecreators', 'postdetails', 'postmetrics'];
export const TRUST = ['checker', 'apify', 'postdetails', 'postmetrics'];
// The most one link can cost from each source, on Apify's free plan as of 5 Nov 2026. It feeds the daily limit, so it errs high.
export const COST_USD: Record<string, number> = { checker: 0.0011, apify: 0.0027, postdetails: 0.0045, postmetrics: 0.0045 };
