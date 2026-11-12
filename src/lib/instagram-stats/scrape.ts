// The pipeline: link -> one source for all the numbers -> backups only if it failed -> report.
// PARKED: followers: restore `config` here too.
import { removeKeys } from './config';
import { parseLink, USERNAME } from './links';
import { request, ServiceProblem } from './http';
import { COST_USD, PartialAnswer, PostNotFound, ROUTE, SOURCES, TRUST, type Source } from './sources';
import { METRICS, RefusedLink, SIX, type Count, type Link, type Report, type SourceAnswer } from './types';

/** Anything from outside: no control characters or line breaks, no keys, and a sane length. */
const clean = (v: unknown): string | undefined =>
  typeof v === 'string' ? removeKeys(v.replace(/[\x00-\x1f\x7f-\x9f‎‏‪-‮⁦-⁩]+/g, ' ')).trim().slice(0, 300) || undefined : undefined;

/** /share/ links redirect to the real post. Only a post counts: a login page must never be read as an account. */
export async function resolve(input: string): Promise<Link> {
  const link = parseLink(input);
  if (link.kind !== 'share') return link;
  const res = await request(link.url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, 20_000);
  const canonical = res.text.slice(0, 256_000).match(/<link[^>]{1,500}rel=["']canonical["'][^>]{0,500}href=["']([^"']{1,500})["']/i)?.[1];
  for (const candidate of [res.url, canonical]) {
    try {
      const found = candidate ? parseLink(candidate) : undefined;
      if (found && found.kind !== 'share' && found.kind !== 'profile') return found;
    } catch {
      // Not usable; try the next one.
    }
  }
  throw new RefusedLink('Instagram did not reveal where this share link goes. Open it in a browser and paste the address it lands on.');
}

// PARKED: followers
// // Posts by one account need the same account numbers, so they share one lookup.
// const accounts = new Map<string, { at: number; answer: Promise<SourceAnswer> }>();
// function cachedAccount(name: string, source: Source, username: string): Promise<SourceAnswer> {
//   const key = `${name}:${username}`;
//   const hit = accounts.get(key);
//   if (config.cacheMs && hit && Date.now() - hit.at < config.cacheMs) return hit.answer;
//   const answer = source.account!(username);
//   if (config.cacheMs) {
//     if (accounts.size >= 1000) accounts.delete(accounts.keys().next().value as string);
//     accounts.set(key, { at: Date.now(), answer });
//     answer.catch(() => accounts.delete(key));
//   }
//   return answer;
// }

const hasNumber = (a: SourceAnswer) => Object.values(a.counts).some((c) => c?.value != null);

export async function scrape(input: string, opts: { noAccount?: boolean; onUpdate?: (partial: Report) => void; budget?: (usd: number) => boolean | Promise<boolean | undefined> } = {}): Promise<Report> {
  const link = await resolve(input);
  // PARKED: followers: a profile link only ever gave account numbers.
  if (link.kind === 'profile') throw new RefusedLink('This is a profile link. Followers and following are switched off for now, so add a post or reel link.');
  // PARKED: followers
  // const isPost = link.kind !== 'profile';
  const isPost = true as boolean;
  const answers = new Map<string, SourceAnswer>();
  const sources: Report['sources'] = [];
  const warnings: string[] = [];
  let budgetStopped = false;
  let notFound = false;
  let serviceDown = false;

  const tryInOrder = async (names: string[], call: (s: Source, name: string) => Promise<SourceAnswer>) => {
    for (const name of names) {
      if (!SOURCES[name].ready()) continue;
      if (opts.budget && !(await opts.budget(COST_USD[name]))) {
        budgetStopped = true;
        return false;
      }
      const started = Date.now();
      try {
        const answer = await call(SOURCES[name], name);
        sources.push({ name, ms: Date.now() - started });
        answers.set(name, { ...answers.get(name), ...answer, counts: { ...answers.get(name)?.counts, ...answer.counts } });
        opts.onUpdate?.(build(false));
        if (hasNumber(answer)) return true;
      } catch (e) {
        sources.push({ name, ms: Date.now() - started, error: clean((e as Error).message) ?? 'unknown error' });
        if (e instanceof ServiceProblem) {
          serviceDown = true;
          return false;
        }
        if (e instanceof PartialAnswer) answers.set(name, e.answer);
        if (e instanceof PostNotFound) {
          notFound = true;
          return false;
        }
      }
    }
    return false;
  };
  const reported = () => [...answers.values()].map((a) => a.owner).filter((o): o is string => typeof o === 'string' && USERNAME.test(o)).map((o) => o.toLowerCase());

  // PARKED: followers
  //   // Account numbers start as soon as any source names the owner, so a slow source can't hold them up.
  //   let ownerKnown!: () => void;
  //   const owner = new Promise<void>((done) => (ownerKnown = done));
  //   const postJobs = isPost
  //     ? ROUTE.post.map((names) =>
  //         tryInOrder(names, async (s) => {
  //           const answer = await s.post!(link);
  //           if (typeof answer.owner === 'string' && USERNAME.test(answer.owner)) setTimeout(ownerKnown);
  //           return answer;
  //         }),
  //       )
  //     : [];
  //   const postsDone = Promise.all(postJobs).then(ownerKnown);
  //
  //   const accountJob = (async () => {
  //     if (isPost && opts.noAccount) return;
  //     if (!isPost) ownerKnown();
  //     await owner;
  //     // A username typed into a post link proves nothing: only a source's answer counts.
  //     const username = isPost ? reported()[0] : link.username;
  //     if (username) await tryInOrder(ROUTE.account, (s, name) => cachedAccount(name, s, username));
  //     else warnings.push('The owner could not be worked out, so followers and following were skipped');
  //   })();
  //   await Promise.all([postsDone, accountJob]);
  // Backups are never run alongside the first source, so the same numbers are never paid for twice.
  const answered = await tryInOrder([ROUTE.first], (s) => s.post!(link));
  if (!answered && !notFound && !budgetStopped && !serviceDown) await Promise.all(ROUTE.backup.map((names) => tryInOrder(names, (s) => s.post!(link))));

  return build(true);

  /** A number we expect on this kind of post is there, or the owner hid it. Photos and carousels often have no views or shares. */
  function hasEverything(metrics: Report['metrics']): boolean {
    const isVideo = link.kind === 'reel' || TRUST.some((n) => /clips|reel|video/i.test(String(answers.get(n)?.type ?? '')));
    return (isVideo ? ['views', 'likes', 'comments', 'shares', 'reposts'] : ['likes', 'comments']).every((m) => metrics[m]?.value != null || metrics[m]?.hidden);
  }

  /** The report so far. Before the end, it only holds numbers that won't be replaced by a better source. */
  function build(final: boolean): Report {
    const owners = new Set(reported());
    const conflict = isPost && owners.size > 1;
    const notes = [...warnings];
    if (conflict) notes.push(`Sources disagree on who owns this post (${[...owners].join(', ')})`); // PARKED: followers: this also hid followers and following.
    if (final && !sources.length) notes.push('No source could run. The scraper key is missing');

    const metrics: Report['metrics'] = {};
    const failed = sources.some((s) => s.error);
    for (const metric of METRICS) {
      const accountMetric = metric === 'followers' || metric === 'following' || metric === 'postsCount';
      if (accountMetric) continue; // PARKED: followers
      const said: { source: string; count: Count }[] = [];
      for (const source of TRUST) {
        const c = answers.get(source)?.counts[metric];
        if (c && !(conflict && accountMetric)) said.push({ source, count: c });
      }
      // A source saying the owner hid a count beats another source's number, because that number isn't real.
      const best = said.find((s) => s.count.hidden) ?? said.find((s) => s.count.value != null);
      const onlyActorsHaveIt = metric === 'shares' || metric === 'reposts' || metric === 'saves';
      if (best && !final && best.count.mayLag && !onlyActorsHaveIt) continue; // A live source may still replace it, so a wrong number never flashes up.
      if (best?.count.hidden) metrics[metric] = { ...best.count, source: best.source };
      else if (best) metrics[metric] = { ...best.count, source: best.source, ...(best.count.mayLag && { note: 'may be behind on a busy post' }) };
      else if (final && ((SIX as readonly string[]).includes(metric) || (metric === 'views' && isPost))) {
        const skipped = !isPost && !accountMetric ? 'not applicable: this is a profile link' : isPost && opts.noAccount && accountMetric ? 'skipped' : undefined;
        metrics[metric] = { value: null, note: skipped ?? clean(said[0]?.count.note) ?? (failed ? 'could not be checked, because a source failed' : metric === 'views' ? 'no views returned. Sources only report views on reels and videos' : 'no source returned this') };
      }
    }
    const first = (field: 'type' | 'posted') => TRUST.map((n) => clean(answers.get(n)?.[field])).find(Boolean);
    return { link, owner: isPost ? (conflict ? undefined : reported()[0]) : link.username, type: first('type') ?? link.kind, posted: first('posted'), metrics, sources: [...sources], warnings: notes, notFound, budgetStopped, serviceDown, complete: final && !notFound && !budgetStopped && !serviceDown && !notes.length && hasEverything(metrics) };
  }
}
