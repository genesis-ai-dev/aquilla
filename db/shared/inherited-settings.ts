// AQU-1075: copy the settings a downstream asked for when its upstream saves.
//
// The copy runs here, under the link, not under the saver's role on the
// downstream. A maintainer of A who cannot open B still updates B's brief
// when B's link says to. The lane the link consumes is `source_link_lane_id`:
// NULL is the former default lane (every link until AQU-1616's backfill), and
// an id that does not resolve to that upstream's lane copies nothing — the
// same fail-closed rule as the text mirror.
//
// No new column. The choice, the detach, and the knowledge-doc id map live in
// the settings JSON. Lane rows are only read.

import type { AquillaDb } from "../shim/postgres"
import { kbR2Key } from "./knowledge"
import {
  loadProjectSettings,
  updateProjectSettingsShared,
} from "./projects"
import {
  INHERIT_FIELD_IDS,
  INHERIT_FIELD_KEYS,
  INHERITED_FROM_LINK_KEY,
  applyUpstreamSettingsCopy,
  copyReceivedSettings,
  emptyInheritedFromLink,
  inheritChoiceFromRequest,
  isReceiving,
  mergeInheritChoice,
  parseInheritedFromLink,
  sameSetting,
  type InheritFieldId,
  type InheritedFromLink,
} from "../../src/lib/sync/inherited-settings"

export interface InheritedBlobStore {
  get(key: string): Promise<{
    arrayBuffer(): Promise<ArrayBuffer>
    httpMetadata?: { contentType?: string }
  } | null>
  put(
    key: string,
    value: ArrayBuffer | Uint8Array,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<unknown>
  delete(key: string): Promise<unknown>
}

export interface InheritWriteOptions {
  blobs?: InheritedBlobStore | null
  r2KeyPrefix?: string
}

interface LiveLink {
  id: string
  consumes: string | null
  laneId: string | null
}

const MAX_CHAIN = 16

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

/**
 * A target link's stored id must be one of that upstream's target lanes.
 * NULL skips the lookup and means the `legacy_tag = ''` lane, which is what
 * `resolveConsumedLaneTag` returns for an unfilled column — so a chain works
 * before AQU-1616 names the lane and after it does. A source link's stored id
 * is the upstream's source lane; NULL likewise still consumes it. A lane of
 * another project, or a target id on a source link, does not resolve.
 */
export async function consumedLaneResolves(
  db: AquillaDb,
  upstreamProjectId: string,
  consumes: string | null,
  laneId: string | null,
): Promise<boolean> {
  if (consumes === "target") {
    if (!laneId) return true
    const row = await db
      .prepare(
        `SELECT legacy_tag FROM lanes
          WHERE id = ? AND project_id = ? AND role = 'target'`,
      )
      .bind(laneId, upstreamProjectId)
      .first<{ legacy_tag: string | null }>()
    return !!row && row.legacy_tag !== null
  }
  if (!laneId) return true
  const row = await db
    .prepare(
      `SELECT id FROM lanes
        WHERE id = ? AND project_id = ? AND role = 'source'`,
    )
    .bind(laneId, upstreamProjectId)
    .first<{ id: string }>()
  return row != null
}

async function listLiveDownstreams(db: AquillaDb, upstreamProjectId: string): Promise<LiveLink[]> {
  const { results } = await db
    .prepare(
      `SELECT id, source_link_consumes, source_link_lane_id
         FROM projects
        WHERE source_project_id = ? AND source_link_mode = 'live'`,
    )
    .bind(upstreamProjectId)
    .all<{ id: string; source_link_consumes: string | null; source_link_lane_id: string | null }>()
  return results.map((row) => ({
    id: row.id,
    consumes: row.source_link_consumes,
    laneId: row.source_link_lane_id,
  }))
}

async function loadLink(db: AquillaDb, projectId: string): Promise<{
  sourceProjectId: string
  mode: string | null
  consumes: string | null
  laneId: string | null
} | null> {
  const row = await db
    .prepare(
      `SELECT source_project_id, source_link_mode, source_link_consumes, source_link_lane_id
         FROM projects WHERE id = ?`,
    )
    .bind(projectId)
    .first<{
      source_project_id: string | null
      source_link_mode: string | null
      source_link_consumes: string | null
      source_link_lane_id: string | null
    }>()
  if (!row?.source_project_id) return null
  return {
    sourceProjectId: row.source_project_id,
    mode: row.source_link_mode,
    consumes: row.source_link_consumes,
    laneId: row.source_link_lane_id,
  }
}

function detachEditedFields(
  stored: InheritedFromLink | null,
  current: Record<string, unknown>,
  incoming: Record<string, unknown>,
  config: InheritedFromLink,
): InheritedFromLink {
  if (!stored) return config
  const detached = { ...config.detached }
  for (const field of INHERIT_FIELD_IDS) {
    if (!isReceiving(stored, field)) continue
    const edited = INHERIT_FIELD_KEYS[field].some((key) => !sameSetting(current, incoming, key))
    if (edited) detached[field] = true
  }
  return { ...config, detached }
}

/**
 * Fold the inherit choice into the blob about to be written.
 *
 * An omitted `inheritedFromLink` is put back, so a settings save that echoes
 * every other key cannot drop the link's choice. Editing a field that is
 * still arriving detaches it: the edit is the override, and the next upstream
 * save leaves it alone. Turning a field on copies the upstream's value in
 * this same write.
 */
export async function prepareInheritedSettingsWrite(
  db: AquillaDb,
  projectId: string,
  current: Record<string, unknown>,
  incoming: Record<string, unknown>,
): Promise<{ settings: Record<string, unknown>; pullKnowledge: boolean }> {
  const stored = parseInheritedFromLink(current[INHERITED_FROM_LINK_KEY])
  const mentioned = Object.prototype.hasOwnProperty.call(incoming, INHERITED_FROM_LINK_KEY)
  let config: InheritedFromLink | null = stored
  const next: Record<string, unknown> = { ...incoming }

  if (!mentioned) {
    if (stored) next[INHERITED_FROM_LINK_KEY] = stored
  } else if (incoming[INHERITED_FROM_LINK_KEY] == null) {
    delete next[INHERITED_FROM_LINK_KEY]
    config = null
  } else {
    config = mergeInheritChoice(stored, incoming[INHERITED_FROM_LINK_KEY])
    next[INHERITED_FROM_LINK_KEY] = config
  }

  if (config && stored) {
    config = detachEditedFields(stored, current, incoming, config)
    next[INHERITED_FROM_LINK_KEY] = config
  }
  if (!config) return { settings: next, pullKnowledge: false }

  const link = await loadLink(db, projectId)
  if (!link) return { settings: next, pullKnowledge: false }
  if (!(await consumedLaneResolves(db, link.sourceProjectId, link.consumes, link.laneId))) {
    return { settings: next, pullKnowledge: false }
  }

  const keysToPull: string[] = []
  let pullKnowledge = false
  for (const field of INHERIT_FIELD_IDS) {
    const now = isReceiving(config, field)
    const was = stored ? isReceiving(stored, field) : false
    if (!now || was) continue
    if (field === "knowledgeDocs") pullKnowledge = true
    else keysToPull.push(...INHERIT_FIELD_KEYS[field])
  }
  if (keysToPull.length === 0) return { settings: next, pullKnowledge }

  const upstream = await loadProjectSettings(db, link.sourceProjectId)
  for (const key of keysToPull) {
    if (Object.prototype.hasOwnProperty.call(upstream.settings, key)) next[key] = upstream.settings[key]
    else delete next[key]
  }
  return { settings: next, pullKnowledge }
}

async function writeDownstreamSettings(
  db: AquillaDb,
  projectId: string,
  settings: Record<string, unknown>,
  updatedBy: number | string,
): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const current = await loadProjectSettings(db, projectId)
    const result = await updateProjectSettingsShared(db, {
      projectId,
      settings,
      ifMatchVersion: current.version,
      updatedBy,
      inheritPropagation: true,
    })
    if (result.status === "ok") return true
    if (result.status !== "conflict") return false
  }
  return false
}

/**
 * Push keys that changed on `upstreamProjectId` to every live downstream
 * whose link still resolves, then to theirs. A detached field is not written,
 * so the chain below that project does not move for that field either.
 */
export async function propagateInheritedSettings(
  db: AquillaDb,
  input: {
    upstreamProjectId: string
    before: Record<string, unknown>
    after: Record<string, unknown>
    updatedBy: number | string
    visited?: Set<string>
  },
): Promise<{ projectId: string; version: number }[]> {
  const visited = input.visited ?? new Set<string>()
  if (visited.has(input.upstreamProjectId) || visited.size >= MAX_CHAIN) return []
  visited.add(input.upstreamProjectId)

  const downstreams = await listLiveDownstreams(db, input.upstreamProjectId)
  const wrote: { projectId: string; version: number }[] = []
  for (const link of downstreams) {
    if (visited.has(link.id)) continue
    if (!(await consumedLaneResolves(db, input.upstreamProjectId, link.consumes, link.laneId))) {
      continue
    }
    const current = await loadProjectSettings(db, link.id)
    const patched = applyUpstreamSettingsCopy(input.before, input.after, current.settings)
    if (!patched) continue
    const ok = await writeDownstreamSettings(db, link.id, patched, input.updatedBy)
    if (!ok) continue
    const fresh = await loadProjectSettings(db, link.id)
    wrote.push({ projectId: link.id, version: fresh.version })
    const further = await propagateInheritedSettings(db, {
      upstreamProjectId: link.id,
      before: current.settings,
      after: fresh.settings,
      updatedBy: input.updatedBy,
      visited,
    })
    wrote.push(...further)
  }
  return wrote
}

interface OwnedDoc {
  id: string
  name: string
  content_type: string | null
  size_bytes: number
  sha256: string
  r2_key: string
  extracted_text: string
  doc_summary: string | null
  index_status: string
  index_tree: unknown
  created_by: string
}

async function listOwnedDocs(db: AquillaDb, projectId: string): Promise<OwnedDoc[]> {
  const { results } = await db
    .prepare(
      `SELECT id, name, content_type, size_bytes, sha256, r2_key, extracted_text,
              doc_summary, index_status, index_tree, created_by
         FROM knowledge_docs
        WHERE project_id = ?
        ORDER BY created_at ASC`,
    )
    .bind(projectId)
    .all<OwnedDoc>()
  return results
}

function treeJson(tree: unknown): string | null {
  if (tree == null) return null
  return typeof tree === "string" ? tree : JSON.stringify(tree)
}

async function copyBlob(
  blobs: InheritedBlobStore | null | undefined,
  fromKey: string,
  toKey: string,
): Promise<void> {
  if (!blobs || fromKey === toKey) return
  const obj = await blobs.get(fromKey)
  if (!obj) return
  const bytes = await obj.arrayBuffer()
  await blobs.put(toKey, bytes, {
    httpMetadata: obj.httpMetadata?.contentType
      ? { contentType: obj.httpMetadata.contentType }
      : undefined,
  })
}

/** Replace this project's copies of the upstream's knowledge documents. */
async function syncKnowledgeDocs(
  db: AquillaDb,
  upstreamProjectId: string,
  downstreamProjectId: string,
  updatedBy: number | string,
  opts: InheritWriteOptions,
): Promise<void> {
  const current = await loadProjectSettings(db, downstreamProjectId)
  const config = parseInheritedFromLink(current.settings[INHERITED_FROM_LINK_KEY])
  if (!config || !isReceiving(config, "knowledgeDocs")) return

  const upstreamDocs = await listOwnedDocs(db, upstreamProjectId)
  const copies = { ...(config.knowledgeDocCopies ?? {}) }
  const seen = new Set<string>()

  for (const doc of upstreamDocs) {
    seen.add(doc.id)
    const existingId = copies[doc.id]
    const tree = treeJson(doc.index_tree)
    if (existingId) {
      await db
        .prepare(
          `UPDATE knowledge_docs
              SET name = ?, content_type = ?, size_bytes = ?, sha256 = ?,
                  extracted_text = ?, doc_summary = ?, index_status = ?,
                  index_tree = ?::jsonb, updated_at = now()
            WHERE id = ? AND project_id = ?`,
        )
        .bind(
          doc.name,
          doc.content_type,
          doc.size_bytes,
          doc.sha256,
          doc.extracted_text,
          doc.doc_summary,
          doc.index_status,
          tree,
          existingId,
          downstreamProjectId,
        )
        .run()
      const row = await db
        .prepare(`SELECT r2_key FROM knowledge_docs WHERE id = ? AND project_id = ?`)
        .bind(existingId, downstreamProjectId)
        .first<{ r2_key: string }>()
      if (row) await copyBlob(opts.blobs, doc.r2_key, row.r2_key)
      continue
    }
    const id = crypto.randomUUID()
    const r2Key = kbR2Key(opts.r2KeyPrefix, { projectId: downstreamProjectId }, id)
    await copyBlob(opts.blobs, doc.r2_key, r2Key)
    await db
      .prepare(
        `INSERT INTO knowledge_docs
           (id, org_id, project_id, name, content_type, size_bytes, sha256, r2_key,
            extracted_text, doc_summary, index_status, index_tree, created_by)
         VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?)`,
      )
      .bind(
        id,
        downstreamProjectId,
        doc.name,
        doc.content_type,
        doc.size_bytes,
        doc.sha256,
        r2Key,
        doc.extracted_text,
        doc.doc_summary,
        doc.index_status,
        tree,
        doc.created_by,
      )
      .run()
    copies[doc.id] = id
  }

  for (const [upstreamId, downstreamId] of Object.entries(copies)) {
    if (seen.has(upstreamId)) continue
    const removed = await db
      .prepare(`DELETE FROM knowledge_docs WHERE id = ? AND project_id = ? RETURNING r2_key`)
      .bind(downstreamId, downstreamProjectId)
      .first<{ r2_key: string }>()
    if (removed && opts.blobs) await opts.blobs.delete(removed.r2_key).catch(() => {})
    delete copies[upstreamId]
  }

  const nextConfig: InheritedFromLink = {
    ...config,
    ...(Object.keys(copies).length > 0 ? { knowledgeDocCopies: copies } : { knowledgeDocCopies: undefined }),
  }
  if (!nextConfig.knowledgeDocCopies) delete nextConfig.knowledgeDocCopies
  const settings = { ...current.settings, [INHERITED_FROM_LINK_KEY]: nextConfig }
  await writeDownstreamSettings(db, downstreamProjectId, settings, updatedBy)
}

export async function propagateKnowledgeDocs(
  db: AquillaDb,
  upstreamProjectId: string,
  opts: InheritWriteOptions & { updatedBy: number | string; visited?: Set<string> },
): Promise<void> {
  const visited = opts.visited ?? new Set<string>()
  if (visited.has(upstreamProjectId) || visited.size >= MAX_CHAIN) return
  visited.add(upstreamProjectId)
  const downstreams = await listLiveDownstreams(db, upstreamProjectId)
  for (const link of downstreams) {
    if (!(await consumedLaneResolves(db, upstreamProjectId, link.consumes, link.laneId))) continue
    await syncKnowledgeDocs(db, upstreamProjectId, link.id, opts.updatedBy, opts)
    await propagateKnowledgeDocs(db, link.id, { ...opts, visited })
  }
}

async function pullKnowledgeFromUpstream(
  db: AquillaDb,
  projectId: string,
  updatedBy: number | string,
  opts: InheritWriteOptions,
): Promise<void> {
  const link = await loadLink(db, projectId)
  if (!link) return
  if (!(await consumedLaneResolves(db, link.sourceProjectId, link.consumes, link.laneId))) return
  await syncKnowledgeDocs(db, link.sourceProjectId, projectId, updatedBy, opts)
  if (link.mode === "live") {
    await propagateKnowledgeDocs(db, projectId, { ...opts, updatedBy })
  }
}

/**
 * One-time copy when a link is saved. Live links keep receiving later saves;
 * a clone keeps this snapshot and is not in the live downstream list.
 */
export async function seedInheritedSettings(
  db: AquillaDb,
  input: {
    downstreamProjectId: string
    upstreamProjectId: string
    choice?: Partial<Record<InheritFieldId, boolean>> | null
    updatedBy: number | string
  } & InheritWriteOptions,
): Promise<void> {
  const current = await loadProjectSettings(db, input.downstreamProjectId)
  const upstream = await loadProjectSettings(db, input.upstreamProjectId)
  const config = emptyInheritedFromLink(inheritChoiceFromRequest(input.choice))
  const settings = copyReceivedSettings(upstream.settings, current.settings, config)
  const ok = await writeDownstreamSettings(db, input.downstreamProjectId, settings, input.updatedBy)
  if (!ok) return
  if (isReceiving(config, "knowledgeDocs")) {
    await syncKnowledgeDocs(db, input.upstreamProjectId, input.downstreamProjectId, input.updatedBy, input)
  }
  const fresh = await loadProjectSettings(db, input.downstreamProjectId)
  await propagateInheritedSettings(db, {
    upstreamProjectId: input.downstreamProjectId,
    before: current.settings,
    after: fresh.settings,
    updatedBy: input.updatedBy,
  })
  if (isReceiving(config, "knowledgeDocs")) {
    await propagateKnowledgeDocs(db, input.downstreamProjectId, {
      ...input,
      updatedBy: input.updatedBy,
    })
  }
}

/** Drop the choice when the link itself is detached. Copied values stay. */
export async function clearInheritedSettings(
  db: AquillaDb,
  projectId: string,
  updatedBy: number | string,
): Promise<void> {
  const current = await loadProjectSettings(db, projectId)
  if (!isRecord(current.settings[INHERITED_FROM_LINK_KEY]) && current.settings[INHERITED_FROM_LINK_KEY] == null) {
    return
  }
  const settings = { ...current.settings }
  delete settings[INHERITED_FROM_LINK_KEY]
  await writeDownstreamSettings(db, projectId, settings, updatedBy)
}

export async function afterInheritedSettingsWrite(
  db: AquillaDb,
  input: {
    projectId: string
    before: Record<string, unknown>
    after: Record<string, unknown>
    updatedBy: number | string
    pullKnowledge: boolean
  } & InheritWriteOptions,
): Promise<{ projectId: string; version: number }[]> {
  if (input.pullKnowledge) {
    await pullKnowledgeFromUpstream(db, input.projectId, input.updatedBy, input)
  }
  return propagateInheritedSettings(db, {
    upstreamProjectId: input.projectId,
    before: input.before,
    after: input.after,
    updatedBy: input.updatedBy,
  })
}
