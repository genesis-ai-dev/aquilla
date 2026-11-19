// AQU-2682: what may write or remove a stored recording.
//
// A recording is stored once, under a name the uploading client chose
// (`projects/<p>/files/<f>/audio/<name>`), and a take plays it by that name.
// The rules:
//
//   - WRITTEN ONCE. A write over an existing recording must carry the very
//     same bytes (a retried upload); other bytes under a stored name are
//     refused. A derived `.peaks` sidecar may be rewritten.
//   - REMOVED BY ITS OWNER. A recording no live take plays (an upload whose
//     attach failed) may be removed by any writer. One a live take plays may
//     be removed by whoever recorded that take, or a Maintainer.
//   - WITHIN THE CALLER'S ACCESS. A writer limited to some files is limited to
//     those files here too (a cue file counts as part of the file it belongs
//     to); one limited to some languages may not remove a recording a take in
//     another language plays. Same lane rules as the events route (scopes, or
//     lane grants when the lane wall is on).

import { createHash } from "node:crypto"
import type { SyncTokenClaims } from "./auth"
import { ROLE } from "./events/role-policy"
import { loadTargetLanes } from "./events/lane-read-wall"
import { decideLaneWrite, laneReadWallEnabled } from "../../src/lib/lanes/write-wall"
import { laneScopeAdmitsTag } from "../../src/lib/lanes/scope-ids"

/** A derived sidecar: rewritable, never somebody's recording. */
export function isDerivedSidecar(objectName: string): boolean {
  return objectName.endsWith(".peaks")
}

/** Hex digests of a body, for comparing with what is stored. */
export function digestsOf(body: ArrayBuffer): { md5: string; sha256: string } {
  const bytes = new Uint8Array(body)
  return {
    md5: createHash("md5").update(bytes).digest("hex"),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  }
}

const hexOf = (buf: ArrayBuffer | undefined) =>
  buf ? Array.from(new Uint8Array(buf), (v) => v.toString(16).padStart(2, "0")).join("") : null

/**
 * Is the stored object exactly these bytes? Read from what R2 keeps: the
 * sha256 we stamp on every write, else R2's own MD5 (its checksum, or a
 * single-part etag). Unknown is "no": a write we cannot prove identical is
 * not a retry.
 */
export function storedBytesMatch(
  existing: Pick<R2Object, "etag" | "size"> & { checksums?: { md5?: ArrayBuffer }; customMetadata?: Record<string, string> },
  digests: { md5: string; sha256: string },
  size: number,
): boolean {
  if (typeof existing.size === "number" && existing.size !== size) return false
  const sha = existing.customMetadata?.sha256
  if (sha) return sha === digests.sha256
  const md5 = hexOf(existing.checksums?.md5) ?? (existing.etag && /^[0-9a-f]{32}$/i.test(existing.etag) ? existing.etag.toLowerCase() : null)
  return md5 != null && md5 === digests.md5
}

type Claims = Pick<SyncTokenClaims, "role" | "username" | "scopes" | "laneGrants"> & { src?: string }

/**
 * The caller's FILE limits. A token whose scopes name files may write only in
 * those files, or in a file hanging off one of them (a cue file, a timeline
 * track's content). Null when allowed.
 */
export async function fileScopeRefusal(
  db: AquillaDb | undefined,
  claims: Claims,
  projectId: string,
  fileId: string,
): Promise<string | null> {
  const files = (claims.scopes ?? []).filter((s) => s.kind === "file").map((s) => s.value)
  if (files.length === 0 || claims.role >= ROLE.MAINTAINER || files.includes(fileId)) return null
  if (db) {
    const row = await db
      .prepare(`SELECT anchor_file_id FROM files WHERE project_id = ? AND id = ?`)
      .bind(projectId, fileId)
      .first<{ anchor_file_id: string | null }>()
    if (row?.anchor_file_id && files.includes(row.anchor_file_id)) return null
  }
  return `file '${fileId}' not in scope for audio`
}

/** The live takes in this file that play this stored object, with their language. */
export async function liveTakesOn(
  db: AquillaDb,
  projectId: string,
  fileId: string,
  objectName: string,
): Promise<Array<{ createdBy: string | null; laneTag: string }>> {
  const { results } = await db
    .prepare(
      `SELECT a.created_by, COALESCE(l.legacy_tag, '') AS lane_tag
         FROM cell_audio a
         LEFT JOIN lanes l ON l.id = a.lane_id
        WHERE a.project_id = ? AND a.file_id = ? AND a.deleted = 0
          AND (a.audio_id = ? OR a.url = ?)`,
    )
    .bind(projectId, fileId, objectName, `frontier-audio://${objectName}`)
    .all<{ created_by: string | null; lane_tag: string }>()
  return (results ?? []).map((r) => ({ createdBy: r.created_by, laneTag: r.lane_tag }))
}

/**
 * The caller's LANGUAGE limits, for a take in `laneTag`: the lane wall's
 * grants when it is on, else the token's lane scopes. Null when allowed.
 */
export async function laneRefusal(
  db: AquillaDb,
  claims: Claims,
  projectId: string,
  laneTag: string,
  laneReadWall: string | undefined,
): Promise<string | null> {
  if (claims.role >= ROLE.MAINTAINER || claims.src === "platform") return null
  const lanes = await loadTargetLanes(db, projectId)
  if (laneReadWallEnabled(laneReadWall)) {
    const decision = decideLaneWrite({
      enabled: true,
      role: claims.role,
      src: claims.src,
      laneGrants: claims.laneGrants,
      laneTag,
      lanes,
      requiredRole: ROLE.CONTRIBUTOR,
    })
    return decision.action === "deny" ? decision.reason : null
  }
  const laneScopes = (claims.scopes ?? []).filter((s) => s.kind === "lane").map((s) => s.value)
  if (laneScopes.length > 0 && !laneScopeAdmitsTag(laneScopes, lanes, laneTag)) {
    return `lane '${laneTag}' not in scope for audio`
  }
  return null
}

/**
 * May this caller remove the stored object? Null when allowed. A recording no
 * live take plays: any writer. One a live take plays: its recorder, or a
 * Maintainer — within the caller's languages.
 */
export async function removalRefusal(
  db: AquillaDb,
  claims: Claims,
  projectId: string,
  fileId: string,
  objectName: string,
  laneReadWall: string | undefined,
): Promise<string | null> {
  const takes = await liveTakesOn(db, projectId, fileId, objectName)
  for (const take of takes) {
    const lane = await laneRefusal(db, claims, projectId, take.laneTag, laneReadWall)
    if (lane) return lane
    if (claims.role < ROLE.MAINTAINER && take.createdBy !== claims.username) {
      return "this recording is a live take's; only whoever recorded it or a maintainer may remove it"
    }
  }
  return null
}
