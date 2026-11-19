// AQU-2664: the actions the UI calls — "even out" over a set of takes (a
// file, a track, several tracks) and "clear" — as ONE undo step each, and the
// measuring behind them, with its fallback: a take that can't be measured
// plays at its own volume and is skipped, and the action says how many.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { clearEvenOut, evenOutTakes, makeTakeMeasurer, takesToEvenOut, type EvenOutHost } from "./even-out"
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

// Re-check M1: a recording shared by several takes (cut pieces, an import's
// sections) is downloaded once per run, however its takes are interleaved
// with others; one whose download failed is not tried again for its other
// takes in that run.
describe("a shared recording across interleaved takes", () => {
  const tone = (seconds: number) => Float32Array.from({ length: seconds * TARGET_RATE }, (_, i) => 0.1 * Math.sin((2 * Math.PI * 1000 * i) / TARGET_RATE))
  function hostWith(takes: Record<string, Record<string, Partial<CodexCellAttachment>>>, fetchBytes: (att: CodexCellAttachment) => Promise<Uint8Array>) {
    const store: Record<string, Record<string, CodexCellAttachment>> = {}
    for (const [c, atts] of Object.entries(takes)) {
      store[c] = {}
      for (const [id, a] of Object.entries(atts)) store[c][id] = { type: "audio", durationMs: 4000, ...a } as CodexCellAttachment
    }
    const readTake = (c: string, id: string) => store[c]?.[id] ?? null
    const measure = makeTakeMeasurer({
      fetchBytes: (att) => fetchBytes(att),
      decode: async () => tone(4),
      emit: async (c, id, r) => { Object.assign(store[c][id], r) },
      meter: async (pcm, rate) => (await import("./loudness")).measureLoudness([pcm], rate),
    })
    const host: EvenOutHost = { readTake, applyEven: async (c, id, t) => { store[c][id].evenTargetLufs = t }, measure, release: () => measure.release() }
    return { host, store }
  }
  const interleaved = {
    c1: { u1: { url: "frontier-audio://U.mp3", trimEndMs: 2000 }, v1: { url: "frontier-audio://V1.wav" } },
    c2: { u2: { url: "frontier-audio://U.mp3", trimStartMs: 2000 }, v2: { url: "frontier-audio://V2.wav" } },
    c3: { u3: { url: "frontier-audio://U.mp3", trimStartMs: 1000, trimEndMs: 3000 } },
  }
  const refs = [
    { cellId: "c1", audioId: "u1" }, { cellId: "c1", audioId: "v1" },
    { cellId: "c2", audioId: "u2" }, { cellId: "c2", audioId: "v2" },
    { cellId: "c3", audioId: "u3" },
  ]

  it("downloads U once, though its takes are mixed with others", async () => {
    const fetched: string[] = []
    const { host } = hostWith(interleaved, async (att) => { fetched.push(att.url); return new Uint8Array([1]) })
    const r = await evenOutTakes(host, refs)
    expect(r).toMatchObject({ evened: 5, unmeasured: 0 })
    expect(fetched.filter((u) => u.endsWith("U.mp3"))).toHaveLength(1)
    expect(fetched).toHaveLength(3)
  })

  it("a recording whose download failed is skipped for its other takes in that run, counted as skipped", async () => {
    const fetched: string[] = []
    const { host } = hostWith(interleaved, async (att) => {
      fetched.push(att.url)
      if (att.url.endsWith("U.mp3")) throw new Error("network gave up")
      return new Uint8Array([1])
    })
    const r = await evenOutTakes(host, refs)
    expect(fetched.filter((u) => u.endsWith("U.mp3"))).toHaveLength(1)
    expect(r).toMatchObject({ evened: 2, unmeasured: 3, skipped: 3 })
  })

  it("a recording whose download ran out of time is skipped for its other takes too", async () => {
    vi.useFakeTimers()
    try {
      let fetches = 0
      const measure = makeTakeMeasurer({
        fetchBytes: () => { fetches++; return new Promise(() => {}) },
        decode: async () => tone(4), emit: async () => {}, timeoutMs: 1000,
      })
      const att = { url: "frontier-audio://slow.mp3", type: "audio", durationMs: 4000 } as CodexCellAttachment
      const first = measure("c1", "a", { ...att, trimEndMs: 2000 })
      await vi.advanceTimersByTimeAsync(1001)
      expect(await first).toBeNull()
      expect(await measure("c2", "b", { ...att, trimStartMs: 2000 })).toBeNull()
      expect(fetches).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it("a later run tries the failed recording again", async () => {
    let fail = true
    const fetched: string[] = []
    const { host } = hostWith(interleaved, async (att) => {
      fetched.push(att.url)
      if (fail && att.url.endsWith("U.mp3")) throw new Error("offline")
      return new Uint8Array([1])
    })
    await evenOutTakes(host, refs)
    fail = false
    const r = await evenOutTakes(host, refs)
    expect(r.unmeasured).toBe(0)
    expect(fetched.filter((u) => u.endsWith("U.mp3"))).toHaveLength(2)
  })
})

// Re-check S1: no copy of the decode when nothing later needs it, and the
// decode is let go when the run ends.
describe("memory while measuring", () => {
  const tone = (seconds: number) => Float32Array.from({ length: seconds * TARGET_RATE }, (_, i) => 0.1 * Math.sin((2 * Math.PI * 1000 * i) / TARGET_RATE))
  it("the last take of a recording is metered in place; earlier ones get a copy, so the decode stays for them", async () => {
    const decoded = tone(4)
    const seen: Float32Array[] = []
    const measure = makeTakeMeasurer({
      fetchBytes: async () => new Uint8Array([1]),
      decode: async () => decoded,
      emit: async () => {},
      meter: async (pcm, rate) => { seen.push(pcm); return (await import("./loudness")).measureLoudness([pcm], rate) },
    })
    const att = { url: "frontier-audio://U.wav", type: "audio", durationMs: 4000 } as CodexCellAttachment
    await measure("c1", "a", { ...att, trimEndMs: 2000 }, undefined, { last: false })
    await measure("c2", "b", { ...att, trimStartMs: 2000 }, undefined, { last: true })
    expect(seen[0].buffer).not.toBe(decoded.buffer)
    expect(seen[1].buffer).toBe(decoded.buffer)
  })

  it("an untrimmed last take is metered as the decode itself", async () => {
    const decoded = tone(2)
    let seen: Float32Array | null = null
    const measure = makeTakeMeasurer({
      fetchBytes: async () => new Uint8Array([1]), decode: async () => decoded, emit: async () => {},
      meter: async (pcm, rate) => { seen = pcm; return (await import("./loudness")).measureLoudness([pcm], rate) },
    })
    await measure("c1", "a", { url: "frontier-audio://W.wav", type: "audio", durationMs: 2000 } as CodexCellAttachment, undefined, { last: true })
    expect(seen).toBe(decoded)
  })

  it("Even out tells the measurer which take is a recording's last, and releases it at the end", async () => {
    const calls: Array<{ id: string; last: boolean | undefined }> = []
    const release = vi.fn()
    const store: Record<string, CodexCellAttachment> = {
      a: { url: "u1", type: "audio" } as CodexCellAttachment,
      b: { url: "u2", type: "audio" } as CodexCellAttachment,
      c: { url: "u1", type: "audio", trimStartMs: 10 } as CodexCellAttachment,
    }
    const host: EvenOutHost = {
      readTake: (_c, id) => store[id],
      applyEven: async () => {},
      measure: async (_c, id, _att, _s, o) => { calls.push({ id, last: o?.last }); return null },
      release,
    }
    await evenOutTakes(host, ["a", "b", "c"].map((id) => ({ cellId: "c", audioId: id })))
    expect(calls).toEqual([{ id: "a", last: false }, { id: "c", last: true }, { id: "b", last: true }])
    expect(release).toHaveBeenCalledTimes(1)
  })
})

describe("the timeout reaches the meter", () => {
  it("the meter is handed a signal that aborts when the take runs out of time", async () => {
    vi.useFakeTimers()
    try {
      let meterSignal: AbortSignal | undefined
      const measure = makeTakeMeasurer({
        fetchBytes: async () => new Uint8Array([1]),
        decode: async () => new Float32Array(48_000),
        emit: async () => {},
        timeoutMs: 1000,
        meter: (_pcm, _rate, signal) => { meterSignal = signal; return new Promise(() => {}) },
      })
      const p = measure("c1", "a", { url: "frontier-audio://m.wav", type: "audio", durationMs: 1000 } as CodexCellAttachment)
      await vi.advanceTimersByTimeAsync(10)
      expect(meterSignal?.aborted).toBe(false)
      await vi.advanceTimersByTimeAsync(1000)
      expect(await p).toBeNull()
      expect(meterSignal?.aborted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})

// Re-check S5: the measurer never claims a duration it doesn't know.
describe("durations from a measure", () => {
  it("a take measured in parts (no whole decode) sends no duration when it has none", async () => {
    const emit = vi.fn(async () => {})
    const measure = makeTakeMeasurer({
      fetchBytes: async () => new Uint8Array(200_000), decode: async () => new Float32Array(0),
      decodeWindow: async () => Float32Array.from({ length: 48_000 }, (_, i) => 0.1 * Math.sin(i / 7)),
      emit, pcmBudgetBytes: 1_000_000,
    })
    const att = { url: "frontier-audio://old.mp3", type: "audio", trimStartMs: 0, trimEndMs: 1000 } as CodexCellAttachment
    expect(await measure("c1", "a", att)).not.toBeNull()
    expect(emit).toHaveBeenCalledWith("c1", "a", expect.anything(), null)
  })

  it("a second take of the same recording and window reuses the decoded length", async () => {
    const emit = vi.fn(async () => {})
    const measure = makeTakeMeasurer({
      fetchBytes: async () => new Uint8Array([1]),
      decode: async () => Float32Array.from({ length: 96_000 }, (_, i) => 0.1 * Math.sin(i / 7)),
      emit,
    })
    const att = { url: "frontier-audio://nolen.wav", type: "audio" } as CodexCellAttachment
    await measure("c1", "a", att)
    await measure("c2", "b", att)
    expect(emit).toHaveBeenNthCalledWith(1, "c1", "a", expect.anything(), 2000)
    expect(emit).toHaveBeenNthCalledWith(2, "c2", "b", expect.anything(), 2000)
  })
})

