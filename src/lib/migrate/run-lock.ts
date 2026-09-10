// Cross-machine mutual exclusion for `migrate-all.ts --apply`.
//
// WHY: the GitHub workflow's `concurrency:` group only serialises Actions runs.
// A local `--apply` (the old 15-minute crontab) could still overlap a nightly
// run, and two writers interleaving /migrate/ingest + the shared
// `.migrate-state.json` corrupt the delta state. The lock is a small JSON
// object in R2 next to the state file; it is leased (TTL) so a crashed holder
// cannot wedge the sync forever, and heartbeat-renewed so a healthy long run
// keeps it.
//
// Pure over an injectable object store so the protocol is unit-tested without R2.

export interface LockStore {
  get(key: string): Promise<string | null>
  /** Create-only when `ifNoneMatch`; must throw with `status: 412` if the key exists. */
  put(key: string, body: string, opts?: { ifNoneMatch?: boolean }): Promise<void>
  delete(key: string): Promise<void>
}

export interface LockRecord {
  holder: string
  acquiredAt: string
  /** ISO timestamp after which the lease is considered abandoned. */
  expiresAt: string
}

export interface RunLockOptions {
  store: LockStore
  key: string
  holder: string
  /** Lease length in ms. Renewed by `heartbeat()`; a run that outlives it without
   *  renewing loses exclusivity. */
  ttlMs: number
  now?: () => number
}

export class LockHeldError extends Error {
  readonly record: LockRecord
  constructor(record: LockRecord) {
    super(
      `migrate lock is held by ${record.holder} (acquired ${record.acquiredAt}, lease expires ${record.expiresAt}). ` +
        "Another --apply run is in progress; wait for it or let the lease expire.",
    )
    this.name = "LockHeldError"
    this.record = record
  }
}

const parseRecord = (raw: string | null): LockRecord | null => {
  if (!raw) return null
  try {
    const r = JSON.parse(raw) as Partial<LockRecord>
    if (typeof r.holder === "string" && typeof r.expiresAt === "string" && typeof r.acquiredAt === "string") {
      return r as LockRecord
    }
  } catch {
    /* corrupt lock → treat as absent */
  }
  return null
}

const isConflict = (e: unknown): boolean =>
  typeof e === "object" && e !== null && (e as { status?: number }).status === 412

export class RunLock {
  private readonly o: RunLockOptions
  private readonly now: () => number
  private held = false
  constructor(o: RunLockOptions) {
    this.o = o
    this.now = o.now ?? Date.now
  }

  private record(): LockRecord {
    const t = this.now()
    return {
      holder: this.o.holder,
      acquiredAt: new Date(t).toISOString(),
      expiresAt: new Date(t + this.o.ttlMs).toISOString(),
    }
  }

  /** @throws LockHeldError when a live lease belongs to someone else. */
  async acquire(): Promise<void> {
    const existing = parseRecord(await this.o.store.get(this.o.key))
    if (existing && Date.parse(existing.expiresAt) > this.now()) throw new LockHeldError(existing)
    if (existing) await this.o.store.delete(this.o.key) // expired lease — reclaim
    try {
      await this.o.store.put(this.o.key, JSON.stringify(this.record()), { ifNoneMatch: true })
    } catch (e) {
      if (!isConflict(e)) throw e
      // Lost the race between our GET and PUT.
      const winner = parseRecord(await this.o.store.get(this.o.key))
      throw winner ? new LockHeldError(winner) : e
    }
    this.held = true
  }

  /** Extend the lease. No-op unless held. */
  async heartbeat(): Promise<void> {
    if (!this.held) return
    await this.o.store.put(this.o.key, JSON.stringify(this.record()))
  }

  async release(): Promise<void> {
    if (!this.held) return
    this.held = false
    await this.o.store.delete(this.o.key)
  }
}
