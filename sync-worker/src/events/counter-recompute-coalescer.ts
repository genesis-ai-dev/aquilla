// AQU-1826: per-file coalescing of the post-commit counter / progress recompute.
//
// `POST /events` defers the `files` counters and the `file_section_progress`
// rows to one pass per file per REQUEST (AQU-1261). That is as far as
// per-request coalescing can go: the pass is a full-file aggregate scan, so ten
// editors saving one cell each in the same 5k-cell file still scan that file ten
// times for ten nearly identical answers, and queue behind each other on the
// same projection rows while they do it (the 200 ms+ lock waits the write-path
// comments report).
//
// This module coalesces ACROSS requests. Concurrent recomputes for one file
// never overlap, and a burst costs at most two passes back to back instead of
// one per request.
//
// The write path's consistency contract is unchanged: "counters are correct by
// the time this request RESPONDS". A caller is always answered by a pass that
// STARTED after its own impact was merged, so that pass reads a snapshot
// containing the caller's committed events. A caller that arrives while a pass
// is already running therefore waits for the NEXT one rather than joining the
// running pass — joining it would answer the caller from a read that predates
// its own commit, which is the AQU-1545 mistake `lib/rerun-single-flight.ts`
// documents.
//
// Unlike that helper, the queued pass does not inherit "the arguments of the
// call that queued it": the impact is a SET (which cells, and whether section
// membership moved), and the section-scope recompute is scoped to exactly the
// cell ids it is given. Callers that join a queued pass must have their cells
// in it or their section rows are silently never rebuilt, so impacts are
// ACCUMULATED and the pass drains everything merged before it started.

/** Which file a committed request touched, and how. */
export interface CounterImpact {
  projectId: string
  fileId: string
  /**
   * A `source.cell.*` event moved section membership, so every section of the
   * file is rebuilt and `cellIds` is irrelevant (it supersedes any per-cell
   * section recompute).
   */
  fullSections: boolean
  /** The cells whose own sections need rebuilding. */
  cellIds: Set<string>
}

interface FileSlot {
  /** Impact merged by callers since the last drain. Drained by `nextRun`. */
  pending: CounterImpact | null
  /** The pass that will drain `pending`; null once it has drained. */
  nextRun: Promise<unknown> | null
  /** The pass currently executing; null when idle. */
  current: Promise<unknown> | null
}

/**
 * Isolate-scoped, keyed by (project, file). Entries are removed as soon as a
 * file goes idle, so a worker that touches many files does not retain a slot
 * per file (cf. `resetChainCacheForTests` in cells-read-route.ts for the same
 * isolate-state convention).
 */
const slots = new Map<string, FileSlot>()

function mergeImpact(into: CounterImpact, from: CounterImpact): void {
  if (from.fullSections) into.fullSections = true
  for (const cellId of from.cellIds) into.cellIds.add(cellId)
}

function copyImpact(impact: CounterImpact): CounterImpact {
  return {
    projectId: impact.projectId,
    fileId: impact.fileId,
    fullSections: impact.fullSections,
    cellIds: new Set(impact.cellIds),
  }
}

/**
 * Run `recompute` for `impact`'s file, coalesced with any concurrent request
 * for the same file.
 *
 * `recompute` receives the accumulated impact of every caller sharing the pass,
 * and runs at most once per file at a time. A rejection propagates to every
 * caller sharing that pass — each one's counters really are behind — and does
 * not stop the next pass from starting.
 *
 * `recompute` is taken from whichever caller STARTED the pass, so it must not
 * close over anything request-specific that outlives that caller. The caller
 * that starts a pass is always one that awaits it, which is what makes the
 * per-request `AQUILLA_PG` connection (opened per request and closed after the
 * response — see index.ts) safe to use: it cannot be closed while a pass built
 * on it is still running.
 *
 * For the same reason, what a pass LEARNS must travel as its return value:
 * `recompute`'s result is handed to every caller the pass answers, including
 * the ones whose own `recompute` never ran. (Callers sharing a file must
 * therefore agree on `R`; there is one callback shape, in route.ts.) AQU-1832
 * needs the timestamp a pass stamped its rows with in order to read back what
 * it wrote, and a request answered by someone else's pass has no other way to
 * learn it.
 *
 * The cost of sharing is that one request's connection failing now leaves its
 * co-committers' counters behind too, for the one request. That is the existing
 * post-commit contract either way — the events are durable, the failure is
 * logged loudly and never reported as a rejected write, and the next commit on
 * the file restores the counts.
 */
export function coalesceFileCounterRecompute<R>(
  impact: CounterImpact,
  recompute: (drained: CounterImpact) => Promise<R>,
): Promise<R> {
  const key = `${impact.projectId}|${impact.fileId}`
  let slot = slots.get(key)
  if (!slot) {
    slot = { pending: null, nextRun: null, current: null }
    slots.set(key, slot)
  }
  const s = slot

  if (s.pending) mergeImpact(s.pending, impact)
  else s.pending = copyImpact(impact)

  // A pass that has not drained yet will carry what we just merged.
  if (s.nextRun) return s.nextRun as Promise<R>

  // `Promise.resolve(...).then(...)` always defers to a microtask, so the
  // assignment to `s.nextRun` below lands BEFORE the drain. Starting the drain
  // synchronously here would clear `s.nextRun` and then have it overwritten
  // with this already-drained pass, and the next caller would be answered by a
  // pass that never saw its cells.
  const nextRun = Promise.resolve(s.current)
    .catch(() => undefined)
    .then(() => {
      const drained = s.pending ?? copyImpact(impact)
      s.pending = null
      s.nextRun = null
      const current = recompute(drained).finally(() => {
        if (s.current === current) s.current = null
        if (!s.pending && !s.nextRun && !s.current && slots.get(key) === s) {
          slots.delete(key)
        }
      })
      s.current = current
      return current
    })
  s.nextRun = nextRun
  return nextRun
}

/** Drop all isolate state. Tests only. */
export function resetFileCounterRecomputeCoalescerForTests(): void {
  slots.clear()
}
