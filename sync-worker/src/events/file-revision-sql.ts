// AQU-2459: the `file_revisions` index row and the file head, as SQL.
//
// Kept apart from file-revision-apply.ts on purpose: event-projection.ts
// imports THIS module for its `file.revision` case, and the apply module
// imports event-projection for the bulk cells upsert. Putting both here would
// make a cycle. Nothing in this file touches `cells`.

import type { AquillaDb, AquillaStatement } from '../../../db/shim/postgres'
import type { EventPayloads } from './types'

/** Where a revision's manifest lives. `prefix` is `r2KeyPrefix(env)`. */
export function revisionManifestKey(prefix: string, projectId: string, fileId: string, revisionN: number): string {
  return `${prefix}revisions/${projectId}/${fileId}/${revisionN}.json`
}

/**
 * Upsert the index row and advance the head. Replay-safe: the same event
 * replayed writes the same row, and the head only ever moves forward.
 */
export function buildFileRevisionIndexStmts(
  db: AquillaDb,
  projectId: string,
  fileId: string,
  eventId: string,
  author: string,
  serverTs: number,
  p: EventPayloads['file.revision'],
): AquillaStatement[] {
  return [
    db
      .prepare(
        `INSERT INTO file_revisions (
           project_id, file_id, revision_n, parent_revision_n, artifact_sha256, filter_stamp, options_hash,
           manifest_r2_key, unit_count, inserted_count, changed_count, moved_count, deleted_count,
           origin, event_id, author, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (project_id, file_id, revision_n) DO UPDATE SET
           parent_revision_n = excluded.parent_revision_n,
           artifact_sha256 = excluded.artifact_sha256,
           filter_stamp = excluded.filter_stamp,
           options_hash = excluded.options_hash,
           manifest_r2_key = excluded.manifest_r2_key,
           unit_count = excluded.unit_count,
           inserted_count = excluded.inserted_count,
           changed_count = excluded.changed_count,
           moved_count = excluded.moved_count,
           deleted_count = excluded.deleted_count,
           origin = excluded.origin,
           event_id = excluded.event_id,
           author = excluded.author`,
      )
      .bind(
        projectId,
        fileId,
        p.revisionN,
        p.parentRevisionN,
        p.artifactSha256,
        p.stamp,
        p.optionsHash,
        p.manifestR2Key,
        p.unitCount,
        p.counts.inserted,
        p.counts.changed,
        p.counts.moved,
        p.counts.deleted,
        p.origin,
        eventId,
        author,
        serverTs,
      ),
    db
      .prepare(
        `UPDATE files SET head_revision_n = GREATEST(COALESCE(head_revision_n, 0), ?),
           updated_at = (extract(epoch from now())*1000)::bigint
         WHERE id = ? AND project_id = ?`,
      )
      .bind(p.revisionN, fileId, projectId),
  ]
}
