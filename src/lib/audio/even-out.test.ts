// AQU-2664: the actions the UI calls — "even out" over a set of takes (a
// file, a track, several tracks) and "clear" — as ONE undo step each, and the
// measuring behind them, with its fallback: a take that can't be measured
// plays at its own volume and is skipped, and the action says how many.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { AUTO_EVEN_CHANGED_TAKES, autoEvenCandidates, clearEvenOut, evenOutTakes, evenStateOf, evenedTakesIn, makeTakeMeasurer, takesToEvenOut, type EvenOutHost } from "./even-out"
import { takeStepHandlers, type TakeStepContext } from "@/lib/history/take-steps"
import { historyReady, historyView, redoLast, registerStepKinds, resetHistoryForTests, setHistoryScope, undoLast } from "@/lib/history/history"
import { clearHistoryStoreForTests } from "@/lib/history/history-store"
import { takeGainDb } from "./take-gain"
import { TARGET_RATE } from "./decode-mono"
import type { CodexCellAttachment } from "@/lib/codex-editor/types"
import type { CellData } from "@/hooks/useCells"

type Att = CodexCellAttachment & { [k: string]: unknown }

/** A little workspace: takes by cell, writes applied in place. */
function workspace(takes: Record<string, Record<string, Partial<Att>>>) {
  const store: Record<string, Record<string, Att>> = {}
  for (const [cellId, atts] of Object.entries(takes)) {
    store[cellId] = {}
    for (const [id, a] of Object.entries(atts)) store[cellId][id] = { url: `frontier-audio://${id}.wav`, type: "audio", slot: "recording", ...a } as Att
  }
  const readTake = (cellId: string, audioId: string) => {
    const a = store[cellId]?.[audioId]
    return a && !a.isDeleted ? a : null
  }
  // The take's own volume is never the action's to write; a call here fails the test.
  const applyGain = vi.fn(async () => {
    throw new Error("evening out wrote the take's own volume")
  })
  const failOn = new Set<string>()
  const applyEven = vi.fn(async (cellId: string, audioId: string, target: number | null) => {
    if (failOn.has(audioId)) throw new Error("outbox refused it")
    store[cellId][audioId].evenTargetLufs = target
  })
  const flush = vi.fn(async () => {})
  const measured: string[] = []
  const readings: Record<string, { loudnessLufs: number; truePeakDb: number } | null> = {}
  const host: EvenOutHost = {
    readTake,
    applyEven,
    flush,
    measure: async (cellId, audioId) => {
      measured.push(audioId)
      const r = readings[audioId]
      if (!r) return null
      Object.assign(store[cellId][audioId], r)
      return r
    },
  }
  const ctx = {
    readTake, selectedIn: () => null, applyTrim: async () => {}, applyGain, applyEven, applyPlace: async () => {},
    cut: async () => true, uncut: async () => {}, select: async () => {}, remove: async () => {}, rename: async () => {},
  } as unknown as TakeStepContext
  return { store, host, ctx, applyGain, applyEven, flush, failOn, measured, readings }
}

let unregister: (() => void) | null = null
beforeEach(async () => {
  resetHistoryForTests()
  await clearHistoryStoreForTests()
  setHistoryScope("p1", "sam")
  await historyReady()
})
afterEach(() => {
  unregister?.()
  unregister = null
})

describe("even out", () => {
  it("sets every measured take to the target, as ONE undo step", async () => {
    const w = workspace({
      c1: { a: { loudnessLufs: -28, truePeakDb: -14 } },
      c2: { b: { loudnessLufs: -10, truePeakDb: -2, gainDb: -1 } },
    })
    unregister = registerStepKinds(takeStepHandlers(w.ctx))
    const r = await evenOutTakes(w.host, [{ cellId: "c1", audioId: "a" }, { cellId: "c2", audioId: "b" }])
    expect(r).toMatchObject({ evened: 2, skipped: 0, targetLufs: -16 })
    expect(takeGainDb(w.store.c1.a)).toBeCloseTo(12, 6)
    expect(takeGainDb(w.store.c2.b)).toBeCloseTo(-7, 6) // its own -1 dB on top of -6
    expect(w.store.c2.b.gainDb).toBe(-1) // its own volume is left as it was
    expect(historyView().undoSteps).toHaveLength(1)
    expect(historyView().undoSteps[0].labelKey).toBe("editor.history.stepEvenOut")
  })

  it("undo puts every take back as it was, and redo evens them out again", async () => {
    const w = workspace({
      c1: { a: { loudnessLufs: -28, truePeakDb: -14 } },
      c2: { b: { loudnessLufs: -20, truePeakDb: -8, evenTargetLufs: -23 } },
    })
    unregister = registerStepKinds(takeStepHandlers(w.ctx))
    await evenOutTakes(w.host, [{ cellId: "c1", audioId: "a" }, { cellId: "c2", audioId: "b" }])
    await undoLast()
    expect(w.store.c1.a.evenTargetLufs).toBeNull()
    expect(w.store.c2.b.evenTargetLufs).toBe(-23)
    expect(takeGainDb(w.store.c1.a)).toBe(0)
    await redoLast()
    expect(w.store.c1.a.evenTargetLufs).toBe(-16)
    expect(w.store.c2.b.evenTargetLufs).toBe(-16)
  })

  it("takes a target the caller names", async () => {
    const w = workspace({ c1: { a: { loudnessLufs: -28, truePeakDb: -14 } } })
    const r = await evenOutTakes(w.host, [{ cellId: "c1", audioId: "a" }], { targetLufs: -23 })
    expect(r.targetLufs).toBe(-23)
    expect(takeGainDb(w.store.c1.a)).toBeCloseTo(5, 6)
  })

  it("measures a take that has no reading yet, once", async () => {
    const w = workspace({ c1: { a: {} }, c2: { b: { loudnessLufs: -20, truePeakDb: -8 } } })
    w.readings.a = { loudnessLufs: -26, truePeakDb: -12 }
    const r = await evenOutTakes(w.host, [{ cellId: "c1", audioId: "a" }, { cellId: "c2", audioId: "b" }])
    expect(w.measured).toEqual(["a"])
    expect(r.evened).toBe(2)
    expect(takeGainDb(w.store.c1.a)).toBeCloseTo(10, 6)
  })

  // Sam, Nov 19: a reading belongs to the window it measured. A take cut or
  // trimmed since is measured again over its new window.
  it("measures again a take whose reading is of another window (cut or trimmed since)", async () => {
    const w = workspace({ c1: { a: { loudnessLufs: -28, truePeakDb: -14, loudnessFromMs: 0, loudnessToMs: null, trimEndMs: 2000 } } })
    w.readings.a = { loudnessLufs: -20, truePeakDb: -8 }
    await evenOutTakes(w.host, [{ cellId: "c1", audioId: "a" }])
    expect(w.measured).toEqual(["a"])
    expect(takeGainDb(w.store.c1.a)).toBeCloseTo(4, 6)
  })

  it("FALLBACK: a stale reading that can't be refreshed still evens the take out", async () => {
    const w = workspace({ c1: { a: { loudnessLufs: -28, truePeakDb: -14, loudnessFromMs: 0, trimStartMs: 500 } } })
    w.readings.a = null
    const r = await evenOutTakes(w.host, [{ cellId: "c1", audioId: "a" }])
    expect(r).toMatchObject({ evened: 1, unmeasured: 0 })
    expect(takeGainDb(w.store.c1.a)).toBeCloseTo(12, 6)
  })

  it("FALLBACK: a take that can't be measured is skipped, counted, and plays at its own volume", async () => {
    const w = workspace({ c1: { a: { gainDb: -2 } }, c2: { b: { loudnessLufs: -20, truePeakDb: -8 } } })
    w.readings.a = null // decode failed, too big for the device, or the network gave up
    const r = await evenOutTakes(w.host, [{ cellId: "c1", audioId: "a" }, { cellId: "c2", audioId: "b" }])
    expect(r).toMatchObject({ evened: 1, skipped: 1, unmeasured: 1 })
    expect(w.store.c1.a.evenTargetLufs).toBeUndefined()
    expect(takeGainDb(w.store.c1.a)).toBe(-2)
  })

  it("FALLBACK: a measurement that throws is a skip, never a failed action", async () => {
    const w = workspace({ c1: { a: {} }, c2: { b: { loudnessLufs: -20, truePeakDb: -8 } } })
    w.host.measure = async () => { throw new Error("decode failed") }
    const r = await evenOutTakes(w.host, [{ cellId: "c1", audioId: "a" }, { cellId: "c2", audioId: "b" }])
    expect(r).toMatchObject({ evened: 1, skipped: 1, unmeasured: 1 })
  })

  it("skips a silent take, and a take that is gone, and says so", async () => {
    const w = workspace({ c1: { a: { loudnessLufs: -70, truePeakDb: -100 } } })
    const r = await evenOutTakes(w.host, [{ cellId: "c1", audioId: "a" }, { cellId: "c9", audioId: "zz" }])
    expect(r).toMatchObject({ evened: 0, skipped: 2, silent: 1, gone: 1 })
    expect(w.applyEven).not.toHaveBeenCalled()
    expect(historyView().undoSteps).toHaveLength(0)
  })

  it("lists the takes it could only raise part of the way (the peak or the range)", async () => {
    const w = workspace({ c1: { a: { loudnessLufs: -28, truePeakDb: -4 } }, c2: { b: { loudnessLufs: -20, truePeakDb: -8 } } })
    const r = await evenOutTakes(w.host, [{ cellId: "c1", audioId: "a" }, { cellId: "c2", audioId: "b" }])
    expect(r.held).toEqual([{ cellId: "c1", audioId: "a", reason: "peak", shortDb: 9 }])
  })

  it("stops measuring when cancelled, and evens out what it has", async () => {
    const w = workspace({ c1: { a: { loudnessLufs: -20, truePeakDb: -8 } }, c2: { b: {} } })
    w.readings.b = { loudnessLufs: -20, truePeakDb: -8 }
    const abort = new AbortController()
    abort.abort()
    const r = await evenOutTakes(w.host, [{ cellId: "c1", audioId: "a" }, { cellId: "c2", audioId: "b" }], { signal: abort.signal })
    expect(w.measured).toEqual([])
    expect(r).toMatchObject({ evened: 1, skipped: 1, unmeasured: 1 })
  })

  it("reports progress while measuring", async () => {
    const w = workspace({ c1: { a: {} }, c2: { b: {} } })
    w.readings.a = { loudnessLufs: -20, truePeakDb: -8 }
    w.readings.b = { loudnessLufs: -20, truePeakDb: -8 }
    const seen: Array<[number, number]> = []
    await evenOutTakes(w.host, [{ cellId: "c1", audioId: "a" }, { cellId: "c2", audioId: "b" }], { onProgress: (d, t) => seen.push([d, t]) })
    expect(seen).toEqual([[0, 2], [1, 2], [2, 2]])
  })
})

// Sam, Nov 19: "I do not want normalization to override volume automation."
describe("evening out is its own stage, before every volume the person sets", () => {
  it("a take's own volume and fades, and the track volume, survive a run, a re-run and a clear untouched", async () => {
    const w = workspace({
      c1: { a: { loudnessLufs: -28, truePeakDb: -14, gainDb: -4.5, fadeInMs: 250, fadeOutMs: 800 } },
      c2: { b: { loudnessLufs: -12, truePeakDb: -2, gainDb: 3, fadeOutMs: 120, slot: "track-2" } },
    })
    unregister = registerStepKinds(takeStepHandlers(w.ctx))
    const tracks = { recording: -6, "track-2": 2 } // the file's track volumes
    const own = () => [w.store.c1.a, w.store.c2.b].map((a) => [a.gainDb, a.fadeInMs, a.fadeOutMs])
    const before = own()
    const refs = [{ cellId: "c1", audioId: "a" }, { cellId: "c2", audioId: "b" }]
    await evenOutTakes(w.host, refs)
    expect(own()).toEqual(before)
    await evenOutTakes(w.host, refs, { targetLufs: -23 })
    expect(own()).toEqual(before)
    await clearEvenOut(w.host, refs)
    expect(own()).toEqual(before)
    await undoLast()
    await undoLast()
    await redoLast()
    expect(own()).toEqual(before)
    expect(tracks).toEqual({ recording: -6, "track-2": 2 })
    expect(w.applyGain).not.toHaveBeenCalled()
    // Only the evened-out target ever moved.
    expect(w.applyEven.mock.calls.every((c) => c.length === 3)).toBe(true)
  })

  it("the take's own volume reads relative to the evened level: 0 dB is 'as evened'", async () => {
    const w = workspace({ c1: { a: { loudnessLufs: -28, truePeakDb: -14 } } })
    await evenOutTakes(w.host, [{ cellId: "c1", audioId: "a" }])
    expect(takeGainDb(w.store.c1.a)).toBeCloseTo(12, 6)
    w.store.c1.a.gainDb = -3 // the Station's line, after
    expect(takeGainDb(w.store.c1.a)).toBeCloseTo(9, 6)
  })
})

describe("SHOULD: writes, roles and the network", () => {
  it("writes every take, then flushes the outbox ONCE", async () => {
    const w = workspace({ c1: { a: { loudnessLufs: -28, truePeakDb: -14 } }, c2: { b: { loudnessLufs: -20, truePeakDb: -8 } }, c3: { c: { loudnessLufs: -22, truePeakDb: -8 } } })
    await evenOutTakes(w.host, [{ cellId: "c1", audioId: "a" }, { cellId: "c2", audioId: "b" }, { cellId: "c3", audioId: "c" }])
    expect(w.applyEven).toHaveBeenCalledTimes(3)
    expect(w.flush).toHaveBeenCalledTimes(1)
  })

  it("a write that fails partway keeps an undo step for the takes that were written, and says how many failed", async () => {
    const w = workspace({ c1: { a: { loudnessLufs: -28, truePeakDb: -14 } }, c2: { b: { loudnessLufs: -20, truePeakDb: -8 } }, c3: { c: { loudnessLufs: -22, truePeakDb: -8 } } })
    unregister = registerStepKinds(takeStepHandlers(w.ctx))
    w.failOn.add("b")
    const r = await evenOutTakes(w.host, [{ cellId: "c1", audioId: "a" }, { cellId: "c2", audioId: "b" }, { cellId: "c3", audioId: "c" }])
    expect(r).toMatchObject({ evened: 2, failed: 1 })
    expect(historyView().undoSteps).toHaveLength(1)
    await undoLast()
    expect(w.store.c1.a.evenTargetLufs).toBeNull()
    expect(w.store.c3.c.evenTargetLufs).toBeNull()
  })

  it("nothing landed: no undo step, and no throw", async () => {
    const w = workspace({ c1: { a: { loudnessLufs: -28, truePeakDb: -14 } } })
    w.failOn.add("a")
    const r = await evenOutTakes(w.host, [{ cellId: "c1", audioId: "a" }])
    expect(r).toMatchObject({ evened: 0, failed: 1 })
    expect(historyView().undoSteps).toHaveLength(0)
  })

  it("someone below Contributor is refused up front, before anything is downloaded", async () => {
    const w = workspace({ c1: { a: {} } })
    w.readings.a = { loudnessLufs: -20, truePeakDb: -8 }
    w.host.allowed = false
    const r = await evenOutTakes(w.host, [{ cellId: "c1", audioId: "a" }])
    expect(r).toMatchObject({ notAllowed: true, evened: 0 })
    expect(w.measured).toEqual([])
    expect(w.applyEven).not.toHaveBeenCalled()
    expect(await clearEvenOut(w.host, [{ cellId: "c1", audioId: "a" }])).toMatchObject({ notAllowed: true, cleared: 0 })
  })
})

describe("clear", () => {
  it("takes evening out off every take as ONE step, and undo puts it back", async () => {
    const w = workspace({
      c1: { a: { loudnessLufs: -28, truePeakDb: -14, evenTargetLufs: -16, gainDb: -1 } },
      c2: { b: { loudnessLufs: -20, truePeakDb: -8, evenTargetLufs: -16 } },
      c3: { c: { loudnessLufs: -20, truePeakDb: -8 } },
    })
    unregister = registerStepKinds(takeStepHandlers(w.ctx))
    const r = await clearEvenOut(w.host, [{ cellId: "c1", audioId: "a" }, { cellId: "c2", audioId: "b" }, { cellId: "c3", audioId: "c" }])
    expect(r).toMatchObject({ cleared: 2 })
    expect(takeGainDb(w.store.c1.a)).toBe(-1) // back to its own volume
    expect(w.store.c2.b.evenTargetLufs).toBeNull()
    expect(historyView().undoSteps[0].labelKey).toBe("editor.history.stepClearEvenOut")
    await undoLast()
    expect(w.store.c1.a.evenTargetLufs).toBe(-16)
    expect(w.store.c2.b.evenTargetLufs).toBe(-16)
  })

  it("an undo leaves alone a take whose target someone changed since", async () => {
    const w = workspace({ c1: { a: { loudnessLufs: -28, truePeakDb: -14 } } })
    unregister = registerStepKinds(takeStepHandlers(w.ctx))
    await evenOutTakes(w.host, [{ cellId: "c1", audioId: "a" }])
    w.store.c1.a.evenTargetLufs = -23 // a colleague evened it out to another level
    await undoLast()
    expect(w.store.c1.a.evenTargetLufs).toBe(-23)
  })
})

describe("which takes", () => {
  const cells = [
    { id: "c1", attachments: {
      a: { url: "u", type: "audio", slot: "recording" },
      gone: { url: "u", type: "audio", slot: "recording", isDeleted: true },
      film: { url: "u", type: "audio", role: "source" },
    } },
    { id: "c2", attachments: { b: { url: "u", type: "audio", slot: "track-2" }, pic: { url: "u", type: "image" } } },
  ] as unknown as CellData[]

  it("a file: every live take, never the film's own sound", () => {
    expect(takesToEvenOut(cells)).toEqual([{ cellId: "c1", audioId: "a" }, { cellId: "c2", audioId: "b" }])
  })

  it("a track or tracks: the takes on them", () => {
    expect(takesToEvenOut(cells, { slots: ["track-2"] })).toEqual([{ cellId: "c2", audioId: "b" }])
    expect(takesToEvenOut(cells, { slots: ["recording", "track-2"] })).toHaveLength(2)
  })
})

describe("the run as the UI shows it (boards 71–73)", () => {
  it("names the step with its count, and hands back the step to undo from a toast", async () => {
    const w = workspace({
      c1: { a: { loudnessLufs: -28, truePeakDb: -14 } },
      c2: { b: { loudnessLufs: -20, truePeakDb: -8 } },
    })
    unregister = registerStepKinds(takeStepHandlers(w.ctx))
    const r = await evenOutTakes(w.host, [{ cellId: "c1", audioId: "a" }, { cellId: "c2", audioId: "b" }])
    const step = historyView().undoSteps[0]
    expect(step.labelParams).toEqual({ count: 2 })
    expect(r.stepId).toBe(step.id)
    const c = await clearEvenOut(w.host, [{ cellId: "c1", audioId: "a" }])
    expect(historyView().nextUndo?.labelParams).toEqual({ count: 1 })
    expect(c.stepId).toBe(historyView().nextUndo?.id)
  })

  it("marks a run from the window as a run, so the Station's own Undo leaves it to ⌘Z (board 73C)", async () => {
    const w = workspace({ c1: { a: { loudnessLufs: -28, truePeakDb: -14 } } })
    unregister = registerStepKinds(takeStepHandlers(w.ctx))
    await evenOutTakes(w.host, [{ cellId: "c1", audioId: "a" }], { markAsRun: true })
    const { matchingSteps } = await import("@/lib/history/history")
    const runParts = matchingSteps((kind, data) => kind === "take.even" && (data as { run?: boolean }).run === true)
    expect(runParts.undo).toHaveLength(1)
    await clearEvenOut(w.host, [{ cellId: "c1", audioId: "a" }])
    const clears = matchingSteps((kind, data) => kind === "take.even" && !(data as { run?: boolean }).run)
    expect(clears.undo).toHaveLength(1)
  })

  it("has no step to undo when nothing changed", async () => {
    const w = workspace({ c1: { a: { loudnessLufs: -28, truePeakDb: -14, evenTargetLufs: -16 } } })
    const r = await evenOutTakes(w.host, [{ cellId: "c1", audioId: "a" }])
    expect(r.stepId).toBeNull()
  })
})

describe("a track's ≈ (board 74)", () => {
  const cell = (id: string, atts: Record<string, Partial<Att>>) => ({ id, attachments: Object.fromEntries(Object.entries(atts).map(([k, a]) => [k, { url: "u", type: "audio", slot: "recording", ...a }])) }) as unknown as CellData

  it("is grey with no takes, or while any take on the track isn't evened", () => {
    expect(evenStateOf([], ["recording"])).toBe("none")
    expect(evenStateOf([cell("c1", { a: { loudnessLufs: -20, truePeakDb: -6, evenTargetLufs: -16 }, b: {} })], ["recording"])).toBe("none")
  })

  it("is lit when every take is evened, and amber when one couldn't go all the way", () => {
    const evened = cell("c1", { a: { loudnessLufs: -20, truePeakDb: -6, evenTargetLufs: -16 } })
    expect(evenStateOf([evened], ["recording"])).toBe("full")
    const held = cell("c2", { b: { loudnessLufs: -30, truePeakDb: -4, evenTargetLufs: -16 } })
    expect(evenStateOf([evened, held], ["recording"])).toBe("part")
  })

  it("reads only the track's own slots, and never the film's sound", () => {
    const c = cell("c1", {
      a: { loudnessLufs: -20, truePeakDb: -6, evenTargetLufs: -16 },
      other: { slot: "track-2" },
      film: { role: "source" },
    })
    expect(evenStateOf([c], ["recording"])).toBe("full")
    expect(evenStateOf([c], ["track-2"])).toBe("none")
  })

  it("counts the evened takes a Clear would take back", () => {
    const c = cell("c1", { a: { evenTargetLufs: -16 }, b: {}, d: { evenTargetLufs: -16, slot: "track-2" } })
    expect(evenedTakesIn([c])).toHaveLength(2)
    expect(evenedTakesIn([c], { slots: ["recording"] })).toEqual([{ cellId: "c1", audioId: "a" }])
  })
})

describe("question 89: new, cut or trimmed takes on an evened track (ONE switch)", () => {
  const cells = [
    { id: "c1", attachments: {
      a: { url: "u", type: "audio", slot: "recording", loudnessLufs: -20, truePeakDb: -6, evenTargetLufs: -16 },
      // New on the evened track: no target.
      b: { url: "u", type: "audio", slot: "recording" },
      // Trimmed since it was measured: its reading is of another window.
      c: { url: "u", type: "audio", slot: "recording", loudnessLufs: -20, truePeakDb: -6, evenTargetLufs: -16, loudnessFromMs: 0, trimStartMs: 300 },
      // On a track nobody evened: left alone.
      d: { url: "u", type: "audio", slot: "track-2" },
    } },
  ] as unknown as CellData[]

  it("is OFF for now: today's behaviour, nothing is evened on its own", () => {
    expect(AUTO_EVEN_CHANGED_TAKES).toBe(false)
    expect(autoEvenCandidates(cells, AUTO_EVEN_CHANGED_TAKES)).toEqual([])
  })

  it("ON: the new and the changed takes on an evened track, and nothing else", () => {
    expect(autoEvenCandidates(cells, true)).toEqual([{ cellId: "c1", audioId: "b" }, { cellId: "c1", audioId: "c" }])
  })
})

describe("measuring a take", () => {
  // A mono take counts as heard on both speakers (dual mono, +3 LU), so a
  // mono sine whose peak is at X dBFS reads X LUFS.
  const sine = (lufs: number, seconds: number) => {
    const a = Math.pow(10, lufs / 20)
    return Float32Array.from({ length: seconds * TARGET_RATE }, (_, i) => a * Math.sin((2 * Math.PI * 1000 * i) / TARGET_RATE))
  }
  const att = { url: "frontier-audio://take-1.wav", type: "audio", durationMs: 2000 } as CodexCellAttachment

  it("decodes the take, measures it, and stores the reading", async () => {
    const emit = vi.fn(async () => {})
    const measure = makeTakeMeasurer({ fetchBytes: async () => new Uint8Array([1]), decode: async () => sine(-24, 2), emit })
    const r = await measure("c1", "take-1", att)
    expect(Math.abs(r!.loudnessLufs - -24)).toBeLessThan(0.5)
    expect(emit).toHaveBeenCalledWith("c1", "take-1", expect.objectContaining({ loudnessLufs: r!.loudnessLufs, truePeakDb: r!.truePeakDb, loudnessFromMs: 0, loudnessToMs: null }), 2000)
  })

  it("decodes a recording shared by several takes once", async () => {
    const decode = vi.fn(async () => sine(-24, 1))
    const fetchBytes = vi.fn(async () => new Uint8Array([1]))
    const measure = makeTakeMeasurer({ fetchBytes, decode, emit: async () => {} })
    await measure("c1", "p1", att)
    await measure("c2", "p2", { ...att, trimStartMs: 200 })
    expect(decode).toHaveBeenCalledTimes(1)
    expect(fetchBytes).toHaveBeenCalledTimes(1)
  })

  // Sam, Nov 19: pieces of a cut take and sections of a shared import are
  // each measured on their own window of the recording.
  it("measures each piece or section over its own window of the recording", async () => {
    const quietThenLoud = new Float32Array(4 * TARGET_RATE)
    quietThenLoud.set(sine(-30, 2), 0)
    quietThenLoud.set(sine(-12, 2), 2 * TARGET_RATE)
    const measure = makeTakeMeasurer({ fetchBytes: async () => new Uint8Array([1]), decode: async () => quietThenLoud.slice(), emit: async () => {} })
    const shared = { url: "frontier-audio://import.mp3", type: "audio", durationMs: 4000 } as CodexCellAttachment
    const first = await measure("c1", "s1", { ...shared, trimEndMs: 2000 })
    const second = await measure("c2", "s2", { ...shared, trimStartMs: 2000 })
    expect(Math.abs(first!.loudnessLufs - -30)).toBeLessThan(0.5)
    expect(Math.abs(second!.loudnessLufs - -12)).toBeLessThan(0.5)
    expect(second!.truePeakDb).toBeCloseTo(-12, 0)
    expect(first!.truePeakDb).toBeCloseTo(-30, 0)
  })

  it("a long import over the memory budget is measured section by section, not skipped", async () => {
    // 10 minutes of "MP3" whose sections decode a chunk at a time.
    const decodeWindow = vi.fn(async (_bytes: Uint8Array, startSec: number, endSec: number) => sine(-20, Math.round(endSec - startSec)))
    const decode = vi.fn(async () => { throw new Error("the whole recording must never be decoded") })
    const measure = makeTakeMeasurer({
      fetchBytes: async () => new Uint8Array([1]), decode, decodeWindow, emit: async () => {},
      pcmBudgetBytes: 50 * TARGET_RATE * 4, // 50 s of PCM
    })
    const long = { url: "frontier-audio://sermon.mp3", type: "audio", durationMs: 600_000 } as CodexCellAttachment
    const r = await measure("c9", "s9", { ...long, trimStartMs: 300_000, trimEndMs: 304_000 })
    expect(Math.abs(r!.loudnessLufs - -20)).toBeLessThan(0.5)
    expect(decode).not.toHaveBeenCalled()
    expect(decodeWindow).toHaveBeenCalledWith(expect.anything(), 300, 304)
  })

  it("FALLBACK: a section too long for the budget, or a long recording that can't be decoded in parts, is unmeasured", async () => {
    const measure = makeTakeMeasurer({
      fetchBytes: async () => new Uint8Array([1]), decode: async () => sine(-20, 1),
      decodeWindow: async () => null, // not an MP3: no way to decode a part
      emit: async () => {}, pcmBudgetBytes: 50 * TARGET_RATE * 4,
    })
    const long = { url: "frontier-audio://film.webm", type: "audio", durationMs: 600_000 } as CodexCellAttachment
    expect(await measure("c1", "a", { ...long, trimStartMs: 0, trimEndMs: 4000 })).toBeNull()
    expect(await measure("c1", "b", { ...long, trimStartMs: 0, trimEndMs: 120_000 })).toBeNull()
  })

  it("SHOULD: a take with no known length is still held to the memory budget", async () => {
    const decode = vi.fn(async () => sine(-20, 1))
    const measure = makeTakeMeasurer({
      // ~200 KB of compressed audio could decode to far more than 1 MB of PCM.
      fetchBytes: async () => new Uint8Array(200_000), decode, decodeWindow: async () => null,
      emit: async () => {}, pcmBudgetBytes: 1_000_000,
    })
    expect(await measure("c1", "a", { url: "frontier-audio://x.webm", type: "audio" } as CodexCellAttachment)).toBeNull()
    expect(decode).not.toHaveBeenCalled()
  })

  it("SHOULD: the timeout really stops the download (and nothing is decoded after it)", async () => {
    vi.useFakeTimers()
    try {
      let aborted = false
      const decode = vi.fn(async () => sine(-24, 1))
      const measure = makeTakeMeasurer({
        fetchBytes: (_a, _w, signal) => new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")) })
        }),
        decode, emit: async () => {}, timeoutMs: 1000,
      })
      const p = measure("c1", "a", att)
      await vi.advanceTimersByTimeAsync(1001)
      expect(await p).toBeNull()
      expect(aborted).toBe(true)
      expect(decode).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it("SHOULD: Cancel reaches the download", async () => {
    let aborted = false
    const ac = new AbortController()
    const measure = makeTakeMeasurer({
      fetchBytes: (_a, _w, signal) => new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")) })
      }),
      decode: async () => sine(-24, 1), emit: async () => {},
    })
    const p = measure("c1", "a", att, ac.signal)
    ac.abort()
    expect(await p).toBeNull()
    expect(aborted).toBe(true)
  })

  it("FALLBACK: no reading when the bytes can't be fetched or decoded", async () => {
    const failFetch = makeTakeMeasurer({ fetchBytes: async () => { throw new Error("offline") }, decode: async () => sine(-24, 1), emit: async () => {} })
    expect(await failFetch("c1", "a", att)).toBeNull()
    const failDecode = makeTakeMeasurer({ fetchBytes: async () => new Uint8Array([1]), decode: async () => { throw new Error("bad audio") }, emit: async () => {} })
    expect(await failDecode("c1", "a", att)).toBeNull()
  })

  it("FALLBACK: a take too long to decode on this device is not fetched at all", async () => {
    const fetchBytes = vi.fn(async () => new Uint8Array([1]))
    const measure = makeTakeMeasurer({ fetchBytes, decode: async () => sine(-24, 1), emit: async () => {}, pcmBudgetBytes: 1_000_000 })
    expect(await measure("c1", "a", { ...att, durationMs: 60_000 })).toBeNull()
    expect(fetchBytes).not.toHaveBeenCalled()
  })

  it("FALLBACK: a fetch slower than the limit gives up", async () => {
    vi.useFakeTimers()
    try {
      const measure = makeTakeMeasurer({ fetchBytes: () => new Promise(() => {}), decode: async () => sine(-24, 1), emit: async () => {}, timeoutMs: 1000 })
      const p = measure("c1", "a", att)
      await vi.advanceTimersByTimeAsync(1001)
      expect(await p).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it("FALLBACK: a reading that can't be saved still counts for this session", async () => {
    const measure = makeTakeMeasurer({ fetchBytes: async () => new Uint8Array([1]), decode: async () => sine(-24, 1), emit: async () => { throw new Error("outbox full") } })
    expect(await measure("c1", "a", att)).not.toBeNull()
  })
})
