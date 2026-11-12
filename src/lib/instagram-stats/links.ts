// Turns any form of an Instagram link into one clean link: phone, PC, tracking, or inside a sentence.
import { RefusedLink, type Link } from './types';

export const USERNAME = /^(?!\.+$)[A-Za-z0-9._]{1,30}$/;
const SHORTCODE = /^[A-Za-z0-9_-]{5,80}$/;
const BASE = 'https://www.instagram.com';
const NO_STATS = "public like or comment counts, so there's nothing to read.";

// No inherited keys: "constructor" in a link must not find something on Object.prototype.
const table = <T>(entries: Record<string, T>): Record<string, T | undefined> => Object.assign(Object.create(null), entries);
const MEDIA = table<Link['kind']>({ p: 'post', reel: 'reel', reels: 'reel', tv: 'tv' });
const REFUSED = table({
  stories: `This is a Story link. Stories have no ${NO_STATS}`,
  s: `This is a Story Highlight link. Highlights have no ${NO_STATS}`,
  explore: 'This is an Explore or hashtag page, not one post or account.',
  direct: 'This is a private message link.',
  reels: 'This is the general Reels feed. Open the reel and copy its own link.',
  accounts: 'This is an Instagram login or settings page.',
});
const RESERVED = new Set('p reel tv share about legal developer api graphql web oauth emails directory lite press privacy terms challenge login logout nojs 404 session coming_soon signup help suspended blocked ajax locations nametag tags popular'.split(' '));

const IN_TEXT = /(?<![\w.\-/=%?&@:#;,!~*$+|])(?:https?:\/\/)?(?:[a-z0-9-]+\.)*(?:instagram\.com|instagr\.am)(?![a-z0-9-]|\.[a-z0-9])(?:\/[^\s<>"']*|[?#][^\s<>"']*)?/i;
const refuse = (message: string) => new RefusedLink(message);
const notInstagram = (input: string) => refuse(`This doesn't look like an Instagram link: ${input}`);

const profile = (name: string): Link => ({ kind: 'profile', username: name.toLowerCase(), url: `${BASE}/${name.toLowerCase()}/` });

function media(kind: Link['kind'], shortcode: string, username?: string): Link {
  if (!SHORTCODE.test(shortcode)) throw refuse(`The post ID in this link doesn't look right: ${shortcode}`);
  return { kind, shortcode, username, url: `${BASE}/${kind === 'post' ? 'p' : kind}/${shortcode}/` };
}

function fromPath(url: URL, depth: number): Link {
  if (depth > 3) throw refuse('This link redirects through too many layers.');
  let parts = url.pathname.split('/').filter(Boolean);
  if (parts[0] === '_u' || parts[0] === '_n') parts = parts.slice(1);
  if (!parts.length) throw refuse('This is the Instagram home page. Paste a post, reel or profile link.');
  const first = parts[0].toLowerCase();

  const next = url.searchParams.get('next'); // A login wall keeps the real destination here.
  if (first === 'accounts' && next?.startsWith('/')) return fromPath(new URL(BASE + next), depth + 1);
  if (first === 'share') {
    if (parts.length < 2) throw refuse('This share link is incomplete.');
    return { kind: 'share', url: `${BASE}/${parts.join('/')}/` };
  }
  if (first === 'reels' && parts[1]?.toLowerCase() === 'audio') throw refuse('This is a Reels audio page. Open the reel and copy its own link.');
  if (first === 'stories' && parts[1]?.toLowerCase() === 'highlights') throw refuse(REFUSED.s!);

  for (let i = 0; i < Math.min(parts.length - 1, 2); i++) {
    const kind = MEDIA[parts[i].toLowerCase()];
    if (kind) return media(kind, parts[i + 1], i === 1 && USERNAME.test(parts[0]) ? parts[0].toLowerCase() : undefined);
  }
  if (REFUSED[first]) throw refuse(REFUSED[first]!);
  if (RESERVED.has(first)) throw refuse(`/${first}/ is an Instagram page, not a post or profile.`);
  if (!USERNAME.test(parts[0])) throw refuse(`The username in this link doesn't look right: ${parts[0]}`);
  if (parts[1]?.toLowerCase() === 'live') throw refuse(`This is a Live video link. Live videos have no ${NO_STATS}`);
  return profile(parts[0]);
}

export function parseLink(raw: string, depth = 0): Link {
  if (depth > 3) throw refuse('This link redirects through too many layers.');
  if (raw.length > 4096) throw refuse('This text is too long to be a link.');
  const input = raw.replace(/[​-‍⁠﻿]/g, '').trim();
  if (!input) throw refuse('The link is empty.');

  const bare = input.replace(/^@/, '');
  if (/^\.+$/.test(bare)) throw notInstagram(input);
  if (USERNAME.test(bare) && !/\.(com|am)$/i.test(bare)) {
    if (RESERVED.has(bare.toLowerCase()) || REFUSED[bare.toLowerCase()]) throw refuse(`"${bare}" is an Instagram page name, not an account.`);
    return profile(bare);
  }
  const short = input.match(/^\/?(p|reel|reels|tv)\/([A-Za-z0-9_-]+)\/?$/i);
  if (short) return media(MEDIA[short[1].toLowerCase()]!, short[2]);

  const hit = input.match(IN_TEXT);
  if (!hit) throw /linkedin|tiktok|youtu|facebook|fb\.watch|twitter|x\.com/i.test(input) ? refuse('Only Instagram links work right now.') : notInstagram(input);
  if ((input.slice(0, hit.index).split(/\s/).pop() ?? '').includes('://')) throw notInstagram(input); // Inside another site's URL.
  const found = hit[0].replace(/[.,;:!?)\]}>'"]+$/, '');
  if (/\/(?:\.|%2e){1,2}(?:\/|$)/i.test(found)) throw refuse(`This link is malformed: ${input}`);

  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(found) ? found : `https://${found}`);
  } catch {
    throw refuse(`This link is malformed: ${input}`);
  }
  if (!/^(?:(?:www|m|l)\.)?(?:instagram\.com|instagr\.am)$/i.test(url.hostname)) throw refuse(`${url.hostname} is an Instagram support site, not a post or profile.`);
  if (/^l\./i.test(url.hostname)) {
    const target = url.searchParams.get('u'); // l.instagram.com wraps links clicked inside Instagram.
    if (!target || !IN_TEXT.test(target)) throw refuse('This Instagram redirect points outside Instagram.');
    return parseLink(target, depth + 1);
  }
  return fromPath(url, 0);
}
