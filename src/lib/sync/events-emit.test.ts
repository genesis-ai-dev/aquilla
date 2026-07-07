import { describe, it, expect, beforeEach } from "vitest"
import "fake-indexeddb/auto"
import {
  buildRawEvent,
  emitTargetCellCommit,
  emitCellValidate,
  emitCellUnvalidate,
  emitSourceCellCreate,
  emitSourceCellCommit,
  emitFileCreate,
  enqueueEvent,
  InsufficientRoleError,
} from "./events-emit"
import {
  outboxPendingCount,
  peekOutboxBatch,
  resetOutboxConnectionForTests,
} from "./outbox"
import { setCqrsOutboxBridge } from "./cqrs-bridge"
import { ROLE } from "./role-policy"
import type { OutboxRawEvent } from "./outbox-types"
import { OUTBOX_SCHEMA_VERSION } from "./outbox-types"

describe("events-emit", () => {
  beforeEach(async () => {
    await resetOutboxConnectionForTests()
    await new Promise<void>((resolve, reject) => {
      const d = indexedDB.deleteDatabase("aquilla-cqrs-outbox")
      d.onblocked = () => resolve()
      d.onsuccess = () => resolve()
      d.onerror = () => reject(d.error)
    })
  })

  describe("pre-enqueue role gate", () => {
    beforeEach(() => setCqrsOutboxBridge(null))

    it("refuses to enqueue an event the user's known role can't perform (would be a guaranteed 403)", async () => {
      setCqrsOutboxBridge({ projectId: "p", activeFileId: "f", username: "u", roleLevel: ROLE.COMMENTER })
      await expect(
        enqueueEvent({ kind: "cell.validate", projectId: "p", fileId: "f", cellId: "c", parentId: null, author: "u", payload: { editEventId: "e" } }),
      ).rejects.toBeInstanceOf(InsufficientRoleError)
      // Nothing was written — the poison event never reaches the durable queue.
      expect(await outboxPendingCount()).toBe(0)
    })

    it("allows the event when the role is sufficient", async () => {
      setCqrsOutboxBridge({ projectId: "p", activeFileId: "f", username: "u", roleLevel: ROLE.REVIEWER })
      await enqueueEvent({ kind: "cell.validate", projectId: "p", fileId: "f", cellId: "c", parentId: null, author: "u", payload: { editEventId: "e" } })
      expect(await outboxPendingCount()).toBe(1)
    })

    it("fails open when the role is unknown (bridge unset) — server stays authoritative", async () => {
      setCqrsOutboxBridge(null)
      await enqueueEvent({ kind: "cell.validate", projectId: "p", fileId: "f", cellId: "c", parentId: null, author: "u", payload: { editEventId: "e" } })
      expect(await outboxPendingCount()).toBe(1)
    })
  })

  describe("buildRawEvent envelope guards", () => {
    it("allows a null parentId on a non-genesis chain-mutating event (server is authoritative)", () => {
      // The server's parent-chain guard is the authoritative check; the
      // client lets transient null-parents through. Wrong-parent events
      // surface as stale siblings via the WS reconciler.
      const ev = buildRawEvent({
        kind: "target.cell.commit",
        projectId: "p",
        fileId: "f",
        cellId: "c",
        parentId: null,
        author: "u",
        payload: { value: "x" },
      })
      expect(ev.parentId).toBe(null)
      expect(ev.kind).toBe("target.cell.commit")
    })

    it("throws when a genesis event carries a non-null parentId", () => {
      expect(() =>
        buildRawEvent({
          kind: "source.cell.create",
          projectId: "p",
          fileId: "f",
          cellId: "c1",
          parentId: "prev-event-id",
          author: "u",
          payload: { cellId: "c1", anchorCellId: null, value: "x" },
        }),
      ).toThrow(/genesis; parentId must be null/)
    })

    it("stamps schemaVersion + auto-generates id + clientTs", () => {
      const ev = buildRawEvent({
        kind: "target.cell.commit",
        projectId: "p",
        fileId: "f",
        cellId: "c",
        parentId: "parent-1",
        author: "u",
        payload: { value: "x" },
      })
      expect(ev.schemaVersion).toBe(OUTBOX_SCHEMA_VERSION)
      expect(typeof ev.id).toBe("string")
      expect(ev.id.length).toBeGreaterThan(0)
      expect(typeof ev.clientTs).toBe("number")
      expect(ev.parentId).toBe("parent-1")
    })
  })

  describe("emitTargetCellCommit", () => {
    it("enqueues a target.cell.commit with sourceEventId pin", async () => {
      const id = await emitTargetCellCommit({
        projectId: "p",
        fileId: "f",
        cellId: "c",
        parentId: "previous-commit",
        sourceEventId: "src-event-1",
        value: "hello",
        valueHtml: "<p>hello</p>",
        author: "alice",
      })
      expect(typeof id).toBe("string")
      expect(await outboxPendingCount()).toBe(1)
      const peek = await peekOutboxBatch(10)
      const ev = peek[0].event as unknown as OutboxRawEvent<"target.cell.commit">
      expect(ev.kind).toBe("target.cell.commit")
      expect(ev.parentId).toBe("previous-commit")
      expect(ev.cellId).toBe("c")
      expect(ev.fileId).toBe("f")
      expect(ev.payload.value).toBe("hello")
      expect(ev.payload.valueHtml).toBe("<p>hello</p>")
      expect(ev.payload.sourceEventId).toBe("src-event-1")
    })

    it("accepts null parentId for first-ever commit (genesis-shape fallback)", async () => {
      // Today the server rejects this with a 409 unless the cell row hasn't
      // been written yet; that's intentional — the outbox dead-letters those
      // and the UI surfaces the conflict.
      const id = await emitTargetCellCommit({
        projectId: "p",
        fileId: "f",
        cellId: "c-new",
        parentId: null,
        value: "first ever",
        author: "alice",
      })
      expect(typeof id).toBe("string")
      const peek = await peekOutboxBatch(10)
      expect(peek[0].event.kind).toBe("target.cell.commit")
      expect(
        (peek[0].event as unknown as OutboxRawEvent<"target.cell.commit">).parentId,
      ).toBe(null)
    })
  })

  describe("emitCellValidate / emitCellUnvalidate", () => {
    it("validate events use null parentId — they're additive, not chain mutating", async () => {
      await emitCellValidate({
        projectId: "p",
        fileId: "f",
        cellId: "c",
        editEventId: "commit-evt-1",
        author: "alice",
      })
      const peek = await peekOutboxBatch(10)
      const ev = peek[0].event as unknown as OutboxRawEvent<"cell.validate">
      expect(ev.kind).toBe("cell.validate")
      expect(ev.parentId).toBe(null)
      expect(ev.payload.editEventId).toBe("commit-evt-1")
    })

    it("emitCellUnvalidate sets the right kind", async () => {
      await emitCellUnvalidate({
        projectId: "p",
        fileId: "f",
        cellId: "c",
        editEventId: "commit-evt-1",
        author: "alice",
      })
      const peek = await peekOutboxBatch(10)
      expect(peek[0].event.kind).toBe("cell.unvalidate")
    })
  })

  describe("importer helpers", () => {
    it("emitSourceCellCreate produces a genesis event with anchorCellId chain", async () => {
      // Two cells: first anchored to null, second anchored to first.
      const id1 = await emitSourceCellCreate({
        projectId: "p",
        fileId: "f",
        cellId: "cell-1",
        anchorCellId: null,
        value: "verse 1",
        author: "import-bot",
      })
      const id2 = await emitSourceCellCreate({
        projectId: "p",
        fileId: "f",
        cellId: "cell-2",
        anchorCellId: "cell-1",
        value: "verse 2",
        author: "import-bot",
      })
      expect(typeof id1).toBe("string")
      expect(typeof id2).toBe("string")
      expect(await outboxPendingCount()).toBe(2)
      const peek = await peekOutboxBatch(10)
      const first = peek[0].event as unknown as OutboxRawEvent<"source.cell.create">
      const second = peek[1].event as unknown as OutboxRawEvent<"source.cell.create">
      expect(first.kind).toBe("source.cell.create")
      expect(first.parentId).toBe(null)
      expect(first.payload.anchorCellId).toBe(null)
      expect(second.payload.anchorCellId).toBe("cell-1")
    })

    it("emitSourceCellCommit advances the source chain head chained on parentId", async () => {
      // The DCS delta path: a content-changed upstream cell commits on the
      // source lane, chained on its current head, carrying a deterministic id
      // for idempotent re-runs.
      const id = await emitSourceCellCommit({
        projectId: "p",
        fileId: "f",
        cellId: "TIT-1-1",
        parentId: "source-head-1",
        value: "verse 1 (v89)",
        valueHtml: "<p>verse 1 (v89)</p>",
        id: "det-event-1",
        author: "import-bot",
      })
      expect(id).toBe("det-event-1")
      expect(await outboxPendingCount()).toBe(1)
      const peek = await peekOutboxBatch(10)
      const ev = peek[0].event as unknown as OutboxRawEvent<"source.cell.commit">
      expect(ev.kind).toBe("source.cell.commit")
      expect(ev.id).toBe("det-event-1")
      expect(ev.parentId).toBe("source-head-1")
      expect(ev.cellId).toBe("TIT-1-1")
      expect(ev.fileId).toBe("f")
      expect(ev.payload.value).toBe("verse 1 (v89)")
      expect(ev.payload.valueHtml).toBe("<p>verse 1 (v89)</p>")
    })

    it("emitSourceCellCommit omits valueHtml when not supplied and defaults its id", async () => {
      const id = await emitSourceCellCommit({
        projectId: "p",
        fileId: "f",
        cellId: "TIT-1-2",
        parentId: "source-head-2",
        value: "verse 2 (v89)",
        author: "import-bot",
      })
      expect(typeof id).toBe("string")
      expect(id.length).toBeGreaterThan(0)
      const peek = await peekOutboxBatch(10)
      const ev = peek[0].event as unknown as OutboxRawEvent<"source.cell.commit">
      expect(ev.payload.value).toBe("verse 2 (v89)")
      expect("valueHtml" in ev.payload).toBe(false)
    })

    it("emitFileCreate is project-scoped and genesis", async () => {
      await emitFileCreate({
        projectId: "p",
        fileId: "f",
        name: "Genesis",
        fileType: "usfm",
        sourceLanguage: "en",
        targetLanguage: "es",
        author: "import-bot",
      })
      const peek = await peekOutboxBatch(10)
      const ev = peek[0].event as unknown as OutboxRawEvent<"file.create">
      expect(ev.kind).toBe("file.create")
      expect(ev.parentId).toBe(null)
      expect(ev.fileId).toBe("f")
      expect(ev.payload.name).toBe("Genesis")
      expect(ev.payload.sourceLanguage).toBe("en")
    })
  })
})
