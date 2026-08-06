import { describe, it, expect, beforeEach } from "vitest"
import "fake-indexeddb/auto"
import {
  buildRawEvent,
  emitTargetCellCommit,
  emitSourceCellCommit,
  emitCellValidate,
  emitCellUnvalidate,
  emitSourceCellCreate,
  emitSourceCellDelete,
  emitTargetCellDelete,
  emitFileCreate,
  enqueueEvent,
  enqueueEvents,
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
      // AQU-538: no targetLang input → the field is OMITTED entirely, so
      // default-lane events stay byte-identical to pre-lane events.
      expect("targetLang" in ev.payload).toBe(false)
    })

    it("AQU-538: includes targetLang in the payload for a non-default lane", async () => {
      await emitTargetCellCommit({
        projectId: "p",
        fileId: "f",
        cellId: "c",
        parentId: "src-head",
        value: "bonjour",
        targetLang: "fr",
        author: "alice",
      })
      const peek = await peekOutboxBatch(10)
      const ev = peek[0].event as unknown as OutboxRawEvent<"target.cell.commit">
      expect(ev.payload.targetLang).toBe("fr")
    })

    it("AQU-538: an explicit empty-string targetLang is omitted (default lane)", async () => {
      await emitTargetCellCommit({
        projectId: "p",
        fileId: "f",
        cellId: "c",
        parentId: "src-head",
        value: "hallo",
        targetLang: "",
        author: "alice",
      })
      const peek = await peekOutboxBatch(10)
      const ev = peek[0].event as unknown as OutboxRawEvent<"target.cell.commit">
      expect("targetLang" in ev.payload).toBe(false)
    })

    it("AQU-538: carries targetLang for a non-default lane", async () => {
      await emitTargetCellCommit({
        projectId: "p",
        fileId: "f",
        cellId: "c",
        parentId: "prev",
        value: "hola",
        author: "alice",
        targetLang: "es",
      })
      const peek = await peekOutboxBatch(10)
      const ev = peek[0].event as unknown as OutboxRawEvent<"target.cell.commit">
      expect(ev.payload.targetLang).toBe("es")
    })

    it("AQU-538: OMITS targetLang for the default lane ('' never crosses the wire)", async () => {
      await emitTargetCellCommit({
        projectId: "p",
        fileId: "f",
        cellId: "c",
        parentId: "prev",
        value: "hello",
        author: "alice",
        targetLang: "",
      })
      const peek = await peekOutboxBatch(10)
      const ev = peek[0].event as unknown as OutboxRawEvent<"target.cell.commit">
      expect("targetLang" in ev.payload).toBe(false)
    })

    // AQU-803: the delete-a-cell editor affordance pairs one source.cell.delete
    // with one target.cell.delete per lane. These pin the emitters' wire shape.
    it("AQU-803: emitSourceCellDelete emits a source.cell.delete with an empty payload and null parent", async () => {
      const id = await emitSourceCellDelete({ projectId: "p", fileId: "f", cellId: "c", author: "lead" })
      expect(typeof id).toBe("string")
      const peek = await peekOutboxBatch(10)
      const ev = peek[0].event as unknown as OutboxRawEvent<"source.cell.delete">
      expect(ev.kind).toBe("source.cell.delete")
      expect(ev.parentId).toBe(null)
      expect(ev.cellId).toBe("c")
      expect(ev.fileId).toBe("f")
      expect(Object.keys(ev.payload)).toHaveLength(0)
    })

    it("AQU-803: emitTargetCellDelete carries targetLang for a non-default lane", async () => {
      await emitTargetCellDelete({ projectId: "p", fileId: "f", cellId: "c", targetLang: "fr", author: "lead" })
      const peek = await peekOutboxBatch(10)
      const ev = peek[0].event as unknown as OutboxRawEvent<"target.cell.delete">
      expect(ev.kind).toBe("target.cell.delete")
      expect(ev.parentId).toBe(null)
      expect(ev.payload.targetLang).toBe("fr")
    })

    it("AQU-803/538: emitTargetCellDelete OMITS targetLang for the default lane ('' never crosses the wire)", async () => {
      await emitTargetCellDelete({ projectId: "p", fileId: "f", cellId: "c", targetLang: "", author: "lead" })
      const peek = await peekOutboxBatch(10)
      const ev = peek[0].event as unknown as OutboxRawEvent<"target.cell.delete">
      expect(ev.kind).toBe("target.cell.delete")
      expect("targetLang" in ev.payload).toBe(false)
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

    it("persists model, prompt, retrieval, and project-state provenance for AI drafts", async () => {
      const aiDraft = {
        model: "test/model",
        provider: "frontier",
        promptVersion: "translation-draft-v1",
        exampleIds: ["approved-1"],
        generatedAt: 1234,
        mode: "single" as const,
        projectState: {
          sourceLanguage: "English",
          targetLanguage: "Spanish",
          approvedExampleCount: 1,
        },
      }
      await emitTargetCellCommit({
        projectId: "p",
        fileId: "f",
        cellId: "c-ai",
        parentId: "head",
        value: "borrador",
        author: "test/model",
        aiSuggestion: true,
        aiDraft,
      })
      const [record] = await peekOutboxBatch(10)
      const event = record.event as unknown as OutboxRawEvent<"target.cell.commit">
      expect(event.payload.ai_suggestion).toBe(true)
      expect(event.payload.ai_draft).toEqual(aiDraft)
    })
  })

  describe("emitSourceCellCommit", () => {
    it("enqueues a chain-mutating source.cell.commit with no sourceEventId pin", async () => {
      const id = await emitSourceCellCommit({
        projectId: "p",
        fileId: "f",
        cellId: "c",
        parentId: "src-head-1",
        value: "fixed English line",
        valueHtml: "<p>fixed English line</p>",
        author: "lead",
      })
      expect(typeof id).toBe("string")
      expect(await outboxPendingCount()).toBe(1)
      const peek = await peekOutboxBatch(10)
      const ev = peek[0].event as unknown as OutboxRawEvent<"source.cell.commit">
      expect(ev.kind).toBe("source.cell.commit")
      // Chains off the source row's current head (advances cells.event_id).
      expect(ev.parentId).toBe("src-head-1")
      expect(ev.cellId).toBe("c")
      expect(ev.fileId).toBe("f")
      expect(ev.payload.value).toBe("fixed English line")
      expect(ev.payload.valueHtml).toBe("<p>fixed English line</p>")
      // Source rows carry no AD-9 staleness pin.
      expect((ev.payload as Record<string, unknown>).sourceEventId).toBeUndefined()
    })

    it("refuses to enqueue below the PROJECT_LEAD (500) floor — never reaches the outbox", async () => {
      setCqrsOutboxBridge({ projectId: "p", activeFileId: "f", username: "u", roleLevel: ROLE.CONTRIBUTOR })
      try {
        await expect(
          emitSourceCellCommit({
            projectId: "p",
            fileId: "f",
            cellId: "c",
            parentId: null,
            value: "nope",
            author: "u",
          }),
        ).rejects.toBeInstanceOf(InsufficientRoleError)
        expect(await outboxPendingCount()).toBe(0)
      } finally {
        setCqrsOutboxBridge(null)
      }
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

    it("AQU-538: emitCellValidate carries targetLang for a non-default lane", async () => {
      await emitCellValidate({
        projectId: "p",
        fileId: "f",
        cellId: "c",
        editEventId: "commit-evt-1",
        author: "alice",
        targetLang: "es",
      })
      const peek = await peekOutboxBatch(10)
      const ev = peek[0].event as unknown as OutboxRawEvent<"cell.validate">
      expect(ev.payload.editEventId).toBe("commit-evt-1")
      expect(ev.payload.targetLang).toBe("es")
    })

    it("AQU-538: emitCellValidate OMITS targetLang for the default lane", async () => {
      await emitCellValidate({
        projectId: "p",
        fileId: "f",
        cellId: "c",
        editEventId: "commit-evt-1",
        author: "alice",
        targetLang: "",
      })
      const peek = await peekOutboxBatch(10)
      const ev = peek[0].event as unknown as OutboxRawEvent<"cell.validate">
      expect("targetLang" in ev.payload).toBe(false)
    })

    it("AQU-538: emitCellUnvalidate carries targetLang for a non-default lane", async () => {
      await emitCellUnvalidate({
        projectId: "p",
        fileId: "f",
        cellId: "c",
        editEventId: "commit-evt-1",
        author: "alice",
        targetLang: "es",
      })
      const peek = await peekOutboxBatch(10)
      const ev = peek[0].event as unknown as OutboxRawEvent<"cell.unvalidate">
      expect(ev.payload.targetLang).toBe("es")
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

  describe("enqueueEvents (bulk builder)", () => {
    it("enqueueEvents builds typed events and bulk-enqueues them", async () => {
      const res = await enqueueEvents([
        { kind: "target.cell.commit", projectId: "p", fileId: "f", cellId: "c1",
          parentId: "s1", author: "u", payload: { value: "hello" } },
        { kind: "target.cell.commit", projectId: "p", fileId: "f", cellId: "c2",
          parentId: "s2", author: "u", payload: { value: "world" } },
      ])
      expect(res).toHaveLength(2)
      expect(res[0].eventId).toBeTruthy()
      const rows = await peekOutboxBatch(100)
      expect(rows.map((r) => r.event.cellId).sort()).toEqual(["c1", "c2"])
    })

    it("returns empty array for empty input without writing to outbox", async () => {
      const res = await enqueueEvents([])
      expect(res).toEqual([])
      expect(await outboxPendingCount()).toBe(0)
    })
  })
})
