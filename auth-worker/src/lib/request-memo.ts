// Per-request read memo (perf, 2026-09). index.ts attaches a fresh instance
// to the request-scoped env copy; services memoise repeated reads (the
// `projects` row, resolveProjectRole) against it so a route that consults the
// role several times — or sync-token-mint, which read the projects row twice —
// hits Postgres once. When no memo is attached (direct service calls from unit
// tests, the scheduled handler) `memoize` simply runs the loader.
//
// Rejections are NOT retained: a failed load is retried by the next caller.

export interface RequestMemo {
  entries: Map<string, Promise<unknown>>
}

export function createRequestMemo(): RequestMemo {
  return { entries: new Map() }
}

export function memoize<T>(
  memo: RequestMemo | undefined,
  key: string,
  load: () => Promise<T>,
): Promise<T> {
  if (!memo) return load()
  const existing = memo.entries.get(key)
  if (existing) return existing as Promise<T>
  const pending = load()
  memo.entries.set(key, pending)
  pending.catch(() => memo.entries.delete(key))
  return pending
}
