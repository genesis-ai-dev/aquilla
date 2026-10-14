/**
 * Bridge handlers added in apiRev 7 (additive): extensions as importers and
 * exporters. Param validation only; LiveToolData implements them
 * (live-data-files.ts), the builder's smoke render passes a stub
 * (smoke-files.ts). Keep in step with the builder prompt
 * (auth-worker/src/lib/tools/build-prompt.ts).
 *
 *   files.upsert / files.setMeta   create or refresh a source file from the
 *                                   extension's own parse (write:files)
 *   files.source / files.group     the raw original; the file's group
 *   cells.byRef                    cells by canonical ref across files
 *   data.get / put / query / delete records in hidden data files, with a
 *                                   drift check against the cell each one is
 *                                   anchored to (write:data)
 *   action.progress / action.done  a headless action reports back
 *   export.deliver                  a headless export hands its files back
 */

import { BridgeError, type BridgeHandler } from "./host-bridge"
import { parseFileExtension, type FileExtensionKind } from "../../../shared/tools/file-extension"

export interface ToolFileView {
  fileId: string
  name: string
  cellCount: number
  /** apiRev 7 (additive): what extensions recorded about the file. */
  kind?: FileExtensionKind
  tags?: string[]
  group?: string | null
  owner?: string | null
  meta?: Record<string, unknown> | null
}

export interface ToolFileFilter {
  tags?: string[]
  kind?: FileExtensionKind
  group?: string
}

export interface ToolUpsertCell {
  key: string
  value: string
  html?: string
  type?: string
  ref?: string
  metadata?: Record<string, unknown>
}

export interface ToolFileUpsert {
  /** Project-wide stable key ("uw:ult:TIT"): the same key always means the same file. */
  key: string
  name: string
  kind: FileExtensionKind
  tags: string[]
  group?: string
  meta?: Record<string, unknown>
  /** The app's file type for the editor ("usfm", "tsv", "md", … default "custom"). */
  format?: string
  bookCode?: string
  cells: ToolUpsertCell[]
  /** The original text, kept for exporters (files.source). */
  raw?: { text: string; format: string }
}

export interface ToolUpsertResult {
  fileId: string
  created: boolean
  creates: number
  commits: number
  deletes: number
  unchanged: number
  /** cell key → cell id (to anchor data to imported cells). */
  cellIds: Record<string, string>
}

export interface ToolRefCell {
  fileId: string
  cellId: string
  ref: string
  source: string
  target: string
  sourceHtml: string | null
  targetHtml: string | null
  type: string | null
  metadata: Record<string, unknown> | null
  validated: boolean
}

export interface ToolDataAnchor {
  fileId: string
  cellId: string
  side?: "source" | "target"
  lane?: string
}

export interface ToolDataDoc {
  id: string
  doc: unknown
  anchor: (ToolDataAnchor & { eventId: string | null }) | null
  /** Against the anchored cell's head now: unchanged, edited since, or gone. Null when unanchored. */
  drift: "current" | "changed" | "orphaned" | null
  ref: string | null
  updatedBy: string | null
  updatedAt: number | null
}

export interface ToolDeliveredFile {
  name: string
  mime: string
  /** Exactly one of text / bytes. */
  text?: string
  bytes?: ArrayBuffer
}

export interface ToolFilesHostData {
  listFilesFiltered: (filter: ToolFileFilter) => Promise<ToolFileView[]>
  upsertFile: (spec: ToolFileUpsert) => Promise<ToolUpsertResult>
  setFileMeta: (fileId: string, patch: { tags?: string[]; kind?: FileExtensionKind; group?: string | null; meta?: Record<string, unknown> | null; name?: string }) => Promise<ToolFileView>
  fileSource: (fileId: string) => Promise<{ text: string } | null>
  fileGroup: (fileId: string) => Promise<{ key: string; files: ToolFileView[] } | null>
  cellsByRef: (query: { refs: string[]; prefix: string | null; fileIds: string[] | null; tags: string[] | null; lane: string }) => Promise<Record<string, ToolRefCell[]>>
  dataGet: (ns: string, coll: string, id: string) => Promise<ToolDataDoc | null>
  dataPut: (ns: string, coll: string, id: string, doc: unknown, anchor: ToolDataAnchor | null) => Promise<{ id: string; version: string }>
  dataQuery: (ns: string, coll: string, filter: { anchorFileId: string | null; anchorCellIds: string[] | null; ref: string | null }) => Promise<ToolDataDoc[]>
  dataDelete: (ns: string, coll: string, id: string) => Promise<boolean>
  actionProgress: (message: string, fraction: number | null) => Promise<boolean>
  actionDone: (message: string | null, ok: boolean) => Promise<boolean>
  exportDeliver: (files: ToolDeliveredFile[]) => Promise<boolean>
}

export const MAX_UPSERT_CELLS = 50_000
export const MAX_UPSERT_VALUE_CHARS = 100_000
export const MAX_RAW_CHARS = 20 * 1024 * 1024
export const MAX_DATA_DOC_CHARS = 200_000
export const MAX_DELIVER_FILES = 200
export const MAX_DELIVER_BYTES = 100 * 1024 * 1024
const NS_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/
const FORMATS = new Set(["md", "txt", "html", "json", "usfm", "tsv", "csv", "obs", "custom", "codex"])

/** True when the string holds an ASCII control character (U+0000-U+001F). */
function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) < 0x20) return true
  return false
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}
function bad(message: string): never {
  throw new BridgeError("invalid_params", message)
}
function obj(params: unknown): Record<string, unknown> {
  if (!isRecord(params)) bad("params must be an object")
  return params
}
function str(v: unknown, name: string, max = 200): string {
  if (typeof v !== "string" || v.length === 0 || v.length > max) bad(`${name} must be a non-empty string of at most ${max} characters`)
  return v
}
function optStr(v: unknown, name: string, max = 200): string | undefined {
  if (v === undefined || v === null) return undefined
  return str(v, name, max)
}
function strList(v: unknown, name: string, maxItems: number, maxLen = 200): string[] {
  if (v === undefined || v === null) return []
  if (!Array.isArray(v)) bad(`${name} must be a list of strings`)
  if (v.length > maxItems) bad(`at most ${maxItems} ${name}`)
  return v.map((x, i) => str(x, `${name}[${i}]`, maxLen))
}
function ns(params: Record<string, unknown>): { ns: string; coll: string } {
  const n = typeof params.ns === "string" ? params.ns : ""
  if (!NS_RE.test(n)) bad("ns must be lowercase letters, digits, dots, dashes or underscores (at most 64)")
  const coll = params.coll === undefined || params.coll === null ? "default" : String(params.coll)
  if (!NS_RE.test(coll)) bad("coll must be lowercase letters, digits, dots, dashes or underscores (at most 64)")
  return { ns: n, coll }
}

function parseUpsert(params: unknown): ToolFileUpsert {
  const p = obj(params)
  const ext = parseFileExtension({ kind: p.kind ?? "normal", tags: p.tags ?? [], group: p.group, meta: p.meta })
  if (!ext.ok) bad(ext.error)
  if (ext.value.kind === "data") bad('kind "data" is for aquilla.data.* — use "normal" or "reference" here')
  if (!Array.isArray(p.cells)) bad("cells must be a list")
  if (p.cells.length > MAX_UPSERT_CELLS) bad(`at most ${MAX_UPSERT_CELLS} cells per file`)
  const keys = new Set<string>()
  const cells: ToolUpsertCell[] = p.cells.map((raw, i) => {
    if (!isRecord(raw)) bad(`cells[${i}] must be an object`)
    const key = str(raw.key, `cells[${i}].key`, 300)
    if (keys.has(key)) bad(`cells[${i}].key "${key}" is used twice`)
    keys.add(key)
    if (typeof raw.value !== "string") bad(`cells[${i}].value must be a string`)
    if (raw.value.length > MAX_UPSERT_VALUE_CHARS) bad(`cells[${i}].value exceeds ${MAX_UPSERT_VALUE_CHARS} characters`)
    const cell: ToolUpsertCell = { key, value: raw.value }
    const html = optStr(raw.html, `cells[${i}].html`, MAX_UPSERT_VALUE_CHARS * 2)
    if (html !== undefined) cell.html = html
    const type = optStr(raw.type, `cells[${i}].type`, 40)
    if (type !== undefined) cell.type = type
    const ref = optStr(raw.ref, `cells[${i}].ref`, 300)
    if (ref !== undefined) cell.ref = ref
    if (raw.metadata !== undefined && raw.metadata !== null) {
      if (!isRecord(raw.metadata)) bad(`cells[${i}].metadata must be an object`)
      if (JSON.stringify(raw.metadata).length > 32_000) bad(`cells[${i}].metadata exceeds 32000 characters`)
      cell.metadata = raw.metadata
    }
    return cell
  })
  const format = optStr(p.format, "format", 20) ?? "custom"
  if (!FORMATS.has(format)) bad(`format must be one of ${[...FORMATS].join(", ")}`)
  const out: ToolFileUpsert = {
    key: str(p.key, "key", 200),
    name: str(p.name, "name", 200),
    kind: ext.value.kind,
    tags: ext.value.tags,
    format,
    cells,
    ...(ext.value.group ? { group: ext.value.group } : {}),
    ...(ext.value.meta ? { meta: ext.value.meta } : {}),
  }
  const bookCode = optStr(p.bookCode, "bookCode", 8)
  if (bookCode) out.bookCode = bookCode
  if (p.raw !== undefined && p.raw !== null) {
    const raw = obj(p.raw)
    if (typeof raw.text !== "string" || raw.text.length > MAX_RAW_CHARS) bad(`raw.text must be a string of at most ${MAX_RAW_CHARS} characters`)
    const rawFormat = optStr(raw.format, "raw.format", 20) ?? "txt"
    if (!FORMATS.has(rawFormat)) bad(`raw.format must be one of ${[...FORMATS].join(", ")}`)
    out.raw = { text: raw.text, format: rawFormat }
  }
  return out
}

function parseAnchor(v: unknown): ToolDataAnchor | null {
  if (v === undefined || v === null) return null
  const a = obj(v)
  const side = a.side === undefined ? "target" : a.side
  if (side !== "source" && side !== "target") bad('anchor.side must be "source" or "target"')
  return {
    fileId: str(a.fileId, "anchor.fileId"),
    cellId: str(a.cellId, "anchor.cellId"),
    side,
    lane: typeof a.lane === "string" ? a.lane.slice(0, 100) : "",
  }
}

function parseDelivered(v: unknown): ToolDeliveredFile[] {
  if (!Array.isArray(v) || v.length === 0) bad("files must be a non-empty list")
  if (v.length > MAX_DELIVER_FILES) bad(`at most ${MAX_DELIVER_FILES} files`)
  let total = 0
  return v.map((raw, i) => {
    const f = obj(raw)
    const name = str(f.name, `files[${i}].name`, 200)
    if (name.includes("\\") || name.startsWith("/") || hasControlChar(name) || name.split("/").some((seg) => seg === "" || seg === "." || seg === "..")) {
      bad(`files[${i}].name must be a plain file name or a relative path`)
    }
    const mime = optStr(f.mime, `files[${i}].mime`, 100) ?? "text/plain"
    if (typeof f.text === "string") {
      total += f.text.length
      if (total > MAX_DELIVER_BYTES) bad(`delivered files exceed ${MAX_DELIVER_BYTES / 1024 / 1024} MB`)
      return { name, mime, text: f.text }
    }
    if (f.bytes instanceof ArrayBuffer) {
      total += f.bytes.byteLength
      if (total > MAX_DELIVER_BYTES) bad(`delivered files exceed ${MAX_DELIVER_BYTES / 1024 / 1024} MB`)
      return { name, mime, bytes: f.bytes }
    }
    return bad(`files[${i}] needs text (a string) or bytes (an ArrayBuffer)`)
  })
}

export function createFilesHandlers(data: ToolFilesHostData): Record<string, BridgeHandler> {
  return {
    "files.upsert": async (params) => data.upsertFile(parseUpsert(params)),
    "files.setMeta": async (params) => {
      const p = obj(params)
      const fileId = str(p.fileId, "fileId")
      const patch: Parameters<ToolFilesHostData["setFileMeta"]>[1] = {}
      if (p.tags !== undefined) patch.tags = strList(p.tags, "tags", 20, 80)
      if (p.kind !== undefined) {
        if (p.kind !== "normal" && p.kind !== "reference") bad('kind must be "normal" or "reference"')
        patch.kind = p.kind
      }
      if (p.group !== undefined) patch.group = p.group === null ? null : str(p.group, "group", 80)
      if (p.meta !== undefined) {
        if (p.meta !== null && !isRecord(p.meta)) bad("meta must be an object or null")
        patch.meta = p.meta as Record<string, unknown> | null
      }
      if (p.name !== undefined) patch.name = str(p.name, "name", 200)
      return data.setFileMeta(fileId, patch)
    },
    "files.source": async (params) => data.fileSource(str(obj(params).fileId, "fileId")),
    "files.group": async (params) => data.fileGroup(str(obj(params).fileId, "fileId")),
    "cells.byRef": async (params) => {
      const p = obj(params)
      const refs = strList(p.refs, "refs", 200, 300)
      const prefix = optStr(p.prefix, "prefix", 300) ?? null
      if (refs.length === 0 && (!prefix || prefix.length < 2)) bad("refs (a list) or prefix (at least 2 characters) is required")
      const fileIds = p.fileIds === undefined || p.fileIds === null ? null : strList(p.fileIds, "fileIds", 50)
      const tags = p.tags === undefined || p.tags === null ? null : strList(p.tags, "tags", 20, 80)
      if (!fileIds && !tags) bad("fileIds or tags is required")
      return data.cellsByRef({ refs, prefix, fileIds, tags, lane: typeof p.lane === "string" ? p.lane.slice(0, 100) : "" })
    },
    "data.get": async (params) => {
      const p = obj(params)
      const { ns: n, coll } = ns(p)
      return data.dataGet(n, coll, str(p.id, "id", 300))
    },
    "data.put": async (params) => {
      const p = obj(params)
      const { ns: n, coll } = ns(p)
      const id = str(p.id, "id", 300)
      const json = JSON.stringify(p.doc ?? null)
      if (json.length > MAX_DATA_DOC_CHARS) bad(`doc exceeds ${MAX_DATA_DOC_CHARS} characters`)
      return data.dataPut(n, coll, id, JSON.parse(json), parseAnchor(p.anchor))
    },
    "data.query": async (params) => {
      const p = obj(params)
      const { ns: n, coll } = ns(p)
      const anchorCellIds = p.anchorCellIds === undefined || p.anchorCellIds === null ? null : strList(p.anchorCellIds, "anchorCellIds", 2000)
      return data.dataQuery(n, coll, {
        anchorFileId: optStr(p.anchorFileId, "anchorFileId") ?? null,
        anchorCellIds,
        ref: optStr(p.ref, "ref", 300) ?? null,
      })
    },
    "data.delete": async (params) => {
      const p = obj(params)
      const { ns: n, coll } = ns(p)
      return data.dataDelete(n, coll, str(p.id, "id", 300))
    },
    "action.progress": async (params) => {
      const p = obj(params)
      const message = typeof p.message === "string" ? p.message.slice(0, 300) : ""
      const fraction = typeof p.fraction === "number" && Number.isFinite(p.fraction) ? Math.max(0, Math.min(1, p.fraction)) : null
      return data.actionProgress(message, fraction)
    },
    "action.done": async (params) => {
      const p = isRecord(params) ? params : {}
      return data.actionDone(typeof p.message === "string" ? p.message.slice(0, 500) : null, p.ok !== false)
    },
    "export.deliver": async (params) => data.exportDeliver(parseDelivered(obj(params).files)),
  }
}

/** Parse files.list's optional filter (apiRev 7). */
export function parseFileFilter(params: unknown): ToolFileFilter {
  if (!isRecord(params)) return {}
  const out: ToolFileFilter = {}
  if (params.tags !== undefined && params.tags !== null) out.tags = strList(params.tags, "tags", 20, 80)
  if (params.kind === "normal" || params.kind === "reference" || params.kind === "data") out.kind = params.kind
  if (typeof params.group === "string" && params.group) out.group = params.group.slice(0, 80)
  return out
}
