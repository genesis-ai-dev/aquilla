// AQU-1856 — garbage collection of orphaned objects in the SNAPSHOTS bucket.
//
// Three media namespaces accumulate objects that nothing ever points at again:
//
//   projects/{pid}/files/{fid}/audio/{audioId}   recordings, TTS output and
//                                               voice-convert results. The bytes
//                                               are PUT before the client emits
//                                               `cell.audio.attach`, so a tab
//                                               closed mid-batch (or a failed
//                                               attach whose best-effort DELETE
//                                               never ran) strands them. Every
//                                               regenerated take strands the one
//                                               it replaced.
//   projects/{pid}/voices/{refId}               voice-clone reference clips, plus
//     projects/{pid}/voices/{refId}.inworld.json the Inworld clone-id cache keyed
//                                               off the same refId. Nothing has
//                                               ever deleted these.
//   artifacts/{pid}/{artifactId}[/original.ext] uploaded originals preserved for
//                                               round-trip fidelity; an upload
//                                               whose artifacts row never landed
//                                               is abandoned bytes.
//
// Until now R2 objects were only removed per file, by `DELETE /admin/files/:p/:f`
// (admin.ts), so none of the above was ever reclaimed.
//
// ─────────────────────────── why this is written defensively ────────────────
//
// This is the only unattended code in the repo that deletes user media, so every
// decision here fails toward keeping bytes:
//
//  1. ALLOWLIST, never denylist. Only keys matching one of the three patterns
//     above are ever deletion candidates. `projects/{pid}/files/{fid}/tail/*`
//     and `.../checkpoints/*` (projection internals), `.../attachments/*`
//     (cell_attachments), `.../source/original.*` (file_source_blobs) and the
//     sweep's own `gc/*` cursor are not recognized, so they are counted and
//     skipped rather than considered. A namespace added later is invisible to
//     the sweep until someone teaches `classifyKey` about it — the safe default.
//  2. GRACE PERIOD. An object younger than `graceMs` (24h) is never a candidate,
//     so the attach that is still in flight — or a long batch TTS run — cannot be
//     swept out from under itself.
//  3. FAIL CLOSED ON READ FAILURE. If a project's reference query throws, that
//     project is recorded in `projectsFailed` and nothing of its is deleted. An
//     empty result set from a *failed* query must never read as "all orphaned";
//     that is the one bug in a sweep like this that cannot be undone.
//  4. CAPS + RESUMABLE CURSOR. `maxProjects` / `maxDeletes` bound a single run;
//     the returned cursors let the next run continue where this one stopped, so
//     the whole bucket is covered over successive nights without one run holding
//     an unbounded working set.
//  5. DRY RUN. `dryRun: true` does every read and classification and reports
//     counts, bytes and sample keys, but issues no delete.

import { r2KeyPrefix, type AudioEnv } from "./audio"

export interface R2GcEnv extends Pick<AudioEnv, "R2_KEY_PREFIX"> {
  SNAPSHOTS: R2Bucket
  AQUILLA_PG?: AquillaDb
}

/** An object must be this old before it can be considered orphaned. Covers a
 *  long batch TTS/voice-convert run plus clock skew between R2 and the worker. */
export const DEFAULT_GRACE_MS = 24 * 60 * 60 * 1000
/** Soft cap on deletes per run, checked at project boundaries — a project is
 *  swept whole or not at all, so one run may overshoot by a project's worth.
 *  R2 takes 1000 keys per delete() call, so this is ~5 batches. */
export const DEFAULT_MAX_DELETES = 5_000
/** Projects visited per run, per namespace group. The cursors resume the rest. */
export const DEFAULT_MAX_PROJECTS = 25
/** Keys included in the report as examples of what was (or would be) deleted. */
export const MAX_SAMPLE_KEYS = 20

export type GcNamespace = "audio" | "voice" | "artifact"

const NAMESPACES: readonly GcNamespace[] = ["audio", "voice", "artifact"]

/** Suffix of the Inworld clone-id cache that rides alongside a reference clip. */
const CLONE_CACHE_SUFFIX = ".inworld.json"

export interface R2GcCursors {
  /** Last `projects/{pid}/` prefix finished — audio + voice namespaces. */
  projects?: string
  /** Last `artifacts/{pid}/` prefix finished. */
  artifacts?: string
}

export interface R2GcOptions {
  /** Classify and report, delete nothing. */
  dryRun?: boolean
  graceMs?: number
  maxDeletes?: number
  maxProjects?: number
  cursors?: R2GcCursors
  /** Injectable for tests; defaults to `Date.now()`. */
  now?: number
}

export interface R2GcNamespaceStat {
  orphaned: number
  bytes: number
}

export interface R2GcReport {
  dryRun: boolean
  graceMs: number
  /** Candidate objects examined (recognized namespaces, past the grace period). */
  scanned: number
  /** Recognized + past grace + unreferenced. */
  orphaned: number
  /** Actually deleted. Equals 0 on a dry run, else matches `orphaned` unless a
   *  cap truncated the run or a delete call failed. */
  deleted: number
  /** Bytes held by the orphaned objects — freed, or reclaimable on a dry run. */
  bytes: number
  skippedUnrecognized: number
  skippedInGrace: number
  projectsScanned: number
  /** Projects whose reference read failed; nothing of theirs was touched. */
  projectsFailed: number
  /** True when a cap stopped the run before the listing was exhausted. */
  truncated: boolean
  byNamespace: Record<GcNamespace, R2GcNamespaceStat>
  /** Up to MAX_SAMPLE_KEYS example keys, so a dry run is reviewable. */
  samples: string[]
  /** Pass back into the next run to continue. Absent once the listing drained. */
  nextCursors: R2GcCursors
  errors: string[]
}

interface Candidate {
  key: string
  size: number
  namespace: GcNamespace
  /** Namespace-local identity compared against the reference set. */
  ref: string
}

/**
 * Split a bucket key (prefix already stripped) into the namespace it belongs to
 * and the identity to look up. Returns null for anything not swept — which is
 * everything except the three media namespaces.
 */
export function classifyKey(rest: string): { namespace: GcNamespace; projectId: string; ref: string } | null {
  const parts = rest.split("/")
  if (parts[0] === "projects") {
    // projects/{pid}/files/{fid}/audio/{audioId}
    if (parts.length === 6 && parts[2] === "files" && parts[4] === "audio") {
      const [, projectId, , fileId, , audioId] = parts
      if (!projectId || !fileId || !audioId) return null
      return { namespace: "audio", projectId, ref: `${fileId}/${audioId}` }
    }
    // projects/{pid}/voices/{refId} and the {refId}.inworld.json clone cache,
    // which lives or dies with the clip it was derived from.
    if (parts.length === 4 && parts[2] === "voices") {
      const [, projectId, , name] = parts
      if (!projectId || !name) return null
      const ref = name.endsWith(CLONE_CACHE_SUFFIX)
        ? name.slice(0, -CLONE_CACHE_SUFFIX.length)
        : name
      if (!ref) return null
      return { namespace: "voice", projectId, ref }
    }
    return null
  }
  if (parts[0] === "artifacts") {
    // artifacts/{pid}/{artifactId} and artifacts/{pid}/{artifactId}/original.ext
    if (parts.length === 3 || parts.length === 4) {
      const [, projectId, artifactId] = parts
      if (!projectId || !artifactId) return null
      return { namespace: "artifact", projectId, ref: artifactId }
    }
    return null
  }
  return null
}

/** Every `(fileId, audioId)` an audio object is still reachable through. */
async function loadAudioRefs(db: AquillaDb, projectId: string): Promise<Set<string>> {
  const refs = new Set<string>()
  // Live takes. `deleted = 1` is the soft-delete the projection writes, so its
  // bytes ARE collectable — that is the point of sweeping regenerated takes.
  const takes = await db
    .prepare(`SELECT file_id, audio_id FROM cell_audio WHERE project_id = ? AND deleted = 0`)
    .bind(projectId)
    .all<{ file_id: string; audio_id: string }>()
  for (const r of takes.results ?? []) refs.add(`${r.file_id}/${r.audio_id}`)

  // Agent-API audio artifacts: the bytes sit in the per-file audio layout keyed
  // by the artifact id standing in for a file id (schema.sql, 0064).
  const artifactAudio = await db
    .prepare(
      `SELECT id::text AS id, audio_id FROM artifacts
        WHERE project_id = ? AND kind = 'audio' AND audio_id IS NOT NULL`,
    )
    .bind(projectId)
    .all<{ id: string; audio_id: string }>()
  for (const r of artifactAudio.results ?? []) {
    refs.add(`${r.id}/${r.audio_id}`)
    // `uuid::text` is canonical lowercase; the key was written from whatever the
    // uploader generated. They agree today, but a case mismatch would read as
    // "orphaned" and delete referenced media, so admit both spellings — a false
    // KEEP costs storage, a false DELETE costs someone's audio.
    refs.add(`${r.id.toLowerCase()}/${r.audio_id}`)
  }

  // A queued/running diarization job still has to fetch its input.
  const jobs = await db
    .prepare(
      `SELECT file_id, audio_object FROM diarization_jobs
        WHERE project_id = ? AND status IN ('queued', 'running')`,
    )
    .bind(projectId)
    .all<{ file_id: string; audio_object: string }>()
  for (const r of jobs.results ?? []) refs.add(`${r.file_id}/${r.audio_object}`)

  return refs
}

/** Every reference-clip id a voice or a take still points at. */
async function loadVoiceRefs(db: AquillaDb, projectId: string): Promise<Set<string>> {
  const refs = new Set<string>()
  // The voice library lives in the project settings blob, so a clip the user
  // uploaded and assigned to a voice is in use even before it has voiced a
  // single line. Missing this is how a sweep eats someone's cloned voice.
  const voices = await db
    .prepare(
      `SELECT DISTINCT v->>'referenceAudioId' AS ref
         FROM project_settings ps,
              jsonb_array_elements(
                CASE WHEN jsonb_typeof(ps.settings::jsonb -> 'ttsSettings' -> 'voices') = 'array'
                     THEN ps.settings::jsonb -> 'ttsSettings' -> 'voices'
                     ELSE '[]'::jsonb END
              ) AS v
        WHERE ps.project_id = ? AND v->>'referenceAudioId' IS NOT NULL`,
    )
    .bind(projectId)
    .all<{ ref: string }>()
  for (const r of voices.results ?? []) if (r.ref) refs.add(r.ref)

  // And any take that records the clip it was cloned/denoised from, so "revert
  // to source" keeps working.
  const takes = await db
    .prepare(
      `SELECT DISTINCT reference_audio_id AS ref FROM cell_audio
        WHERE project_id = ? AND deleted = 0 AND reference_audio_id IS NOT NULL`,
    )
    .bind(projectId)
    .all<{ ref: string }>()
  for (const r of takes.results ?? []) if (r.ref) refs.add(r.ref)

  return refs
}

/** Artifact ids with a surviving metadata row. */
async function loadArtifactRefs(db: AquillaDb, projectId: string): Promise<Set<string>> {
  const refs = new Set<string>()
  const rows = await db
    .prepare(`SELECT id::text AS id FROM artifacts WHERE project_id = ?`)
    .bind(projectId)
    .all<{ id: string }>()
  for (const r of rows.results ?? []) {
    if (!r.id) continue
    // Both spellings, for the reason in loadAudioRefs.
    refs.add(r.id)
    refs.add(r.id.toLowerCase())
  }
  return refs
}

/** Drain a delimited listing into the child prefixes it reports. */
async function listPrefixes(bucket: R2Bucket, prefix: string): Promise<string[]> {
  const out: string[] = []
  let cursor: string | undefined
  do {
    const page = await bucket.list({ prefix, delimiter: "/", cursor })
    for (const p of page.delimitedPrefixes) out.push(p)
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor)
  return out.sort()
}

/** Drain a non-delimited listing into its objects. */
async function listObjects(
  bucket: R2Bucket,
  prefix: string,
): Promise<Array<{ key: string; size: number; uploaded: Date }>> {
  const out: Array<{ key: string; size: number; uploaded: Date }> = []
  let cursor: string | undefined
  do {
    const page = await bucket.list({ prefix, cursor })
    for (const o of page.objects) out.push({ key: o.key, size: o.size, uploaded: o.uploaded })
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor)
  return out
}

function emptyReport(dryRun: boolean, graceMs: number): R2GcReport {
  const byNamespace = {} as Record<GcNamespace, R2GcNamespaceStat>
  for (const ns of NAMESPACES) byNamespace[ns] = { orphaned: 0, bytes: 0 }
  return {
    dryRun,
    graceMs,
    scanned: 0,
    orphaned: 0,
    deleted: 0,
    bytes: 0,
    skippedUnrecognized: 0,
    skippedInGrace: 0,
    projectsScanned: 0,
    projectsFailed: 0,
    truncated: false,
    byNamespace,
    samples: [],
    nextCursors: {},
    errors: [],
  }
}

/**
 * Sweep orphaned media objects out of SNAPSHOTS.
 *
 * Walks `projects/{pid}/` (audio takes + voice clips) and `artifacts/{pid}/`
 * (uploaded originals) one project at a time, loading that project's reference
 * sets from Postgres and deleting only objects that are both unreferenced and
 * older than the grace period. Bounded by `maxProjects` / `maxDeletes`; the
 * returned `nextCursors` resume the rest on the next run.
 */
export async function sweepOrphanedR2Objects(
  env: R2GcEnv,
  options: R2GcOptions = {},
): Promise<R2GcReport> {
  const dryRun = options.dryRun ?? false
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS
  const maxDeletes = options.maxDeletes ?? DEFAULT_MAX_DELETES
  const maxProjects = options.maxProjects ?? DEFAULT_MAX_PROJECTS
  const now = options.now ?? Date.now()
  const report = emptyReport(dryRun, graceMs)

  const db = env.AQUILLA_PG
  if (!db) {
    // Fail closed: with no way to ask what is referenced, everything would look
    // orphaned.
    report.errors.push("AQUILLA_PG not bound — refusing to sweep")
    return report
  }

  const base = r2KeyPrefix(env)
  const cutoff = now - graceMs
  const pending: Candidate[] = []

  // One project's worth of work: classify its objects under `prefix`, compare
  // against `refs`, and queue the orphans.
  const collect = (
    objects: Array<{ key: string; size: number; uploaded: Date }>,
    refsFor: (ns: GcNamespace) => Set<string> | undefined,
  ) => {
    for (const obj of objects) {
      if (!obj.key.startsWith(base)) {
        report.skippedUnrecognized++
        continue
      }
      const classified = classifyKey(obj.key.slice(base.length))
      if (!classified) {
        report.skippedUnrecognized++
        continue
      }
      if (obj.uploaded.getTime() > cutoff) {
        report.skippedInGrace++
        continue
      }
      report.scanned++
      const refs = refsFor(classified.namespace)
      // No reference set for this namespace means the read did not happen —
      // treat it as "cannot tell", never as "not referenced".
      if (!refs) continue
      if (refs.has(classified.ref) || refs.has(classified.ref.toLowerCase())) continue
      report.orphaned++
      report.bytes += obj.size
      const stat = report.byNamespace[classified.namespace]
      stat.orphaned++
      stat.bytes += obj.size
      if (report.samples.length < MAX_SAMPLE_KEYS) report.samples.push(obj.key)
      pending.push({ key: obj.key, size: obj.size, namespace: classified.namespace, ref: classified.ref })
    }
  }

  // ── audio takes + voice clips, by project ────────────────────────────────
  const projectPrefixes = await listPrefixes(env.SNAPSHOTS, `${base}projects/`)
  const projectsAfter = options.cursors?.projects
  const projectQueue = projectsAfter
    ? projectPrefixes.filter((p) => p > projectsAfter)
    : projectPrefixes
  let visited = 0
  for (const projectPrefix of projectQueue) {
    if (visited >= maxProjects || pending.length >= maxDeletes) {
      report.truncated = true
      break
    }
    visited++
    const projectId = projectPrefix.slice(`${base}projects/`.length).replace(/\/$/, "")
    let audioRefs: Set<string>
    let voiceRefs: Set<string>
    try {
      audioRefs = await loadAudioRefs(db, projectId)
      voiceRefs = await loadVoiceRefs(db, projectId)
    } catch (err) {
      // Fail closed for this project only; the rest of the run continues.
      report.projectsFailed++
      report.errors.push(`project ${projectId}: reference read failed: ${errText(err)}`)
      report.nextCursors.projects = projectPrefix
      continue
    }
    try {
      const objects: Array<{ key: string; size: number; uploaded: Date }> = []
      // Only the two swept sub-prefixes are listed at all, so a tail or
      // checkpoint object is never even fetched, let alone classified.
      for (const filePrefix of await listPrefixes(env.SNAPSHOTS, `${projectPrefix}files/`)) {
        objects.push(...(await listObjects(env.SNAPSHOTS, `${filePrefix}audio/`)))
      }
      objects.push(...(await listObjects(env.SNAPSHOTS, `${projectPrefix}voices/`)))
      collect(objects, (ns) => (ns === "audio" ? audioRefs : ns === "voice" ? voiceRefs : undefined))
      report.projectsScanned++
    } catch (err) {
      report.errors.push(`project ${projectId}: listing failed: ${errText(err)}`)
    }
    report.nextCursors.projects = projectPrefix
  }
  if (!report.truncated && projectQueue.length > 0 && visited >= projectQueue.length) {
    // Listing drained — start from the top next run.
    delete report.nextCursors.projects
  }

  // ── uploaded originals, by project ───────────────────────────────────────
  const artifactPrefixes = await listPrefixes(env.SNAPSHOTS, `${base}artifacts/`)
  const artifactsAfter = options.cursors?.artifacts
  const artifactQueue = artifactsAfter
    ? artifactPrefixes.filter((p) => p > artifactsAfter)
    : artifactPrefixes
  let artifactsVisited = 0
  for (const artifactPrefix of artifactQueue) {
    if (artifactsVisited >= maxProjects || pending.length >= maxDeletes) {
      report.truncated = true
      break
    }
    artifactsVisited++
    const projectId = artifactPrefix.slice(`${base}artifacts/`.length).replace(/\/$/, "")
    let artifactRefs: Set<string>
    try {
      artifactRefs = await loadArtifactRefs(db, projectId)
    } catch (err) {
      report.projectsFailed++
      report.errors.push(`artifacts ${projectId}: reference read failed: ${errText(err)}`)
      report.nextCursors.artifacts = artifactPrefix
      continue
    }
    try {
      collect(await listObjects(env.SNAPSHOTS, artifactPrefix), (ns) =>
        ns === "artifact" ? artifactRefs : undefined,
      )
      report.projectsScanned++
    } catch (err) {
      report.errors.push(`artifacts ${projectId}: listing failed: ${errText(err)}`)
    }
    report.nextCursors.artifacts = artifactPrefix
  }
  if (!report.truncated && artifactQueue.length > 0 && artifactsVisited >= artifactQueue.length) {
    delete report.nextCursors.artifacts
  }

  if (dryRun || pending.length === 0) return report

  // Everything queued gets deleted, including a last project's overshoot past
  // `maxDeletes` — the cap decides when to stop taking NEW projects, not which
  // of an accepted project's orphans to leave behind. Truncating here instead
  // would strand the remainder until the cursor wrapped the whole bucket, and
  // make `bytes` overstate what was actually freed.
  // R2 delete() takes at most 1000 keys per call.
  const keys = pending.map((c) => c.key)
  const CHUNK = 1000
  for (let i = 0; i < keys.length; i += CHUNK) {
    const batch = keys.slice(i, i + CHUNK)
    try {
      await env.SNAPSHOTS.delete(batch)
      report.deleted += batch.length
    } catch (err) {
      report.errors.push(`delete batch at ${i} failed: ${errText(err)}`)
    }
  }
  return report
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** One-line digest for the cron log / the admin response. */
export function formatR2GcReport(report: R2GcReport): string {
  const mb = (report.bytes / (1024 * 1024)).toFixed(1)
  const ns = NAMESPACES.map((n) => `${n}=${report.byNamespace[n].orphaned}`).join(" ")
  return [
    report.dryRun ? "dry-run" : "swept",
    `projects=${report.projectsScanned}`,
    `scanned=${report.scanned}`,
    `orphaned=${report.orphaned} (${ns})`,
    `deleted=${report.deleted}`,
    `${mb}MB`,
    `grace=${Math.round(report.graceMs / 3_600_000)}h`,
    report.skippedInGrace ? `inGrace=${report.skippedInGrace}` : "",
    report.projectsFailed ? `failedProjects=${report.projectsFailed}` : "",
    report.truncated ? "truncated" : "",
  ]
    .filter(Boolean)
    .join(" ")
}
