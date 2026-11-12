// AQU-1826: the per-file coalescer behind the post-commit counter recompute.
//
// The properties that make it safe to share a full-file aggregate pass between
// concurrent requests:
//
//   1. a caller is answered by a pass that STARTED after its impact was merged,
//      so the pass reads a snapshot containing that caller's commit;
//   2. the pass drains the ACCUMULATED impact, so a caller that joins a queued
//      pass still gets its own cells' section rows rebuilt;
//   3. passes for one file never overlap, and a burst costs at most two.

import { afterEach, describe, expect, it } from 'vitest'
import {
  coalesceFileCounterRecompute,
  resetFileCounterRecomputeCoalescerForTests,
  type CounterImpact,
} from '../events/counter-recompute-coalescer'

afterEach(() => {
  resetFileCounterRecomputeCoalescerForTests()
})

function impact(
  fileId: string,
  cellIds: string[],
  fullSections = false,
  projectId = 'p',
): CounterImpact {
  return { projectId, fileId, fullSections, cellIds: new Set(cellIds) }
}

/** A `recompute` whose runs can be settled by hand, recording what it drained. */
function gatedRecompute() {
  const drained: Array<{ fileId: string; cellIds: string[]; fullSections: boolean }> = []
  const gates: Array<{ resolve: () => void; reject: (e: unknown) => void }> = []
  let started = 0
  const recompute = (d: CounterImpact): Promise<void> => {
    started += 1
    drained.push({
      fileId: d.fileId,
      cellIds: [...d.cellIds].sort(),
      fullSections: d.fullSections,
    })
    return new Promise<void>((resolve, reject) => {
      gates.push({ resolve: () => resolve(), reject })
    })
  }
  return { recompute, drained, gates, get started() { return started } }
}

/** Let every pending microtask run. */
const flush = () => new Promise<void>((r) => setTimeout(r, 0))

describe('coalesceFileCounterRecompute', () => {
  it('runs one pass for callers that arrive before it starts, draining every cell', async () => {
    const g = gatedRecompute()
    const a = coalesceFileCounterRecompute(impact('f1', ['c1']), g.recompute)
    const b = coalesceFileCounterRecompute(impact('f1', ['c2']), g.recompute)
    const c = coalesceFileCounterRecompute(impact('f1', ['c3']), g.recompute)
    expect(a).toBe(b)
    expect(b).toBe(c)

    await flush()
    expect(g.started).toBe(1)
    expect(g.drained[0]).toEqual({ fileId: 'f1', cellIds: ['c1', 'c2', 'c3'], fullSections: false })

    g.gates[0].resolve()
    await Promise.all([a, b, c])
  })

  it('answers a caller that arrives mid-pass from the NEXT pass, never the running one', async () => {
    const g = gatedRecompute()
    const first = coalesceFileCounterRecompute(impact('f1', ['c1']), g.recompute)
    await flush()
    expect(g.started).toBe(1)

    // Arrives while the first pass is still running: its cell is NOT in that
    // pass, so joining it would leave c2's section row stale forever.
    const second = coalesceFileCounterRecompute(impact('f1', ['c2']), g.recompute)
    const third = coalesceFileCounterRecompute(impact('f1', ['c3']), g.recompute)
    expect(second).not.toBe(first)
    expect(third).toBe(second)

    await flush()
    expect(g.started).toBe(1) // no overlap: the next pass waits for the first

    g.gates[0].resolve()
    await first
    await flush()

    expect(g.started).toBe(2)
    expect(g.drained[1]).toEqual({ fileId: 'f1', cellIds: ['c2', 'c3'], fullSections: false })
    g.gates[1].resolve()
    await second
    await third
  })

  it('collapses a burst of ten callers into at most two passes', async () => {
    const g = gatedRecompute()
    const calls: Array<Promise<void>> = []
    calls.push(coalesceFileCounterRecompute(impact('f1', ['c0']), g.recompute))
    await flush()
    for (let i = 1; i < 10; i += 1) {
      calls.push(coalesceFileCounterRecompute(impact('f1', [`c${i}`]), g.recompute))
    }
    await flush()
    expect(g.started).toBe(1)

    g.gates[0].resolve()
    await flush()
    expect(g.started).toBe(2)
    expect(g.drained[1].cellIds).toEqual(['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9'])

    g.gates[1].resolve()
    await Promise.all(calls)
    expect(g.started).toBe(2)
  })

  it('carries fullSections through a merge — a source.cell.* event in the burst wins', async () => {
    const g = gatedRecompute()
    const a = coalesceFileCounterRecompute(impact('f1', ['c1']), g.recompute)
    const b = coalesceFileCounterRecompute(impact('f1', [], true), g.recompute)
    await flush()
    expect(g.drained[0].fullSections).toBe(true)
    g.gates[0].resolve()
    await Promise.all([a, b])
  })

  it('does not coalesce different files', async () => {
    const g = gatedRecompute()
    const a = coalesceFileCounterRecompute(impact('f1', ['c1']), g.recompute)
    const b = coalesceFileCounterRecompute(impact('f2', ['c1']), g.recompute)
    expect(a).not.toBe(b)
    await flush()
    expect(g.started).toBe(2)
    expect(g.drained.map((d) => d.fileId).sort()).toEqual(['f1', 'f2'])
    g.gates[0].resolve()
    g.gates[1].resolve()
    await Promise.all([a, b])
  })

  it('does not coalesce the same file id in different projects', async () => {
    const g = gatedRecompute()
    const a = coalesceFileCounterRecompute(impact('f1', ['c1'], false, 'p1'), g.recompute)
    const b = coalesceFileCounterRecompute(impact('f1', ['c1'], false, 'p2'), g.recompute)
    expect(a).not.toBe(b)
    await flush()
    expect(g.started).toBe(2)
    g.gates[0].resolve()
    g.gates[1].resolve()
    await Promise.all([a, b])
  })

  // AQU-2143: a pass runs on ONE caller's request-scoped connection, and that
  // caller's POST can be aborted by its client (15 s) while the pass is still
  // running. It used to take every co-committer's counters down with it, which
  // in a bulk-validate burst is how a file's progress rows stayed at their
  // pre-burst state: the passes that would have rewritten them died with the
  // requests that happened to start them.
  it("retries a failed pass on a co-committer's connection before giving up", async () => {
    const g = gatedRecompute()
    const a = coalesceFileCounterRecompute(impact('f1', ['c1']), g.recompute)
    const b = coalesceFileCounterRecompute(impact('f1', ['c2']), g.recompute)
    await flush()
    expect(g.started).toBe(1)

    // a's connection is torn down under the pass.
    g.gates[0].reject(new Error('connection closed'))
    await flush()

    // The same drained impact, re-run on b's: one attempt, not a new pass.
    expect(g.started).toBe(2)
    expect(g.drained[1]).toEqual({ fileId: 'f1', cellIds: ['c1', 'c2'], fullSections: false })
    g.gates[1].resolve()
    expect(await Promise.all([a, b])).toEqual([undefined, undefined])
  })

  it('propagates the failure once every candidate connection is gone, and still runs the next pass', async () => {
    const g = gatedRecompute()
    const a = coalesceFileCounterRecompute(impact('f1', ['c1']), g.recompute)
    const b = coalesceFileCounterRecompute(impact('f1', ['c2']), g.recompute)
    await flush()

    const queued = coalesceFileCounterRecompute(impact('f1', ['c3']), g.recompute)
    // Both sharers' connections die — the pass has nothing left to run on.
    g.gates[0].reject(new Error('boom'))
    await flush()
    g.gates[1].reject(new Error('boom'))
    await expect(a).rejects.toThrow('boom')
    await expect(b).rejects.toThrow('boom')

    // The queued pass is not cancelled by the failure: c3's counters still need
    // bringing up to date.
    await flush()
    expect(g.started).toBe(3)
    expect(g.drained[2].cellIds).toEqual(['c3'])
    g.gates[2].resolve()
    await queued
  })

  it('stops retrying a pass after MAX_PASS_ATTEMPTS, however many callers share it', async () => {
    // A database that is simply unreachable must cost a pass a bounded number
    // of attempts, not one per sharer.
    const g = gatedRecompute()
    const calls = Array.from({ length: 8 }, (_, i) =>
      coalesceFileCounterRecompute(impact('f1', [`c${i}`]), g.recompute),
    )
    // Settled before the gates fail, so the shared rejection is never unhandled.
    const settled = Promise.all(calls.map((c) => expect(c).rejects.toThrow('unreachable')))
    await flush()

    for (let i = 0; i < 8 && g.gates[i]; i += 1) {
      g.gates[i].reject(new Error('unreachable'))
      await flush()
    }
    expect(g.started).toBe(3)
    await settled
  })

  // The burst shape from the ticket, end to end: many concurrent requests on
  // one file, the one whose connection the pass runs on torn down, and the file
  // still ends at the state the last request committed rather than at its
  // pre-burst value.
  it('leaves the file at its final state when the request a pass runs on is torn down', async () => {
    let applied = 0
    /** A recompute that rewrites the file's row from everything committed. */
    const pass = (alive: boolean) => async (d: CounterImpact): Promise<number> => {
      if (!alive) throw new Error('connection closed')
      applied = d.cellIds.size
      return applied
    }
    const liveRequest = pass(true)

    const first = coalesceFileCounterRecompute(impact('f1', ['c0']), liveRequest)
    await flush()
    expect(await first).toBe(1)

    // The burst goes on. The next request's POST is aborted at the client's
    // timeout, so the pass it starts has no connection left to run on — but
    // four live co-committers merged into that same pass.
    const abortedRequest = coalesceFileCounterRecompute(impact('f1', ['c1']), pass(false))
    const live = ['c2', 'c3', 'c4', 'c5'].map((c) =>
      coalesceFileCounterRecompute(impact('f1', [c]), liveRequest),
    )

    await Promise.all([abortedRequest, ...live])
    expect(applied).toBe(5)
  })

  it('releases its slot once a file goes idle, so a long-lived isolate does not retain one per file', async () => {
    const g = gatedRecompute()
    const a = coalesceFileCounterRecompute(impact('f1', ['c1']), g.recompute)
    await flush()
    g.gates[0].resolve()
    await a
    await flush()

    // A fresh slot means a fresh pass rather than a shared stale promise.
    const b = coalesceFileCounterRecompute(impact('f1', ['c9']), g.recompute)
    expect(b).not.toBe(a)
    await flush()
    expect(g.drained[1].cellIds).toEqual(['c9'])
    g.gates[1].resolve()
    await b
  })

  it("hands a pass's result to every caller it answers, including ones whose own recompute never ran", async () => {
    // AQU-1832 reads back the rows a pass wrote by the timestamp the pass
    // stamped them with. A caller answered by a pass another caller started
    // has no closure of its own to find that in — the pass's return value is
    // the only channel, so it has to reach the joiners too.
    let releaseFirst: () => void = () => {}
    const firstPassHeld = new Promise<void>((r) => { releaseFirst = r })
    const ranBy = (who: string) => async (): Promise<{ ranBy: string }> => {
      if (who === 'a') await firstPassHeld
      return { ranBy: who }
    }
    const a = coalesceFileCounterRecompute(impact('f1', ['c1']), ranBy('a'))
    await flush()
    // Both arrive mid-pass: b starts the queued pass, c only joins it.
    const b = coalesceFileCounterRecompute(impact('f1', ['c2']), ranBy('b'))
    const c = coalesceFileCounterRecompute(impact('f1', ['c3']), ranBy('c'))
    releaseFirst()
    expect(await a).toEqual({ ranBy: 'a' })
    expect(await b).toEqual({ ranBy: 'b' })
    expect(await c).toEqual({ ranBy: 'b' })
  })
})
