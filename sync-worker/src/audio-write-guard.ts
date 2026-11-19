// AQU-2682: what may write or remove a stored recording.
//
// A recording is stored under a name the uploading client chose
// (`projects/<p>/files/<f>/audio/<name>`), and a take plays it by that name.
// The rules:
//
//   - WRITTEN ONCE. A write over an existing recording must carry the very
//     same bytes (a retried upload); other bytes under a stored name are
//     refused.
//   - ONLY WHAT NO TAKE HAS NAMED. Storage creates or removes only recordings
//     no take has ever named: live, removed (Undo brings it back), or a piece
//     of a cut take. Every client uploads before it attaches, and every
//     client removal is the cleanup of an upload whose attach failed, so
//     neither ever meets a named recording. Nobody removes a take's
//     recording through storage; the sweep does, once nothing names it.
//   - A VOICE'S WAV IS THE VOICE'S. `<base>.wav` beside an AI voice
//     (`<base>.webm|opus|mp3`) is that voice's full-quality copy: only the
//     voice's recorder (or uploader, before it is attached) or a Maintainer
//     writes it, once, within their languages, and it is never removed
//     through storage.
//   - A `.peaks` sidecar is a real one: the AQPK header, 16 KB at most. It is
//     drawn, never heard, and may be rewritten.
//   - WITHIN THE CALLER'S ACCESS. A writer whose access is limited to some
//     files is limited to those files (a cue file counts as part of the file
//     it belongs to), and to their languages wherever a take's language is
//     known. Same rules as the events route.

import { createHash } from "node:crypto"
import type { SyncTokenClaims } from "./auth"
import { ROLE } from "./events/role-policy"
import { loadTargetLanes } from "./events/lane-read-wall"
import { decideLaneWrite, laneReadWallEnabled } from "../../src/lib/lanes/write-wall"
import { laneScopeAdmitsTag } from "../../src/lib/lanes/scope-ids"
import type { LaneIdentity } from "../../src/lib/lanes/read-wall"

/** A derived sidecar: rewritable, never somebody's recording. */
export function isDerivedSidecar(objectName: string): boolean {
  return objectName.endsWith(".peaks")
}

/** The most a real peaks sidecar weighs (one is ~330 bytes; 4096 bins ~4 KB). */
export const MAX_PEAKS_SIDECAR_BYTES = 16 * 1024
const PEAKS_MAGIC = [0x41, 0x51, 0x50, 0x4b] // "AQPK", src/lib/audio/peaks-sidecar.ts

/** Is this body a peaks sidecar, and nothing that could play? */
export function isPeaksSidecarBody(body: ArrayBuffer): boolean {
  if (body.byteLength < 8 || body.byteLength > MAX_PEAKS_SIDECAR_BYTES) return false
  const head = new Uint8Array(body, 0, PEAKS_MAGIC.length)
  return PEAKS_MAGIC.every((b, i) => head[i] === b)
}

/** A take may never be named as a sidecar (it would escape every rule here). */
export function namesSidecar(...names: Array<string | null | undefined>): boolean {
  return names.some((n) => typeof n === "string" && n.endsWith(".peaks"))
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
  // Every role, as on the events route: a scope is a limit whoever holds it.
  const files = (claims.scopes ?? []).filter((s) => s.kind === "file").map((s) => s.value)
  if (files.length === 0 || files.includes(fileId)) return null
  if (db) {
    const row = await db
      .prepare(`SELECT anchor_file_id FROM files WHERE project_id = ? AND id = ?`)
      .bind(projectId, fileId)
      .first<{ anchor_file_id: string | null }>()
    if (row?.anchor_file_id && files.includes(row.anchor_file_id)) return null
  }
  return `file '${fileId}' not in scope for audio`
}

/**
 * Has any take in this file EVER named this stored object, in any state: live,
 * removed (soft, so Undo can bring it back), or a piece of a cut take?
 * `cell_audio` rows are never hard-deleted, so this is the whole history. A
 * piece needs no third test: it plays its take's url, and its take's row
 * (named by `piece_of`) is itself a row naming the object. Two indexed
 * lookups (`idx_cell_audio_name`, `idx_cell_audio_url`).
 */
export async function namedByATake(
  db: AquillaDb,
  projectId: string,
  fileId: string,
  objectName: string,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS hit FROM cell_audio WHERE project_id = ? AND file_id = ? AND audio_id = ?
       UNION ALL
       SELECT 1 FROM cell_audio WHERE project_id = ? AND file_id = ? AND url = ?
       LIMIT 1`,
    )
    .bind(projectId, fileId, objectName, projectId, fileId, `frontier-audio://${objectName}`)
    .first<{ hit: number }>()
  return row != null
}

const SIBLING_OWNER_EXTS = [".webm", ".opus", ".mp3"]

/** Who owns a voice's WAV: everyone who made a take that IS the voice. */
export interface SiblingOwnership {
  /** Distinct recorders (or, before the take exists, the voice's uploader). */
  owners: Array<string | null>
  /** Distinct languages of the takes that are the voice (none before). */
  laneTags: string[]
}

/**
 * Whose is this `<base>.wav`? The AI voice beside it, `<base>.webm|opus|mp3`:
 * the takes whose OWN name is the voice (never a take that merely plays the
 * voice's recording under another name), or, before any is attached, whoever
 * uploaded the voice (stamped on its object). Null when nothing owns it: an
 * ordinary recording of its own. Computed once per request.
 */
export async function siblingOwner(
  db: AquillaDb,
  bucket: Pick<R2Bucket, "head">,
  keyOf: (name: string) => string,
  projectId: string,
  fileId: string,
  objectName: string,
): Promise<SiblingOwnership | null> {
  if (!objectName.toLowerCase().endsWith(".wav") || objectName.length <= 4) return null
  const base = objectName.slice(0, -4)
  const voices = SIBLING_OWNER_EXTS.map((ext) => `${base}${ext}`)
  const { results } = await db
    .prepare(
      `SELECT DISTINCT a.created_by, COALESCE(l.legacy_tag, '') AS lane_tag
         FROM cell_audio a
         LEFT JOIN lanes l ON l.id = a.lane_id
        WHERE a.project_id = ? AND a.file_id = ? AND a.audio_id IN (?, ?, ?)`,
    )
    .bind(projectId, fileId, ...voices)
    .all<{ created_by: string | null; lane_tag: string }>()
  const rows = results ?? []
  if (rows.length > 0) {
    return {
      owners: [...new Set(rows.map((r) => r.created_by))],
      laneTags: [...new Set(rows.map((r) => r.lane_tag))],
    }
  }
  for (const voice of voices) {
    const stored = await bucket.head(keyOf(voice))
    if (stored) return { owners: [stored.customMetadata?.uploadedBy ?? null], laneTags: [] }
  }
  return null
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
  requiredRole: number = ROLE.CONTRIBUTOR,
  /** The project's lanes, from the caller's per-request cache when it has one. */
  loadLanes: () => Promise<LaneIdentity[]> = () => loadTargetLanes(db, projectId),
): Promise<string | null> {
  if (laneReadWallEnabled(laneReadWall)) {
    // The wall's own rule: Maintainer+ and platform pass (before anything is
    // loaded), a grant decides everyone else (as the events route does).
    if (claims.role >= ROLE.MAINTAINER || claims.src === "platform") return null
    const decision = decideLaneWrite({
      enabled: true,
      role: claims.role,
      src: claims.src,
      laneGrants: claims.laneGrants,
      laneTag,
      lanes: await loadLanes(),
      requiredRole,
    })
    return decision.action === "deny" ? decision.reason : null
  }
  if (!(claims.scopes ?? []).some((s) => s.kind === "lane")) return null
  const lanes = await loadLanes()
  const laneScopes = (claims.scopes ?? []).filter((s) => s.kind === "lane").map((s) => s.value)
  if (laneScopes.length > 0 && !laneScopeAdmitsTag(laneScopes, lanes, laneTag)) {
    return `lane '${laneTag}' not in scope for audio`
  }
  return null
}

/**
 * May this caller remove the stored object? Null when allowed: only a
 * recording no take has ever named, no AI voice's WAV, and no take's
 * waveform. Nobody removes these through storage (not their recorder, not a
 * Maintainer); the sweep does once nothing names them.
 */
export async function removalRefusal(
  db: AquillaDb,
  bucket: Pick<R2Bucket, "head">,
  keyOf: (name: string) => string,
  projectId: string,
  fileId: string,
  objectName: string,
): Promise<string | null> {
  const subject = isDerivedSidecar(objectName) ? objectName.slice(0, -".peaks".length) : objectName
  if (await namedByATake(db, projectId, fileId, subject)) {
    return "a take names this recording; it is not removed through storage"
  }
  if (await siblingOwner(db, bucket, keyOf, projectId, fileId, objectName)) {
    return "this is an AI voice's full-quality copy; it is not removed through storage"
  }
  return null
}

/**
 * May this caller write a recording that is NOT stored yet? Null when allowed:
 * not under a name a take has named (bytes the sweep took from a removed take
 * stay its own).
 */
export async function firstWriteRefusal(
  db: AquillaDb,
  projectId: string,
  fileId: string,
  objectName: string,
): Promise<{ status: number; reason: string } | null> {
  if (await namedByATake(db, projectId, fileId, objectName)) {
    return { status: 409, reason: "a take already names this recording" }
  }
  return null
}

/**
 * An AI voice's WAV: written by its one owner or a Maintainer, within every
 * language the voice is in. Owners who disagree (several takes are the voice,
 * made by different people) leave it to a Maintainer.
 */
export async function siblingRefusal(
  db: AquillaDb,
  claims: Claims,
  projectId: string,
  owned: SiblingOwnership | null,
  laneReadWall: string | undefined,
): Promise<{ status: number; reason: string } | null> {
  if (!owned) return null
  if (claims.role < ROLE.MAINTAINER) {
    const [owner, ...others] = owned.owners
    if (others.length > 0 || !owner || owner !== claims.username) {
      return { status: 403, reason: "this is another person's AI voice's full-quality copy" }
    }
  }
  for (const laneTag of owned.laneTags) {
    const lane = await laneRefusal(db, claims, projectId, laneTag, laneReadWall)
    if (lane) return { status: 403, reason: lane }
  }
  return null
}
