// Module-level request coalescer: shares one in-flight request between
// concurrent identical callers (and optionally caches the settled value for a
// short TTL). Used where the same read is mounted more than once in a tab
// (useFileAudioAttachments ×3 per file, the members roster from
// useProjectMembers + useSetupChecklist) so a mount or a focus wave costs one
// request, not N.
//
// Freshness rule: a caller that arrives while a request is in flight joins it
// only inside `joinWindowMs` of the request's start. A later arrival is a
// "something may have changed" trigger, so it waits for the in-flight request
// and then runs ONE follow-up (shared by every other late arrival). That keeps
// a WS poke from being answered with a response computed before the write it
// announced.

export interface RequestCoalescerOptions {
  /** Cache the settled value for this long; 0 (default) caches nothing. */
  cacheTtlMs?: number
  /** Late arrivals beyond this window queue a follow-up instead of joining. Default: no limit. */
  joinWindowMs?: number
  /** Injectable clock for tests. */
  now?: () => number
}

export interface RequestCoalescer<T> {
  run(key: string, fn: () => Promise<T>, options?: { fresh?: boolean }): Promise<T>
  /** Drop the cached value (and any pending join) for one key, or all keys. */
  invalidate(key?: string): void
}

interface InFlight<T> {
  startedAt: number
  promise: Promise<T>
  followUp: Promise<T> | null
}

const registry = new Set<() => void>()

export function createRequestCoalescer<T>(options: RequestCoalescerOptions = {}): RequestCoalescer<T> {
  const cacheTtlMs = options.cacheTtlMs ?? 0
  const joinWindowMs = options.joinWindowMs ?? Infinity
  const now = options.now ?? (() => Date.now())
  const inFlight = new Map<string, InFlight<T>>()
  const cache = new Map<string, { value: T; expiresAt: number }>()

  function start(key: string, fn: () => Promise<T>): Promise<T> {
    const entry = { startedAt: now(), followUp: null } as InFlight<T>
    entry.promise = fn().then(
      (value) => {
        if (inFlight.get(key) === entry) inFlight.delete(key)
        if (cacheTtlMs > 0) cache.set(key, { value, expiresAt: now() + cacheTtlMs })
        return value
      },
      (err: unknown) => {
        if (inFlight.get(key) === entry) inFlight.delete(key)
        throw err
      },
    )
    inFlight.set(key, entry)
    return entry.promise
  }

  const coalescer: RequestCoalescer<T> = {
    run(key, fn, runOptions) {
      if (!runOptions?.fresh) {
        const hit = cache.get(key)
        if (hit && hit.expiresAt > now()) return Promise.resolve(hit.value)
        if (hit) cache.delete(key)
      }
      const current = inFlight.get(key)
      if (current) {
        if (now() - current.startedAt <= joinWindowMs) return current.promise
        if (!current.followUp) {
          const settled = current.promise.then(() => undefined, () => undefined)
          current.followUp = settled.then(() => start(key, fn))
        }
        return current.followUp
      }
      return start(key, fn)
    },
    invalidate(key) {
      if (key === undefined) {
        cache.clear()
        inFlight.clear()
      } else {
        cache.delete(key)
        inFlight.delete(key)
      }
    },
  }
  registry.add(() => coalescer.invalidate())
  return coalescer
}

/** Test-only: drop every coalescer's cache and in-flight state. */
export function resetAllRequestCoalescersForTests(): void {
  for (const reset of registry) reset()
}
