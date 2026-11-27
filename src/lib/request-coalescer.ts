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
  /**
   * `joinLatest`: join the newest request for `key` whatever its age — the
   * queued follow-up if there is one, else the one in flight. For a caller
   * that is not reporting a change (a component mounting), so a request
   * already on its way is as fresh an answer as it needs.
   */
  run(key: string, fn: () => Promise<T>, options?: { fresh?: boolean; joinLatest?: boolean }): Promise<T>
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
        if (runOptions?.joinLatest) return current.followUp ?? current.promise
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

let turn = 0
let turnOpen = false

/**
 * A number that is the same for every call made before the current stack
 * unwinds, and different afterwards. React runs all the effects of one commit
 * in one such turn, so "started in this turn" means "started by a sibling that
 * mounted in the same commit", a few microseconds ago.
 */
export function currentSyncTurn(): number {
  if (!turnOpen) {
    turnOpen = true
    turn += 1
    queueMicrotask(() => {
      turnOpen = false
    })
  }
  return turn
}

export interface SameTurnCoalescer<T> {
  run(key: string, fn: () => Promise<T>): Promise<T>
}

/**
 * Shares one request between identical callers that ask in the same
 * synchronous turn, and only those (AQU-2654).
 *
 * This is for a read that several components start when they mount together
 * AND that the same callers re-run to recover or refresh. A window measured
 * in milliseconds cannot tell those apart: a refresh that arrives 100 ms
 * after a request that is hanging would join the hung request, or queue
 * behind it. A caller in a later turn always gets a request of its own.
 */
export function createSameTurnCoalescer<T>(): SameTurnCoalescer<T> {
  const started = new Map<string, { turn: number; promise: Promise<T> }>()
  registry.add(() => started.clear())
  return {
    run(key, fn) {
      const now = currentSyncTurn()
      const existing = started.get(key)
      if (existing && existing.turn === now) return existing.promise
      const entry = { turn: now, promise: fn() }
      started.set(key, entry)
      const forget = () => {
        if (started.get(key) === entry) started.delete(key)
      }
      entry.promise.then(forget, forget)
      return entry.promise
    },
  }
}

/**
 * Module-level shared reads that are not built on a coalescer (the sync-token
 * mint, the project-settings read) register their reset here, so the one
 * `afterEach` in src/test-setup.ts clears them too.
 */
export function registerSharedStateResetForTests(reset: () => void): void {
  registry.add(reset)
}

/** Test-only: drop every coalescer's cache and in-flight state. */
export function resetAllRequestCoalescersForTests(): void {
  for (const reset of registry) reset()
}
