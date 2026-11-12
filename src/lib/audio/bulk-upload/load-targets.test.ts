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
