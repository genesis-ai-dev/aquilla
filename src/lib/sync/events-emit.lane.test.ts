// AQU-1902: every lane-addressed write is stamped with its lane row before it
// reaches the outbox — or refused at the source when no lane row can be named,
// instead of being queued, refused by the server (AQU-1900) and dropped.
import { describe, it, expect, beforeEach } from "vitest"
import "fake-indexeddb/auto"
import {
  emitCellValidate,
  emitTargetCellCommit,
  emitTargetCellCommits,
  emitTargetCellRepin,
  enqueueEvent,
  TargetLaneUnresolvedError,
} from "./events-emit"
import { outboxPendingCount, peekOutboxBatch, resetOutboxConnectionForTests } from "./outbox"
import { setCqrsOutboxBridge } from "./cqrs-bridge"
import {
  resetProjectTargetLanesForTests,
  setProjectLaneHint,
  setProjectTargetLanes,
} from "./project-target-lanes"

const PROJECT = "proj-1902"
const TAGGED = [
  { id: "lane-es", legacyTag: "Spanish" },
  { id: "lane-fr", legacyTag: "French" },
]

function commit(lane: { targetLang: string; laneId?: string }, cellId = "cell-1") {
  return {
    projectId: PROJECT,
    fileId: "file-1",
    cellId,
    parentId: "evt-source",
    value: "En el principio",
    author: "alice",
    ...lane,
  }
}

async function queuedPayloads(): Promise<Array<Record<string, unknown>>> {
  const batch = await peekOutboxBatch(50)
  return batch.map((record) => record.event.payload as Record<string, unknown>)
}

describe("events-emit lane stamping (AQU-1902)", () => {
  beforeEach(async () => {
    setCqrsOutboxBridge(null)
    resetProjectTargetLanesForTests()
    await resetOutboxConnectionForTests()
    await new Promise<void>((resolve, reject) => {
      const d = indexedDB.deleteDatabase("aquilla-cqrs-outbox")
      d.onblocked = () => resolve()
      d.onsuccess = () => resolve()
      d.onerror = () => reject(d.error)
    })
  })

  it("editor commit: stamps the lane id of the active lane's tag", async () => {
    setProjectTargetLanes(PROJECT, TAGGED)
    await emitTargetCellCommit(commit({ targetLang: "Spanish" }))
    expect(await queuedPayloads()).toEqual([
      expect.objectContaining({ value: "En el principio", targetLang: "Spanish", laneId: "lane-es" }),
    ])
  })

  it("refuses a lane-less commit on an all-tagged project and queues nothing", async () => {
    setProjectTargetLanes(PROJECT, TAGGED)
    await expect(emitTargetCellCommit(commit({ targetLang: "" }))).rejects.toMatchObject({
      name: "TargetLaneUnresolvedError",
      reason: "no-such-lane",
    })
    expect(await outboxPendingCount()).toBe(0)
  })

  it("refuses while the lanes are loading, unless the remembered lane names this tag", async () => {
    setProjectTargetLanes(PROJECT, null)
    await expect(emitTargetCellCommit(commit({ targetLang: "Spanish" }))).rejects.toBeInstanceOf(
      TargetLaneUnresolvedError,
    )
    expect(await outboxPendingCount()).toBe(0)

    setProjectLaneHint(PROJECT, { laneId: "lane-es", targetLang: "Spanish" })
    await emitTargetCellCommit(commit({ targetLang: "Spanish" }))
    expect(await queuedPayloads()).toEqual([
      expect.objectContaining({ targetLang: "Spanish", laneId: "lane-es" }),
    ])
  })

  it("keeps a lane-less commit lane-less on a project with no target lane (bridge)", async () => {
    setProjectTargetLanes(PROJECT, [])
    await emitTargetCellCommit(commit({ targetLang: "" }))
    const [payload] = await queuedPayloads()
    expect(payload).not.toHaveProperty("targetLang")
    expect(payload).not.toHaveProperty("laneId")
  })

  it("passes a project nothing registered through unchanged (server stays authoritative)", async () => {
    await emitTargetCellCommit(commit({ targetLang: "Spanish" }))
    const [payload] = await queuedPayloads()
    expect(payload).toMatchObject({ targetLang: "Spanish" })
    expect(payload).not.toHaveProperty("laneId")
  })

  it("validation is stamped too", async () => {
    setProjectTargetLanes(PROJECT, TAGGED)
    await emitCellValidate({
      projectId: PROJECT,
      fileId: "file-1",
      cellId: "cell-1",
      editEventId: "evt-commit",
      author: "alice",
      targetLang: "French",
    })
    expect(await queuedPayloads()).toEqual([
      expect.objectContaining({ editEventId: "evt-commit", targetLang: "French", laneId: "lane-fr" }),
    ])
  })

  it("repin carries the repinned row's lane", async () => {
    setProjectTargetLanes(PROJECT, TAGGED)
    await emitTargetCellRepin({
      projectId: PROJECT,
      fileId: "file-1",
      cellId: "cell-1",
      sourceEventId: "evt-src-2",
      expectedTargetEventId: "evt-target-1",
      targetLang: "French",
      author: "reviewer",
    })
    expect(await queuedPayloads()).toEqual([
      expect.objectContaining({ sourceEventId: "evt-src-2", targetLang: "French", laneId: "lane-fr" }),
    ])
  })

  it("a raw staged payload (agent apply) is resolved the same way", async () => {
    setProjectTargetLanes(PROJECT, TAGGED)
    await enqueueEvent({
      kind: "target.cell.commit",
      projectId: PROJECT,
      fileId: "file-1",
      cellId: "cell-1",
      parentId: "evt-source",
      author: "alice",
      payload: { value: "x", laneId: "lane-fr" },
    })
    expect(await queuedPayloads()).toEqual([
      expect.objectContaining({ targetLang: "French", laneId: "lane-fr" }),
    ])
  })

  it("one unresolvable event refuses the whole batch before anything is queued", async () => {
    setProjectTargetLanes(PROJECT, TAGGED)
    await expect(
      emitTargetCellCommits([commit({ targetLang: "Spanish" }, "cell-1"), commit({ targetLang: "" }, "cell-2")]),
    ).rejects.toBeInstanceOf(TargetLaneUnresolvedError)
    expect(await outboxPendingCount()).toBe(0)
  })

  it("leaves non-lane kinds alone", async () => {
    setProjectTargetLanes(PROJECT, null)
    await enqueueEvent({
      kind: "source.cell.commit",
      projectId: PROJECT,
      fileId: "file-1",
      cellId: "cell-1",
      parentId: "evt-source",
      author: "alice",
      payload: { value: "In the beginning" },
    })
    expect(await outboxPendingCount()).toBe(1)
  })
})
