// Media redesign slice 2: the editor counts a language by what it delivers.
// The cell store derives each line's PROGRESS status (`laneStatus`) from the
// shared rule (src/lib/lanes/lane-delivers.ts); the chapter list carries the
// text and audio figures side by side (AQU-2110) from the same recorded and
// approved lines, which the workspace hands the store twice — exactly as
// `feed` does here. A Text language runs exactly today's code.
import { describe, expect, it } from "vitest"
import type { CellRow } from "@/lib/sync/cells-read-types"
import { CellStore } from "./useActiveCellStore"
import { laneLineDone, type LaneDelivers } from "@/lib/lanes/lane-delivers"

function row(cellId: string, side: "source" | "target", value: string, ref: string, endorsementCount = 0): CellRow {
  return {
    cellId,
    side,
    value,
    valueHtml: null,
    type: null,
    canonicalRef: ref,
    anchorCellId: null,
    eventId: `${side}-${cellId}`,
    sourceEventId: null,
    lastEditor: "alice",
    lastEditAt: 1,
    validated: endorsementCount >= 1,
    wordCount: value ? 1 : 0,
    endorsementCount,
    metadata: null,
  }
}

/**
 * P1.6's ten lines of RUT 1, both thresholds at 1: 1–4 both done, 5–7 text
 * validated only, 8–9 recording approved with unvalidated text, 10 nothing.
 */
function p16Store() {
  const store = new CellStore()
  store.setRuntime({ projectId: "p", fileId: "f", username: "alice", requiredValidations: 1, auditStats: new Map() })
  const rows: CellRow[] = []
  for (let n = 1; n <= 10; n++) rows.push(row(`c${n}`, "source", `Verse ${n}`, `RUT 1:${n}`))
  for (const n of [1, 2, 3, 4, 5, 6, 7]) rows.push(row(`c${n}`, "target", `Vers ${n}`, `RUT 1:${n}`, 1))
  for (const n of [8, 9]) rows.push(row(`c${n}`, "target", `Vers ${n}`, `RUT 1:${n}`, 0))
  store.replaceRows(rows)
  return store
}
const RECORDED = new Set(["c1", "c2", "c3", "c4", "c8", "c9"])
const APPROVED = new Set(["c1", "c2", "c3", "c4", "c8", "c9"])

/** What the workspace does: one pair of sets, to the line statuses and the chapter list. */
function feed(store: CellStore, delivers: LaneDelivers | null, recorded: ReadonlySet<string>, approved: ReadonlySet<string>) {
  store.setLaneAudio({ delivers, recorded, approved })
  store.setAudioProgressCellIds({ recorded, audioValidated: approved })
}

function counts(store: CellStore) {
  const ids = Array.from({ length: 10 }, (_, i) => `c${i + 1}`)
  const status = ids.map((id) => store.getCellSummary(id)?.laneStatus ?? store.getCellSummary(id)?.status)
  const chapter = store.getNavigationIndex()[0]
  return {
    started: status.filter((s) => s !== "empty").length,
    done: status.filter((s) => s === "validated").length,
    chapter: {
      translated: chapter.translated,
      validated: chapter.validated,
      audioRecorded: chapter.audioRecorded,
      audioValidated: chapter.audioValidated,
      total: chapter.total,
    },
  }
}

describe("a language that counts its recordings", () => {
  it("Text and audio: 4 of 10 lines done, with the chapter's text and audio side by side (P2.6)", () => {
    const store = p16Store()
    feed(store, "text_and_audio", RECORDED, APPROVED)
    expect(counts(store)).toEqual({
      started: 9,
      done: 4,
      chapter: { translated: 9, validated: 7, audioRecorded: 6, audioValidated: 6, total: 10 },
    })
    // `status` itself stays the text's, for every reader that means text.
    expect(store.getCellSummary("c5")?.status).toBe("validated")
    expect(store.getCellSummary("c5")?.laneStatus).toBe("unvalidated")
  })

  it("Audio: recorded and approved lines, whatever the text says", () => {
    const store = p16Store()
    feed(store, "audio", new Set(["c1", "c2", "c10"]), new Set(["c1"]))
    expect(counts(store)).toMatchObject({ started: 3, done: 1, chapter: { audioRecorded: 3, audioValidated: 1, total: 10 } })
    expect(store.getCellSummary("c10")?.laneStatus).toBe("unvalidated")
    expect(store.getCellSummary("c10")?.audioApproved).toBe(false)
  })

  it("moves at once when a recording lands, without reloading the file (P2.1 step 5)", () => {
    const store = p16Store()
    feed(store, "audio", new Set(["c1"]), new Set())
    expect(counts(store).started).toBe(1)
    feed(store, "audio", new Set(["c1", "c2"]), new Set())
    expect(counts(store)).toMatchObject({ started: 2, done: 0, chapter: { audioRecorded: 2, audioValidated: 0 } })
  })

  it("counts every line by the shared line rule", () => {
    for (const delivers of ["audio", "text_and_audio"] as const) {
      const store = p16Store()
      feed(store, delivers, RECORDED, APPROVED)
      for (let n = 1; n <= 10; n++) {
        const summary = store.getCellSummary(`c${n}`)!
        const done = laneLineDone(delivers, {
          textValidated: summary.status === "validated",
          audioApproved: APPROVED.has(`c${n}`),
        })
        expect(summary.laneStatus === "validated", `${delivers} c${n}`).toBe(done)
      }
    }
  })

  it("a text edit in Text and audio starts the line by the shared rule and moves the chapter's text", () => {
    const store = p16Store()
    feed(store, "text_and_audio", RECORDED, APPROVED)
    store.applyOptimisticTargetEdit("c10", { value: "Vers 10" })
    expect(store.getCellSummary("c10")?.laneStatus).toBe("unvalidated")
    expect(counts(store)).toMatchObject({ started: 10, done: 4, chapter: { translated: 10, validated: 7 } })
  })
})

describe("a Text language runs today's code", () => {
  it.each(["text", null] as Array<LaneDelivers | null>)("%s: no lane status, and the chapter counts its text only", (delivers) => {
    const store = p16Store()
    const before = counts(store)
    store.setLaneAudio({ delivers, recorded: RECORDED, approved: APPROVED })
    expect(store.getCellSummary("c8")?.laneStatus).toBeUndefined()
    expect(counts(store)).toEqual(before)
    expect(before).toEqual({
      started: 9,
      done: 7,
      chapter: { translated: 9, validated: 7, audioRecorded: 0, audioValidated: 0, total: 10 },
    })
  })

  it("a recording with no text still counts as translated in the chapter list, as today", () => {
    const store = new CellStore()
    store.setRuntime({
      projectId: "p", fileId: "f", username: "alice", requiredValidations: 1, auditStats: new Map(),
      ownTakeCellIds: new Set(["c1"]),
    })
    store.replaceRows([row("c1", "source", "Verse", "RUT 1:1"), row("c2", "source", "Verse", "RUT 1:2")])
    expect(store.getNavigationIndex()[0].translated).toBe(1)
    expect(store.getCellSummary("c1")?.hasOwnTake).toBe(true)
  })
})
