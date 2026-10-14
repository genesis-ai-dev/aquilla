/**
 * apiRev 7, the live half of host-handlers-files.ts: extensions that create
 * and refresh project files, keep records in hidden data files, read cells by
 * ref across files, and report back from headless actions and exports.
 *
 * Everything here is an ordinary write through the ordinary pipes:
 *   - a NEW file goes through the bulk /import front door (bulkUploadSource),
 *     the same one every importer uses;
 *   - a REFRESH runs the shared change detection (src/lib/import/change-
 *     detection.ts, lifted out of the Door43 delta) and emits only the
 *     source.cell.create / commit / delete events that differ — so downstream
 *     translations go stale through the normal staleness machinery;
 *   - every write carries the extension's tool_origin WITH its server-minted
 *     session, which the sync-worker verifies (and requires for these writes).
 *
 * Ids are deterministic (uuidv5): the same file key always names the same file
 * in a project, the same cell key the same cell, so a refresh is a delta and
 * cooperating extensions (an importer, an editor, an exporter) find each
 * other's files and records.
 */

import { v5 as uuidv5, v7 as uuidv7 } from "uuid"
import { contentHash } from "@/lib/dcs/content-hash"
import { detectChanges, type HeldCellState } from "@/lib/import/change-detection"
import { bulkUploadSource, type BulkImportCell } from "@/lib/sync/bulk-import"
import { fetchAllFileCells, fetchCellsByIds, fetchCellsByRef, fetchProjectFiles } from "@/lib/sync/cells-read"
import type { CellRow, FileSummary } from "@/lib/sync/cells-read-types"
import { emitFileExtensionSet, emitFileRename, emitSourceCellCommit, emitSourceCellCreate, emitSourceCellDelete } from "@/lib/sync/events-emit"
import { fetchRawOriginalSource } from "@/lib/sync/source-export"
import { uploadSourceOriginal } from "@/lib/sync/source-upload"
import { sanitizeSourceDisplayHtml } from "@/lib/richtext/editor-content"
import type { SourceArtifactFormat } from "../../../shared/import-contract"
import { EXTENSION_DATA_ROLE, type FileExtensionKind, type FileExtensionMeta } from "../../../shared/tools/file-extension"
import type { ToolOrigin } from "../../../shared/tools/manifest"
import type {
  ToolDataAnchor,
  ToolDataDoc,
  ToolDeliveredFile,
  ToolFileFilter,
  ToolFileUpsert,
  ToolFileView,
  ToolFilesHostData,
  ToolRefCell,
  ToolUpsertResult,
} from "./host-handlers-files"

/** Fixed namespace for extension-derived ids. NEVER CHANGE: every extension
 *  file/cell id in every project derives from it. */
export const EXTENSION_NS = "0f3c9a52-6d1e-4b8a-9e57-2a7c61d4b3f0"

export const extensionFileId = (projectId: string, key: string): string => uuidv5(`${projectId}|ext-file|${key}`, EXTENSION_NS)
export const extensionDataFileId = (projectId: string, ns: string, coll: string): string =>
  uuidv5(`${projectId}|ext-data|${ns}|${coll}`, EXTENSION_NS)
export const extensionCellId = (fileId: string, key: string): string => uuidv5(`${fileId}|cell|${key}`, EXTENSION_NS)

/** Source rich text an extension writes (files.upsert, write:files = project
 *  lead) is stored as given, exactly like a built-in importer's parser HTML:
 *  every display path sanitizes on read to its own allowlist (pairRows,
 *  cells.byRef, the editor). AQU-1937 parity: the Door43 importer's markdown
 *  HTML must land byte-identical to the built-in import's. */
export function storedSourceHtml(html: string): string {
  return html
}

/** What a refresh compares: value and rich text (metadata rides separately). */
export function upsertHash(value: string, html: string | null | undefined): string {
  return `${contentHash(value)}:${contentHash(html ?? "")}`
}

/** The JSON a data cell holds. */
interface DataEnvelope {
  v: 1
  id: string
  doc: unknown
  anchor: (ToolDataAnchor & { eventId: string | null }) | null
}

export interface HeadlessCallbacks {
  progress?: (message: string, fraction: number | null) => void
  done?: (message: string | null, ok: boolean) => void
  deliver?: (files: ToolDeliveredFile[]) => void
  /** AQU-1937: an importer's dynamic option choices. */
  choices?: (choices: { value: string; label: string }[]) => void
  /** AQU-1937: the import run this frame is doing — recorded on every file it upserts. */
  importContext?: { toolId: string; importerId: string; options: Record<string, unknown> }
}

export interface LiveFilesOptions {
  projectId: string
  author: string
  /** Read at write time: the session token arrives after the frame boots. */
  toolOrigin: () => ToolOrigin
  tokenFor: (projectId: string, fileId: string) => Promise<string | null>
  flush: () => void
  resolveLaneTag: (lane: string) => Promise<string>
  headless?: () => HeadlessCallbacks | undefined
}

export function toolFileView(f: FileSummary): ToolFileView {
  const ext = f.extension ?? null
  return {
    fileId: f.fileId,
    name: f.name,
    cellCount: f.cellCount,
    kind: f.role === EXTENSION_DATA_ROLE ? "data" : (ext?.kind ?? "normal"),
    tags: ext?.tags ?? [],
    group: ext?.group ?? null,
    owner: ext?.owner ?? null,
    meta: ext?.meta ?? null,
  }
}

function matchesFilter(v: ToolFileView, filter: ToolFileFilter): boolean {
  if (filter.kind && v.kind !== filter.kind) return false
  if (filter.group && v.group !== filter.group) return false
  if (filter.tags && filter.tags.length > 0 && !filter.tags.every((t) => v.tags?.includes(t))) return false
  return true
}

function parseEnvelope(value: string): DataEnvelope | null {
  try {
    const parsed: unknown = JSON.parse(value)
    if (parsed && typeof parsed === "object" && (parsed as DataEnvelope).v === 1 && typeof (parsed as DataEnvelope).id === "string") {
      return parsed as DataEnvelope
    }
  } catch {
    /* not a data record */
  }
  return null
}

export class LiveFilesData implements ToolFilesHostData {
  private readonly opts: LiveFilesOptions
  /** Data file rows by file id (cellId → row), refreshed on invalidate. */
  private readonly dataCache = new Map<string, Promise<Map<string, CellRow>>>()
  private filesCache: Promise<FileSummary[]> | null = null
  /** Resolves once the tool session has been minted (or failed): file and
   *  data writes wait for it so their tool_origin is verifiable. */
  private ready: Promise<void> = Promise.resolve()

  constructor(opts: LiveFilesOptions) {
    this.opts = opts
  }

  whenReady(p: Promise<unknown>): void {
    this.ready = p.then(() => undefined, () => undefined)
  }

  /** After cells.changed: drop what may be stale. */
  invalidate(fileId: string): void {
    this.dataCache.delete(fileId)
    this.filesCache = null
  }

  private async token(fileId: string): Promise<string> {
    const t = await this.opts.tokenFor(this.opts.projectId, fileId)
    if (!t) throw new Error("no sync token for this project")
    return t
  }

  private files(fresh = false): Promise<FileSummary[]> {
    if (fresh || !this.filesCache) {
      this.filesCache = this.token("any").then((t) => fetchProjectFiles(this.opts.projectId, t, { extensionData: true }))
      this.filesCache.catch(() => (this.filesCache = null))
    }
    return this.filesCache
  }

  async listFilesFiltered(filter: ToolFileFilter): Promise<ToolFileView[]> {
    const files = await this.files(true)
    return files
      .filter((f) => f.role !== "audio-cues" && f.role !== "timeline-content" && !f.deletedAt)
      .map(toolFileView)
      .filter((v) => matchesFilter(v, filter))
  }

  // ── files.upsert ─────────────────────────────────────────────────────────

  async upsertFile(spec: ToolFileUpsert): Promise<ToolUpsertResult> {
    await this.ready
    const { projectId } = this.opts
    const fileId = spec.fileId ?? extensionFileId(projectId, spec.key)
    const origin = this.opts.toolOrigin()
    const cellIds: Record<string, string> = {}
    for (const c of spec.cells) cellIds[c.key] = c.cellId ?? extensionCellId(fileId, c.key)
    const run = this.opts.headless?.()?.importContext
    const extension: FileExtensionMeta = {
      kind: spec.kind,
      tags: spec.tags,
      owner: origin.toolId,
      ...(spec.group ? { group: spec.group } : {}),
      ...(spec.meta ? { meta: spec.meta } : {}),
      // AQU-1937: provenance the platform records for "Refresh from source".
      ...(run ? { import: { tool: run.toolId, importer: run.importerId, options: run.options, ...(spec.upstream ? { upstream: spec.upstream } : {}), at: Date.now() } } : {}),
    }
    const existing = (await this.files(true)).find((f) => f.fileId === fileId)
    if (existing?.deletedAt) throw new Error(`the file "${existing.name}" was deleted; restore it from Trash before refreshing it`)

    if (!existing) {
      const cells: BulkImportCell[] = spec.cells.map((c, i) => ({
        id: uuidv7(),
        cellId: cellIds[c.key],
        anchorCellId: i === 0 ? null : cellIds[spec.cells[i - 1].key],
        value: c.value,
        ...(c.html !== undefined ? { valueHtml: storedSourceHtml(c.html) } : {}),
        ...(c.type !== undefined ? { type: c.type } : {}),
        ...(c.ref !== undefined ? { canonicalRef: c.ref } : {}),
        ...(c.sequenceIndex !== undefined ? { sequenceIndex: c.sequenceIndex } : {}),
        ...(c.metadata !== undefined ? { metadata: c.metadata } : {}),
      }))
      await bulkUploadSource({
        projectId,
        fileId,
        file: {
          id: uuidv7(),
          name: spec.name,
          fileType: spec.format ?? "custom",
          importFormat: `extension:${origin.toolId}`,
          parserVersion: `extension:${origin.toolId}@${origin.version}`,
          ...(spec.bookCode ? { bookCode: spec.bookCode } : {}),
          extension: extension as unknown as Record<string, unknown>,
        },
        cells,
        ...(spec.raw ? { rawSource: spec.raw.text, rawSourceFormat: spec.raw.format as SourceArtifactFormat } : {}),
        getToken: (id) => this.opts.tokenFor(projectId, id),
        toolOrigin: origin,
      })
      this.filesCache = null
      return { fileId, created: true, creates: cells.length, commits: 0, deletes: 0, unchanged: 0, cellIds }
    }

    // Refresh: classify against the held source rows, emit only the deltas.
    const rows = await fetchAllFileCells(projectId, fileId, await this.token(fileId), "source")
    const held = new Map<string, HeldCellState>()
    const rowById = new Map<string, CellRow>()
    for (const r of rows) {
      held.set(r.cellId, { eventId: r.eventId, contentHash: upsertHash(r.value, r.valueHtml), fileId })
      rowById.set(r.cellId, r)
    }
    const desired = spec.cells.map((c, i) => {
      const html = c.html !== undefined ? storedSourceHtml(c.html) : undefined
      return { ...c, html, cellId: cellIds[c.key], index: i, contentHash: upsertHash(c.value, html ?? rowById.get(cellIds[c.key])?.valueHtml ?? null) }
    })
    const changes = detectChanges([{ fileId, cells: desired }], held)
    for (const { cell } of changes.creates) {
      await emitSourceCellCreate({
        projectId,
        fileId,
        cellId: cell.cellId,
        anchorCellId: cell.index === 0 ? null : desired[cell.index - 1].cellId,
        value: cell.value,
        ...(cell.html !== undefined ? { valueHtml: cell.html } : {}),
        ...(cell.type !== undefined ? { type: cell.type } : {}),
        ...(cell.ref !== undefined ? { canonicalRef: cell.ref } : {}),
        ...(cell.sequenceIndex !== undefined ? { sequenceIndex: cell.sequenceIndex } : {}),
        ...(cell.metadata !== undefined ? { metadata: cell.metadata } : {}),
        author: this.opts.author,
        toolOrigin: origin,
      })
    }
    for (const { cell, parentEventId } of changes.commits) {
      await emitSourceCellCommit({
        projectId,
        fileId,
        cellId: cell.cellId,
        parentId: parentEventId,
        value: cell.value,
        ...(cell.html !== undefined ? { valueHtml: cell.html } : {}),
        author: this.opts.author,
        toolOrigin: origin,
      })
    }
    for (const cellId of changes.deletes) {
      await emitSourceCellDelete({ projectId, fileId, cellId, parentId: held.get(cellId)?.eventId ?? null, author: this.opts.author, toolOrigin: origin })
    }
    const before = existing.extension ?? null
    const comparable = (e: FileExtensionMeta | null) => (e?.import ? { ...e, import: { ...e.import, at: 0 } } : e)
    if (JSON.stringify(comparable(before)) !== JSON.stringify(comparable(extension))) {
      await emitFileExtensionSet({ projectId, fileId, extension: extension as unknown as Record<string, unknown>, author: this.opts.author, toolOrigin: origin })
    }
    if (existing.name !== spec.name) await emitFileRename({ projectId, fileId, name: spec.name, author: this.opts.author })
    if (spec.raw) {
      await uploadSourceOriginal({
        projectId,
        fileId,
        artifactId: uuidv7(),
        bytes: new TextEncoder().encode(spec.raw.text).buffer as ArrayBuffer,
        format: spec.raw.format as SourceArtifactFormat,
        artifactName: spec.name,
        updateSourceSidecar: true,
        getToken: (id) => this.opts.tokenFor(projectId, id),
      })
    }
    this.opts.flush()
    this.filesCache = null
    return {
      fileId,
      created: false,
      creates: changes.creates.length,
      commits: changes.commits.length,
      deletes: changes.deletes.length,
      unchanged: changes.unchanged,
      cellIds,
    }
  }

  async setFileMeta(
    fileId: string,
    patch: { tags?: string[]; kind?: FileExtensionKind; group?: string | null; meta?: Record<string, unknown> | null; name?: string },
  ): Promise<ToolFileView> {
    await this.ready
    const file = (await this.files(true)).find((f) => f.fileId === fileId && !f.deletedAt)
    if (!file) throw new Error("file not found")
    const origin = this.opts.toolOrigin()
    const current: FileExtensionMeta = file.extension ?? { kind: "normal", tags: [] }
    const next: FileExtensionMeta = {
      ...current,
      ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
      ...(patch.kind !== undefined ? { kind: patch.kind } : {}),
      owner: current.owner ?? origin.toolId,
    }
    if (patch.group !== undefined) {
      if (patch.group === null) delete next.group
      else next.group = patch.group
    }
    if (patch.meta !== undefined) {
      if (patch.meta === null) delete next.meta
      else next.meta = patch.meta
    }
    await emitFileExtensionSet({ projectId: this.opts.projectId, fileId, extension: next as unknown as Record<string, unknown>, author: this.opts.author, toolOrigin: origin })
    if (patch.name !== undefined && patch.name !== file.name) {
      await emitFileRename({ projectId: this.opts.projectId, fileId, name: patch.name, author: this.opts.author })
    }
    this.opts.flush()
    this.filesCache = null
    return toolFileView({ ...file, name: patch.name ?? file.name, extension: next })
  }

  async fileSource(fileId: string): Promise<{ text: string } | null> {
    try {
      const { bytes } = await fetchRawOriginalSource({
        projectId: this.opts.projectId,
        fileId,
        getToken: (id) => this.opts.tokenFor(this.opts.projectId, id),
      })
      return { text: new TextDecoder().decode(bytes) }
    } catch (err) {
      if (err instanceof Error && "status" in err && (err as { status?: number }).status === 404) return null
      throw err
    }
  }

  async fileGroup(fileId: string): Promise<{ key: string; files: ToolFileView[] } | null> {
    const views = (await this.files(true)).filter((f) => !f.deletedAt).map(toolFileView)
    const self = views.find((v) => v.fileId === fileId)
    if (!self?.group) return null
    return { key: self.group, files: views.filter((v) => v.group === self.group) }
  }

  // ── cells.byRef ──────────────────────────────────────────────────────────

  async cellsByRef(query: { refs: string[]; prefix: string | null; fileIds: string[] | null; tags: string[] | null; lane: string }): Promise<Record<string, ToolRefCell[]>> {
    let fileIds = query.fileIds
    if (!fileIds) {
      const tagged = await this.listFilesFiltered({ tags: query.tags ?? [] })
      fileIds = tagged.map((f) => f.fileId)
    }
    const out: Record<string, ToolRefCell[]> = {}
    if (fileIds.length === 0) return out
    const lane = await this.opts.resolveLaneTag(query.lane)
    const token = await this.token("any")
    for (let i = 0; i < fileIds.length; i += 50) {
      const { cells } = await fetchCellsByRef(this.opts.projectId, token, {
        fileIds: fileIds.slice(i, i + 50),
        ...(query.refs.length > 0 ? { refs: query.refs } : { prefix: query.prefix ?? "" }),
        lane,
      })
      const byKey = new Map<string, ToolRefCell>()
      for (const row of cells) {
        if (!row.canonicalRef || row.hidden) continue
        const key = `${row.fileId}|${row.cellId}`
        let cell = byKey.get(key)
        if (!cell) {
          cell = {
            fileId: row.fileId,
            cellId: row.cellId,
            ref: row.canonicalRef,
            source: "",
            target: "",
            sourceHtml: null,
            targetHtml: null,
            type: row.type,
            metadata: row.metadata ?? null,
            validated: false,
          }
          byKey.set(key, cell)
          ;(out[row.canonicalRef] ??= []).push(cell)
        }
        if (row.side === "source") {
          cell.source = row.value
          cell.sourceHtml = row.valueHtml ? sanitizeSourceDisplayHtml(row.valueHtml) : null
          cell.type = row.type
          cell.metadata = row.metadata ?? null
        } else {
          cell.target = row.value
          cell.targetHtml = row.valueHtml ? sanitizeSourceDisplayHtml(row.valueHtml) : null
          cell.validated = row.validated
        }
      }
    }
    return out
  }

  // ── data.* — records in hidden data files ───────────────────────────────

  private dataRows(fileId: string): Promise<Map<string, CellRow>> {
    let p = this.dataCache.get(fileId)
    if (!p) {
      p = (async () => {
        const exists = (await this.files()).some((f) => f.fileId === fileId)
        if (!exists) return new Map<string, CellRow>()
        const rows = await fetchAllFileCells(this.opts.projectId, fileId, await this.token(fileId), "source")
        return new Map(rows.map((r) => [r.cellId, r]))
      })()
      this.dataCache.set(fileId, p)
      p.catch(() => this.dataCache.delete(fileId))
    }
    return p
  }

  private async ensureDataFile(ns: string, coll: string): Promise<string> {
    const fileId = extensionDataFileId(this.opts.projectId, ns, coll)
    if ((await this.files()).some((f) => f.fileId === fileId)) return fileId
    if ((await this.files(true)).some((f) => f.fileId === fileId)) return fileId
    const origin = this.opts.toolOrigin()
    await bulkUploadSource({
      projectId: this.opts.projectId,
      fileId,
      file: {
        id: uuidv7(),
        name: coll === "default" ? `${ns} (extension data)` : `${ns} / ${coll} (extension data)`,
        fileType: "json",
        role: EXTENSION_DATA_ROLE,
        importFormat: `extension:${origin.toolId}`,
        extension: { kind: "data", tags: [`data:${ns}`], owner: origin.toolId, meta: { ns, coll } },
      },
      cells: [],
      getToken: (id) => this.opts.tokenFor(this.opts.projectId, id),
      toolOrigin: origin,
    })
    this.filesCache = null
    this.dataCache.delete(fileId)
    return fileId
  }

  /** The anchored cell's heads now: for drift checks and to stamp a write. */
  private async anchorHeads(anchors: ToolDataAnchor[]): Promise<Map<string, { source: CellRow | null; targets: Map<string, CellRow> }>> {
    const out = new Map<string, { source: CellRow | null; targets: Map<string, CellRow> }>()
    const byFile = new Map<string, Set<string>>()
    for (const a of anchors) {
      const set = byFile.get(a.fileId) ?? new Set<string>()
      set.add(a.cellId)
      byFile.set(a.fileId, set)
    }
    for (const [fileId, ids] of byFile) {
      const list = [...ids]
      const token = await this.token(fileId)
      for (let i = 0; i < list.length; i += 100) {
        const rows = await fetchCellsByIds(this.opts.projectId, fileId, list.slice(i, i + 100), token)
        for (const r of rows) {
          const key = `${fileId}|${r.cellId}`
          const entry = out.get(key) ?? { source: null, targets: new Map<string, CellRow>() }
          if (r.side === "source") entry.source = r
          else entry.targets.set(r.targetLang ?? "", r)
          out.set(key, entry)
        }
      }
    }
    return out
  }

  private headOf(
    heads: Map<string, { source: CellRow | null; targets: Map<string, CellRow> }>,
    anchor: ToolDataAnchor,
    laneTag: string,
  ): { exists: boolean; eventId: string | null; ref: string | null } {
    const entry = heads.get(`${anchor.fileId}|${anchor.cellId}`)
    if (!entry?.source || entry.source.hidden) return { exists: false, eventId: null, ref: null }
    const row = anchor.side === "source" ? entry.source : entry.targets.get(laneTag) ?? null
    return { exists: true, eventId: row?.eventId ?? null, ref: entry.source.canonicalRef }
  }

  private async toDocs(rows: CellRow[]): Promise<ToolDataDoc[]> {
    const parsed = rows.flatMap((r) => {
      const env = parseEnvelope(r.value)
      return env ? [{ row: r, env }] : []
    })
    const anchors = parsed.flatMap(({ env }) => (env.anchor ? [env.anchor] : []))
    const heads = anchors.length > 0 ? await this.anchorHeads(anchors) : new Map()
    const laneTags = new Map<string, string>()
    const out: ToolDataDoc[] = []
    for (const { row, env } of parsed) {
      let drift: ToolDataDoc["drift"] = null
      if (env.anchor) {
        const lane = env.anchor.lane ?? ""
        if (!laneTags.has(lane)) laneTags.set(lane, await this.opts.resolveLaneTag(lane))
        const head = this.headOf(heads, env.anchor, laneTags.get(lane) ?? "")
        drift = !head.exists ? "orphaned" : head.eventId === env.anchor.eventId ? "current" : "changed"
      }
      out.push({
        id: env.id,
        doc: env.doc,
        anchor: env.anchor,
        drift,
        ref: row.canonicalRef,
        updatedBy: row.lastEditor,
        updatedAt: row.lastEditAt ?? null,
      })
    }
    return out
  }

  async dataGet(ns: string, coll: string, id: string): Promise<ToolDataDoc | null> {
    const fileId = extensionDataFileId(this.opts.projectId, ns, coll)
    const row = (await this.dataRows(fileId)).get(extensionCellId(fileId, id))
    if (!row) return null
    return (await this.toDocs([row]))[0] ?? null
  }

  async dataQuery(ns: string, coll: string, filter: { anchorFileId: string | null; anchorCellIds: string[] | null; ref: string | null }): Promise<ToolDataDoc[]> {
    const fileId = extensionDataFileId(this.opts.projectId, ns, coll)
    const wanted = filter.anchorCellIds ? new Set(filter.anchorCellIds) : null
    const rows = [...(await this.dataRows(fileId)).values()].filter((r) => {
      if (filter.ref && r.canonicalRef !== filter.ref) return false
      if (!filter.anchorFileId && !wanted) return true
      const env = parseEnvelope(r.value)
      if (!env?.anchor) return false
      if (filter.anchorFileId && env.anchor.fileId !== filter.anchorFileId) return false
      if (wanted && !wanted.has(env.anchor.cellId)) return false
      return true
    })
    return this.toDocs(rows)
  }

  async dataPut(ns: string, coll: string, id: string, doc: unknown, anchor: ToolDataAnchor | null): Promise<{ id: string; version: string }> {
    await this.ready
    const fileId = await this.ensureDataFile(ns, coll)
    const cellId = extensionCellId(fileId, id)
    const rows = await this.dataRows(fileId)
    let stamped: DataEnvelope["anchor"] = null
    let ref: string | undefined
    if (anchor) {
      const heads = await this.anchorHeads([anchor])
      const head = this.headOf(heads, anchor, await this.opts.resolveLaneTag(anchor.lane ?? ""))
      if (!head.exists) throw new Error("the anchor cell does not exist")
      stamped = { ...anchor, eventId: head.eventId }
      ref = head.ref ?? undefined
    }
    const envelope: DataEnvelope = { v: 1, id, doc, anchor: stamped }
    const value = JSON.stringify(envelope)
    const origin = this.opts.toolOrigin()
    const existing = rows.get(cellId)
    let version: string
    if (existing) {
      if (existing.value === value) return { id, version: existing.eventId }
      version = await emitSourceCellCommit({ projectId: this.opts.projectId, fileId, cellId, parentId: existing.eventId, value, author: this.opts.author, toolOrigin: origin })
    } else {
      const tail = [...rows.values()].pop()
      version = await emitSourceCellCreate({
        projectId: this.opts.projectId,
        fileId,
        cellId,
        anchorCellId: tail?.cellId ?? null,
        value,
        type: "data",
        ...(ref ? { canonicalRef: ref } : {}),
        author: this.opts.author,
        toolOrigin: origin,
      })
    }
    // Optimistic: the next read in this session sees the write at once.
    rows.set(cellId, {
      ...(existing ?? { cellId, side: "source", valueHtml: null, type: "data", canonicalRef: ref ?? null, anchorCellId: null, sourceEventId: null, validated: false, wordCount: 0 }),
      value,
      eventId: version,
      lastEditor: this.opts.author,
      lastEditAt: Date.now(),
    } as CellRow)
    this.opts.flush()
    return { id, version }
  }

  async dataDelete(ns: string, coll: string, id: string): Promise<boolean> {
    await this.ready
    const fileId = extensionDataFileId(this.opts.projectId, ns, coll)
    const rows = await this.dataRows(fileId)
    const cellId = extensionCellId(fileId, id)
    const existing = rows.get(cellId)
    if (!existing) return false
    await emitSourceCellDelete({ projectId: this.opts.projectId, fileId, cellId, parentId: existing.eventId, author: this.opts.author, toolOrigin: this.opts.toolOrigin() })
    rows.delete(cellId)
    this.opts.flush()
    return true
  }

  // ── headless actions and exports ─────────────────────────────────────────

  async actionProgress(message: string, fraction: number | null): Promise<boolean> {
    const cb = this.opts.headless?.()?.progress
    if (!cb) return false
    cb(message, fraction)
    return true
  }

  async actionDone(message: string | null, ok: boolean): Promise<boolean> {
    const cb = this.opts.headless?.()?.done
    if (!cb) return false
    cb(message, ok)
    return true
  }

  async importChoices(choices: { value: string; label: string }[]): Promise<boolean> {
    const cb = this.opts.headless?.()?.choices
    if (!cb) return false
    cb(choices)
    return true
  }

  async exportDeliver(files: ToolDeliveredFile[]): Promise<boolean> {
    const cb = this.opts.headless?.()?.deliver
    if (!cb) return false
    cb(files)
    return true
  }
}
