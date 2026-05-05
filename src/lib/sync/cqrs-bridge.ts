/**
 * Workspace-scoped bridge so low-level Yjs helpers can enqueue CQRS events
 * without threading project/file IDs through every call site.
 */

import * as Y from "yjs"
import { v7 as uuidv7 } from "uuid"
import { getPlainText, getFragmentHtml } from "@/lib/richtext/translated-xml"
import { enqueueOutboxEvent } from "./outbox"
import type { CqrsRawEvent } from "./cqrs-types"
import { CQRS_SCHEMA_VERSION } from "./cqrs-types"
import {
  makeSyncTokenFetcher,
  type ProjectBootstrap,
  type SyncTokenCallbacks,
} from "./sync-token"

export interface CqrsOutboxBridge {
  projectId: string
  /** Active editor file — event payloads are scoped to this file. */
  activeFileId: string | null
  username: string
}

let bridge: CqrsOutboxBridge | null = null

/** Latest client-generated cell.commit id per cell (session) for validate/unvalidate payloads. */
const lastCommitEventIdByCell = new Map<string, string>()

export function setCqrsOutboxBridge(next: CqrsOutboxBridge | null): void {
  bridge = next
  if (!next) lastCommitEventIdByCell.clear()
}

export function buildFileScopedTokenFetcher(
  getJwt: () => string | null,
  projectId: string,
  bootstrap: ProjectBootstrap = {},
  apiUrl?: string,
  callbacks: SyncTokenCallbacks = {},
): (fileId: string) => Promise<string | null> {
  const cache = new Map<string, () => Promise<string | null>>()
  return (fileId: string) => {
    let fetcher = cache.get(fileId)
    if (!fetcher) {
      fetcher = makeSyncTokenFetcher(
        getJwt,
        projectId,
        fileId,
        bootstrap,
        apiUrl,
        callbacks,
      )
      cache.set(fileId, fetcher)
    }
    return fetcher()
  }
}

function readCellSnapshot(
  doc: Y.Doc,
  cellId: string,
): { plain: string; html: string } | null {
  const cellsMap = doc.getMap("cells")
  const cell = cellsMap.get(cellId) as Y.Map<unknown> | undefined
  if (!cell) return null
  const frag = cell.get("translatedXml") as Y.XmlFragment | undefined
  if (frag) {
    return { plain: getPlainText(frag), html: getFragmentHtml(frag) }
  }
  const t = (cell.get("translated") as string) || ""
  return { plain: t, html: "" }
}

/**
 * After a value edit lands in the Y.Doc, mirror it to the CQRS outbox.
 *
 * `fileIdOverride` lets cross-file callers (batch replace, parallel passages)
 * stamp the event with the correct fileId instead of the bridge's active
 * editor file. Without it, events on non-active files would be misfiled
 * in D1 — the audit trail would point at the wrong file.
 */
export function enqueueCellCommitAfterValueEdit(
  doc: Y.Doc,
  cellId: string,
  clientTs: number = Date.now(),
  fileIdOverride?: string,
): string | null {
  const b = bridge
  if (!b) return null
  const fileId = fileIdOverride ?? b.activeFileId
  if (!fileId) return null
  const snap = readCellSnapshot(doc, cellId)
  if (!snap) return null
  const id = uuidv7()
  const prev = lastCommitEventIdByCell.get(cellId)
  const event: CqrsRawEvent<"cell.commit"> = {
    id,
    schemaVersion: CQRS_SCHEMA_VERSION,
    kind: "cell.commit",
    projectId: b.projectId,
    fileId,
    cellId,
    author: b.username,
    payload: {
      value: snap.plain,
      valueHtml: snap.html,
      ...(prev ? { prevEventId: prev } : {}),
    },
    clientTs,
  }
  lastCommitEventIdByCell.set(cellId, id)
  void enqueueOutboxEvent(event)
  return id
}

/**
 * `fileIdOverride` — see enqueueCellCommitAfterValueEdit. Same rationale:
 * cross-file batch operations need to stamp the correct fileId.
 */
export function enqueueCellValidateToggle(
  cellId: string,
  validate: boolean,
  clientTs: number = Date.now(),
  fileIdOverride?: string,
  editEventIdOverride?: string,
): void {
  const b = bridge
  if (!b) return
  const fileId = fileIdOverride ?? b.activeFileId
  if (!fileId) return
  const editEventId =
    editEventIdOverride ?? lastCommitEventIdByCell.get(cellId) ?? `legacy:${fileId}:${cellId}`

  const id = uuidv7()
  const event: CqrsRawEvent =
    validate
      ? {
          id,
          schemaVersion: CQRS_SCHEMA_VERSION,
          kind: "cell.validate",
          projectId: b.projectId,
          fileId,
          cellId,
          author: b.username,
          payload: { editEventId },
          clientTs,
        }
      : {
          id,
          schemaVersion: CQRS_SCHEMA_VERSION,
          kind: "cell.unvalidate",
          projectId: b.projectId,
          fileId,
          cellId,
          author: b.username,
          payload: { editEventId },
          clientTs,
        }

  void enqueueOutboxEvent(event)
}
