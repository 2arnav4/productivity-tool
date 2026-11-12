// A small stand-in for outgoing calls, so no test can reach a real service. Anything not expected fails.
type Matcher = RegExp | string | ((path: string) => boolean);
interface Expected { origin: string; path: Matcher; method: string; status: number; body: unknown; headers: Record<string, string>; persist: boolean; used: boolean; error?: Error; delayMs?: number; responder?: () => { statusCode: number; data: string } }

export class MockNet {
  private expected: Expected[] = [];
  private real = globalThis.fetch;
  calls: { url: string; init?: RequestInit }[] = [];

  constructor() {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      this.calls.push({ url: url.toString(), init });
      const path = url.pathname + url.search;
      const hit = this.expected.find((e) => !e.used && e.origin === url.origin && e.method === (init?.method ?? 'GET') && (typeof e.path === 'function' ? e.path(path) : typeof e.path === 'string' ? e.path === path : e.path.test(path)));
      // Nothing expected reads as a refused run: that one source failed, and no real service is ever reached.
      if (!hit) return new Response(JSON.stringify({ error: { message: `Unexpected call in a test: ${path}` } }), { status: 400 });
      if (!hit.persist) hit.used = true;
      if (hit.delayMs) await new Promise((done) => setTimeout(done, hit.delayMs));
      if (hit.error) throw hit.error;
      if (hit.responder) {
        const r = hit.responder();
        return new Response(r.data, { status: r.statusCode });
      }
      const body = typeof hit.body === 'function' ? hit.body({ body: init?.body, path }) : hit.body;
      const text = typeof body === 'string' ? body : JSON.stringify(body);
      return new Response(hit.status >= 300 && hit.status < 400 ? null : text, { status: hit.status, headers: hit.headers });
    }) as typeof fetch;
  }

  get(origin: string) {
    return {
      intercept: ({ path, method = 'GET' }: { path: Matcher; method?: string }) => ({
        reply: (status: number | (() => { statusCode: number; data: string }), body: unknown = '', opts: { headers?: Record<string, string> } = {}) => {
          const e: Expected = { origin, path, method, status: typeof status === 'number' ? status : 200, body, headers: opts.headers ?? {}, persist: false, used: false, ...(typeof status === 'function' && { responder: status }) };
          this.expected.push(e);
          const handle = { persist: () => { e.persist = true; return handle; }, delay: (ms: number) => { e.delayMs = ms; return handle; } };
          return handle;
        },
        replyWithError: (error: Error) => {
          this.expected.push({ origin, path, method, status: 0, body: '', headers: {}, persist: false, used: false, error });
        },
      }),
    };
  }

  /** Calls to scraper actors so far, whose URL matches. */
  count(match: RegExp) {
    return this.calls.filter((c) => match.test(c.url)).length;
  }

  close() {
    globalThis.fetch = this.real;
  }
}
