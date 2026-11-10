// AQU-2495 (review, Nov 9): a take's clip may now start before 0:00 (a music
// bed with 45 s trimmed off its start, dragged so it sounds from 0:00), but
// its sound may not: playback skips whatever sounds before the file, and the
// audio exports by time pull it to 0:00, so the deliverable had it later than
// the app. The Station's Start is held the way the timeline's left trim handle
// is: never so far back that the sound starts before the file.
import { describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@testing-library/react"
import { useStationEditor } from "./useStationEditor"
import type { StationHost, StationTake } from "./station-host"
import type { StationTarget } from "@/lib/station/target"

vi.mock("@/lib/station/load", () => ({
  loadStationPcm: async () => ({ data: new Float32Array(48_000 * 120), rate: 48_000, duration: 120, peak: 1 }),
  putStationPcm: (_id: string, p: unknown) => p,
  pcmKey: (u: string) => u,
}))

const BED = "bed.wav"

/** A line from 12 s; its bed's clip starts `placeMs` from it, `trimMs` trimmed off. */
function bed(placeMs: number, trimMs: number, startTime: number | null = 12): StationTake {
  const att = { url: `frontier-audio://${BED}`, type: "audio", slot: "trk-music", durationMs: 120_000, trimStartMs: trimMs, targetOffsetMs: placeMs }
  return {
    fileId: "f1",
    cell: { id: "c1", fileId: "f1", startTime: startTime ?? undefined, endTime: startTime != null ? startTime + 4 : undefined, attachments: { [BED]: att } } as unknown as StationTake["cell"],
    att: att as StationTake["att"],
  }
}

function hostFor(take: StationTake): StationHost {
  return {
    project: { id: "p1" } as StationHost["project"],
    username: "ana",
    editable: true,
    getSyncToken: async () => "jwt",
    readTake: () => take,
    trim: vi.fn(async () => {}),
    setLevel: vi.fn(async () => {}),
  } as unknown as StationHost
}

const target: StationTarget = { fileId: "f1", cellId: "c1", audioId: BED }

async function open(take: StationTake) {
  const host = hostFor(take)
  const view = renderHook(() => useStationEditor(host, take, target, false))
  await waitFor(() => expect(view.result.current.length).toBe(120))
  return { host, view }
}

describe("the Station's Start never lets a take sound before the file (AQU-2495)", () => {
  // Its clip starts 45 s before 0:00 (12 s - 57 s); 50 s trimmed off, so it sounds from 0:05.
  it("dragging Start back past the file's start stops at it, and Keep saves it there", async () => {
    const { host, view } = await open(bed(-57_000, 50_000))
    act(() => view.result.current.setLiveTrim({ a: 30, b: -1 }))
    expect(view.result.current.trimA).toBeCloseTo(45, 3)
    await act(async () => { await view.result.current.commitTrim(30, -1) })
    expect(host.trim).toHaveBeenCalledWith("c1", BED, { trimStartMs: 45_000, trimEndMs: undefined })
  })

  it("a take whose clip starts inside the file un-trims to its very start, as before", async () => {
    const { host, view } = await open(bed(0, 2_000))
    await act(async () => { await view.result.current.commitTrim(0, -1) })
    expect(host.trim).toHaveBeenCalledWith("c1", BED, { trimStartMs: undefined, trimEndMs: undefined })
  })

  it("on a line with no times there is no file to fall off", async () => {
    const { host, view } = await open(bed(-57_000, 50_000, null))
    await act(async () => { await view.result.current.commitTrim(30, -1) })
    expect(host.trim).toHaveBeenCalledWith("c1", BED, { trimStartMs: 30_000, trimEndMs: undefined })
  })
})
