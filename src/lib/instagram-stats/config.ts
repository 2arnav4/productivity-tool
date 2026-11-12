// Keys and settings, server only. A line break in a key would end up quoted in error messages, so it's stopped here.

function key(name: string): string {
  const value = process.env[name]?.trim() ?? '';
  if (/[\x00-\x1f\x7f]/.test(value)) throw new Error(`${name} in the environment contains a hidden character. Copy it again.`);
  return value;
}

/** A setting from the environment. Anything that isn't a number of 0 or more falls back to the default, so a typo can't switch off a safety limit. */
export function setting(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return process.env[name] !== undefined && process.env[name] !== '' && Number.isFinite(n) && n >= 0 ? n : fallback;
}

export const config = {
  apifyToken: key('APIFY_TOKEN'),
  // PARKED: scrapecreators
  // scrapeCreatorsKey: key('SCRAPECREATORS_KEY'),
  retryFailedMs: setting('RETRY_FAILED_MS', 30 * 60_000), // First wait after a failed fetch. It doubles each time.
  dailyLimitUsd: setting('DAILY_LIMIT_USD', Infinity), // PARKED: daily limit. Off unless this is set. Estimated spend per UTC day before fetching stops.
  startWindowMs: setting('START_WINDOW_MS', 20_000), // How long one request keeps starting new links.
  responseMs: setting('RESPONSE_MS', 100_000), // A request answers by then, because hosts cut requests at 120 seconds. Work carries on.
  // PARKED: followers (only the account lookups read this)
  // cacheMs: process.env.CACHE_MS !== undefined ? Number(process.env.CACHE_MS) : 30 * 60_000,
  batchWindowMs: process.env.BATCH_WINDOW_MS !== undefined ? Number(process.env.BATCH_WINDOW_MS) : 150,
};

/** Removes our keys from outside text, plain or URL-encoded, in any letter case. */
export function removeKeys(text: string): string {
  let out = text;
  // PARKED: scrapecreators: add config.scrapeCreatorsKey back to this list when restoring it.
  for (const k of [config.apifyToken].filter(Boolean)) {
    for (const form of new Set([k, encodeURIComponent(k), Buffer.from(k).toString('base64')])) out = out.replace(new RegExp(form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '[removed]');
    // A key split up by invisible characters can't be cut out neatly, so the whole message goes.
    if (out.replace(/[\x00-\x20\x7f-\x9f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g, '').toLowerCase().includes(k.toLowerCase())) return '[removed]';
  }
  return out;
}
