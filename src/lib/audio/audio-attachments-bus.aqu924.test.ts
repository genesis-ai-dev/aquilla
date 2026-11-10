// AQU-924: uploaded cell audio must not disappear when its attach event can't
// be delivered.
//
// The reported loss had two halves, and this file pins the DURABLE half — what
// survives a page refresh. The optimistic-shadow registry is memory-only, so
// after a reload the only thing that can bring a not-yet-saved take back is
// rehydration from the outbox. That rehydration used to consider `pending`
// records only, so an attach that had been quarantined (403) or had burned
// through its retry budget was skipped: the take was gone from the cell with no
// waveform, no error and nothing to retry, even though its bytes were in R2 and
// its event was still sitting right there in IndexedDB.
//
// The in-memory half (a quarantined overlay keeping the take visible and badged
// `syncFailed` rather than being dropped) lives in
// useFileAudioAttachments.shadow.test.tsx.

import { describe, it, expect, beforeEach } from "vitest"
import "fake-indexeddb/auto"
import {
  enqueueOutboxEvent,
  getOutboxFileAudioRecords,
  quarantineOutboxEvents,
  removeOutboxEvents,
  resetOutboxConnectionForTests,
} from "@/lib/sync/outbox"
import { CQRS_SCHEMA_VERSION } from "@/lib/sync/outbox-types"
import type { CqrsRawEvent } from "@/lib/sync/outbox-types"
import {
  __resetShadowRehydrationForTests,
  clearOptimisticShadows,
  getOptimisticShadows,
  injectOptimisticAudioAttachment,
  injectOptimisticAudioRemove,
  injectOptimisticAudioTrim,
  rehydrateShadowsFromOutbox,
  retryFailedAudioSync,
} from "./audio-attachments-bus"

const PROJECT = "p1"
const FILE = "f-est"
const CELL = "EST 1:1"
const AUDIO_ID = "audio-EST_1_1-1700000000000-abc123.wav"

/** The event the upload button emits after its R2 PUT succeeds. */
function attachEvent(over: Record<string, unknown> = {}) {
  return {
    id: "evt-attach-1",
    schemaVersion: CQRS_SCHEMA_VERSION,
    kind: "cell.audio.attach",
    projectId: PROJECT,
    fileId: FILE,
    cellId: CELL,
    parentId: null,
    author: "joy",
    payload: {
      audioId: AUDIO_ID,
      url: `frontier-audio://${AUDIO_ID}`,
      slot: "recording",
      mimeType: "audio/wav",
      durationMs: 4200,
    },
    clientTs: 1,
    ...over,
  } as unknown as CqrsRawEvent<"cell.audio.attach">
}

describe("AQU-924 — a failed audio attach survives a reload", () => {
  beforeEach(async () => {
    clearOptimisticShadows(FILE)
    __resetShadowRehydrationForTests()
    await resetOutboxConnectionForTests()
    await new Promise<void>((resolve, reject) => {
      const d = indexedDB.deleteDatabase("aquilla-cqrs-outbox")
      d.onblocked = () => resolve()
      d.onsuccess = () => resolve()
      d.onerror = () => reject(d.error)
    })
  })

  it("returns quarantined attaches, not just pending ones", async () => {
    await enqueueOutboxEvent(attachEvent())
    await quarantineOutboxEvents(["evt-attach-1"], { status: 403, reason: "HTTP 403" })

    const records = await getOutboxFileAudioRecords(PROJECT, FILE)
    expect(records.map((r) => r.id)).toEqual(["evt-attach-1"])
    expect(records[0].status).toBe("failed")
  })

  it("still excludes events for other files and other projects", async () => {
    await enqueueOutboxEvent(attachEvent())
    await enqueueOutboxEvent(attachEvent({ id: "other-file", fileId: "f-other" }))
    await enqueueOutboxEvent(attachEvent({ id: "other-project", projectId: "p2" }))
    await quarantineOutboxEvents(["evt-attach-1", "other-file", "other-project"], {
      status: 403,
      reason: "HTTP 403",
    })

    const records = await getOutboxFileAudioRecords(PROJECT, FILE)
    expect(records.map((r) => r.id)).toEqual(["evt-attach-1"])
  })

  it("a DELIVERED attach is not resurrected — delivery deletes the record", async () => {
    await enqueueOutboxEvent(attachEvent())
    await removeOutboxEvents(["evt-attach-1"]) // what an accepted flush does

    expect(await getOutboxFileAudioRecords(PROJECT, FILE)).toEqual([])
    await rehydrateShadowsFromOutbox(PROJECT, FILE)
    expect(getOptimisticShadows(FILE).size).toBe(0)
  })

  it("rehydrates a quarantined attach after a reload, so the take reappears", async () => {
    await enqueueOutboxEvent(attachEvent())
    await quarantineOutboxEvents(["evt-attach-1"], { status: 403, reason: "HTTP 403" })

    // Fresh page: the registry is empty until rehydration runs.
    expect(getOptimisticShadows(FILE).size).toBe(0)
    await rehydrateShadowsFromOutbox(PROJECT, FILE)

    const shadows = getOptimisticShadows(FILE).get(CELL)
    expect(shadows).toHaveLength(1)
    const shadow = shadows![0]
    expect(shadow.kind).toBe("attach")
    if (shadow.kind !== "attach") throw new Error("expected an attach shadow")
    expect(shadow.att.audioId).toBe(AUDIO_ID)
    expect(shadow.att.durationMs).toBe(4200)
    // Bound to its record, so the reader can look the status up and paint
    // `syncFailed` rather than "saving".
    expect(shadow.eventId).toBe("evt-attach-1")
  })

  it("does NOT rehydrate a stuck REMOVE — a failed delete must not keep hiding a live clip", async () => {
    await enqueueOutboxEvent(
      attachEvent({ id: "evt-remove", kind: "cell.audio.remove" }),
    )
    await quarantineOutboxEvents(["evt-remove"], { status: 403, reason: "HTTP 403" })

    await rehydrateShadowsFromOutbox(PROJECT, FILE)
    // Nothing painted: the clip is still on the server and must stay visible.
    expect(getOptimisticShadows(FILE).size).toBe(0)
  })

  it("still rehydrates a PENDING remove (unchanged behaviour)", async () => {
    await enqueueOutboxEvent(
      attachEvent({ id: "evt-remove", kind: "cell.audio.remove" }),
    )

    await rehydrateShadowsFromOutbox(PROJECT, FILE)
    const shadows = getOptimisticShadows(FILE).get(CELL)
    expect(shadows).toHaveLength(1)
    expect(shadows![0].kind).toBe("remove")
  })

  // AQU-2492 (review, Nov 9): undoing a cut is one event now, not a remove, a
  // trim and a rename; a queued one still takes the cut's piece off the screen.
  it("rehydrates a PENDING undo of a cut as the removal of the piece the cut made", async () => {
    await enqueueOutboxEvent(
      attachEvent({
        id: "evt-uncut",
        kind: "cell.audio.uncut",
        payload: { audioId: AUDIO_ID, pieceAudioId: "piece-b.wav", trimStartMs: null, trimEndMs: null },
      }),
    )
    await rehydrateShadowsFromOutbox(PROJECT, FILE)
    const shadows = getOptimisticShadows(FILE).get(CELL)
    expect(shadows).toHaveLength(1)
    expect(shadows![0]).toMatchObject({ kind: "remove", audioId: "piece-b.wav", eventId: "evt-uncut" })
  })

  it("retryFailedAudioSync puts the clip's stuck attach back on the queue", async () => {
    await enqueueOutboxEvent(attachEvent())
    await quarantineOutboxEvents(["evt-attach-1"], { status: 403, reason: "HTTP 403" })

    const requeued = await retryFailedAudioSync(PROJECT, FILE, CELL, AUDIO_ID)
    expect(requeued).toBe(1)

    const records = await getOutboxFileAudioRecords(PROJECT, FILE)
    expect(records[0].status).toBe("pending")
    expect(records[0].attempts).toBe(0)
    expect(records[0].lastError).toBeNull()
  })

  it("retryFailedAudioSync only touches the clip it was asked about", async () => {
    await enqueueOutboxEvent(attachEvent())
    await enqueueOutboxEvent(
      attachEvent({
        id: "evt-other-clip",
        payload: {
          audioId: "audio-EST_1_2-1700000000001-def456.wav",
          url: "frontier-audio://other",
          slot: "recording",
        },
      }),
    )
    await quarantineOutboxEvents(["evt-attach-1", "evt-other-clip"], {
      status: 403,
      reason: "HTTP 403",
    })

    expect(await retryFailedAudioSync(PROJECT, FILE, CELL, AUDIO_ID)).toBe(1)

    const byId = new Map(
      (await getOutboxFileAudioRecords(PROJECT, FILE)).map((r) => [r.id, r.status]),
    )
    expect(byId.get("evt-attach-1")).toBe("pending")
    expect(byId.get("evt-other-clip")).toBe("failed") // untouched
  })

  it("retryFailedAudioSync is a no-op (0) when nothing is stuck for that clip", async () => {
    await enqueueOutboxEvent(attachEvent()) // pending, not failed
    expect(await retryFailedAudioSync(PROJECT, FILE, CELL, AUDIO_ID)).toBe(0)
    expect(await retryFailedAudioSync(PROJECT, FILE, CELL, "audio-nope.wav")).toBe(0)
  })
})

// AQU-2492 (review, Nov 9), finding 1: Undo a cut, then Redo it before any
// read. The Undo hides the second piece; the Redo names that same piece again
// and paints it without claiming a selection (it rides its group's). That
// paint used to be dropped because "a delete outranks a metadata write", so
// the second half stayed hidden until the remove's 12 s grace ran out, and an
// Undo pressed then read it as gone and was thrown away.
describe("AQU-2492 — Redo of a cut straight after its Undo", () => {
  const take = (audioId: string, over: Record<string, unknown> = {}) => ({
    audioId,
    url: "frontier-audio://take-a.wav",
    slot: "recording",
    mimeType: "audio/wav",
    voiceId: null,
    referenceAudioId: null,
    durationMs: 6000,
    trimStartMs: null,
    trimEndMs: null,
    ...over,
  })

  beforeEach(() => clearOptimisticShadows(FILE))

  it("the piece the Redo brings back is painted at once, over the Undo's removal of it", () => {
    // The Undo: the piece goes, the take is whole again.
    injectOptimisticAudioRemove(FILE, CELL, "take-b", "recording", "evt-uncut")
    injectOptimisticAudioTrim(FILE, CELL, take("take-a"), "evt-uncut")
    // The Redo, at once: the take ends at the cut, the same piece comes back.
    injectOptimisticAudioTrim(FILE, CELL, take("take-a", { trimEndMs: 2000 }), "evt-redo")
    injectOptimisticAudioAttachment(
      FILE, CELL, take("take-b", { trimStartMs: 2000, pieceOf: "take-a" }), "evt-redo",
      { claimSelection: false, revive: true },
    )
    const shadows = getOptimisticShadows(FILE).get(CELL) ?? []
    expect(shadows.some((s) => s.kind === "remove" && s.audioId === "take-b")).toBe(false)
    const piece = shadows.find((s) => s.kind === "attach" && s.att.audioId === "take-b")
    expect(piece).toMatchObject({ kind: "attach", claimsSelection: false, att: { trimStartMs: 2000, pieceOf: "take-a" } })
    expect(shadows.find((s) => s.kind === "attach" && s.att.audioId === "take-a")).toMatchObject({ att: { trimEndMs: 2000 } })
  })

  it("a plain metadata paint still never brings back a take the user deleted", () => {
    injectOptimisticAudioRemove(FILE, CELL, "take-b", "recording", "evt-remove")
    injectOptimisticAudioAttachment(FILE, CELL, take("take-b", { durationMs: 5000 }), "evt-measure", { claimSelection: false })
    const shadows = getOptimisticShadows(FILE).get(CELL) ?? []
    expect(shadows.map((s) => s.kind)).toEqual(["remove"])
  })
})
