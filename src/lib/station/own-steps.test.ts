// AQU-2493 (review, Nov 9): which Undo steps the Station's own button acts on.
import { beforeEach, describe, expect, it } from "vitest"
import { historyReady, recordGroup, recordStep, registerStepKinds, resetHistoryForTests, setHistoryScope, type StepHandler } from "@/lib/history/history"
import { clearHistoryStoreForTests } from "@/lib/history/history-store"
import { movedSinceStationStep, newestStationStep, stationStepMatch } from "./own-steps"

describe("the Station's own Undo steps", () => {
  const mine = stationStepMatch("c331", "t2.webm")

  it("are changes to the open take: trim, volume and fades, rename, a saved version, a delete, an approval", () => {
    for (const kind of ["take.window", "take.gain", "take.rename", "take.add", "take.remove", "vote.audio"]) {
      expect(mine(kind, { cellId: "c331", audioId: "t2.webm" })).toBe(true)
    }
  })

  it("are never a move of the open take on the timeline (the Station cannot move a take; ⌘Z still undoes it)", () => {
    expect(mine("take.place", { cellId: "c331", audioId: "t2.webm", before: null, after: 600 })).toBe(false)
  })

  it("include a version made of a cut take when the open take is one of its later pieces", () => {
    expect(mine("take.add", { cellId: "c331", audioId: "dn.wav", pieces: ["t2.webm"] })).toBe(true)
  })

  it("are never the line's own changes, which name no take", () => {
    expect(mine("text.commit", { cellId: "c331", side: "target", lane: "" })).toBe(false)
    expect(mine("vote.text", { cellId: "c331", lane: "", voted: true })).toBe(false)
    expect(mine("row.retime", { cellId: "c331" })).toBe(false)
    expect(mine("row.hidden", { cellId: "c331", hidden: true })).toBe(false)
    expect(mine("cast.assign", { cellId: "c331" })).toBe(false)
  })

  it("are never another take's, another line's, or a choice of which take plays", () => {
    expect(mine("take.gain", { cellId: "c331", audioId: "t1.webm" })).toBe(false)
    expect(mine("take.gain", { cellId: "c9", audioId: "t2.webm" })).toBe(false)
    expect(mine("take.select", { cellId: "c331", slot: "recording", before: "t1.webm", after: "t2.webm" })).toBe(false)
    // A non-take step that happens to carry the same ids.
    expect(mine("comment.create", { cellId: "c331", audioId: "t2.webm" })).toBe(false)
    expect(mine("take.gain", null)).toBe(false)
  })
})

// AQU-2493 (review, Nov 9), finding 6: a step made of several parts counted
// for the Station when any one part named the open take, so approving thirty
// lines' audio from the selection bar (one step) was taken back whole by the
// Station's Undo when one of them was the open take. A bulk change made
// outside the Station is never the Station's to undo.
describe("the Station's own Undo and a step made of several parts", () => {
  const noop = { undo: async () => ({ kind: "done" }), redo: async () => ({ kind: "done" }) } as unknown as StepHandler<never>
  beforeEach(async () => {
    resetHistoryForTests()
    await clearHistoryStoreForTests()
    registerStepKinds({ "take.window": noop, "take.place": noop, "vote.audio": noop, "take.add": noop, "take.remove": noop })
    setHistoryScope("p1", "sam")
    await historyReady()
  })
  const trim = () => recordStep({ kind: "take.window", data: { cellId: "c12", audioId: "t12.webm", before: {}, after: { trimEndMs: 900 } }, labelKey: "editor.history.stepTrimTake", lane: null })

  it("passes over a bulk approval that includes the open take, to the Station's own last change", () => {
    trim()
    recordGroup(
      { labelKey: "editor.history.stepValidateAudioMany", labelParams: { count: 3 }, fileId: "f1" },
      ["c1", "c12", "c30"].map((cellId) => ({
        kind: "vote.audio",
        data: { cellId, audioId: cellId === "c12" ? "t12.webm" : `${cellId}.webm`, voted: true },
        labelKey: "editor.history.stepValidateAudio",
        fileId: "f1",
      })),
    )
    expect(newestStationStep("c12", "t12.webm")?.labelKey).toBe("editor.history.stepTrimTake")
  })

  it("still counts a Station save, which writes copies on the other lines that use the recording", () => {
    trim()
    recordGroup({ labelKey: "editor.history.stepStationSaveOver", fileId: "f1" }, [
      { kind: "take.add", data: { cellId: "c12", audioId: "v2.wav", slot: "recording" }, labelKey: "editor.history.stepAddTake", fileId: "f1" },
      { kind: "take.remove", data: { cellId: "c12", audioId: "t12.webm", slot: "recording" }, labelKey: "editor.history.stepDeleteTake", fileId: "f1" },
      { kind: "take.add", data: { cellId: "c30", audioId: "v2-30.wav", slot: "recording" }, labelKey: "editor.history.stepAddTake", fileId: "f1" },
      { kind: "take.remove", data: { cellId: "c30", audioId: "t30.webm", slot: "recording" }, labelKey: "editor.history.stepDeleteTake", fileId: "f1" },
    ])
    expect(newestStationStep("c12", "v2.wav")?.labelKey).toBe("editor.history.stepStationSaveOver")
    expect(newestStationStep("c12", "t12.webm")?.labelKey).toBe("editor.history.stepStationSaveOver")
  })

  it("passes over a timeline move of the open take, to the Station's own last change", () => {
    trim()
    recordStep({ kind: "take.place", data: { cellId: "c12", audioId: "t12.webm", before: null, after: 600, recordingsBefore: null, recordingsAfter: null }, labelKey: "editor.history.stepMove", lane: null })
    expect(newestStationStep("c12", "t12.webm")?.labelKey).toBe("editor.history.stepTrimTake")
  })

  // Review of 152db3f40: a save, then a move of the saved take on the timeline. Undoing the save under the
  // move would throw the move away (the save's undo does not look at places, and ⌘Z then finds no take).
  it("knows when the open take was moved on the timeline since the Station's last change (a save), as it does a cut", () => {
    recordGroup({ labelKey: "editor.history.stepStationSaveOver", fileId: "f1" }, [
      { kind: "take.add", data: { cellId: "c12", audioId: "v2.wav", slot: "recording" }, labelKey: "editor.history.stepAddTake", fileId: "f1" },
      { kind: "take.remove", data: { cellId: "c12", audioId: "t12.webm", slot: "recording" }, labelKey: "editor.history.stepDeleteTake", fileId: "f1" },
    ])
    const save = newestStationStep("c12", "v2.wav")
    expect(save?.labelKey).toBe("editor.history.stepStationSaveOver")
    expect(movedSinceStationStep("c12", "v2.wav", save!.id)).toBe(false)
    recordStep({ kind: "take.place", data: { cellId: "c12", audioId: "other.wav", before: null, after: 600, recordingsBefore: null, recordingsAfter: null }, labelKey: "editor.history.stepMove", lane: null })
    expect(movedSinceStationStep("c12", "v2.wav", save!.id)).toBe(false)
    recordStep({ kind: "take.place", data: { cellId: "c12", audioId: "v2.wav", before: null, after: 600, recordingsBefore: null, recordingsAfter: null }, labelKey: "editor.history.stepMove", lane: null })
    expect(newestStationStep("c12", "v2.wav")?.id).toBe(save!.id)
    expect(movedSinceStationStep("c12", "v2.wav", save!.id)).toBe(true)
  })

  it("a move made before the Station's last change is not one since", () => {
    recordStep({ kind: "take.place", data: { cellId: "c12", audioId: "t12.webm", before: null, after: 600, recordingsBefore: null, recordingsAfter: null }, labelKey: "editor.history.stepMove", lane: null })
    trim()
    const own = newestStationStep("c12", "t12.webm")
    expect(movedSinceStationStep("c12", "t12.webm", own!.id)).toBe(false)
  })

  it("an approval of the open take alone, made anywhere, is still its own", () => {
    trim()
    recordStep({ kind: "vote.audio", data: { cellId: "c12", audioId: "t12.webm", voted: true }, labelKey: "editor.history.stepValidateAudio", lane: null })
    expect(newestStationStep("c12", "t12.webm")?.labelKey).toBe("editor.history.stepValidateAudio")
  })
})
