/**
 * Snapshot ingester. Bulk-loads the JSONL stream returned from
 * `GET /projects/:id/snapshot` into the local store atomically.
 * See docs/DATA_PERSISTENCE_PLAN.md §8.3.
 *
 * Stream format: one JSON object per line.
 *   line 1: {"type":"snapshot_meta","snapshot_seq":N,"project_id":"...","generated_at":...}
 *   line 2..N: {"type":"project_meta"|"library_doc"|"library_version"|"cell"|"commit", ...}
 * Blank lines are tolerated.
 */

import type { LocalStore } from "./db"
import { upsertCell, type CellRow } from "./cells"
import { upsertProjectMeta, type ProjectMetaRow } from "./project-meta"

export interface SnapshotIngestResult {
  snapshotSeq: number
  projectId: string
  counts: {
    cells: number
    commits: number
    library_docs: number
    library_versions: number
  }
}

interface SnapshotMetaRecord {
  type: "snapshot_meta"
  snapshot_seq: number
  project_id: string
  generated_at: number
}

export async function ingestSnapshot(
  store: LocalStore,
  source: AsyncIterable<string>,
): Promise<SnapshotIngestResult> {
  const iter = source[Symbol.asyncIterator]()

  const header = await readHeader(iter)
  const snapshotSeq = header.snapshot_seq
  const projectId = header.project_id
  const counts = { cells: 0, commits: 0, library_docs: 0, library_versions: 0 }

  await store.transaction(async () => {
    for (let next = await iter.next(); !next.done; next = await iter.next()) {
      const line = next.value.trim()
      if (!line) continue
      const parsed = JSON.parse(line) as { type: string } & Record<
        string,
        unknown
      >
      await applyRecord(store, parsed, snapshotSeq, counts)
    }
  })

  return { snapshotSeq, projectId, counts }
}

async function readHeader(
  iter: AsyncIterator<string>,
): Promise<SnapshotMetaRecord> {
  for (let next = await iter.next(); !next.done; next = await iter.next()) {
    const line = next.value.trim()
    if (!line) continue
    const parsed = JSON.parse(line) as { type: string } & Record<
      string,
      unknown
    >
    if (parsed.type !== "snapshot_meta") {
      throw new Error(
        `expected snapshot_meta header as first record, got "${parsed.type}"`,
      )
    }
    return parsed as unknown as SnapshotMetaRecord
  }
  throw new Error("empty snapshot stream")
}

async function applyRecord(
  store: LocalStore,
  parsed: { type: string } & Record<string, unknown>,
  snapshotSeq: number,
  counts: SnapshotIngestResult["counts"],
): Promise<void> {
  switch (parsed.type) {
    case "project_meta": {
      const meta: ProjectMetaRow = {
        project_id: parsed.project_id as string,
        org_id: parsed.org_id as string,
        name: parsed.name as string,
        library_doc_id: parsed.library_doc_id as string,
        bound_version_id: parsed.bound_version_id as string,
        source_lang: parsed.source_lang as string,
        target_lang: parsed.target_lang as string,
        last_seq: snapshotSeq,
        snapshot_seq: snapshotSeq,
        loaded_at: Date.now(),
      }
      await upsertProjectMeta(store, meta)
      return
    }
    case "library_doc": {
      await store.run(
        `INSERT OR REPLACE INTO library_documents (
          id, org_id, name, format, usage_kind, source_lang,
          current_version_id, gitlab_origin, created_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          parsed.id,
          parsed.org_id,
          parsed.name,
          parsed.format,
          parsed.usage_kind ?? "source",
          parsed.source_lang,
          parsed.current_version_id ?? null,
          parsed.gitlab_origin ?? null,
          parsed.created_by,
          parsed.created_at,
          parsed.updated_at,
        ],
      )
      counts.library_docs++
      return
    }
    case "library_version": {
      await store.run(
        `INSERT OR REPLACE INTO library_document_versions (
          id, library_doc_id, source_hash, skeleton_hash, parser_version,
          parsed_at, cell_count, source_meta
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          parsed.id,
          parsed.library_doc_id,
          parsed.source_hash,
          parsed.skeleton_hash,
          parsed.parser_version,
          parsed.parsed_at,
          parsed.cell_count,
          parsed.source_meta ?? "{}",
        ],
      )
      counts.library_versions++
      return
    }
    case "cell": {
      const cell: CellRow = {
        id: parsed.id as string,
        project_id: parsed.project_id as string,
        scope_id: parsed.scope_id as string,
        address: parsed.address as string,
        ord: parsed.ord as number,
        kind: (parsed.kind as string) ?? "text",
        parent_cell_id: (parsed.parent_cell_id as string | null) ?? null,
        source_text: parsed.source_text as string,
        source_text_hash: parsed.source_text_hash as string,
        source_version_id: parsed.source_version_id as string,
        translation_text: (parsed.translation_text as string) ?? "",
        tag_dictionary: (parsed.tag_dictionary as string) ?? "{}",
        status: (parsed.status as string) ?? "empty",
        approved_at_version:
          (parsed.approved_at_version as number | null) ?? null,
        locked_by_user_id:
          (parsed.locked_by_user_id as string | null) ?? null,
        version: (parsed.version as number) ?? 0,
        last_edited_by: (parsed.last_edited_by as string | null) ?? null,
        last_edited_at: (parsed.last_edited_at as number | null) ?? null,
        seq: parsed.seq as number,
        created_at: parsed.created_at as number,
        updated_at: parsed.updated_at as number,
        org_id: parsed.org_id as string,
        source_lang: parsed.source_lang as string,
        target_lang: parsed.target_lang as string,
        format_meta: (parsed.format_meta as string) ?? "{}",
      }
      await upsertCell(store, cell)
      counts.cells++
      return
    }
    case "commit": {
      await store.run(
        `INSERT OR REPLACE INTO commits (
          id, project_id, seq, kind, actor_id, message, payload, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          parsed.id,
          parsed.project_id,
          parsed.seq,
          parsed.kind,
          parsed.actor_id,
          parsed.message,
          parsed.payload ?? "{}",
          parsed.created_at,
        ],
      )
      counts.commits++
      return
    }
    default:
      throw new Error(`unknown snapshot record type: ${parsed.type}`)
  }
}
