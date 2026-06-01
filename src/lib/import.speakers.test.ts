// Regression test for the double-parse cellId mismatch bug:
//
// Previously, ImportDialog would call extractVttStrings + buildBulkCellsWithSpeakers
// in a SEPARATE pass from the importFile call, so both parses minted fresh UUIDs.
// The speakerPairs keys (first parse) never matched the uploaded cell IDs (second
// parse), silently dropping all speaker→voice assignments.
//
// The fix: emitParsedFile now calls buildBulkCellsWithSpeakers ONCE and surfaces
// the speakerPairs in its return value. This test asserts the invariant that every
// cellId in speakerPairs matches a cellId among the cells sent to bulkUploadSource.

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest"
import { emitParsedFile, importFile } from "./import"

interface CapturedBody {
  projectId: string
  fileId: string
  cells: Array<{ id: string; cellId: string; anchorCellId: string | null; value: string }>
}

let captured: CapturedBody[]

beforeEach(() => {
  captured = []
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as CapturedBody
      captured.push(body)
      return new Response(
        JSON.stringify({ accepted: body.cells.length, fileId: body.fileId }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )
    }),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const getToken = async () => "test-token"

describe("import — speakerPairs cellId consistency (single-parse invariant)", () => {
  it("emitParsedFile: every speakerPair cellId matches a cell that was uploaded", async () => {
    // Simulate parsed VTT strings with speaker annotations (as extractVttStrings produces).
    // We use fixed IDs matching what buildBulkCellsWithSpeakers will use (str.id).
    const { ref, speakerPairs } = await emitParsedFile(
      {
        name: "scene.vtt",
        strings: [
          {
            id: "cue-1",
            original: "Hello there",
            translated: "",
            context: "0:00:01",
            group: "g1",
            type: "cue",
            start: 1,
            end: 2,
            speaker: "Narrator",
          },
          {
            id: "cue-2",
            original: "General Kenobi",
            translated: "",
            context: "0:00:03",
            group: "g2",
            type: "cue",
            start: 3,
            end: 4,
            speaker: "Villain",
          },
          {
            id: "cue-3",
            original: "No speaker here",
            translated: "",
            context: "0:00:05",
            group: "g3",
            type: "cue",
            start: 5,
            end: 6,
            // speaker is absent
          },
        ],
      },
      "vtt",
      { projectId: "p-sp", author: "tester", getToken },
    )

    // Collect all cellIds that were actually uploaded.
    const uploadedCellIds = new Set(captured.flatMap((b) => b.cells.map((c) => c.cellId)))

    // Every speakerPair (with or without a speaker) must reference a real uploaded cell.
    for (const { cellId } of speakerPairs) {
      expect(uploadedCellIds.has(cellId)).toBe(true)
    }

    // Specifically, the two cues with speakers must be assigned to real cells.
    const speakerPairsWithSpeaker = speakerPairs.filter((p) => p.speaker)
    expect(speakerPairsWithSpeaker).toHaveLength(2)
    expect(speakerPairsWithSpeaker[0].speaker).toBe("Narrator")
    expect(speakerPairsWithSpeaker[1].speaker).toBe("Villain")
    for (const { cellId } of speakerPairsWithSpeaker) {
      expect(uploadedCellIds.has(cellId)).toBe(true)
    }

    // Sanity: the upload happened and cellCount matches.
    expect(ref.cellCount).toBe(3)
  })

  it("importFile (VTT): speakerPairs cellIds match the cells in the bulk upload", async () => {
    const vttContent = [
      "WEBVTT",
      "",
      "00:00:01.000 --> 00:00:02.000",
      "<v Alice>First line</v>",
      "",
      "00:00:03.000 --> 00:00:04.000",
      "<v Bob>Second line</v>",
      "",
      "00:00:05.000 --> 00:00:06.000",
      "No speaker",
      "",
    ].join("\n")

    const file = new File([vttContent], "dialogue.vtt", { type: "text/vtt" })
    const { refs, speakerPairs } = await importFile(file, {
      projectId: "p-vtt",
      author: "tester",
      getToken,
    })

    expect(refs).toHaveLength(1)
    expect(refs[0].cellCount).toBe(3)

    const uploadedCellIds = new Set(captured.flatMap((b) => b.cells.map((c) => c.cellId)))

    // All speakerPairs must reference cells that were actually uploaded.
    for (const { cellId } of speakerPairs) {
      expect(uploadedCellIds.has(cellId)).toBe(true)
    }

    // Two cues have speakers.
    const withSpeaker = speakerPairs.filter((p) => p.speaker)
    expect(withSpeaker).toHaveLength(2)
    expect(withSpeaker.map((p) => p.speaker)).toEqual(["Alice", "Bob"])
  })
})
