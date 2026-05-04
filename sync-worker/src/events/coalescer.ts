import type { RealtimeMessage, ProjectionTable } from './realtime'

interface CoalescerOptions {
  windowMs?: number      // default 100
  /** Receives the coalesced projection.dirty message ready to broadcast. */
  emit: (msg: Extract<RealtimeMessage, { t: 'projection.dirty' }>) => void
  /**
   * Inject a custom scheduler; defaults to globalThis.setTimeout. Useful for
   * tests (vitest fake timers) and for environments where
   * globalThis.setTimeout has nonstandard behavior.
   */
  setTimeout?: typeof globalThis.setTimeout
  clearTimeout?: typeof globalThis.clearTimeout
}

/**
 * Buffers projection.dirty signals per (project, file) for `windowMs`
 * (default 100ms). On flush, emits one projection.dirty per scope with the
 * union of tables that became dirty during the window.
 *
 * Why coalesce: a burst of validations across 50 cells in a file would
 * otherwise emit 50 separate projection.dirty frames. Clients only need
 * to invalidate the affected file's query keys once.
 *
 * Per-event 'event' messages are NOT coalesced — clients sometimes need
 * per-cell granularity for surgical invalidation. The coalescer only
 * batches the table-level dirty signal.
 */
export class ProjectionDirtyCoalescer {
  private buffer = new Map<string, { project: string; file?: string; tables: Set<ProjectionTable> }>()
  private timer: ReturnType<typeof globalThis.setTimeout> | null = null
  private readonly windowMs: number
  private readonly emit: CoalescerOptions['emit']
  private readonly setTimeoutFn: typeof globalThis.setTimeout
  private readonly clearTimeoutFn: typeof globalThis.clearTimeout

  constructor(opts: CoalescerOptions) {
    this.windowMs = opts.windowMs ?? 100
    this.emit = opts.emit
    this.setTimeoutFn = opts.setTimeout ?? globalThis.setTimeout
    this.clearTimeoutFn = opts.clearTimeout ?? globalThis.clearTimeout
  }

  /** Mark a (project, file) scope dirty for a set of tables. */
  signalDirty(project: string, file: string | undefined, tables: ProjectionTable[]): void {
    const key = scopeKey(project, file)
    const existing = this.buffer.get(key)
    if (existing) {
      for (const t of tables) existing.tables.add(t)
    } else {
      this.buffer.set(key, { project, file, tables: new Set(tables) })
    }
    if (!this.timer) {
      this.timer = this.setTimeoutFn(() => this.flush(), this.windowMs)
    }
  }

  /**
   * Force-flush all buffered scopes. Called at the natural window boundary
   * via the timer, but exposed for tests and for graceful shutdown when the
   * DO hibernates.
   */
  flush(): void {
    if (this.timer) {
      this.clearTimeoutFn(this.timer)
      this.timer = null
    }
    // Snapshot before clearing so re-entrant signalDirty calls (e.g. inside
    // emit) start a fresh window rather than getting silently discarded.
    const entries = [...this.buffer.values()]
    this.buffer.clear()
    for (const { project, file, tables } of entries) {
      this.emit({
        v: 1,
        t: 'projection.dirty',
        project,
        ...(file !== undefined ? { file } : {}),
        tables: [...tables],
      })
    }
  }

  /** For tests / instrumentation. Returns true if any scope is buffered. */
  hasPending(): boolean {
    return this.buffer.size > 0
  }
}

/**
 * Build a stable string key for a (project, file) scope.
 *
 * Assumes project IDs and file IDs do not contain null bytes. Realistic ID
 * generators (UUIDs, slugs) satisfy this. Using \0 as the separator means
 * no normal fileId can produce a collision with the undefined sentinel.
 */
function scopeKey(project: string, file: string | undefined): string {
  return file === undefined ? `${project}\0` : `${project}\0${file}`
}
