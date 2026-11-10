import { beforeEach, describe, expect, it, vi } from "vitest"
import type { CellRow } from "@/lib/sync/cells-read-types"

let sourceRows: Partial<CellRow>[] = []

vi.mock("@/lib/sync/cells-read", () => ({
  fetchAllFileCells: vi.fn(async (_p: string, _f: string, _jwt: string, side: "source" | "target") => (side === "source" ? sourceRows : [])),
  fetchFileCells: vi.fn(),
}))
vi.mock("@/lib/sync/cell-audio-read", () => ({ fetchFileAudioAttachments: vi.fn(async () => ({ cells: {} })) }))

import { loadTargetFile } from "./load-targets"

const row = (cellId: string, extra: Partial<CellRow> = {}): Partial<CellRow> => ({ cellId, side: "source", type: "text", value: cellId, canonicalRef: null, ...extra })
const info = { fileId: "f1", name: "Episode 1", bookCode: null }

beforeEach(() => { sourceRows = [] })

// AQU-2496 (review, Nov 9): every bulk take goes on the main track. The
// preview's "choose the earlier recording again" is true only where it
// replaces the main track's own take, not where the earlier recording plays
// on an added track or a layer and never stops.
describe("loadTargetFile: which lines' main-track take a bulk upload replaces", () => {
  const take = (slot: string) => ({ audioId: "", url: "frontier-audio://x.webm", slot, mimeType: null, voiceId: null, referenceAudioId: null, durationMs: 1000, trimStartMs: null, trimEndMs: null })
  const entry = (bySlot: Record<string, string>) => ({
    attachments: Object.fromEntries(Object.entries(bySlot).map(([slot, id]) => [id, take(slot)])),
    selectedBySlot: bySlot,
    selectedAudioId: bySlot.recording ?? null,
    selectedGeneratedVoiceAudioId: null,
    audioTimings: {},
  })

  it("is the main track's own chosen take only", async () => {
    sourceRows = [row("c1"), row("c2"), row("c3"), row("c4")]
    const { fetchFileAudioAttachments } = await import("@/lib/sync/cell-audio-read")
    vi.mocked(fetchFileAudioAttachments).mockResolvedValueOnce({
      cells: {
        c1: entry({ recording: "audio-c1-1-a.webm" }),
        c2: entry({ "0199aaaa-voices": "audio-c2-1-b.webm" }),
        c3: entry({ "0199bbbb-music": "audio-c3-1-c.webm" }),
      },
    } as never)
    const lines = (await loadTargetFile("p1", info, "jwt", "")).lines
    expect(lines.map((l) => [l.cellId, l.hasRecording, l.mainTake])).toEqual([
      ["c1", true, true],
      ["c2", true, false],
      ["c3", true, false],
      ["c4", false, false],
    ])
  })
})

// Sam, Oct 29 (question 3): "a file whose lines have times" is a subtitle or
// film file, and refuses ranges. The loader is what tells the matcher so.
describe("loadTargetFile: a timed file", () => {
  it("is timed when its lines have start times", async () => {
    sourceRows = [row("c1", { startMs: 0, endMs: 1200 }), row("c2", { startMs: 1200, endMs: 2500 })]
    expect((await loadTargetFile("p1", info, "jwt", "")).timed).toBe(true)
  })

  it("is not timed when no line has a time (a Bible book, a document)", async () => {
    sourceRows = [row("c1"), row("c2", { startMs: null, endMs: null })]
    expect((await loadTargetFile("p1", info, "jwt", "")).timed).toBe(false)
  })

  it("ignores hidden lines and headings when deciding", async () => {
    sourceRows = [row("h", { type: "paratext", startMs: 0 }), row("x", { hidden: true, startMs: 0 }), row("c1")]
    expect((await loadTargetFile("p1", info, "jwt", "")).timed).toBe(false)
  })
})
