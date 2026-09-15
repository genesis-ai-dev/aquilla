import { beforeEach, describe, expect, it, vi } from "vitest"
import type { JSONContent } from "@tiptap/core"
import {
  composerDraftKey, composerDraftStore, createComposerDraftStore, resetComposerDraftsForTesting,
  type ComposerDraftScope,
} from "./composer-drafts"
import { serializeDocJSON, serializeWithChips } from "./context-chip"

const scope: ComposerDraftScope = { owner: "alice", projectId: "project", conversationId: "run:1" }
const document: JSONContent = {
  type: "doc", content: [{
    type: "paragraph", content: [
      { type: "text", text: "Check <this> ", marks: [{ type: "bold" }] },
      {
        type: "contextChip", attrs: {
          chipId: "chip", fileId: "file", cellId: "cell", side: "source",
          canonicalRef: "GEN 1:1", selection: "<exact>\nsource & words",
          preview: "<exact> source & words", fileName: "Genesis.usfm",
        },
      },
    ],
  }],
}

beforeEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
  resetComposerDraftsForTesting()
})

describe("scoped composer drafts", () => {
  it("reloads exact TipTap JSON/chip attrs and uploaded artifact references", () => {
    const first = createComposerDraftStore(scope)
    first.setDocument(document)
    first.addAttachment({ artifactId: "artifact", fileName: "notes.txt" })
    const reloaded = createComposerDraftStore(scope).getSnapshot()
    expect(reloaded.document).toEqual(document)
    expect(reloaded.attachments).toEqual([{ artifactId: "artifact", fileName: "notes.txt" }])
    const { text, chips } = serializeDocJSON(reloaded.document)
    expect(serializeWithChips(text, chips).wire).toContain('"<exact>\nsource & words"')
  })

  it("isolates owner, project and conversation, including local/named-local and delimiters", () => {
    composerDraftStore(scope).setDocument(document)
    for (const other of [
      { ...scope, owner: "bob" }, { ...scope, owner: null },
      { ...scope, projectId: "other" }, { ...scope, conversationId: "team-chat" },
    ]) {
      expect(composerDraftStore(other).getSnapshot().document).not.toEqual(document)
    }
    expect(composerDraftKey({ ...scope, owner: null })).not.toBe(composerDraftKey({ ...scope, owner: "local" }))
    expect(composerDraftKey({ ...scope, owner: "a:b", projectId: "c" }))
      .not.toBe(composerDraftKey({ ...scope, owner: "a", projectId: "b:c" }))
  })

  it("rejects a saved record belonging to another owner rather than exposing its artifacts", () => {
    createComposerDraftStore(scope).addAttachment({ artifactId: "private", fileName: "private.txt" })
    const bob = { ...scope, owner: "bob" }
    localStorage.setItem(composerDraftKey(bob), localStorage.getItem(composerDraftKey(scope))!)
    const loaded = createComposerDraftStore(bob).getSnapshot()
    expect(loaded.attachments).toEqual([])
    expect(loaded.persistenceError).toContain("Could not restore")
  })

  it.each(["{", '{"version":900}', JSON.stringify({
    version: 1, scope, document: { type: "doc", content: [{ type: "unsupported" }] },
    documentRevision: 0, attachments: [],
  })])("reports corrupt or unsupported storage explicitly (%s)", (raw) => {
    localStorage.setItem(composerDraftKey(scope), raw)
    expect(createComposerDraftStore(scope).getSnapshot().persistenceError).toContain("Could not restore")
  })

  it("retains in-tab edits on blocked/quota-limited storage and clears the error after recovery", () => {
    const blockedRead = vi.spyOn(window.localStorage, "getItem").mockImplementation(() => { throw new Error("blocked") })
    const store = composerDraftStore(scope)
    expect(store.getSnapshot().persistenceError).toContain("Could not restore")
    blockedRead.mockRestore()
    const blockedWrite = vi.spyOn(window.localStorage, "setItem").mockImplementation(() => { throw new Error("quota") })
    store.setDocument(document)
    expect(composerDraftStore(scope).getSnapshot().document).toEqual(document)
    expect(store.getSnapshot().persistenceError).toContain("Could not save")
    blockedWrite.mockRestore()
    store.setDocument(document)
    expect(store.getSnapshot().persistenceError).toBeNull()
    expect(createComposerDraftStore(scope).getSnapshot().document).toEqual(document)
  })

  it("consumes only the submitted revision and attachment batch", () => {
    const store = composerDraftStore(scope)
    store.setDocument(document)
    const revision = store.getSnapshot().documentRevision
    store.addAttachment({ artifactId: "sent", fileName: "sent.txt" })
    store.addAttachment({ artifactId: "later", fileName: "later.txt" })
    store.setDocument({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "new draft" }] }] })
    store.consumeDocument(revision)
    store.removeAttachments(["sent"])
    expect(serializeDocJSON(store.getSnapshot().document).text).toBe("new draft")
    expect(store.getSnapshot().attachments).toEqual([{ artifactId: "later", fileName: "later.txt" }])
    store.consumeDocument(store.getSnapshot().documentRevision)
    expect(serializeDocJSON(createComposerDraftStore(scope).getSnapshot().document).text).toBe("")
    expect(store.getSnapshot().attachments).toHaveLength(1)
  })

  it("shares in-tab handoff state across remounts without persisting a phantom pending send on reload", () => {
    const store = composerDraftStore(scope)
    store.setSending(true)
    store.setSendError("A previous attempt failed")
    store.setDocument(document)
    expect(composerDraftStore(scope).getSnapshot()).toMatchObject({ isSending: true, sendError: "A previous attempt failed" })
    expect(createComposerDraftStore(scope).getSnapshot()).toMatchObject({ isSending: false, sendError: null, document })
  })
})
