// AQU-2655: an edit that validates itself writes its commit and its
// validation to the outbox as ONE write. WHY: as two writes, every outbox
// subscriber re-read IndexedDB and re-rendered the workspace for the state in
// between (edit pending, approvals cleared), and a crash between them kept
// the edit and silently lost its validation.
import { describe, it, expect, beforeEach, vi } from "vitest"
import "fake-indexeddb/auto"
import { emitTargetCellCommitAndValidate, TargetLaneUnresolvedError } from "./events-emit"
import {
  outboxPendingCount,
  peekOutboxBatch,
  resetOutboxConnectionForTests,
  setActiveOutboxOwner,
  subscribeToOutbox,
} from "./outbox"
import { setCqrsOutboxBridge } from "./cqrs-bridge"
import { resetProjectTargetLanesForTests, setProjectTargetLanes } from "./project-target-lanes"
import { ROLE } from "./role-policy"

// A role the client refuses validation to while it may still commit. No real
// role is like that today (validate's floor is below commit's); the emitter
// must still keep the edit if one ever is.
const refuseValidation = vi.hoisted(() => ({ on: false }))
vi.mock("./role-policy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./role-policy")>()
  return {
    ...actual,
    canPerform: (kind: string, level: number) =>
      refuseValidation.on && kind === "cell.validate" ? false : actual.canPerform(kind, level),
  }
})

const PROJECT = "proj-2655"
const COMMIT_ID = "0190a000-0000-7000-8000-000000000001"

function commitInput(value = "En el principio") {
  return {
    id: COMMIT_ID,
    projectId: PROJECT,
    fileId: "file-1",
    cellId: "cell-1",
    parentId: "evt-source",
    value,
    author: "alice",
    targetLang: "Spanish",
  }
}

const validateInput = {
  projectId: PROJECT,
  fileId: "file-1",
  cellId: "cell-1",
  author: "alice",
  targetLang: "Spanish",
  auto: true,
  surface: "cell" as const,
}

const journalKeys = () => Object.keys(localStorage).filter((k) => k.startsWith("aquilla:outbox-recovery:"))

describe("emitTargetCellCommitAndValidate (AQU-2655)", () => {
  beforeEach(async () => {
    refuseValidation.on = false
    localStorage.clear()
    setCqrsOutboxBridge(null)
    resetProjectTargetLanesForTests()
    setProjectTargetLanes(PROJECT, [{ id: "lane-es", legacyTag: "Spanish" }])
    await resetOutboxConnectionForTests()
    await new Promise<void>((resolve, reject) => {
      const d = indexedDB.deleteDatabase("aquilla-cqrs-outbox")
      d.onblocked = () => resolve()
      d.onsuccess = () => resolve()
      d.onerror = () => reject(d.error)
    })
    setActiveOutboxOwner("alice")
  })

  it("queues the edit and its validation together and tells subscribers once, with both already there", async () => {
    const seenAtNotify: Promise<string[]>[] = []
    let result: Awaited<ReturnType<typeof emitTargetCellCommitAndValidate>> | undefined
    const unsubscribe = subscribeToOutbox(() => {
      seenAtNotify.push(peekOutboxBatch(10).then((rows) => rows.map((r) => r.event.kind)))
    })
    try {
      result = await emitTargetCellCommitAndValidate(commitInput(), validateInput)
      expect(result.eventId).toBe(COMMIT_ID)
      // One notification, and the first read it triggers never sees half the gesture.
      expect(seenAtNotify).toHaveLength(1)
      expect(await seenAtNotify[0]).toEqual(["target.cell.commit", "cell.validate"])
    } finally {
      unsubscribe()
    }
    const [commit, validate] = await peekOutboxBatch(10)
    // The flusher sends in this order, so the server sees the edit before the
    // vote that must name it as the cell's latest edit.
    expect(commit.event).toMatchObject({ id: COMMIT_ID, kind: "target.cell.commit", parentId: "evt-source" })
    expect(validate.event).toMatchObject({
      kind: "cell.validate",
      parentId: null,
      payload: expect.objectContaining({ editEventId: COMMIT_ID, laneId: "lane-es" }),
    })
    expect(result?.validation).toEqual({ ok: true, eventId: validate.event.id })
  })

  it("journals the pair as one entry before IndexedDB lands, so a crash recovers both or neither", async () => {
    const pending = emitTargetCellCommitAndValidate(commitInput(), validateInput)
    const keys = journalKeys()
    expect(keys).toHaveLength(1)
    const entry = localStorage.getItem(keys[0])!
    expect((JSON.parse(entry) as { event: { kind: string } }[]).map((r) => r.event.kind))
      .toEqual(["target.cell.commit", "cell.validate"])
    await pending
    expect(journalKeys()).toEqual([])

    // The page died before IndexedDB committed: only the journal survived.
    await resetOutboxConnectionForTests()
    await new Promise<void>((resolve) => {
      const d = indexedDB.deleteDatabase("aquilla-cqrs-outbox")
      d.onsuccess = () => resolve()
      d.onblocked = () => resolve()
    })
    localStorage.setItem(keys[0], entry)
    setActiveOutboxOwner("alice")
    expect((await peekOutboxBatch(10)).map((r) => r.event.kind)).toEqual(["target.cell.commit", "cell.validate"])
  })

  it("still journals a commit too big for a batch entry on its own, as a lone commit would be", async () => {
    const pending = emitTargetCellCommitAndValidate(commitInput("x".repeat(300_000)), validateInput)
    expect(journalKeys()).toEqual([`aquilla:outbox-recovery:v1:${COMMIT_ID}`])
    await pending
    expect(journalKeys()).toEqual([])
    expect(await outboxPendingCount()).toBe(2)
  })

  it("queues neither and tells nobody when the edit itself is refused", async () => {
    const listener = vi.fn()
    const unsubscribe = subscribeToOutbox(listener)
    try {
      await expect(
        emitTargetCellCommitAndValidate({ ...commitInput(), targetLang: "" }, { ...validateInput, targetLang: "" }),
      ).rejects.toBeInstanceOf(TargetLaneUnresolvedError)
    } finally {
      unsubscribe()
    }
    expect(listener).not.toHaveBeenCalled()
    expect(await outboxPendingCount()).toBe(0)
    expect(journalKeys()).toEqual([])
  })

  it("keeps the edit when only its validation is refused", async () => {
    refuseValidation.on = true
    setCqrsOutboxBridge({ projectId: PROJECT, activeFileId: "file-1", username: "alice", roleLevel: ROLE.CONTRIBUTOR })
    const { eventId, validation } = await emitTargetCellCommitAndValidate(commitInput(), validateInput)
    expect(eventId).toBe(COMMIT_ID)
    expect(validation).toMatchObject({ ok: false, error: expect.objectContaining({ name: "InsufficientRoleError" }) })
    expect((await peekOutboxBatch(10)).map((r) => r.id)).toEqual([COMMIT_ID])
  })
})
