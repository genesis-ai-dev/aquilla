import { beforeEach, describe, expect, it, vi } from "vitest"

const calls = vi.hoisted(() => ({ attach: [] as unknown[], place: [] as unknown[], remove: [] as unknown[] }))
vi.mock("@/lib/audio/upload", () => ({
  buildAudioId: (seed: string) => `audio-${seed}`,
  uploadCellAudio: vi.fn(async (a: { audioId: string }) => ({ audioId: a.audioId, ext: "wav", url: `frontier-audio://${a.audioId}.wav` })),
  deleteCellAudio: vi.fn(async () => {}),
}))
vi.mock("@/lib/audio/bytes-cache", () => ({ audioCachePutBlob: vi.fn(async () => {}) }))
vi.mock("@/lib/audio/audio-attachments-bus", () => ({ injectOptimisticAudioAttachment: vi.fn(), notifyAudioAttachmentsChanged: vi.fn() }))
vi.mock("@/lib/sync/events-emit", () => ({
  emitCellAudioAttach: vi.fn(async (x: unknown) => (calls.attach.push(x), "ev")),
  emitCellAudioPlace: vi.fn(async (x: unknown) => (calls.place.push(x), "ev")),
  emitCellAudioRemove: vi.fn(async (x: unknown) => (calls.remove.push(x), "ev")),
}))

import { historyReady, historyView, redoLast, registerStepKinds, resetHistoryForTests, setHistoryScope, undoLast } from "@/lib/history/history"
import { clearHistoryStoreForTests } from "@/lib/history/history-store"
import { takeStepHandlers } from "@/lib/history/take-steps"
import type { CodexCellAttachment } from "@/lib/codex-editor/types"
import { saveStationVersion, type VersionPlacement } from "./save"

const base: VersionPlacement = {
  fileId: "f",
  cellId: "c331",
  fromAudioId: "t2.webm",
  slot: "recording",
  label: "Take 2",
  trimStartMs: null,
  trimEndMs: 2500,
  targetOffsetMs: 120,
  recordingsOffsetMs: null,
  selectedBefore: "t2.webm",
}

describe("Save as new version", () => {
  beforeEach(() => {
    calls.attach.length = 0
    calls.place.length = 0
    calls.remove.length = 0
  })

  it("attaches the new version on each line, pointing back at the take it replaces, keeping track, name, trim and place", async () => {
    const res = await saveStationVersion({
      projectId: "p",
      samples: new Float32Array(48000),
      rate: 48000,
      placements: [base, { ...base, cellId: "c316", fromAudioId: "t1.webm", trimEndMs: null, targetOffsetMs: null }],
      author: "ana",
      getSyncToken: async () => "jwt",
      where: { fileId: "f" },
    })
    expect(res.audioIds).toEqual(["audio-c331.wav", "audio-c316.wav"])
    expect(calls.attach[0]).toMatchObject({ cellId: "c331", referenceAudioId: "t2.webm", label: "Take 2", slot: "recording", trimEndMs: 2500, durationMs: 1000 })
    expect(calls.attach[1]).toMatchObject({ cellId: "c316", referenceAudioId: "t1.webm", url: "frontier-audio://audio-c331.wav" })
    expect(calls.place).toHaveLength(1)
    expect(calls.remove).toHaveLength(0)
  })

  // Item 30: each line's attach carries what changed and where it went, for
  // the History row ("Version 2 saved: a part deleted · used on line 331").
  it("records what the version changed and the lines it goes on, on every line's attach", async () => {
    const changes = { kinds: ["deleted" as const, "inserted" as const], usedOn: ["c331", "c316"] }
    await saveStationVersion({
      projectId: "p",
      samples: new Float32Array(4800),
      rate: 48000,
      placements: [base, { ...base, cellId: "c316", fromAudioId: "t1.webm" }],
      author: "ana",
      getSyncToken: async () => "jwt",
      where: { fileId: "f" },
      changes,
    })
    expect(calls.attach).toHaveLength(2)
    for (const a of calls.attach) expect(a).toMatchObject({ versionChanges: changes })
  })

  it("replaces a piece of a split take in place, as a piece (Q6)", async () => {
    await saveStationVersion({
      projectId: "p",
      samples: new Float32Array(4800),
      rate: 48000,
      placements: [{ ...base, fromAudioId: "piece2.webm", pieceOf: "t3.webm" }],
      author: "ana",
      getSyncToken: async () => "jwt",
      where: { fileId: "f" },
    })
    expect(calls.attach[0]).toMatchObject({ pieceOf: "t3.webm" })
    expect(calls.remove[0]).toMatchObject({ audioId: "piece2.webm" })
  })

  it("Save saves over the take: the take it replaces goes in the same step, and the attach says so (Nov 2)", async () => {
    const changes = { kinds: ["deleted" as const], usedOn: ["c331", "c316"] }
    await saveStationVersion({
      projectId: "p",
      samples: new Float32Array(4800),
      rate: 48000,
      placements: [base, { ...base, cellId: "c316", fromAudioId: "t1.webm" }],
      author: "ana",
      getSyncToken: async () => "jwt",
      where: { fileId: "f" },
      changes,
      mode: "over",
    })
    expect(calls.attach).toHaveLength(2)
    for (const a of calls.attach) expect(a).toMatchObject({ label: "Take 2", versionChanges: { ...changes, over: true } })
    expect(calls.remove.map((r) => (r as { audioId: string }).audioId)).toEqual(["t2.webm", "t1.webm"])
  })

  // Found in the Nov 2 browser check: Undo after a plain Save said "Undid:
  // Save a new version".
  it("names the Undo step by what Save did: over the take, or a new version", async () => {
    resetHistoryForTests()
    setHistoryScope("p", "ana")
    const args = {
      projectId: "p",
      samples: new Float32Array(4800),
      rate: 48000,
      placements: [base],
      author: "ana",
      getSyncToken: async () => "jwt",
      where: { fileId: "f" },
    }
    await saveStationVersion({ ...args, mode: "over" })
    expect(historyView().nextUndo?.labelKey).toBe("editor.history.stepStationSaveOver")
    await saveStationVersion({ ...args, placements: [base, { ...base, cellId: "c316" }], mode: "new" })
    expect(historyView().nextUndo?.labelKey).toBe("editor.history.stepStationVersion")
    resetHistoryForTests()
  })

  it("Save as new version keeps the original", async () => {
    await saveStationVersion({
      projectId: "p",
      samples: new Float32Array(4800),
      rate: 48000,
      placements: [base],
      author: "ana",
      getSyncToken: async () => "jwt",
      where: { fileId: "f" },
      changes: { kinds: ["deleted"], usedOn: ["c331"] },
      mode: "new",
    })
    expect(calls.remove).toHaveLength(0)
    expect(calls.attach[0]).not.toMatchObject({ versionChanges: { over: true } })
  })

  // AQU-2493 (review, Nov 9): Undo of a save on one piece of a cut take left
  // both the old piece and the new one on the line: taking the new piece away
  // was skipped as "changed since", because its take still held the pieces
  // that were there all along.
  describe("Undo of a save on one piece of a cut take", () => {
    type Takes = Record<string, Partial<CodexCellAttachment>>
    /** A line's takes, with the workspace's own reads and writes over them. */
    async function world(takes: Takes) {
      resetHistoryForTests()
      await clearHistoryStoreForTests()
      registerStepKinds(
        takeStepHandlers({
          readTake: (_c, id) => (takes[id] && !takes[id].isDeleted ? (takes[id] as CodexCellAttachment) : null),
          selectedIn: () => "t3.webm",
          applyTrim: async () => {},
          applyPlace: async () => {},
          cut: async () => true,
          uncut: async () => {},
          newPieceId: () => "fresh",
          select: async (_c, _slot, id) => {
            if (id) takes[id] = { ...takes[id], isDeleted: false }
          },
          remove: async (_c, id) => {
            takes[id] = { ...takes[id], isDeleted: true }
          },
          rename: async () => {},
          liveGroup: (_c, id) => {
            const group = takes[id]?.pieceOf ?? id
            return Object.keys(takes).filter((k) => !takes[k].isDeleted && (takes[k].pieceOf ?? k) === group)
          },
        }),
      )
      setHistoryScope("p", "ana")
      await historyReady()
    }
    const live = (takes: Takes) => Object.keys(takes).filter((k) => !takes[k].isDeleted).sort()
    const savePiece = (piece: VersionPlacement) =>
      saveStationVersion({ projectId: "p", samples: new Float32Array(4800), rate: 48000, placements: [piece], author: "ana", getSyncToken: async () => "jwt", where: { fileId: "f" }, mode: "over" })

    it("takes the new piece away and brings the old one back; Redo swaps them again", async () => {
      const takes: Takes = { "t3.webm": { slot: "recording", trimEndMs: 2500 }, "piece2.webm": { slot: "recording", pieceOf: "t3.webm", trimStartMs: 2500 } }
      await world(takes)
      const res = await savePiece({ ...base, fromAudioId: "piece2.webm", pieceOf: "t3.webm", selectedBefore: "t3.webm", otherPieces: ["t3.webm"] })
      // What the save's events did to the line.
      takes[res.audioIds[0]] = { slot: "recording", pieceOf: "t3.webm" }
      takes["piece2.webm"] = { ...takes["piece2.webm"], isDeleted: true }

      expect((await undoLast())?.outcome).toEqual({ kind: "done" })
      expect(live(takes)).toEqual(["piece2.webm", "t3.webm"])
      expect((await redoLast())?.outcome).toEqual({ kind: "done" })
      expect(live(takes)).toEqual([res.audioIds[0], "t3.webm"].sort())
      resetHistoryForTests()
    })

    it("the same for the take's first piece, which the other pieces are named after", async () => {
      const takes: Takes = { "t3.webm": { slot: "recording", trimEndMs: 2500 }, "piece2.webm": { slot: "recording", pieceOf: "t3.webm", trimStartMs: 2500 } }
      await world(takes)
      const res = await savePiece({ ...base, fromAudioId: "t3.webm", pieceOf: "t3.webm", selectedBefore: "t3.webm", otherPieces: ["piece2.webm"] })
      takes[res.audioIds[0]] = { slot: "recording", pieceOf: "t3.webm" }
      takes["t3.webm"] = { ...takes["t3.webm"], isDeleted: true }

      expect((await undoLast())?.outcome).toEqual({ kind: "done" })
      expect(live(takes)).toEqual(["piece2.webm", "t3.webm"])
      resetHistoryForTests()
    })

    it("still leaves the new piece alone when it was cut again since the save", async () => {
      const takes: Takes = { "t3.webm": { slot: "recording", trimEndMs: 2500 }, "piece2.webm": { slot: "recording", pieceOf: "t3.webm", trimStartMs: 2500 } }
      await world(takes)
      const res = await savePiece({ ...base, fromAudioId: "piece2.webm", pieceOf: "t3.webm", selectedBefore: "t3.webm", otherPieces: ["t3.webm"] })
      takes[res.audioIds[0]] = { slot: "recording", pieceOf: "t3.webm" }
      takes["piece2.webm"] = { ...takes["piece2.webm"], isDeleted: true }
      // Someone cut the saved piece in two.
      takes["piece3.wav"] = { slot: "recording", pieceOf: "t3.webm" }

      await undoLast()
      expect(live(takes)).toContain(res.audioIds[0])
      expect(live(takes)).toContain("piece3.wav")
      resetHistoryForTests()
    })
  })
})
