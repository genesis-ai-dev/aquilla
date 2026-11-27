// AQU-2459 Phase B: Shared pure-virtual source cell store.
//
// Used by BOTH `sync-worker` and `auth-worker` (both bind `AQUILLA_PG` and
// `SNAPSHOTS` R2 in every environment) so every reader sees the exact same
// virtual source rows without duplicating manifest loading or overlay merging.
//
// Invariant:
//   - A file with `files.source_virtual = TRUE` writes ZERO `side = 'source'`
//     rows into Postgres `cells` at import time. Its canonical source units live
//     in R2 at `file_revisions.manifest_r2_key` for `files.head_revision_n`.
//   - If a user manually edits, hides, moves, deletes, or transcribes a source
//     cell after import, that single cell lands as a sparse `side = 'source'`
//     overlay row in Postgres `cells`. On read, sparse overlays override the
//     matching manifest unit (and any manually inserted cell appends in anchor
//     order). On the next revision, overlays are folded into the new manifest
//     and cleared from `cells`.
//   - R2 manifest keys include `(projectId, fileId, revisionN)` and are
//     immutable once written, so an isolate-level LRU cache keyed by
//     `manifest_r2_key` can never serve stale data.

import type { AquillaDb } from "../shim/postgres"
import { contentHashOf, type StoredRevisionManifest, type StoredRevisionUnit } from "./file-revision"

/** Minimal R2 bucket surface needed to read manifests (matches CF R2Bucket + test fakes). */
export interface ManifestR2Bucket {
  get(key: string): Promise<{ text(): Promise<string> } | null>
}

export interface VirtualFileHead {
  readonly projectId: string
  readonly fileId: string
  readonly headRevisionN: number
  readonly manifestR2Key: string
  readonly revisionEventId: string
  readonly author: string
  readonly createdAt: number
}

/**
 * Canonical source-cell row shape compatible with Postgres `cells` readers across
 * `sync-worker` and `auth-worker`, plus the 122-bit `revision_content_hash`.
 */
export interface VirtualSourceRow {
  readonly project_id: string
  readonly file_id: string
  readonly cell_id: string
  readonly side: "source"
  readonly target_lang: ""
  readonly value: string
  readonly value_html: string | null
  readonly type: string | null
  readonly canonical_ref: string | null
  readonly anchor_cell_id: string | null
  readonly event_id: string
  readonly source_event_id: null
  readonly last_editor: string | null
  readonly last_edit_at: number
  readonly validated: 0
  readonly ai_drafted: 0
  readonly ai_draft: null
  readonly word_count: number
  /** 32-bit djb2 hash matching `event-projection.ts::contentHash`. */
  readonly content_hash: string
  /** 122-bit normalized source content hash (`file-revision.ts::contentHashOf`). */
  readonly revision_content_hash: string
  readonly endorsement_count: 0
  readonly start_ms: number | null
  readonly end_ms: number | null
  readonly medium: string | null
  readonly sequence_index: number | null
  readonly transcription: string | null
  readonly camera_state: string | null
  readonly metadata: Record<string, unknown> | null
  readonly lane_id: string | null
  readonly hidden_at: number | null
  readonly tombstoned_at: number | null
  readonly upstream_event_id: string | null
  readonly upstream_seq: number | null
  readonly upstream_cell_id: string | null
  readonly source_location: string | null
}

/** Raw Postgres sparse source overlay row. */
interface SparseSourceOverlayRow {
  cell_id: string
  value: string
  value_html: string | null
  type: string | null
  canonical_ref: string | null
  anchor_cell_id: string | null
  event_id: string
  last_editor: string | null
  last_edit_at: number | string
  word_count: number | string
  content_hash: string | null
  start_ms: number | string | null
  end_ms: number | string | null
  medium: string | null
  sequence_index: number | string | null
  transcription: string | null
  camera_state: string | null
  metadata: Record<string, unknown> | string | null
  lane_id: string | null
  hidden_at: number | string | null
  tombstoned_at: number | string | null
  upstream_event_id: string | null
  upstream_seq: number | string | null
  upstream_cell_id: string | null
  source_location: string | null
}

// ---------------------------------------------------------------------------
// Isolate-level immutable manifest LRU cache
// ---------------------------------------------------------------------------

const MANIFEST_CACHE_MAX_ENTRIES = 64
const MANIFEST_CACHE_MAX_UNITS = 250_000

const manifestCache = new Map<string, StoredRevisionManifest>()
let manifestCacheTotalUnits = 0

export function resetVirtualSourceCacheForTests(): void {
  manifestCache.clear()
  manifestCacheTotalUnits = 0
}

function manifestCacheDelete(key: string): void {
  const existing = manifestCache.get(key)
  if (!existing) return
  manifestCache.delete(key)
  manifestCacheTotalUnits -= existing.units.length + (existing.tombstonedUnits?.length ?? 0)
}

function manifestCacheGet(key: string): StoredRevisionManifest | null {
  const existing = manifestCache.get(key)
  if (!existing) return null
  // Refresh LRU recency.
  manifestCache.delete(key)
  manifestCache.set(key, existing)
  return existing
}

export function cacheVirtualManifest(key: string, manifest: StoredRevisionManifest): void {
  const size = manifest.units.length + (manifest.tombstonedUnits?.length ?? 0)
  manifestCacheDelete(key)
  if (size > MANIFEST_CACHE_MAX_UNITS) return
  manifestCache.set(key, manifest)
  manifestCacheTotalUnits += size
  while (
    manifestCache.size > MANIFEST_CACHE_MAX_ENTRIES ||
    manifestCacheTotalUnits > MANIFEST_CACHE_MAX_UNITS
  ) {
    const oldest = manifestCache.keys().next().value
    if (oldest === undefined) break
    manifestCacheDelete(oldest)
  }
}

export async function loadVirtualManifest(
  r2: ManifestR2Bucket,
  manifestR2Key: string,
): Promise<StoredRevisionManifest | null> {
  const hit = manifestCacheGet(manifestR2Key)
  if (hit) return hit
  const obj = await r2.get(manifestR2Key)
  if (!obj) return null
  const parsed = JSON.parse(await obj.text()) as StoredRevisionManifest
  cacheVirtualManifest(manifestR2Key, parsed)
  return parsed
}

// ---------------------------------------------------------------------------
// Helpers matching event-projection.ts
// ---------------------------------------------------------------------------

/** Identical to `event-projection.ts::contentHash` (32-bit djb2 hex). */
export function djb2ContentHash(text: string): string {
  let hash = 5381
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) >>> 0
  }
  return hash.toString(16).padStart(8, "0")
}

/** Identical to `event-projection.ts::countWords`. */
export function countSourceWords(text: string): number {
  const trimmed = text.trim()
  if (!trimmed) return 0
  return trimmed.split(/\s+/).length
}

function parseMeta(raw: Record<string, unknown> | string | null | undefined): Record<string, unknown> | null {
  if (raw == null) return null
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as unknown
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null
    } catch {
      return null
    }
  }
  return { ...raw }
}

function numOrNull(v: number | string | null | undefined): number | null {
  if (v == null) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function isUndefinedColumnErr(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /column .*source_virtual.* does not exist/i.test(msg)
}

// ---------------------------------------------------------------------------
// Database head lookups
// ---------------------------------------------------------------------------

/**
 * Look up a single file's virtual head metadata. Returns null when the file
 * does not exist, is not virtual (`source_virtual = FALSE`), or has no head
 * revision row yet. Safe on databases predating migration 0213.
 */
export async function getVirtualFileHead(
  db: AquillaDb,
  projectId: string,
  fileId: string,
): Promise<VirtualFileHead | null> {
  try {
    const row = await db
      .prepare(
        `SELECT f.id AS file_id, f.head_revision_n, r.manifest_r2_key, r.event_id, r.author, r.created_at
         FROM files f
         JOIN file_revisions r
           ON r.project_id = f.project_id
          AND r.file_id = f.id
          AND r.revision_n = f.head_revision_n
         WHERE f.project_id = ? AND f.id = ? AND f.source_virtual = TRUE`,
      )
      .bind(projectId, fileId)
      .first<{
        file_id: string
        head_revision_n: number | string
        manifest_r2_key: string
        event_id: string
        author: string
        created_at: number | string
      }>()
    if (!row) return null
    return {
      projectId,
      fileId: row.file_id,
      headRevisionN: Number(row.head_revision_n),
      manifestR2Key: row.manifest_r2_key,
      revisionEventId: row.event_id,
      author: row.author,
      createdAt: Number(row.created_at),
    }
  } catch (err) {
    if (isUndefinedColumnErr(err)) return null
    throw err
  }
}

/**
 * Look up all virtual files in a project (or a specific fileId subset).
 * Excludes soft-deleted files unless `includeDeleted` is true.
 */
export async function getProjectVirtualFileHeads(
  db: AquillaDb,
  projectId: string,
  opts?: { fileIds?: readonly string[]; includeDeleted?: boolean },
): Promise<VirtualFileHead[]> {
  try {
    const parts = [
      `SELECT f.id AS file_id, f.head_revision_n, r.manifest_r2_key, r.event_id, r.author, r.created_at
       FROM files f
       JOIN file_revisions r
         ON r.project_id = f.project_id
        AND r.file_id = f.id
        AND r.revision_n = f.head_revision_n
       WHERE f.project_id = ? AND f.source_virtual = TRUE`,
    ]
    const binds: unknown[] = [projectId]
    if (!opts?.includeDeleted) {
      parts.push("AND f.deleted_at IS NULL")
    }
    if (opts?.fileIds && opts.fileIds.length > 0) {
      const ph = opts.fileIds.map(() => "?").join(", ")
      parts.push(`AND f.id IN (${ph})`)
      binds.push(...opts.fileIds)
    }
    const { results } = await db
      .prepare(parts.join(" "))
      .bind(...binds)
      .all<{
        file_id: string
        head_revision_n: number | string
        manifest_r2_key: string
        event_id: string
        author: string
        created_at: number | string
      }>()
    return (results ?? []).map((row) => ({
      projectId,
      fileId: row.file_id,
      headRevisionN: Number(row.head_revision_n),
      manifestR2Key: row.manifest_r2_key,
      revisionEventId: row.event_id,
      author: row.author,
      createdAt: Number(row.created_at),
    }))
  } catch (err) {
    if (isUndefinedColumnErr(err)) return []
    throw err
  }
}

// ---------------------------------------------------------------------------
// Manifest → VirtualSourceRow conversion & sparse overlay merge
// ---------------------------------------------------------------------------

/** Build a VirtualSourceRow from one manifest unit. */
export function manifestUnitToSourceRow(
  head: VirtualFileHead,
  unit: StoredRevisionUnit,
  anchorCellId: string | null,
  sourceLaneId: string | null,
): VirtualSourceRow {
  let metadata = unit.metadata ? { ...unit.metadata } : null
  if (unit.paragraphStart && !(metadata && metadata.paragraphStart === true)) {
    metadata = { ...(metadata ?? {}), paragraphStart: true }
  }
  return {
    project_id: head.projectId,
    file_id: head.fileId,
    cell_id: unit.cellId,
    side: "source",
    target_lang: "",
    value: unit.text,
    value_html: unit.html ?? null,
    type: unit.type ?? null,
    canonical_ref: unit.canonicalRef ?? null,
    anchor_cell_id: anchorCellId,
    event_id: unit.eventId,
    source_event_id: null,
    last_editor: head.author,
    last_edit_at: head.createdAt,
    validated: 0,
    ai_drafted: 0,
    ai_draft: null,
    word_count: countSourceWords(unit.text),
    content_hash: djb2ContentHash(unit.text),
    revision_content_hash: unit.contentHash || contentHashOf(unit.text),
    endorsement_count: 0,
    start_ms: unit.startMs ?? null,
    end_ms: unit.endMs ?? null,
    medium: unit.medium ?? null,
    sequence_index: unit.sequenceIndex,
    transcription: unit.transcription ?? null,
    camera_state: null,
    metadata,
    lane_id: sourceLaneId,
    hidden_at: null,
    tombstoned_at: unit.tombstonedAt ?? null,
    upstream_event_id: null,
    upstream_seq: null,
    upstream_cell_id: null,
    source_location: null,
  }
}

function overlayToSourceRow(
  projectId: string,
  fileId: string,
  overlay: SparseSourceOverlayRow,
  base?: VirtualSourceRow,
): VirtualSourceRow {
  return {
    project_id: projectId,
    file_id: fileId,
    cell_id: overlay.cell_id,
    side: "source",
    target_lang: "",
    value: overlay.value,
    value_html: overlay.value_html,
    type: overlay.type,
    canonical_ref: overlay.canonical_ref,
    anchor_cell_id: overlay.anchor_cell_id,
    event_id: overlay.event_id,
    source_event_id: null,
    last_editor: overlay.last_editor,
    last_edit_at: Number(overlay.last_edit_at),
    validated: 0,
    ai_drafted: 0,
    ai_draft: null,
    word_count: Number(overlay.word_count),
    content_hash: overlay.content_hash ?? djb2ContentHash(overlay.value),
    revision_content_hash: contentHashOf(overlay.value),
    endorsement_count: 0,
    start_ms: numOrNull(overlay.start_ms),
    end_ms: numOrNull(overlay.end_ms),
    medium: overlay.medium,
    sequence_index: numOrNull(overlay.sequence_index) ?? base?.sequence_index ?? null,
    transcription: overlay.transcription,
    camera_state: overlay.camera_state,
    metadata: parseMeta(overlay.metadata),
    lane_id: overlay.lane_id ?? base?.lane_id ?? null,
    hidden_at: numOrNull(overlay.hidden_at),
    tombstoned_at: numOrNull(overlay.tombstoned_at),
    upstream_event_id: overlay.upstream_event_id,
    upstream_seq: numOrNull(overlay.upstream_seq),
    upstream_cell_id: overlay.upstream_cell_id,
    source_location: overlay.source_location,
  }
}

const SPARSE_OVERLAY_COLUMNS = `
  cell_id, value, value_html, type, canonical_ref, anchor_cell_id,
  event_id, last_editor, last_edit_at, word_count, content_hash,
  start_ms, end_ms, medium, sequence_index, transcription, camera_state,
  metadata, lane_id, hidden_at, tombstoned_at, upstream_event_id,
  upstream_seq, upstream_cell_id, source_location
`

export interface LoadedVirtualFile {
  readonly head: VirtualFileHead
  readonly manifest: StoredRevisionManifest
  /** Live + hidden units in document order (excludes tombstoned unless `includeTombstoned`). */
  readonly rows: VirtualSourceRow[]
  /** Tombstoned units from prior revisions (for orphan review & stale-source). */
  readonly tombstonedRows: VirtualSourceRow[]
  /** Fast O(1) lookup of live + hidden source rows by cellId. */
  readonly byCellId: Map<string, VirtualSourceRow>
  /** True when at least one sparse Postgres overlay row existed for this file. */
  readonly hasSparseOverlays: boolean
}

/**
 * Load a virtual file's full source rows: cached R2 manifest merged with any
 * sparse `side = 'source'` overlay rows in Postgres `cells`.
 *
 * Returns null if the file is not virtual or its manifest is missing.
 */
export async function loadVirtualSourceFile(
  db: AquillaDb,
  r2: ManifestR2Bucket,
  projectId: string,
  fileId: string,
  opts?: {
    head?: VirtualFileHead
    manifest?: StoredRevisionManifest
    /** Skip querying Postgres for sparse overlays (e.g. brand-new fresh import). */
    skipSparseOverlays?: boolean
  },
): Promise<LoadedVirtualFile | null> {
  const head = opts?.head ?? (await getVirtualFileHead(db, projectId, fileId))
  if (!head) return null
  const manifest = opts?.manifest ?? (await loadVirtualManifest(r2, head.manifestR2Key))
  if (!manifest) return null

  // Resolve source lane id once (usually 1 row) + sparse source overlays (0 rows for unedited virtual files).
  const [sourceLaneRow, overlaysRes] = await Promise.all([
    db
      .prepare(`SELECT id FROM lanes WHERE project_id = ? AND role = 'source' LIMIT 1`)
      .bind(projectId)
      .first<{ id: string }>(),
    opts?.skipSparseOverlays
      ? Promise.resolve({ results: [] as SparseSourceOverlayRow[] })
      : db
          .prepare(
            `SELECT ${SPARSE_OVERLAY_COLUMNS}
             FROM cells
             WHERE project_id = ? AND file_id = ? AND side = 'source'`,
          )
          .bind(projectId, fileId)
          .all<SparseSourceOverlayRow>(),
  ])

  const sourceLaneId = sourceLaneRow?.id ?? null
  const overlays = overlaysRes.results ?? []
  const overlayByCellId = new Map<string, SparseSourceOverlayRow>()
  for (const ov of overlays) overlayByCellId.set(ov.cell_id, ov)

  const rows: VirtualSourceRow[] = []
  const tombstonedRows: VirtualSourceRow[] = []
  const byCellId = new Map<string, VirtualSourceRow>()
  const seenManifestIds = new Set<string>()

  let prevCellId: string | null = null
  for (const unit of manifest.units) {
    seenManifestIds.add(unit.cellId)
    const base = manifestUnitToSourceRow(head, unit, prevCellId, sourceLaneId)
    const ov = overlayByCellId.get(unit.cellId)
    const merged = ov ? overlayToSourceRow(projectId, fileId, ov, base) : base
    if (merged.tombstoned_at != null) {
      tombstonedRows.push(merged)
    } else {
      rows.push(merged)
      byCellId.set(merged.cell_id, merged)
      prevCellId = merged.cell_id
    }
  }

  for (const unit of manifest.tombstonedUnits ?? []) {
    if (seenManifestIds.has(unit.cellId)) continue
    seenManifestIds.add(unit.cellId)
    const base = manifestUnitToSourceRow(
      head,
      { ...unit, tombstonedAt: unit.tombstonedAt ?? head.createdAt },
      null,
      sourceLaneId,
    )
    const ov = overlayByCellId.get(unit.cellId)
    const merged = ov ? overlayToSourceRow(projectId, fileId, ov, base) : base
    if (merged.tombstoned_at != null) {
      tombstonedRows.push(merged)
    } else {
      rows.push(merged)
      byCellId.set(merged.cell_id, merged)
    }
  }

  // Any sparse source rows NOT in the manifest (e.g. a user manually inserted a
  // new cell via `source.cell.create` after import): splice after their anchor.
  const extras: VirtualSourceRow[] = []
  for (const ov of overlays) {
    if (seenManifestIds.has(ov.cell_id)) continue
    const extra = overlayToSourceRow(projectId, fileId, ov)
    if (extra.tombstoned_at != null) {
      tombstonedRows.push(extra)
    } else {
      extras.push(extra)
    }
  }
  if (extras.length > 0) {
    // Insert extras right after their anchor (or at the tail if anchor not found).
    for (const extra of extras) {
      const anchorIdx = extra.anchor_cell_id
        ? rows.findIndex((r) => r.cell_id === extra.anchor_cell_id)
        : -1
      if (anchorIdx >= 0) {
        rows.splice(anchorIdx + 1, 0, extra)
      } else if (extra.anchor_cell_id === null) {
        rows.unshift(extra)
      } else {
        rows.push(extra)
      }
      byCellId.set(extra.cell_id, extra)
    }
  }

  return {
    head,
    manifest,
    rows,
    tombstonedRows,
    byCellId,
    hasSparseOverlays: overlays.length > 0,
  }
}

/**
 * Load all virtual files in a project in parallel. Files whose R2 manifest
 * cannot be read are skipped (never crashes a project-wide search).
 */
export async function loadProjectVirtualSourceFiles(
  db: AquillaDb,
  r2: ManifestR2Bucket,
  projectId: string,
  opts?: { fileIds?: readonly string[]; includeDeleted?: boolean },
): Promise<LoadedVirtualFile[]> {
  const heads = await getProjectVirtualFileHeads(db, projectId, opts)
  if (!heads || heads.length === 0) return []
  const loaded = await Promise.all(
    heads.map((head) => loadVirtualSourceFile(db, r2, projectId, head.fileId, { head })),
  )
  return loaded.filter((f): f is LoadedVirtualFile => f !== null)
}

/**
 * Resolve source cell chain heads (`event_id`) for a set of `(projectId, fileId, cellId)`
 * tuples when those files are virtual. Used by `events/route.ts::prefetchCellHeads`
 * so `target.cell.commit` and `source.cell.*` writes against virtual cells pass
 * AD-2 / AQU-1068 head validation without source rows in Postgres `cells`.
 */
export async function loadVirtualSourceCellHeads(
  db: AquillaDb,
  r2: ManifestR2Bucket,
  cells: ReadonlyArray<{ projectId: string; fileId: string; cellId: string }>,
): Promise<Map<string, { eventId: string; unit: StoredRevisionUnit; head: VirtualFileHead; anchorCellId: string | null }>> {
  const out = new Map<
    string,
    { eventId: string; unit: StoredRevisionUnit; head: VirtualFileHead; anchorCellId: string | null }
  >()
  if (cells.length === 0) return out

  const byFile = new Map<string, { projectId: string; fileId: string; cellIds: Set<string> }>()
  for (const c of cells) {
    const key = `${c.projectId}\0${c.fileId}`
    let entry = byFile.get(key)
    if (!entry) {
      entry = { projectId: c.projectId, fileId: c.fileId, cellIds: new Set() }
      byFile.set(key, entry)
    }
    entry.cellIds.add(c.cellId)
  }

  await Promise.all(
    [...byFile.values()].map(async ({ projectId, fileId, cellIds }) => {
      const head = await getVirtualFileHead(db, projectId, fileId)
      if (!head) return
      const manifest = await loadVirtualManifest(r2, head.manifestR2Key)
      if (!manifest) return
      let prevId: string | null = null
      for (const unit of manifest.units) {
        if (cellIds.has(unit.cellId)) {
          out.set(`${projectId}\0${fileId}\0${unit.cellId}`, {
            eventId: unit.eventId,
            unit,
            head,
            anchorCellId: prevId,
          })
        }
        prevId = unit.cellId
      }
      for (const unit of manifest.tombstonedUnits ?? []) {
        if (cellIds.has(unit.cellId) && !out.has(`${projectId}\0${fileId}\0${unit.cellId}`)) {
          out.set(`${projectId}\0${fileId}\0${unit.cellId}`, {
            eventId: unit.eventId,
            unit,
            head,
            anchorCellId: null,
          })
        }
      }
    }),
  )

  return out
}
