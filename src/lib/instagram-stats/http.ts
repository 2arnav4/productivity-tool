// All outgoing HTTP: timeout, size limit, redirects only on the same host, and no keys in error messages.

/* eslint-disable @typescript-eslint/no-explicit-any -- replies from outside services are checked field by field where they're read */
const MAX_BYTES = 10 * 1024 * 1024;

/**
 * The whole service is unavailable to us: out of money, bad key, too many runs, or it's down.
 * No single link is at fault, so this must never count against one. Nothing here was charged.
 */
export class ServiceProblem extends Error {}
// 403 isn't here: it can be about one scraper's permissions, and a backup can still answer.
const WHOLE_SERVICE = (status: number) => status === 401 || status === 402 || status === 429 || status >= 500;

export async function request(url: string, init: RequestInit, timeoutMs: number): Promise<{ status: number; url: string; text: string }> {
  const host = new URL(url).host;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    let current = url;
    for (let hop = 0; ; hop++) {
      const res = await fetch(current, { ...init, redirect: 'manual', signal: ctrl.signal });
      const location = res.headers.get('location');
      const next = res.status >= 300 && res.status < 400 && location && hop < 5 ? new URL(location, current) : undefined;
      if (next?.protocol === 'https:' && next.host === host) {
        await res.body?.cancel();
        current = next.toString();
        continue;
      }
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of (res.body ?? []) as unknown as AsyncIterable<Uint8Array>) {
        if ((size += chunk.length) > MAX_BYTES) throw new Error(`Response from ${host} is too large`);
        chunks.push(chunk);
      }
      return { status: res.status, url: current, text: Buffer.concat(chunks).toString('utf8') };
    }
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw new Error(`Timed out waiting for ${host}`);
    if ((e as Error).message.includes('too large')) throw e;
    throw new ServiceProblem(`Network error reaching ${host}`); // Never the library's message: it can quote headers, which hold keys.
  } finally {
    clearTimeout(timer);
  }
}

/** No retries: every call here costs money, and a retry would pay again. */
export async function requestJson(url: string, init: RequestInit, timeoutMs: number): Promise<any> {
  const res = await request(url, init, timeoutMs);
  let data: any;
  try {
    data = JSON.parse(res.text);
  } catch {
    if (WHOLE_SERVICE(res.status)) throw new ServiceProblem(`HTTP ${res.status} from ${new URL(url).host}`);
    throw new Error(`${new URL(url).host} sent an unreadable reply (status ${res.status})`);
  }
  if (res.status !== 200 && res.status !== 201) {
    const message = typeof data?.error === 'string' ? data.error : (data?.error?.message ?? data?.message);
    const said = typeof message === 'string' ? message : `HTTP ${res.status} from ${new URL(url).host}`;
    throw WHOLE_SERVICE(res.status) ? new ServiceProblem(said) : new Error(said);
  }
  return data;
}
