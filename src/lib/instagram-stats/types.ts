export const SIX = ['followers', 'following', 'likes', 'comments', 'shares', 'reposts'] as const;
export const METRICS = [...SIX, 'views', 'saves', 'postsCount'] as const;
export type Metric = (typeof METRICS)[number];

export interface Link {
  kind: 'post' | 'reel' | 'tv' | 'profile' | 'share';
  url: string; // One clean URL, whichever form was pasted.
  shortcode?: string;
  username?: string;
}

/** value null = not available, and note says why. It is never turned into 0. */
export interface Count {
  value: number | null;
  note?: string;
  mayLag?: boolean; // From an actor that can return a saved copy.
  hidden?: boolean; // The owner hid it. This beats any number another source reports.
}

export interface SourceAnswer {
  owner?: unknown;
  counts: Partial<Record<Metric, Count>>;
  type?: unknown;
  posted?: unknown;
}

export interface Report {
  link: Link;
  owner?: string;
  type?: string;
  posted?: string;
  metrics: Record<string, Count & { source?: string }>;
  sources: { name: string; ms: number; error?: string }[];
  warnings: string[];
  budgetStopped?: boolean; // Today's spending limit stopped a source from running.
  notFound?: boolean; // The post doesn't exist or can't be seen, so no backup was paid for.
  serviceDown?: boolean; // The whole service refused or failed, so no link is to blame and nothing was charged.
  complete?: boolean; // Every job that ran got an answer, so a gap is a real gap and not a failed source.
}

/** The link is understood but can't give stats. The message says why, in plain words. */
export class RefusedLink extends Error {}
