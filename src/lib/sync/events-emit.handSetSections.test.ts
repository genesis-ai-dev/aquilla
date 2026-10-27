// AQU-2185: the client half of "Start a section here".
//
// Three things are worth pinning at the emit boundary:
//
//   1. It is NOT chain-mutating and carries `parentId: null`. Naming a division
//      must not advance the source head, or every lane's translation goes stale
//      (AD-9) for a change that touched no text.
//   2. The client's role mirror refuses it below PROJECT_LEAD. This module fails
//      OPEN on an unknown kind, so a missing row in role-policy.ts would let a
//      contributor's outbox enqueue a section the server then 403s — the
//      division would appear optimistically and vanish on reload, which reads
//      as the app losing work rather than as a refusal.
//   3. A blank name is refused HERE rather than sent as a clear. `null` means
//      "remove the section"; `""` is a caller's bug, and letting it through
//      would delete a division nobody asked to remove.

import { describe, it, expect, beforeEach } from "vitest"
import "fake-indexeddb/auto"
import { emitSourceCellMilestoneSet, InsufficientRoleError } from "./events-emit"
import { peekOutboxBatch, resetOutboxConnectionForTests } from "./outbox"
import { setCqrsOutboxBridge } from "./cqrs-bridge"
import { ROLE } from "./role-policy"
import { isChainMutatingKind, isGenesisKind } from "./outbox-types"

describe("emitSourceCellMilestoneSet (AQU-2185)", () => {
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

  it("enqueues a parent-less set event on the named cell", async () => {
    await emitSourceCellMilestoneSet({
      projectId: "p",
      fileId: "f",
      cellId: "v70",
      label: "The storm",
      author: "lead",
    })

    const batch = await peekOutboxBatch(10)
    expect(batch).toHaveLength(1)
    expect(batch[0].event.kind).toBe("source.cell.milestone.set")
    expect(batch[0].event.cellId).toBe("v70")
    expect(batch[0].event.payload).toEqual({ label: "The storm" })
    // Null because the kind is non-chain-mutating: it must not compete for the
    // source row's chain slot, and it must not move the head.
    expect(batch[0].event.parentId).toBeNull()
  })

  it("trims the name, so a stray space cannot make two sections of one", async () => {
    await emitSourceCellMilestoneSet({
      projectId: "p",
      fileId: "f",
      cellId: "v70",
      label: "  The storm  ",
      author: "lead",
    })

    const batch = await peekOutboxBatch(10)
    expect(batch[0].event.payload).toEqual({ label: "The storm" })
  })

  it("carries label:null to clear the section, on the same kind", async () => {
    await emitSourceCellMilestoneSet({
      projectId: "p",
      fileId: "f",
      cellId: "v70",
      label: null,
      author: "lead",
    })

    const batch = await peekOutboxBatch(10)
    expect(batch[0].event.kind).toBe("source.cell.milestone.set")
    expect(batch[0].event.payload).toEqual({ label: null })
  })

  it("refuses a blank name instead of turning it into a clear", async () => {
    await expect(
      emitSourceCellMilestoneSet({
        projectId: "p",
        fileId: "f",
        cellId: "v70",
        label: "   ",
        author: "lead",
      }),
    ).rejects.toThrow(/non-blank/)
    expect(await peekOutboxBatch(10)).toHaveLength(0)
  })

  it("is neither chain-mutating nor genesis", () => {
    expect(isChainMutatingKind("source.cell.milestone.set")).toBe(false)
    expect(isGenesisKind("source.cell.milestone.set")).toBe(false)
  })

  it("refuses to enqueue below PROJECT_LEAD rather than letting the server 403 it", async () => {
    setCqrsOutboxBridge({ projectId: "p", activeFileId: "f", username: "u", roleLevel: ROLE.CONTRIBUTOR })

    await expect(
      emitSourceCellMilestoneSet({
        projectId: "p",
        fileId: "f",
        cellId: "v70",
        label: "The storm",
        author: "u",
      }),
    ).rejects.toBeInstanceOf(InsufficientRoleError)
    expect(await peekOutboxBatch(10)).toHaveLength(0)
  })

  it("admits a project lead", async () => {
    setCqrsOutboxBridge({ projectId: "p", activeFileId: "f", username: "u", roleLevel: ROLE.PROJECT_LEAD })

    await emitSourceCellMilestoneSet({
      projectId: "p",
      fileId: "f",
      cellId: "v70",
      label: "The storm",
      author: "u",
    })

    expect(await peekOutboxBatch(10)).toHaveLength(1)
  })
})
