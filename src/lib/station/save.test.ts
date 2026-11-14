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

import { historyView, matchingSteps, resetHistoryForTests, setHistoryScope } from "@/lib/history/history"
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

  // AQU-2492 (review, Nov 9), findings 4 and 8: the step that removes the
  // take Save replaced names the new version (its Undo never hands the slot
  // back to it) and who had approved the old take (only an approval given
  // after the Undo stops the Redo).
  it("the removal in Save's step names the new version and who had approved the old take", async () => {
    resetHistoryForTests()
    setHistoryScope("p", "ana")
    const res = await saveStationVersion({
      projectId: "p",
      samples: new Float32Array(4800),
      rate: 48000,
      placements: [{ ...base, approvedBy: ["ben"] }],
      author: "ana",
      getSyncToken: async () => "jwt",
      where: { fileId: "f" },
      mode: "over",
    })
    const named = matchingSteps((kind, data) => {
      const d = data as { audioId?: string; replacedBy?: string; approvedBy?: Record<string, string[]> }
      return kind === "take.remove" && d.audioId === "t2.webm" && d.replacedBy === res.audioIds[0] && d.approvedBy?.["t2.webm"]?.join() === "ben"
    })
    expect(named.undo).toHaveLength(1)
    resetHistoryForTests()
  })

  // AQU-2492 (review, round 2): Save over a piece of a cut take notes, on
  // both halves of its step, the stretch of its recording the replaced piece
  // played, which the new piece stands for: its Undo and Redo are then held
  // to the rule that no two pieces of a take play one stretch.
  it("Save over a piece notes the stretch it replaced, for its Undo and its Redo", async () => {
    resetHistoryForTests()
    setHistoryScope("p", "bob")
    const stretch = { pieceOf: "t1.webm", url: "frontier-audio://t1.webm", startMs: 1000, endMs: 4000 }
    const res = await saveStationVersion({
      projectId: "p",
      samples: new Float32Array(4800),
      rate: 48000,
      placements: [{ ...base, fromAudioId: "p2.webm", pieceOf: "t1.webm", replacedStretch: stretch }],
      author: "bob",
      getSyncToken: async () => "jwt",
      where: { fileId: "f" },
      mode: "over",
    })
    const added = matchingSteps((kind, data) => {
      const d = data as { audioId?: string; replaces?: string; stretches?: Record<string, unknown> }
      return kind === "take.add" && d.audioId === res.audioIds[0] && d.replaces === "p2.webm" && JSON.stringify(d.stretches?.[res.audioIds[0]]) === JSON.stringify(stretch)
    })
    const removed = matchingSteps((kind, data) => {
      const d = data as { audioId?: string; stretches?: Record<string, unknown> }
      return kind === "take.remove" && d.audioId === "p2.webm" && JSON.stringify(d.stretches?.["p2.webm"]) === JSON.stringify(stretch)
    })
    expect(added.undo).toHaveLength(1)
    expect(removed.undo).toHaveLength(1)
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
})
