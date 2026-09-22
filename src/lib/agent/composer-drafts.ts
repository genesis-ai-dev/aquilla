import { useSyncExternalStore } from "react"
import type { JSONContent } from "@tiptap/core"

/** A destination is not enough: two accounts can open the same project/run. */
export interface ComposerDraftScope {
  owner: string | null
  projectId: string
  conversationId: string
}

export interface ComposerDraftAttachment {
  artifactId: string
  fileName: string
}

export interface ComposerDraftSnapshot {
  document: JSONContent
  documentRevision: number
  attachments: ComposerDraftAttachment[]
  persistenceError: string | null
  /** In-tab handoff state follows the draft across navigation, not reload. */
  isSending: boolean
  sendError: string | null
  attachmentError: string | null
}

const emptyDocument = (): JSONContent => ({ type: "doc", content: [{ type: "paragraph" }] })

export function composerDraftKey(scope: ComposerDraftScope): string {
  return `aquilla:agent-composer:v1:${JSON.stringify([scope.owner, scope.projectId, scope.conversationId])}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function validInline(value: unknown): boolean {
  if (!isRecord(value)) return false
  if (value.marks !== undefined && (!Array.isArray(value.marks) || !value.marks.every(
    (mark: unknown) => isRecord(mark) && typeof mark.type === "string"
      && ["bold", "italic", "strike", "code", "link", "underline"].includes(mark.type),
  ))) return false
  if (value.type === "text") return typeof value.text === "string" && value.text.length > 0
  if (value.type === "hardBreak") return true
  if (value.type !== "contextChip" || !isRecord(value.attrs)) return false
  const attrs = value.attrs
  return attrs.side === "source"
    && ["chipId", "fileId", "cellId", "selection", "preview"].every((key) => typeof attrs[key] === "string")
    && ["canonicalRef", "fileName"].every((key) => attrs[key] === undefined || typeof attrs[key] === "string")
}

function validDocument(value: unknown): value is JSONContent {
  return isRecord(value) && value.type === "doc" && Array.isArray(value.content)
    && value.content.length > 0 && value.content.every((block: unknown) =>
      isRecord(block) && block.type === "paragraph"
      && (block.content === undefined || (Array.isArray(block.content) && block.content.every(validInline))),
    )
}

function validAttachments(value: unknown): value is ComposerDraftAttachment[] {
  return Array.isArray(value) && value.every((attachment: unknown) =>
    isRecord(attachment) && typeof attachment.artifactId === "string"
    && typeof attachment.fileName === "string",
  )
}

/**
 * JSON (never HTML) preserves chip attrs and marks. Failed persistence keeps a
 * live in-tab copy and an observable error; no credentials or file bytes are
 * saved. Uploaded artifact references remain bound to their account/project.
 */
export function createComposerDraftStore(scope?: ComposerDraftScope) {
  const key = scope ? composerDraftKey(scope) : null
  let snapshot: ComposerDraftSnapshot = {
    document: emptyDocument(), documentRevision: 0, attachments: [], persistenceError: null,
    isSending: false, sendError: null, attachmentError: null,
  }
  const listeners = new Set<() => void>()

  if (key) {
    try {
      const raw = window.localStorage.getItem(key)
      if (raw) {
        const saved: unknown = JSON.parse(raw)
        if (!isRecord(saved) || saved.version !== 1 || !isRecord(saved.scope)
          || saved.scope.owner !== scope?.owner || saved.scope.projectId !== scope?.projectId
          || saved.scope.conversationId !== scope?.conversationId
          || !validDocument(saved.document) || !validAttachments(saved.attachments)
          || typeof saved.documentRevision !== "number" || !Number.isSafeInteger(saved.documentRevision)
          || saved.documentRevision < 0) {
          throw new Error("Invalid composer draft")
        }
        snapshot = {
          ...snapshot,
          document: saved.document,
          documentRevision: saved.documentRevision,
          attachments: saved.attachments.map(({ artifactId, fileName }) => ({ artifactId, fileName })),
          persistenceError: null,
        }
      }
    } catch {
      snapshot = {
        ...snapshot,
        persistenceError: "Could not restore this draft. New changes will be kept in this tab; keep it open until saving works.",
      }
    }
  }

  function update(next: ComposerDraftSnapshot) {
    snapshot = next
    if (key) {
      try {
        window.localStorage.setItem(key, JSON.stringify({
          version: 1, scope, document: next.document,
          documentRevision: next.documentRevision, attachments: next.attachments,
        }))
        snapshot = { ...next, persistenceError: null }
      } catch {
        snapshot = {
          ...next,
          persistenceError: "Could not save this draft on this device. It is kept in this tab; keep the tab open to avoid losing it.",
        }
      }
    }
    listeners.forEach((listener) => listener())
  }

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    setDocument(document: JSONContent) {
      update({ ...snapshot, document, documentRevision: snapshot.documentRevision + 1 })
    },
    /** A successful old send must not erase typing done while it was pending. */
    consumeDocument(revision: number) {
      if (snapshot.documentRevision !== revision) return
      update({ ...snapshot, document: emptyDocument(), documentRevision: revision + 1 })
    },
    addAttachment(attachment: ComposerDraftAttachment) {
      update({
        ...snapshot,
        attachments: [
          ...snapshot.attachments.filter((item) => item.artifactId !== attachment.artifactId),
          { artifactId: attachment.artifactId, fileName: attachment.fileName },
        ],
      })
    },
    /** Only remove the submitted batch, not uploads that finished after send. */
    removeAttachments(artifactIds: readonly string[]) {
      update({ ...snapshot, attachments: snapshot.attachments.filter((item) => !artifactIds.includes(item.artifactId)) })
    },
    setSending(isSending: boolean) {
      snapshot = { ...snapshot, isSending }
      listeners.forEach((listener) => listener())
    },
    setSendError(sendError: string | null) {
      snapshot = { ...snapshot, sendError }
      listeners.forEach((listener) => listener())
    },
    setAttachmentError(attachmentError: string | null) {
      snapshot = { ...snapshot, attachmentError }
      listeners.forEach((listener) => listener())
    },
  }
}

export type ComposerDraftStore = ReturnType<typeof createComposerDraftStore>
const stores = new Map<string, ComposerDraftStore>()

export function composerDraftStore(scope: ComposerDraftScope): ComposerDraftStore {
  const key = composerDraftKey(scope)
  let store = stores.get(key)
  if (!store) {
    store = createComposerDraftStore(scope)
    stores.set(key, store)
  }
  return store
}

export function useComposerDraft(store: ComposerDraftStore): ComposerDraftSnapshot {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
}

export function resetComposerDraftsForTesting(): void {
  stores.clear()
}
