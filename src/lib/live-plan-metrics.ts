// A plan row's numbers, worked out from each link's answer. Used in the browser and on the server, so no scraper code or keys here.

export const STATS = [
  { key: "views", label: "Views" },
  { key: "likes", label: "Likes" },
  { key: "comments", label: "Comments" },
  { key: "shares", label: "Shares" },
  { key: "reposts", label: "Reposts" },
  { key: "engagement", label: "Engagement" },
] as const;

export type StatKey = (typeof STATS)[number]["key"];
type CountedKey = Exclude<StatKey, "engagement">;
const ENGAGEMENT_PARTS: CountedKey[] = ["likes", "comments", "shares"];
const NOT_FETCHED = "Stats not fetched yet";
const NO_LINK = "No live link yet";

/**
 * Why a stat has no number, so the table can show a different icon for each case.
 * - failed: the link itself can't give stats (post not found, private or deleted, not a post link). Retrying won't help.
 * - hidden: the owner hid this count on Instagram.
 * - na: Instagram doesn't show this count for this kind of post (views on photos and carousels).
 * - retry: on our side or still waiting: not fetched yet, a source failed, daily limit, held numbers. Retrying or waiting can help.
 */
export type MissingKind = "failed" | "hidden" | "na" | "retry";

// Matched against the server's own wording. Anything not matched counts as "retry", so a new message never shows as a red failure by mistake.
const OWNER_HID = /owner has hidden/i;
const NOT_SHOWN_FOR_TYPE = /^not applicable|only report views on reels and videos/i;
const POST_GONE = /^post not found/i;

export function missingKind(reason: string | undefined, flags: { hidden?: boolean; notShown?: boolean; unusable?: boolean } = {}): MissingKind {
  if (flags.hidden || (reason && OWNER_HID.test(reason))) return "hidden";
  if (flags.notShown || (reason && NOT_SHOWN_FOR_TYPE.test(reason))) return "na";
  if (flags.unusable || (reason && POST_GONE.test(reason))) return "failed";
  return "retry";
}

/** One line from the stats route. */
export interface StatsLine {
  link: string;
  url?: string;
  key?: string;
  metrics?: Partial<Record<CountedKey, { value: number | null; note?: string; hidden?: boolean; notShown?: boolean }>>;
  done?: boolean;
  savedAt?: string;
  warning?: string;
  error?: string;
  unusable?: boolean;
}

/** Stats for one live link. A null stat means unavailable, never 0. */
export type LinkMetrics = Partial<Record<CountedKey, number | null>> & {
  key?: string; // The post it points to, so two forms of one link count once.
  notes?: Partial<Record<CountedKey, string>>;
  hidden?: Partial<Record<CountedKey, true>>; // Counts the owner hid on Instagram.
  notShown?: Partial<Record<CountedKey, true>>; // Counts Instagram doesn't show for this type of post.
  error?: string; // Nothing could be read.
  warning?: string; // Numbers are shown, but something about them isn't current.
  unusable?: boolean; // Retrying can't help.
  fetched_at?: string;
};

export type MetricsByLink = Record<string, LinkMetrics>;

export function lineToMetrics(line: StatsLine): LinkMetrics {
  const out: LinkMetrics = { key: line.key, notes: {}, error: line.error, warning: line.warning, unusable: line.unusable, fetched_at: line.savedAt };
  for (const [name, count] of Object.entries(line.metrics ?? {}) as [CountedKey, { value: number | null; note?: string; hidden?: boolean; notShown?: boolean }][]) {
    out[name] = count.value;
    if (count.note) out.notes![name] = count.note;
    if (count.hidden) (out.hidden ??= {})[name] = true;
    if (count.notShown) (out.notShown ??= {})[name] = true;
  }
  return out;
}

interface RowWithLinks {
  live_links?: string[] | null;
  quantity?: number | null;
  metrics?: MetricsByLink | null;
}

interface ExportRow extends RowWithLinks {
  handle_name: string;
  category?: string | null;
  followers?: number | null;
  quantity: number;
  total_cost?: number | null;
  verified: boolean;
  paid: boolean;
}

// live_links is jsonb that any signed-in user can write, so anything that isn't a text link is skipped rather than crashing the plan.
// Only the row's first `quantity` slots are shown and editable, so links past them are left out of fetches and totals.
export const currentLinks = (row: RowWithLinks) => {
  const all = Array.isArray(row.live_links) ? (row.live_links as unknown[]) : [];
  const slots = typeof row.quantity === "number" && row.quantity >= 0 ? all.slice(0, row.quantity) : all;
  return slots.filter((l): l is string => typeof l === "string" && l.trim() !== "");
};

/** A row's links, one per post: the same post pasted twice, even as /p/ and /reel/, counts once. */
function rowPosts(row: RowWithLinks) {
  const seen = new Set<string>();
  const posts: { link: string; m?: LinkMetrics }[] = [];
  for (const link of currentLinks(row)) {
    const m = row.metrics?.[link];
    const id = m?.key ?? link;
    if (seen.has(id)) continue;
    seen.add(id);
    posts.push({ link, m });
  }
  return posts;
}

/** A row's total for one stat across its current live links. A real 0 stays 0, and missing is never counted as 0. */
export function rowStat(row: RowWithLinks, key: StatKey): { value: number | null; reason?: string; partial?: boolean; kind?: MissingKind } {
  if (key === "engagement") {
    const parts = ENGAGEMENT_PARTS.map(k => ({ k, stat: rowStat(row, k) }));
    const counted = parts.filter(p => p.stat.value !== null);
    if (!counted.length) return { value: null, reason: parts[0].stat.reason || NOT_FETCHED, kind: parts[0].stat.kind };
    const incomplete = parts.filter(p => p.stat.value === null || p.stat.partial).map(p => p.k);
    return {
      value: counted.reduce((sum, p) => sum + (p.stat.value as number), 0),
      partial: incomplete.length > 0,
      reason: incomplete.length ? `Likes + comments + shares. Incomplete: ${incomplete.join(", ")}` : "Likes + comments + shares",
    };
  }
  const posts = rowPosts(row);
  // Nothing pasted yet: there's nothing to fetch or retry, so no icon, just a plain dash.
  if (!posts.length) return { value: null, reason: NO_LINK };
  const values = posts.map(p => p.m?.[key]).filter((v): v is number => typeof v === "number");
  const flagged = posts.map(p => p.m?.warning).filter(Boolean).join(" ");
  if (values.length > 0) {
    const value = values.reduce((sum, v) => sum + v, 0);
    const missing = posts.length - values.length;
    // A total that leaves out a link must not read as complete: it gets compared against promised numbers
    const reason = [missing > 0 ? `${missing} of ${posts.length} links missing` : "", flagged].filter(Boolean).join(". ");
    return missing > 0 || flagged ? { value, partial: true, reason } : { value };
  }
  // The reason and its kind come from the same link, so the icon always matches the hover text.
  const noted = posts.find(p => p.m?.notes?.[key] || p.m?.hidden?.[key] || p.m?.notShown?.[key]);
  if (noted) return { value: null, reason: noted.m!.notes?.[key], kind: missingKind(noted.m!.notes?.[key], { hidden: noted.m!.hidden?.[key], notShown: noted.m!.notShown?.[key] }) };
  const failed = posts.find(p => p.m?.error);
  if (failed) return { value: null, reason: failed.m!.error, kind: missingKind(failed.m!.error, { unusable: failed.m!.unusable }) };
  return { value: null, reason: NOT_FETCHED, kind: "retry" };
}

/** When the row's numbers were last fetched, oldest first, since that's the one that matters when checking a deliverable. */
export function rowFetchedAt(row: RowWithLinks): string | undefined {
  const times = rowPosts(row).map(p => p.m?.fetched_at).filter((t): t is string => !!t);
  return times.sort()[0];
}

/** The whole plan in the table's order and columns. Excel and the Drive Sheet both use this, so they can't drift apart. */
export function planExportRows(items: ExportRow[]) {
  const categoryOf = (i: ExportRow) => i.category || "Uncategorised";
  const categories = [...new Set(items.map(categoryOf))];
  const ordered = categories.flatMap(c => items.filter(i => categoryOf(i) === c));
  return ordered.map((i, k) => {
    const links = currentLinks(i);
    return {
      "#": k + 1,
      "Page / Creator": i.handle_name,
      "Followers": i.followers ?? "",
      "Deliv.": `${Math.min(links.length, i.quantity)}/${i.quantity}`,
      "Payout": i.total_cost ?? "",
      "Live Links": links.join("\n"),
      ...Object.fromEntries(STATS.map(s => [s.label, rowStat(i, s.key).value ?? ""])),
      "Verified": i.verified ? "Yes" : "No",
      "Paid": i.paid ? "Yes" : "No",
    } as Record<string, string | number>;
  });
}
