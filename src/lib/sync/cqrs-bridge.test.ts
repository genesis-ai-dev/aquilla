/**
 * Unit tests for cqrs-bridge.ts
 *
 * Tests the workspace-scoped singleton bridge used to enqueue CQRS events
 * from Yjs helpers without threading project/file IDs through call sites.
 *
 * Covers:
 *   - setCqrsOutboxBridge activation / teardown
 *   - enqueueCellCommitAfterValueEdit with and without fileIdOverride
 *   - enqueueCellValidateToggle with and without fileIdOverride
 *   - Silent no-op cases documented here as specification
 *
 * Uses real IDB via fake-indexeddb/auto (see src/test-setup.ts) and reads
 * back persisted shapes via peekOutboxBatch to avoid mocking the outbox.
 */

import { describe, it, expect, beforeEach } from "vitest"
import * as Y from "yjs"
import {
  setCqrsOutboxBridge,
  enqueueCellCommitAfterValueEdit,
  enqueueCellValidateToggle,
} from "./cqrs-bridge"
import {
  peekOutboxBatch,
  outboxPendingCount,
  resetOutboxConnectionForTests,
} from "./outbox"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDoc(cellId: string, text = "Hello world"): Y.Doc {
  const doc = new Y.Doc()
  const cells = doc.getMap("cells")
  const cell = new Y.Map()
  cells.set(cellId, cell)
  const frag = new Y.XmlFragment()
  // Attach before writing — Yjs warns on writes to detached Y types
  cell.set("translatedXml", frag)
  doc.transact(() => {
    const el = new Y.XmlElement("paragraph")
    const txt = new Y.XmlText()
    txt.insert(0, text)
    el.insert(0, [txt])
    frag.insert(0, [el])
  })
  return doc
}

const BRIDGE = {
  projectId: "proj-1",
  activeFileId: "file-1",
  username: "testuser",
}

async function resetIdb(): Promise<void> {
  await resetOutboxConnectionForTests()
  await new Promise<void>((resolve, reject) => {
    const d = indexedDB.deleteDatabase("codex-cqrs-outbox")
    d.onblocked = () => resolve()
    d.onsuccess = () => resolve()
    d.onerror = () => reject(d.error)
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("cqrs-bridge", () => {
  beforeEach(async () => {
    // Null the bridge so each test starts clean
    setCqrsOutboxBridge(null)
    await resetIdb()
  })

  // -- setCqrsOutboxBridge activation ----------------------------------------

  it("enqueueCellCommitAfterValueEdit is a no-op when no bridge is set", async () => {
    const doc = makeDoc("cell-1")
    enqueueCellCommitAfterValueEdit(doc, "cell-1", Date.now())
    expect(await outboxPendingCount()).toBe(0)
  })

  it("enqueueCellCommitAfterValueEdit enqueues an event with correct shape after bridge is set", async () => {
    setCqrsOutboxBridge(BRIDGE)
    const doc = makeDoc("cell-1", "Translated text")
    enqueueCellCommitAfterValueEdit(doc, "cell-1", 1234)

    // Give the microtask queue a chance to settle (enqueue is async void)
    await new Promise((r) => setTimeout(r, 0))

    const batch = await peekOutboxBatch(10)
    expect(batch).toHaveLength(1)
    const ev = batch[0].event
    expect(ev.kind).toBe("cell.commit")
    expect(ev.projectId).toBe("proj-1")
    expect(ev.fileId).toBe("file-1")
    expect(ev.cellId).toBe("cell-1")
    expect(ev.author).toBe("testuser")
    expect(ev.clientTs).toBe(1234)
    expect(typeof ev.id).toBe("string")
    expect(ev.id.length).toBeGreaterThan(0)
    // payload must have value and valueHtml
    const p = ev.payload as { value: string; valueHtml: string }
    expect(p.value).toBe("Translated text")
    expect(typeof p.valueHtml).toBe("string")
  })

  // -- Bridge teardown -------------------------------------------------------

  it("setting bridge to null clears lastCommitEventIdByCell (validate is no-op after re-set)", async () => {
    // Enqueue one commit to populate the internal map
    setCqrsOutboxBridge(BRIDGE)
    const doc = makeDoc("cell-teardown")
    enqueueCellCommitAfterValueEdit(doc, "cell-teardown", 1)
    await new Promise((r) => setTimeout(r, 0))
    expect(await outboxPendingCount()).toBe(1)

    // Null the bridge — must clear lastCommitEventIdByCell
    setCqrsOutboxBridge(null)

    // Re-set with same project / file
    setCqrsOutboxBridge(BRIDGE)

    // Validate should be a no-op because the map was cleared
    enqueueCellValidateToggle("cell-teardown", true, 2)
    await new Promise((r) => setTimeout(r, 0))
    // Only the commit is present, no validate
    const batch = await peekOutboxBatch(10)
    expect(batch.filter((r) => r.event.kind === "cell.validate")).toHaveLength(0)
  })

  // -- fileId stamping -------------------------------------------------------

  it("enqueueCellCommitAfterValueEdit stamps event with bridge.activeFileId when no override is given", async () => {
    setCqrsOutboxBridge(BRIDGE)
    const doc = makeDoc("cell-2")
    enqueueCellCommitAfterValueEdit(doc, "cell-2", 10)
    await new Promise((r) => setTimeout(r, 0))
    const batch = await peekOutboxBatch(10)
    expect(batch[0].event.fileId).toBe("file-1")
  })

  it("enqueueCellCommitAfterValueEdit stamps event with fileIdOverride when one is given", async () => {
    setCqrsOutboxBridge(BRIDGE) // activeFileId = "file-1"
    const doc = makeDoc("cell-3")
    enqueueCellCommitAfterValueEdit(doc, "cell-3", 10, "file-OVERRIDE")
    await new Promise((r) => setTimeout(r, 0))
    const batch = await peekOutboxBatch(10)
    expect(batch).toHaveLength(1)
    // Must be the override, NOT the bridge's activeFileId
    expect(batch[0].event.fileId).toBe("file-OVERRIDE")
    expect(batch[0].event.fileId).not.toBe("file-1")
  })

  // -- Silent no-op cases (documented behavior) ------------------------------

  it("enqueueCellCommitAfterValueEdit returns without enqueueing when bridge has no activeFileId and no override", async () => {
    setCqrsOutboxBridge({ ...BRIDGE, activeFileId: null })
    const doc = makeDoc("cell-4")
    enqueueCellCommitAfterValueEdit(doc, "cell-4", 10)
    await new Promise((r) => setTimeout(r, 0))
    expect(await outboxPendingCount()).toBe(0)
  })

  it("enqueueCellCommitAfterValueEdit returns without enqueueing when cell does not exist in the doc", async () => {
    setCqrsOutboxBridge(BRIDGE)
    const doc = makeDoc("cell-exists")
    enqueueCellCommitAfterValueEdit(doc, "cell-DOES-NOT-EXIST", 10)
    await new Promise((r) => setTimeout(r, 0))
    expect(await outboxPendingCount()).toBe(0)
  })

  // -- prevEventId chaining --------------------------------------------------

  it("subsequent commits to the same cell carry prevEventId pointing at the previous commit id", async () => {
    setCqrsOutboxBridge(BRIDGE)
    const doc = makeDoc("cell-chain")

    enqueueCellCommitAfterValueEdit(doc, "cell-chain", 1)
    await new Promise((r) => setTimeout(r, 0))
    const first = (await peekOutboxBatch(10))[0].event
    const firstId = first.id

    // Simulate second edit
    enqueueCellCommitAfterValueEdit(doc, "cell-chain", 2)
    await new Promise((r) => setTimeout(r, 0))
    const batch = await peekOutboxBatch(10)
    const second = batch.find((r) => r.event.clientTs === 2)!.event
    expect(second).toBeDefined()
    const p = second.payload as { prevEventId?: string }
    expect(p.prevEventId).toBe(firstId)
  })

  // -- enqueueCellValidateToggle ---------------------------------------------

  it("enqueueCellValidateToggle stamps event with fileIdOverride when given", async () => {
    setCqrsOutboxBridge(BRIDGE)
    // First commit to populate the lastCommitEventIdByCell map
    const doc = makeDoc("cell-vf")
    enqueueCellCommitAfterValueEdit(doc, "cell-vf", 1)
    await new Promise((r) => setTimeout(r, 0))
    // Don't resetIdb mid-test — just enqueue both and filter by clientTs
    enqueueCellValidateToggle("cell-vf", true, 2, "file-OVERRIDE")
    await new Promise((r) => setTimeout(r, 0))
    const batch = await peekOutboxBatch(10)
    // The validate event should be the second event in the batch
    const validateEvent = batch.find((r) => r.event.kind === "cell.validate")
    expect(validateEvent).toBeDefined()
    expect(validateEvent!.event.fileId).toBe("file-OVERRIDE")
    expect(validateEvent!.event.fileId).not.toBe("file-1")
  })

  it("enqueueCellValidateToggle stamps event with bridge.activeFileId when no override is given", async () => {
    setCqrsOutboxBridge(BRIDGE)
    const doc = makeDoc("cell-va")
    enqueueCellCommitAfterValueEdit(doc, "cell-va", 1)
    await new Promise((r) => setTimeout(r, 0))
    enqueueCellValidateToggle("cell-va", true, 2)
    await new Promise((r) => setTimeout(r, 0))
    const batch = await peekOutboxBatch(10)
    const validateEvent = batch.find((r) => r.event.kind === "cell.validate")
    expect(validateEvent).toBeDefined()
    expect(validateEvent!.event.fileId).toBe("file-1")
  })

  it("enqueueCellValidateToggle is a silent no-op when no prior commit exists for the cell", async () => {
    setCqrsOutboxBridge(BRIDGE)
    // No commit for "cell-unregistered" — lastCommitEventIdByCell has no entry
    enqueueCellValidateToggle("cell-unregistered", true, 1)
    await new Promise((r) => setTimeout(r, 0))
    expect(await outboxPendingCount()).toBe(0)
  })

  it("enqueueCellValidateToggle produces kind 'cell.validate' when validate=true", async () => {
    setCqrsOutboxBridge(BRIDGE)
    const doc = makeDoc("cell-v1")
    enqueueCellCommitAfterValueEdit(doc, "cell-v1", 1)
    await new Promise((r) => setTimeout(r, 0))
    enqueueCellValidateToggle("cell-v1", true, 2)
    await new Promise((r) => setTimeout(r, 0))
    const batch = await peekOutboxBatch(10)
    const validateEvent = batch.find((r) => r.event.kind === "cell.validate")
    expect(validateEvent).toBeDefined()
    expect(validateEvent!.event.kind).toBe("cell.validate")
  })

  it("enqueueCellValidateToggle produces kind 'cell.unvalidate' when validate=false", async () => {
    setCqrsOutboxBridge(BRIDGE)
    const doc = makeDoc("cell-u1")
    enqueueCellCommitAfterValueEdit(doc, "cell-u1", 1)
    await new Promise((r) => setTimeout(r, 0))
    enqueueCellValidateToggle("cell-u1", false, 2)
    await new Promise((r) => setTimeout(r, 0))
    const batch = await peekOutboxBatch(10)
    const unvalidateEvent = batch.find((r) => r.event.kind === "cell.unvalidate")
    expect(unvalidateEvent).toBeDefined()
    expect(unvalidateEvent!.event.kind).toBe("cell.unvalidate")
  })
})
