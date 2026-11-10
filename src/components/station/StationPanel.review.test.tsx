// AQU-2493 (review, Nov 9): the Station's Save, Keep, Delete, Insert and Undo
// with a recording loaded — what the Nov 9 review found, each pinned here.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { __resetStationTargetForTests, openInStation } from "@/lib/station/target"
import type { StationHost, StationTake } from "./station-host"

const RATE = 48000
const mocks = vi.hoisted(() => ({
  save: vi.fn(async (_args: unknown) => ({ audioIds: ["new.wav"], url: "frontier-audio://new.wav", durationMs: 1000 })),
  /** What the device's audio cache still holds, by id. */
  cached: new Map<string, Uint8Array>(),
  /** Ids whose read from that cache never comes back in the test. */
  slow: new Set<string>(),
  /** Record now, as the Station's recorder reports it. */
  rec: { phase: { kind: "idle" } as { kind: string; at?: number }, busy: false },
}))
vi.mock("./StationRecorder", () => ({
  useStationRecorder: () => ({ ...mocks.rec, recording: mocks.rec.phase.kind === "recording", count: null, elapsedMs: 0, start() {}, stop() {}, keep() {}, again() {}, drop() {} }),
  StationRecordBar: () => null,
}))
vi.mock("@/lib/station/load", () => ({
  // Five seconds of a ramp, so every sample says where it came from.
  loadStationPcm: async () => {
    const data = new Float32Array(48000 * 5)
    for (let i = 0; i < data.length; i++) data[i] = i / data.length
    return { data, rate: 48000, peak: 1, duration: 5 }
  },
  pcmKey: (u: string) => u,
  putStationPcm: (_k: string, data: Float32Array, rate = 48000) => ({ data, rate, peak: 1, duration: data.length / rate }),
}))
vi.mock("@/lib/station/save", () => ({ saveStationVersion: mocks.save }))
vi.mock("@/lib/audio/bytes-cache", () => ({
  audioCacheGet: (id: string) => (mocks.slow.has(id) ? new Promise(() => {}) : Promise.resolve(mocks.cached.get(id) ?? null)),
  audioCachePutBlob: async () => {},
}))
vi.mock("@/lib/audio/decode-mono", () => ({ TARGET_RATE: 48000, decodeToMono48k: async () => new Float32Array(48000 * 2).fill(0.5) }))
vi.mock("@/lib/station/preview", () => ({
  previewCanMix: () => false,
  StationPreview: class {
    playing = false
    setSamples() {}
    setBlob() {}
    setLevel() {}
    setRate() {}
    setLoop() {}
    play() {}
    pause() {}
    dispose() {}
  },
}))

const { StationPanel } = await import("./StationPanel")

const TARGET = { fileId: "f1", cellId: "c331", audioId: "t2.webm" }
const DRAFT_KEY = "aquilla:stationDraft:f1|c331|t2.webm"

function makeTake(over: Partial<StationTake["att"]> = {}): StationTake {
  const att = { url: "frontier-audio://t2.webm", type: "audio", label: "Take 2", validators: [], validatorCount: 0, ...over }
  return {
    fileId: "f1",
    cell: { id: "c331", attachments: { "t2.webm": att } } as unknown as StationTake["cell"],
    att: att as StationTake["att"],
  }
}

function makeHost(take: StationTake, over: Partial<StationHost> = {}): StationHost {
  return {
    project: { id: "p1" } as StationHost["project"],
    username: "ana",
    editable: true,
    getSyncToken: async () => "jwt",
    readTake: () => take,
    lineName: () => "line 331",
    trackVars: () => ({ "--tl-track-hue": "#2489eb" }),
    voteState: () => ({ canVote: true, voted: false }),
    vote: vi.fn(async () => {}),
    trim: vi.fn(async () => {}),
    approvalsNeeded: 1,
    pauseOtherPlayback: () => {},
    reportHistory: () => {},
    setLevel: vi.fn(async () => {}),
    selectedIn: () => "t2.webm",
    fileName: () => null,
    insertChoices: () => [],
    placementsOf: () => [take],
    removeNoise: async () => null,
    changeVoice: () => null,
    takeIsLayer: () => false,
    ...over,
  }
}

/** Open the Station on the take and wait for its recording to load. */
async function open(take: StationTake, over: Partial<StationHost> = {}) {
  const host = makeHost(take, over)
  openInStation(TARGET)
  render(<StationPanel host={host} visible />)
  // The lane is 1000 px wide: 200 px a second on the five-second recording.
  const lane = screen.getByTestId("station-lane")
  lane.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 128, right: 1000, bottom: 128, x: 0, y: 0, toJSON: () => ({}) })
  await waitFor(() => expect(screen.getByTestId("station-status-row")).toBeTruthy())
  await act(async () => {})
  return { host, lane }
}

/** Drag across the lane from `a` to `b` seconds. */
function selectRange(lane: HTMLElement, a: number, b: number) {
  fireEvent.pointerDown(lane, { button: 0, clientX: a * 200, clientY: 10, pointerId: 1 })
  fireEvent.pointerMove(lane, { clientX: b * 200, clientY: 10, pointerId: 1 })
  fireEvent.pointerUp(lane, { clientX: b * 200, clientY: 10, pointerId: 1 })
}

beforeEach(() => {
  localStorage.clear()
  mocks.cached.clear()
  mocks.slow.clear()
  mocks.rec = { phase: { kind: "idle" }, busy: false }
  mocks.save.mockClear()
})
afterEach(() => __resetStationTargetForTests())

describe("the Station's Save with inserted audio that can't be loaded again (finding 5)", () => {
  const draftWithInsert = () =>
    localStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({
        ops: [{ kind: "ins", at: 1, src: "station-insert-x", len: 2, label: "the file “amen”" }],
        trim: null,
        sources: { "station-insert-x": { kind: "file", cacheId: "station-insert-x", ext: "wav", label: "the file “amen”" } },
        undo: [{ ops: [], trim: null }],
        scope: "clip",
      }),
    )

  it("refuses to save silence in its place, and says why", async () => {
    draftWithInsert()
    await open(makeTake())
    fireEvent.click(screen.getByTestId("station-save"))
    await act(async () => {})
    expect(mocks.save).not.toHaveBeenCalled()
    expect(screen.getByTestId("station-message").textContent).toMatch(/inserted .* no longer on this device/)
    // The change is still there to undo.
    expect(screen.getByTestId("station-not-saved")).toBeTruthy()
  })

  it("waits, saying so, while the inserted audio is still loading again", async () => {
    draftWithInsert()
    mocks.slow.add("station-insert-x")
    await open(makeTake())
    fireEvent.click(screen.getByTestId("station-save"))
    await act(async () => {})
    expect(mocks.save).not.toHaveBeenCalled()
    expect(screen.getByTestId("station-message").textContent).toMatch(/still loading/)
  })

  it("saves as usual once the inserted audio has loaded again", async () => {
    draftWithInsert()
    mocks.cached.set("station-insert-x", new Uint8Array(4))
    await open(makeTake())
    fireEvent.click(screen.getByTestId("station-save"))
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1))
    const { samples } = mocks.save.mock.calls[0][0] as { samples: Float32Array }
    expect(samples.length).toBe(RATE * 7)
    // The insert's own sound, not silence.
    expect(samples[RATE * 2]).toBeCloseTo(0.5)
  })
})

describe("the Station's K (Keep this) follows the Keep button (finding 10)", () => {
  it("does nothing on the imported source recording, which opens to listen only", async () => {
    const { host, lane } = await open(makeTake({ role: "source" } as never))
    selectRange(lane, 1, 3)
    expect(screen.getByTestId("station-selection")).toBeTruthy()
    expect(screen.queryByTestId("station-keep")).toBeNull()
    fireEvent.keyDown(screen.getByTestId("station"), { key: "k", code: "KeyK" })
    await act(async () => {})
    expect(host.trim).not.toHaveBeenCalled()
    // The selection is still there to play and loop.
    expect(screen.getByTestId("station-selection")).toBeTruthy()
  })

  it("does nothing for someone who may not change takes", async () => {
    const { host, lane } = await open(makeTake(), { editable: false })
    selectRange(lane, 1, 3)
    fireEvent.keyDown(screen.getByTestId("station"), { key: "k", code: "KeyK" })
    await act(async () => {})
    expect(host.trim).not.toHaveBeenCalled()
  })

  it("still keeps the selection on a take you may change", async () => {
    const { host, lane } = await open(makeTake())
    selectRange(lane, 1, 3)
    fireEvent.keyDown(screen.getByTestId("station"), { key: "k", code: "KeyK" })
    await waitFor(() => expect(host.trim).toHaveBeenCalledWith("c331", "t2.webm", { trimStartMs: 1000, trimEndMs: 3000 }))
  })

  it("A does not approve the source recording, which is never approved", async () => {
    const { host } = await open(makeTake({ role: "source" } as never))
    fireEvent.keyDown(screen.getByTestId("station"), { key: "a", code: "KeyA" })
    expect(host.vote).not.toHaveBeenCalled()
  })
})

describe("a Station save holds the take's place when its Start moved with the edit (finding 14)", () => {
  type Placed = { trimStartMs: number | null; targetOffsetMs: number | null; recordingsOffsetMs: number | null }
  const saved = async (): Promise<Placed> => {
    fireEvent.click(screen.getByTestId("station-save"))
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1))
    return (mocks.save.mock.calls[0][0] as { placements: Placed[] }).placements[0]
  }
  /** A take whose Start is at 0.20 s, sounding 10.2 s into its line's file. */
  const placedTake = (over: Partial<StationTake["att"]> = {}) => makeTake({ trimStartMs: 200, targetOffsetMs: 10_000, recordingsOffsetMs: 500, ...over })
  const deleteRange = (lane: HTMLElement, a: number, b: number) => {
    selectRange(lane, a, b)
    fireEvent.keyDown(screen.getByTestId("station"), { key: "Delete", code: "Delete" })
  }
  const seedDraft = (draft: { ops: unknown[]; trim?: { a: number; b: number } | null; sources?: Record<string, unknown> }) =>
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ trim: null, sources: {}, undo: [{ ops: [], trim: null }], scope: "clip", ...draft }))

  it("deleting from the left edge past Start leaves the sound where it was following the source, and the pause as it was following the recordings", async () => {
    const { lane } = await open(placedTake())
    deleteRange(lane, 0, 0.8)
    // Start is at the new recording's edge now: 0.2 s earlier in the clip, so
    // the clip sits 0.2 s later and its sound still starts at 10.2 s.
    expect(await saved()).toMatchObject({ trimStartMs: null, targetOffsetMs: 10_200, recordingsOffsetMs: 500 })
  })

  it("on a layer track the sound stays put following the recordings too", async () => {
    const { lane } = await open(placedTake(), { takeIsLayer: () => true })
    deleteRange(lane, 0, 0.8)
    expect(await saved()).toMatchObject({ trimStartMs: null, targetOffsetMs: 10_200, recordingsOffsetMs: 700 })
  })

  it("inserting two seconds at the very start does not push the kept part two seconds later", async () => {
    seedDraft({
      ops: [{ kind: "ins", at: 0, src: "station-insert-x", len: 2, label: "the file “amen”" }],
      sources: { "station-insert-x": { kind: "file", cacheId: "station-insert-x", ext: "wav", label: "the file “amen”" } },
    })
    mocks.cached.set("station-insert-x", new Uint8Array(4))
    await open(placedTake())
    expect(await saved()).toMatchObject({ trimStartMs: 2200, targetOffsetMs: 8_000, recordingsOffsetMs: 500 })
  })

  it("a take nobody has placed gets a place of its own, so it stays at its line's start", async () => {
    const take = makeTake({ trimStartMs: 200 })
    Object.assign(take.cell, { startTime: 10, endTime: 15 })
    const { lane } = await open(take)
    deleteRange(lane, 0, 0.8)
    expect(await saved()).toMatchObject({ trimStartMs: null, targetOffsetMs: 200, recordingsOffsetMs: 0 })
  })

  it("an edit after Start moves nothing", async () => {
    const { lane } = await open(placedTake())
    deleteRange(lane, 2, 3)
    expect(await saved()).toMatchObject({ trimStartMs: 200, targetOffsetMs: 10_000, recordingsOffsetMs: 500 })
  })

  it("a Start you dragged yourself before saving is a trim, as Keep is: the sound stays and the place is not shifted", async () => {
    seedDraft({ ops: [{ kind: "del", a: 2, b: 3 }], trim: { a: 1, b: -1 } })
    await open(placedTake())
    expect(await saved()).toMatchObject({ trimStartMs: 1000, targetOffsetMs: 10_000, recordingsOffsetMs: 500 })
  })

  // AQU-2493 (review, Nov 9), finding 7: the shift was worked out from the
  // STORED Start carried through every edit, with no record of when Start was
  // moved. Start moved to 0 by hand (a trim, the take then sounds from 10.0 s),
  // and then a delete at 0.1 s — after Start, so it moves nothing — made the
  // save shift the clip as if Start had still been at 0.2 s: 0.1 s late.
  const keepAll = (lane: HTMLElement) => {
    selectRange(lane, 0, 5)
    fireEvent.keyDown(screen.getByTestId("station"), { key: "k", code: "KeyK" })
  }
  it("an edit made after Start was moved by hand is measured from where Start was then: it moves nothing", async () => {
    const { lane } = await open(placedTake())
    deleteRange(lane, 3, 3.2)
    keepAll(lane)
    await act(async () => {})
    deleteRange(lane, 0.1, 0.2)
    expect(await saved()).toMatchObject({ trimStartMs: null, targetOffsetMs: 10_000, recordingsOffsetMs: 500 })
  })

  it("an unsaved edit undone takes its shift back with it", async () => {
    const { lane } = await open(placedTake())
    deleteRange(lane, 0, 0.8)
    fireEvent.click(screen.getByTestId("station-undo"))
    await act(async () => {})
    deleteRange(lane, 2, 3)
    expect(await saved()).toMatchObject({ trimStartMs: 200, targetOffsetMs: 10_000, recordingsOffsetMs: 500 })
  })
})

describe("while Record now is running, Save and the Station's Undo wait (finding 15)", () => {
  const unsavedDelete = () =>
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ ops: [{ kind: "del", a: 2, b: 3 }], trim: null, sources: {}, undo: [{ ops: [], trim: null }], scope: "clip" }))

  for (const kind of ["counting", "recording", "finishing"]) {
    it(`Save does nothing and Undo is greyed while it is ${kind}`, async () => {
      unsavedDelete()
      mocks.rec = { phase: { kind, at: 1 }, busy: true }
      await open(makeTake())
      fireEvent.click(screen.getByTestId("station-save"))
      await act(async () => {})
      expect(mocks.save).not.toHaveBeenCalled()
      expect((screen.getByTestId("station-save") as HTMLButtonElement).disabled).toBe(true)
      expect((screen.getByTestId("station-save-more") as HTMLButtonElement).disabled).toBe(true)
      const undo = screen.getByTestId("station-undo")
      expect(undo.getAttribute("aria-disabled")).toBe("true")
      expect(undo.getAttribute("aria-label")).toMatch(/Stop the recording first/)
      fireEvent.click(undo)
      // The unsaved delete is still there: Undo took nothing back mid-take.
      expect(screen.getByTestId("station-not-saved")).toBeTruthy()
    })
  }

  it("once the recording is stopped and waits for Keep, Save and Undo work again", async () => {
    unsavedDelete()
    mocks.rec = { phase: { kind: "pending", at: 1 }, busy: true }
    await open(makeTake())
    expect((screen.getByTestId("station-save") as HTMLButtonElement).disabled).toBe(false)
    expect(screen.getByTestId("station-undo").getAttribute("aria-disabled")).toBe("false")
    fireEvent.click(screen.getByTestId("station-save"))
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1))
  })
})
