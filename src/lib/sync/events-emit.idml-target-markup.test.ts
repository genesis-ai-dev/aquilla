// Placing a validated IDML translation into its style runs without committing it.
//
// A translation typed as plain text in a file that only later received its IDML
// contract has to be moved into the paragraph's style runs before the file can
// be exported. Saved as a `target.cell.commit`, that resets the line to
// unvalidated although not one word changed. `emitIdmlTargetMarkup` sends the
// event the server already projects as markup only — `source.cell.metadata.patch`
// with `targetHtml` — which leaves text, history, chain head and validation
// where they were. What is pinned here is the envelope the server requires
// (version 2, parent-less, an empty metadata merge) and the role floor.

import { describe, it, expect, beforeEach } from "vitest"
import "fake-indexeddb/auto"
import { emitIdmlTargetMarkup, InsufficientRoleError } from "./events-emit"
import { peekOutboxBatch, resetOutboxConnectionForTests } from "./outbox"
import { setCqrsOutboxBridge } from "./cqrs-bridge"
import { canPerform, ROLE } from "./role-policy"
import { isChainMutatingKind, isGenesisKind } from "./outbox-types"

const HTML = '<p data-idml-version="2"><span data-idml-slot="0" data-idml-protected="slot">Теория</span></p>'

describe("emitIdmlTargetMarkup", () => {
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

  it("enqueues a version-2 markup patch that names no parent and merges no metadata", async () => {
    const ids = await emitIdmlTargetMarkup([
      { projectId: "p", fileId: "f", cellId: "c1", targetHtml: HTML, author: "lead" },
      { projectId: "p", fileId: "f", cellId: "c2", targetHtml: HTML, author: "lead" },
    ])

    const batch = await peekOutboxBatch(10)
    expect(batch.map((entry) => entry.event.id)).toEqual(ids)
    expect(batch[0].event).toMatchObject({
      kind: "source.cell.metadata.patch",
      schemaVersion: 2,
      cellId: "c1",
      parentId: null,
      payload: { version: 1, metadata: {}, targetHtml: HTML },
    })
  })

  it("is neither chain-mutating nor genesis: no head moves, so nothing goes stale", () => {
    expect(isChainMutatingKind("source.cell.metadata.patch")).toBe(false)
    expect(isGenesisKind("source.cell.metadata.patch")).toBe(false)
  })

  it("is a project lead's write, refused below that before it reaches the outbox", async () => {
    expect(canPerform("source.cell.metadata.patch", ROLE.PROJECT_LEAD)).toBe(true)
    setCqrsOutboxBridge({ projectId: "p", activeFileId: "f", username: "u", roleLevel: ROLE.CONTRIBUTOR })

    await expect(
      emitIdmlTargetMarkup([{ projectId: "p", fileId: "f", cellId: "c1", targetHtml: HTML, author: "u" }]),
    ).rejects.toBeInstanceOf(InsufficientRoleError)
    expect(await peekOutboxBatch(10)).toHaveLength(0)
  })
})
