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
  /**
   * AQU-2143: the `recompute` callbacks of the callers merged into `pending`,
   * in arrival order, capped at `MAX_PASS_ATTEMPTS`. The pass takes the first
   * (the starter's, as before) and falls back to the next when one fails.
   * Drained with `pending`, so no closure — and no request's connection — is
   * retained past the pass that uses it.
   */
  pendingRecomputes: Array<(drained: CounterImpact) => Promise<unknown>>
  /** The pass that will drain `pending`; null once it has drained. */
  nextRun: Promise<unknown> | null
  /** The pass currently executing; null when idle. */
  current: Promise<unknown> | null
}

/**
 * AQU-2143: how many of a pass's co-committers may be asked to run it.
 *
 * A pass runs on the connection of ONE of the requests it answers, and that
 * request can be gone — the client aborts the POST at its 15 s timeout and the
 * request-scoped `AQUILLA_PG` connection closes under the pass. With no
 * fallback, that one dead connection sank the counters of every co-committer
 * sharing the pass, which during a bulk validate (a burst where roughly a
 * third of the POSTs abort) is how a file's progress rows stayed at their
 * pre-burst state: the passes that would have rewritten them died with the
 * requests that happened to start them.
 *
 * Three is enough that a burst with a large aborted fraction still finds a
 * live connection on the first retry, and small enough that a genuinely
 * unreachable database costs a pass three attempts rather than one per sharer.
 */
const MAX_PASS_ATTEMPTS = 3

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
 * AQU-2143: run one pass, falling back to a co-committer's `recompute` when the
 * one it tried fails.
 *
 * Every candidate is a caller that AWAITS this pass (callbacks are registered
 * by callers that go on to return its promise), so each one's request-scoped
 * connection is live for the pass's lifetime unless that request itself died —
 * which is exactly the failure being recovered from. A later attempt therefore
 * starts strictly after every merged caller's commit, so the snapshot contract
 * above holds for it as it does for the first.
 *
 * Only when every candidate fails does the pass reject: the counters really are
 * behind for all of them, and the caller logs it (route.ts) without
 * un-accepting the durably committed events.
 */
async function runPass<R>(
  drained: CounterImpact,
  candidates: ReadonlyArray<(drained: CounterImpact) => Promise<unknown>>,
): Promise<R> {
  const attempts = Math.min(candidates.length, MAX_PASS_ATTEMPTS)
  let lastErr: unknown
  for (let i = 0; i < attempts; i += 1) {
    try {
      return (await candidates[i](drained)) as R
    } catch (err) {
      lastErr = err
    }
  }
  throw lastErr
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
 * AQU-2143: unless that caller's own request is torn down mid-pass, which the
 * client's 15 s abort does to a third of the POSTs in a bulk-validate burst.
 * So a failing pass is retried on a co-committer's `recompute` before it
 * rejects (`runPass`, up to `MAX_PASS_ATTEMPTS`) — a dead connection costs the
 * pass an attempt instead of costing every sharer its counters.
 *
 * For the same reason, what a pass LEARNS must travel as its return value:
 * `recompute`'s result is handed to every caller the pass answers, including
 * the ones whose own `recompute` never ran. (Callers sharing a file must
 * therefore agree on `R`; there is one callback shape, in route.ts.) AQU-1832
 * needs the timestamp a pass stamped its rows with in order to read back what
 * it wrote, and a request answered by someone else's pass has no other way to
 * learn it.
 *
 * The cost of sharing is that a pass fails for all of its sharers only when
 * every connection it can reach for is gone (AQU-2143 narrowed this from "one
 * request's connection failing"). That is the existing post-commit contract
 * either way — the events are durable, the failure is logged loudly and never
 * reported as a rejected write, and the next commit on the file restores the
 * counts. A replayed retry now counts as such a commit, so a burst whose last
 * batches were aborted and retried heals itself (route.ts).
 */
export function coalesceFileCounterRecompute<R>(
  impact: CounterImpact,
  recompute: (drained: CounterImpact) => Promise<R>,
): Promise<R> {
  const key = `${impact.projectId}|${impact.fileId}`
  let slot = slots.get(key)
  if (!slot) {
    slot = { pending: null, pendingRecomputes: [], nextRun: null, current: null }
    slots.set(key, slot)
  }
  const s = slot

  if (s.pending) mergeImpact(s.pending, impact)
  else s.pending = copyImpact(impact)

  // Registered before the early-out below, so a caller that only JOINS a queued
  // pass still offers its connection as a fallback for it.
  if (s.pendingRecomputes.length < MAX_PASS_ATTEMPTS) s.pendingRecomputes.push(recompute)

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
      const candidates = s.pendingRecomputes.length > 0 ? s.pendingRecomputes : [recompute]
      s.pending = null
      s.pendingRecomputes = []
      s.nextRun = null
      const current = runPass<R>(drained, candidates).finally(() => {
        if (s.current === current) s.current = null
        if (!s.pending && !s.pendingRecomputes.length && !s.nextRun && !s.current && slots.get(key) === s) {
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
