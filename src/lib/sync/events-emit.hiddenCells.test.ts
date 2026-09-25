// AQU-1422: the client half of "Hide cell / Show cell".
//
// Two things are worth pinning at the emit boundary, and both are about the
// difference between this kind and the delete it replaces:
//
//   1. It is NOT chain-mutating and carries `parentId: null`. A hide must not
//      advance the source head, or every lane's translation goes stale (AD-9)
//      for a change that touched no text.
//   2. The client's role mirror refuses it below PROJECT_LEAD. This module fails
//      OPEN on an unknown kind, so a missing row in role-policy.ts would let a
//      contributor's outbox enqueue a hide the server then 403s — the row would
//      vanish optimistically and come back on reload, which reads as data loss
//      rather than as a refusal.

import { describe, it, expect, beforeEach } from "vitest"
import "fake-indexeddb/auto"
import { emitSourceCellVisibilitySet, InsufficientRoleError } from "./events-emit"
import { peekOutboxBatch, resetOutboxConnectionForTests } from "./outbox"
import { setCqrsOutboxBridge } from "./cqrs-bridge"
import { ROLE } from "./role-policy"
import { isChainMutatingKind, isGenesisKind } from "./outbox-types"

describe("emitSourceCellVisibilitySet (AQU-1422)", () => {
  beforeEach(async () => {
    setCqrsOutboxBridge(null)
    await resetOutboxConnectionForTests()
    await new Promise<void>((resolve, reject) => {
      const d = indexedDB.deleteDatabase("aquilla-cqrs-outbox")
      d.onblocked = () => resolve()
      d.onsuccess = () => resolve()
      d.onerror = () => reject(d.error)
    })
  })

  it("enqueues a parent-less hide event on the named cell", async () => {
    await emitSourceCellVisibilitySet({
      projectId: "p",
      fileId: "f",
      cellId: "v1",
      hidden: true,
      author: "lead",
    })

    const batch = await peekOutboxBatch(10)
    expect(batch).toHaveLength(1)
    expect(batch[0].event.kind).toBe("source.cell.visibility.set")
    expect(batch[0].event.cellId).toBe("v1")
    expect(batch[0].event.payload).toEqual({ hidden: true })
    // Null because the kind is non-chain-mutating: it must not compete for the
    // source row's chain slot, and it must not move the head.
    expect(batch[0].event.parentId).toBeNull()
  })

  it("carries hidden:false for show, on the same kind", async () => {
    await emitSourceCellVisibilitySet({
      projectId: "p",
      fileId: "f",
      cellId: "v1",
      hidden: false,
      author: "lead",
    })

    const batch = await peekOutboxBatch(10)
    expect(batch[0].event.payload).toEqual({ hidden: false })
  })

  it("is neither chain-mutating nor genesis", () => {
    expect(isChainMutatingKind("source.cell.visibility.set")).toBe(false)
    expect(isGenesisKind("source.cell.visibility.set")).toBe(false)
  })

  it("refuses to enqueue below PROJECT_LEAD rather than letting the server 403 it", async () => {
    setCqrsOutboxBridge({ projectId: "p", activeFileId: "f", username: "u", roleLevel: ROLE.CONTRIBUTOR })

    await expect(
      emitSourceCellVisibilitySet({
        projectId: "p",
        fileId: "f",
        cellId: "v1",
        hidden: true,
        author: "u",
      }),
    ).rejects.toBeInstanceOf(InsufficientRoleError)
    // Nothing durable was written, so no flush can carry it and the optimistic
    // row is put back by the caller's catch.
    expect(await peekOutboxBatch(10)).toHaveLength(0)
  })

  it("admits a project lead", async () => {
    setCqrsOutboxBridge({ projectId: "p", activeFileId: "f", username: "u", roleLevel: ROLE.PROJECT_LEAD })

    await emitSourceCellVisibilitySet({
      projectId: "p",
      fileId: "f",
      cellId: "v1",
      hidden: true,
      author: "u",
    })

    expect(await peekOutboxBatch(10)).toHaveLength(1)
  })
})
