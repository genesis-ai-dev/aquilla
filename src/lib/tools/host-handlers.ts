/**
 * Bridge method handlers: param validation over a ToolHostData source. The
 * live source (live-data.ts) reads/writes the real project; the smoke render
 * (smoke.ts) passes a stub. Keep in step with the builder's system prompt
 * (auth-worker/src/lib/tools/build-prompt.ts).
 */

import { BridgeError, type BridgeHandler } from "./host-bridge"
import { isToolScope, type ToolScope } from "../../../shared/tools/manifest"
import type { ToolCellViewRev3 } from "../../../shared/tools/editor-api"
import { createEditorHandlers, type ToolEditorHostData } from "./host-handlers-editor"
import { createRev4Handlers, type ToolRev4HostData } from "./host-handlers-rev4"
import { MAX_UI_STRING_KEYS, type UiStrings } from "./ui-strings"

export interface ToolFileView {
  fileId: string
  name: string
  cellCount: number
}

export interface ToolCellView extends ToolCellViewRev3 {
  cellId: string
  ref: string | null
  source: string
  target: string
  validated: boolean
  chapter: string | null
  /** apiRev 2 (additive). Rich-text variants, sanitized by the host to the
   *  editor's inline allowlist (b/i/u/s/em/strong/code/p/br/span + footnote
   *  markers). Null for plain-text cells. */
  sourceHtml?: string | null
  targetHtml?: string | null
  /** Cell type from the importer ("heading", "paratext", … or null). */
  type?: string | null
  lastEditor?: string | null
  lastEditAt?: number | null
  /** The current target is an untouched machine draft. */
  aiDrafted?: boolean
}

export interface ToolCellPage {
  cells: ToolCellView[]
  /** Opaque cursor for the next page; null on the last page. */
  nextCursor: string | null
  /** Total cells in the file (when the server knows it), else null. */
  total: number | null
}

/** Who holds each cell's focus lock right now (other people only). */
export type ToolPresence = Record<string, { username: string }>

export interface ToolAudioEntry {
  hasAudio: boolean
  durationMs: number | null
}

export interface ToolTermView {
  id: string
  term: string
  renderings: { rendering: string; status: string }[]
  notes: string | null
}

export interface ToolEdit {
  fileId: string
  cellId: string
  value: string
  /** apiRev 2: rich-text value. The host sanitizes it before it is written. */
  html?: string
}

export interface ToolWriteResult {
  committed: string[]
  failed: { cellId: string; reason: string }[]
}

export interface ToolValidateResult {
  validated: string[]
  failed: { cellId: string; reason: string }[]
}

export interface ToolHostData extends ToolEditorHostData, ToolRev4HostData {
  listFiles: () => Promise<ToolFileView[]>
  listCells: (fileId: string, lane: string) => Promise<ToolCellView[]>
  listTerms: () => Promise<ToolTermView[]>
  commit: (edits: ToolEdit[]) => Promise<ToolWriteResult>
  validate: (items: { fileId: string; cellId: string }[]) => Promise<ToolValidateResult>
  storageGet: (key: string) => Promise<unknown>
  storageSet: (key: string, value: unknown) => Promise<void>
  storageRemove: (key: string) => Promise<void>
  notify: (message: string) => void
  /** One completion through the app's own AI proxy, as the user. */
  generate: (input: { prompt: string; system: string; maxTokens: number }) => Promise<{ text: string }>
  /** A message for the user that stays until dismissed (unlike notify). */
  tell: (message: string) => void
  grantedScopes: () => ToolScope[]
  /** Explicit permission request (aquilla.permissions.request). */
  requestScope: (scope: ToolScope) => Promise<boolean>

  // ── apiRev 2 ────────────────────────────────────────────────────────────
  /** One server page of a file (paged reads for long books). */
  pageCells: (fileId: string, lane: string, cursor: string | null, limit: number) => Promise<ToolCellPage>
  /** A fresh read of specific cells (targeted refresh after cells.changed). */
  getCells: (fileId: string, cellIds: string[], lane: string) => Promise<ToolCellView[]>
  unvalidate: (items: { fileId: string; cellId: string }[]) => Promise<ToolValidateResult>
  listPresence: (fileId: string) => Promise<ToolPresence>
  claimCell: (fileId: string, cellId: string) => Promise<boolean>
  releaseCell: (fileId: string, cellId: string) => Promise<boolean>
  commentCounts: (fileId: string) => Promise<Record<string, number>>
  openComments: (fileId: string, cellId: string) => Promise<boolean>
  listAudio: (fileId: string) => Promise<Record<string, ToolAudioEntry>>
  playAudio: (fileId: string, cellId: string) => Promise<boolean>
  stopAudio: () => Promise<boolean>
  /** A host shortcut pressed inside the frame (allowlisted by the host). */
  hostKey: (key: HostKey) => Promise<boolean>
  /** apiRev 3: the app's UI strings in the user's language (ui-strings.ts). */
  uiStrings: (keys: string[]) => Promise<UiStrings>
}

export interface HostKey {
  key: string
  mod: boolean
  shift: boolean
  alt: boolean
}

export const MAX_PAGE_LIMIT = 2000
export const MAX_GET_CELLS = 500

export const MAX_EDITS_PER_CALL = 2000
export const MAX_VALUE_CHARS = 20_000
export const MAX_STORAGE_VALUE_CHARS = 64_000

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function bad(message: string): never {
  throw new BridgeError("invalid_params", message)
}

function str(v: unknown, name: string, max = 200): string {
  if (typeof v !== "string" || v.length === 0 || v.length > max) bad(`${name} must be a non-empty string`)
  return v
}

function key(params: unknown): string {
  if (!isRecord(params)) bad("params must be an object")
  return str(params.key, "key", 200)
}

function cellRefs(list: unknown, name: string): { fileId: string; cellId: string }[] {
  if (!Array.isArray(list)) bad(`${name} must be an array`)
  if (list.length > MAX_EDITS_PER_CALL) bad(`at most ${MAX_EDITS_PER_CALL} ${name} per call`)
  return list.map((item, i) => {
    if (!isRecord(item)) bad(`${name}[${i}] must be an object`)
    return { fileId: str(item.fileId, `${name}[${i}].fileId`), cellId: str(item.cellId, `${name}[${i}].cellId`) }
  })
}

export function parseEdits(params: unknown): ToolEdit[] {
  if (!isRecord(params)) bad("params must be an object")
  const refs = cellRefs(params.edits, "edits")
  const raw = params.edits as unknown[]
  return refs.map((ref, i) => {
    const value = (raw[i] as Record<string, unknown>).value
    if (typeof value !== "string") bad(`edits[${i}].value must be a string`)
    if (value.length > MAX_VALUE_CHARS) bad(`edits[${i}].value exceeds ${MAX_VALUE_CHARS} characters`)
    const html = (raw[i] as Record<string, unknown>).html
    if (html !== undefined && html !== null && typeof html !== "string") bad(`edits[${i}].html must be a string`)
    if (typeof html === "string" && html.length > MAX_VALUE_CHARS * 2) bad(`edits[${i}].html exceeds ${MAX_VALUE_CHARS * 2} characters`)
    return typeof html === "string" ? { ...ref, value, html } : { ...ref, value }
  })
}

function fileOnly(params: unknown): string {
  if (!isRecord(params)) bad("params must be an object")
  return str(params.fileId, "fileId")
}

function cellRef(params: unknown): { fileId: string; cellId: string } {
  if (!isRecord(params)) bad("params must be an object")
  return { fileId: str(params.fileId, "fileId"), cellId: str(params.cellId, "cellId") }
}

function laneOf(params: Record<string, unknown>): string {
  return typeof params.lane === "string" ? params.lane.slice(0, 100) : ""
}

/** Parse a host-key request. Only the key identity crosses; never text. */
export function parseHostKey(params: unknown): HostKey {
  if (!isRecord(params)) bad("params must be an object")
  const key = str(params.key, "key", 20)
  return { key, mod: params.mod === true, shift: params.shift === true, alt: params.alt === true }
}

export function createToolHandlers(data: ToolHostData): Record<string, BridgeHandler> {
  return {
    ...createEditorHandlers(data),
    ...createRev4Handlers(data),
    "files.list": async () => data.listFiles(),
    "cells.list": async (params) => {
      if (!isRecord(params)) bad("params must be an object")
      const lane = typeof params.lane === "string" ? params.lane : ""
      return data.listCells(str(params.fileId, "fileId"), lane)
    },
    "terms.list": async () => data.listTerms(),
    "cells.commit": async (params) => data.commit(parseEdits(params)),
    "cells.validate": async (params) => {
      if (!isRecord(params)) bad("params must be an object")
      return data.validate(cellRefs(params.items, "items"))
    },
    "storage.get": async (params) => data.storageGet(key(params)),
    "storage.set": async (params) => {
      const k = key(params)
      const value = (params as Record<string, unknown>).value
      const json = JSON.stringify(value ?? null)
      if (json.length > MAX_STORAGE_VALUE_CHARS) bad(`storage value exceeds ${MAX_STORAGE_VALUE_CHARS} characters`)
      await data.storageSet(k, JSON.parse(json))
      return true
    },
    "storage.remove": async (params) => {
      await data.storageRemove(key(params))
      return true
    },
    "permissions.list": async () => data.grantedScopes(),
    "permissions.request": async (params) => {
      if (!isRecord(params) || !isToolScope(params.scope)) bad("scope must be a known scope")
      return data.requestScope(params.scope)
    },
    "ai.generate": async (params) => {
      if (!isRecord(params) || typeof params.prompt !== "string" || !params.prompt.trim()) bad("prompt must be a non-empty string")
      if (params.prompt.length > 20_000) bad("prompt exceeds 20000 characters")
      const system = typeof params.system === "string" ? params.system.slice(0, 5000) : ""
      const maxTokens = typeof params.maxTokens === "number" && params.maxTokens > 0 ? Math.min(params.maxTokens, 2000) : 800
      return data.generate({ prompt: params.prompt, system, maxTokens })
    },
    tell: async (params) => {
      if (!isRecord(params) || typeof params.message !== "string") bad("message must be a string")
      data.tell(params.message.slice(0, 1000))
      return true
    },
    "cells.page": async (params) => {
      if (!isRecord(params)) bad("params must be an object")
      const cursor = typeof params.cursor === "string" && params.cursor.length > 0 ? params.cursor.slice(0, 500) : null
      const rawLimit = typeof params.limit === "number" && Number.isFinite(params.limit) ? Math.floor(params.limit) : 500
      const limit = Math.max(1, Math.min(rawLimit, MAX_PAGE_LIMIT))
      return data.pageCells(str(params.fileId, "fileId"), laneOf(params), cursor, limit)
    },
    "cells.get": async (params) => {
      if (!isRecord(params)) bad("params must be an object")
      if (!Array.isArray(params.cellIds)) bad("cellIds must be an array")
      if (params.cellIds.length > MAX_GET_CELLS) bad(`at most ${MAX_GET_CELLS} cellIds per call`)
      const ids = params.cellIds.map((id, i) => str(id, `cellIds[${i}]`))
      return data.getCells(str(params.fileId, "fileId"), ids, laneOf(params))
    },
    "cells.unvalidate": async (params) => {
      if (!isRecord(params)) bad("params must be an object")
      return data.unvalidate(cellRefs(params.items, "items"))
    },
    "presence.list": async (params) => data.listPresence(fileOnly(params)),
    "presence.claim": async (params) => {
      const ref = cellRef(params)
      return data.claimCell(ref.fileId, ref.cellId)
    },
    "presence.release": async (params) => {
      const ref = cellRef(params)
      return data.releaseCell(ref.fileId, ref.cellId)
    },
    "comments.counts": async (params) => data.commentCounts(fileOnly(params)),
    "comments.open": async (params) => {
      const ref = cellRef(params)
      return data.openComments(ref.fileId, ref.cellId)
    },
    "audio.list": async (params) => data.listAudio(fileOnly(params)),
    "audio.play": async (params) => {
      const ref = cellRef(params)
      return data.playAudio(ref.fileId, ref.cellId)
    },
    "audio.stop": async () => data.stopAudio(),
    "ui.hostKey": async (params) => data.hostKey(parseHostKey(params)),
    "ui.strings": async (params) => {
      if (!isRecord(params) || !Array.isArray(params.keys)) bad("keys must be an array")
      if (params.keys.length > MAX_UI_STRING_KEYS) bad(`at most ${MAX_UI_STRING_KEYS} keys per call`)
      return data.uiStrings(params.keys.map((k, i) => str(k, `keys[${i}]`)))
    },
    "ui.notify": async (params) => {
      if (!isRecord(params) || typeof params.message !== "string") bad("message must be a string")
      data.notify(params.message.slice(0, 300))
      return true
    },
  }
}
