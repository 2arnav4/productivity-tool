// Two small tools for paid calls: a limit on how many run at once, and batching links that arrive together.
export function createLimiter(max: number) {
  let running = 0;
  const waiting: (() => void)[] = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (running >= max) await new Promise<void>((resolve) => waiting.push(resolve));
    else running++;
    try {
      return await fn();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else running--;
    }
  };
}

type Caller<R> = { resolve: (value: R) => void; reject: (reason: unknown) => void };

/** run gets unique keys and returns the answer per key. A key with no answer fails alone. */
export function createBatcher<R>(windowMs: number, maxSize: number, run: (keys: string[]) => Promise<Map<string, R>>, notFound: string) {
  let batch = new Map<string, Caller<R>[]>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    clearTimeout(timer);
    timer = undefined;
    const current = batch;
    batch = new Map();
    run([...current.keys()]).then(
      (answers) => current.forEach((callers, key) => callers.forEach((c) => (answers.has(key) ? c.resolve(answers.get(key)!) : c.reject(new Error(notFound))))),
      (e) => current.forEach((callers) => callers.forEach((c) => c.reject(e))),
    );
  };
  return (key: string) =>
    new Promise<R>((resolve, reject) => {
      batch.set(key, [...(batch.get(key) ?? []), { resolve, reject }]);
      if (batch.size >= maxSize) flush();
      else timer ??= setTimeout(flush, windowMs);
    });
}
