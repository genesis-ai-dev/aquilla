// Artifact bookkeeping for an uploaded audio/video object (AQU-1853).
//
// Extracted from the single-shot `PUT /audio/...` handler so the multipart
// upload path (`audio-multipart.ts`) records an imported clip exactly the same
// way. Everything here is the Postgres side: the immutable `artifacts` row, its
// source-side `artifact_bindings` row, and the `file_source_blobs` pointer that
// lets "Download original" reuse the same R2 object instead of a second copy.
//
// Deliberately two steps rather than one. The single-shot path checks artifact
// identity BEFORE it writes the bytes, so a reused artifact id pointing at
// different media is refused without clobbering the stored object; splitting
// the conflict check from the row write keeps that ordering intact.

import { artifactBindingConflictColumn, laneIdResolveSql } from "./events/lane-id-sql"

export interface AudioArtifactRow {
  id: string
  project_id: string
  file_id: string | null
  audio_id: string | null
  sha256: string
}

export interface AudioArtifactIdentity {
  artifactId: string
  projectId: string
  fileId: string
  /** Full object name the client chose, e.g. `audio-<cell>-<ts>-<rnd>.webm`. */
  audioId: string
  /** Hex SHA-256 of the object's bytes, or null when none was computed. */
  sha256: string | null
}

/**
 * Look up the artifact row this upload claims and decide whether it belongs to
 * different media. `conflict` means the id is already taken by another
 * (project, file, audio, bytes) tuple and the caller must refuse with 409;
 * `existing` is the matching row when the upload is a replay of one already
 * recorded (used to decide whether a later failure should delete the object).
 */
export async function loadAudioArtifactConflict(
  db: AquillaDb,
  identity: AudioArtifactIdentity,
): Promise<{ existing: AudioArtifactRow | null; conflict: boolean }> {
  const existing = await db.prepare(
    `SELECT id::text AS id, project_id, file_id, audio_id, sha256
       FROM artifacts WHERE id::text = ?`,
  ).bind(identity.artifactId).first<AudioArtifactRow>()
  if (!existing) return { existing: null, conflict: false }
  const conflict =
    existing.project_id !== identity.projectId
    || existing.file_id !== identity.fileId
    || existing.audio_id !== identity.audioId
    || existing.sha256 !== identity.sha256
  return { existing, conflict }
}

export interface WriteAudioArtifactRowsEnv {
  SNAPSHOTS: R2Bucket
  AQUILLA_PG?: AquillaDb
}

export interface WriteAudioArtifactRowsArgs {
  env: WriteAudioArtifactRowsEnv
  projectId: string
  fileId: string
  audioId: string
  /** R2 key the bytes were written to. */
  key: string
  artifactId: string
  artifactName?: string
  contentType: string
  sizeBytes: number
  sha256: string
  userId: string
  /** Row returned by `loadAudioArtifactConflict`, when the upload is a replay. */
  existing: AudioArtifactRow | null
}

export type WriteAudioArtifactRowsResult =
  | { ok: true }
  | { ok: false; status: number; message: string }

/**
 * Write (idempotently) the artifact rows for an uploaded audio/video object.
 *
 * Returns a failure result rather than throwing so each caller can wrap the
 * response in its own CORS helper. On a metadata failure for a *new* artifact
 * the R2 object is deleted again so a half-recorded upload leaves no orphan; a
 * replay over an artifact already on record leaves the stored object alone.
 */
export async function writeAudioArtifactRows(
  args: WriteAudioArtifactRowsArgs,
): Promise<WriteAudioArtifactRowsResult> {
  const {
    env, projectId, fileId, audioId, key,
    artifactId, artifactName, contentType, sizeBytes, sha256, userId, existing,
  } = args
  const db = env.AQUILLA_PG
  if (!db) return { ok: false, status: 500, message: "AQUILLA_PG binding not configured" }

  const conflictColumn = await artifactBindingConflictColumn(db)
  try {
    await db.batch([
      db.prepare(
        `INSERT INTO artifacts (
           id, project_id, uploaded_by_user_id, credential_id, name, content_type,
           size_bytes, sha256, r2_key, file_id, kind, audio_id, metadata
         ) VALUES (?::uuid, ?, ?, NULL, ?, ?, ?, ?, ?, ?, 'audio', ?, ?::text::jsonb)
         ON CONFLICT (id) DO NOTHING`,
      ).bind(
        artifactId,
        projectId,
        userId,
        artifactName ?? audioId,
        contentType,
        sizeBytes,
        sha256,
        key,
        fileId,
        audioId,
        JSON.stringify({ origin: "browser-media-import" }),
      ),
      db.prepare(
        `INSERT INTO artifact_bindings (
           id, project_id, artifact_id, file_id, binding_role,
           member_path, profile_id, profile_version, fidelity, manifest, recipe, lane_id
         ) VALUES (?::uuid, ?, ?::uuid, ?, 'source', '', 'builtin:media', '1',
                   'preserved-only', '{}'::jsonb, NULL, ${laneIdResolveSql('source')})
         ON CONFLICT (artifact_id, file_id, binding_role, ${conflictColumn}, member_path)
         DO UPDATE SET
           updated_at = now()`,
        // AQU-1240 slice 8: source-side media binding -> the source lane.
      ).bind(crypto.randomUUID(), projectId, artifactId, fileId, projectId),
      // Imported media is also the original source. Reuse its R2 object
      // rather than uploading another copy for Download original.
      db.prepare(
        `INSERT INTO file_source_blobs (
           file_id, project_id, format, raw_source, r2_key, size_bytes, created_at
         ) VALUES (?, ?, ?, NULL, ?, ?, (extract(epoch from now()) * 1000)::bigint)
         ON CONFLICT (file_id) DO NOTHING`,
      ).bind(
        fileId,
        projectId,
        /\.([a-z0-9]+)$/i.exec(audioId)?.[1].toLowerCase() ?? "bin",
        key,
        sizeBytes,
      ),
    ])
  } catch (error) {
    if (!existing) await env.SNAPSHOTS.delete(key).catch(() => {})
    console.error("[audio] artifact metadata write failed:", error)
    return { ok: false, status: 500, message: "audio artifact metadata write failed" }
  }
  return { ok: true }
}
