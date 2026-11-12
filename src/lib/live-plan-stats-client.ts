// The page's side of the stats route: reads the answer as it arrives, and keeps asking until every link has one.
import type { StatsLine } from "@/lib/live-plan-metrics";

const MAX_PER_REQUEST = 500;
const MAX_STALLED = 10; // Requests in a row with no new answer before the page stops asking.
const pause = (ms: number) => new Promise(done => setTimeout(done, ms));

export const NO_ANSWER = "No answer right now. Please retry";

/** Raised for an answer that asking again can't change, such as the Refresh limit. */
export class StatsRequestError extends Error {}

async function readLines(res: Response, onLine: (line: Record<string, unknown>) => void) {
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += value;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    lines.filter(Boolean).forEach(line => onLine(JSON.parse(line)));
  }
}

/**
 * mode "attach" pays only for links with no usable answer. mode "refresh" pays for each link once.
 * Without `links` the server uses every link on the plan. Returns the links that never got an answer.
 */
export async function fetchPlanStats(opts: {
  planId: string;
  mode: "attach" | "refresh";
  links?: string[];
  onLine: (line: StatsLine) => void;
}): Promise<string[]> {
  const { planId, mode, onLine } = opts;
  // Sent again if the connection is cut, so resuming never uses up another Refresh or pays twice.
  const refreshId = mode === "refresh" ? crypto.randomUUID() : undefined;
  const answered = new Set<string>();
  const known = new Set<string>(opts.links ?? []);
  let todo = opts.links ? [...opts.links] : null; // null: the server picks. Not started yet.
  let waiting: string[] = []; // May have started on the server. Asking again joins them, and never pays twice.
  let stalled = 0;

  while ((todo === null || todo.length || waiting.length) && stalled < MAX_STALLED) {
    const batch = todo === null ? undefined : todo.splice(0, MAX_PER_REQUEST);
    const wait = waiting;
    const before = answered.size;
    const firstAsk = todo === null;
    if (firstAsk) todo = [];
    waiting = [];
    try {
      const res = await fetch("/api/distro/live-plan-stats", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planId, mode, links: batch, wait, refreshId }),
      });
      if (!res.ok) throw new StatsRequestError(((await res.json().catch(() => ({}))) as { error?: string }).error || "Stats could not be fetched.");
      await readLines(res, line => {
        if (Array.isArray(line.more)) {
          todo = [...(line.more as string[]), ...(todo ?? [])];
          waiting = [...waiting, ...((line.wait as string[]) ?? [])];
          [...(line.more as string[]), ...waiting].forEach(raw => known.add(raw));
          return;
        }
        const stat = line as unknown as StatsLine;
        known.add(stat.link);
        if (stat.done) answered.add(stat.link);
        onLine(stat);
      });
    } catch (e) {
      if (e instanceof StatsRequestError) throw e;
      // A connection that ended early says nothing about the links it didn't answer. They're asked for again.
      if (firstAsk && !known.size) todo = null;
    }
    const told = new Set([...(todo ?? []), ...waiting]);
    waiting = [...waiting, ...[...(batch ?? []), ...wait].filter(raw => !answered.has(raw) && !told.has(raw))];
    stalled = answered.size > before ? 0 : stalled + 1;
    if (stalled) await pause(2000);
  }
  return [...known].filter(raw => !answered.has(raw));
}
