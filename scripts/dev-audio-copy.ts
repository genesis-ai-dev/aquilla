// AQU-2114 — the decisions behind `scripts/neon-copy-dev-audio.ts`: which of a
// project's production media objects dev needs, which of those it is missing,
// and the two guards that stand between this job and production data. Kept
// apart from the script so every one of them is unit-testable without an R2
// account or a database (the script itself imports `./pg`-shaped I/O).
//
// WHY THIS JOB EXISTS: the nightly "Refresh Dev Neon Branch" workflow restores
// Neon `dev` from `production`, which copies every audio ROW but none of the
// audio BYTES — those live in R2. So a migrated project's takes 404 on
// dev.aquilla.app. This copies the bytes, key for key (neither environment sets
// an R2 key prefix, so a take's key is identical in both buckets).
//
// THE SAME IS TRUE OF UPLOADED SOURCE ORIGINALS. `file_source_blobs.r2_key` and
// `artifacts.r2_key` name the bytes an export or "Download original" reads
// (sync-worker/src/events/export-route.ts, original-source.ts); the restore
// carries the rows and not the objects, so every file imported on production
// exported on dev with 404 "source bytes missing from storage — re-import".
// Originals live under `artifacts/{pid}/{artifactId}/original.{ext}` (or, for
// uploads from before artifacts existed, the legacy
// `projects/{pid}/files/{fid}/source/original.{ext}`), and this copies the
// ones the restored rows name, exactly as it does takes.
//
// WHY IT WORKS FROM THE DATABASE: prod's bucket still holds orphans the nightly
// cleanup (AQU-1856) has not reached. A bucket mirror would copy them, dev's own
// cleanup would delete them — they are unreferenced on dev too — and the next
// mirror would copy them again, every night. So the copy set is exactly the set
// the cleanup PROTECTS, read through the cleanup's own reference queries in
// `db/shared/media-refs.ts`. One copy of those queries, so "what dev keeps" and
// "what dev copies" cannot drift apart.

import { classifyKey } from "../db/shared/media-refs"
import type { AquillaDb } from "../db/shim/postgres"

/** Read-only source. Nothing here ever writes to or deletes from this bucket. */
export const PROD_MEDIA_BUCKET = "aquilla-snapshots"
/** The only permitted destination. */
export const DEV_MEDIA_BUCKET = "aquilla-snapshots-dev"
/** Example keys carried in the report, so a dry run is reviewable. */
export const MAX_SAMPLE_KEYS = 10

/** `AQUILLA_NEON_TARGET` values that must never be read for this job. Mirrors
 *  neon-scrub-guard.ts: production under any alias, and no target at all. */
const PROTECTED_TARGETS = new Set(["production", "prod", "main"])
/** The one target whose rows describe the dev bucket. */
const DEV_TARGETS = new Set(["dev", "development"])

export interface ListedObject {
  key: string
  size: number
}

/** The reference sets loaded for one project: the two the nightly cleanup
 *  shares (`db/shared/media-refs.ts`) plus the uploaded originals. */
export interface ProjectMediaRefs {
  /** `${fileId}/${audioId}` for every audio object still reachable. */
  audio: Set<string>
  /** Reference-clip ids a voice or a take still points at. */
  voice: Set<string>
  /** Full R2 keys of uploaded source originals the project's rows name
   *  (`loadOriginalRefs`). Keys, not ids: the row's key is exactly what an
   *  export reads, and it is the only thing that tells the legacy
   *  `projects/{pid}/files/{fid}/source/original.{ext}` shape apart from the
   *  projection internals beside it. */
  original: Set<string>
}

/**
 * Every uploaded-original key the project's restored rows point at:
 * `file_source_blobs.r2_key` (what export and "Download original" read) and
 * `artifacts.r2_key` (the artifact the blob was cut from, and agent-API
 * uploads that never became a file). Inline legacy blobs have no key and need
 * no copy. A key the cleanup's classifier recognizes as a take or a voice clip
 * (a browser media import registers its recording as its own original) is
 * left to the audio and voice sets, whose rows decide whether it is live.
 */
export async function loadOriginalRefs(db: AquillaDb, projectId: string): Promise<Set<string>> {
  const rows = await db
    .prepare(
      `SELECT r2_key FROM file_source_blobs WHERE project_id = ? AND r2_key IS NOT NULL
       UNION
       SELECT r2_key FROM artifacts WHERE project_id = ? AND r2_key IS NOT NULL`,
    )
    .bind(projectId, projectId)
    .all<{ r2_key: string | null }>()
  const refs = new Set<string>()
  for (const row of rows.results ?? []) {
    const key = row.r2_key?.trim()
    if (!key) continue
    const namespace = classifyKey(key)?.namespace
    if (namespace === "audio" || namespace === "voice") continue
    refs.add(key)
  }
  return refs
}

export interface CopyGateInput {
  /** `AQUILLA_NEON_TARGET`, as neon-target.ts sets it for the child. */
  target: string | undefined
  source: string
  destination: string
}

/**
 * Null when the copy may run, else why not — checked before the first read, let
 * alone the first copy. A script holding raw `NEON_PG_*` credentials cannot
 * tell which branch it is pointed at, so it reads the target neon-target
 * recorded rather than guessing (the same reasoning as AQU-1941's prune gate).
 */
export function copyRefusal(input: CopyGateInput): string | null {
  if (input.destination !== DEV_MEDIA_BUCKET) {
    return `refusing to copy into '${input.destination}' — the destination must be ${DEV_MEDIA_BUCKET}`
  }
  if (input.source !== PROD_MEDIA_BUCKET) {
    return `refusing to copy from '${input.source}' — the source must be ${PROD_MEDIA_BUCKET}`
  }
  const target = input.target?.trim().toLowerCase()
  if (!target) {
    return "AQUILLA_NEON_TARGET is unset — run this through neon-target (pnpm neon:copy-dev-audio:dev), never bare"
  }
  if (PROTECTED_TARGETS.has(target)) {
    return `refusing to read ${target} for a dev audio copy — the restored dev branch already has the same rows`
  }
  if (!DEV_TARGETS.has(target)) {
    return `refusing to read '${target}' for a dev audio copy — the database must be the dev branch`
  }
  return null
}

/** The R2 key an audio object with reference `${fileId}/${audioId}` occupies.
 *  An audio id never contains a slash — `classifyKey` only recognizes a
 *  six-segment audio key — so the first slash is the whole split. */
export function audioKey(projectId: string, ref: string): string {
  const slash = ref.indexOf("/")
  if (slash < 0) throw new Error(`audio reference '${ref}' is not fileId/audioId`)
  return `projects/${projectId}/files/${ref.slice(0, slash)}/audio/${ref.slice(slash + 1)}`
}

/** The R2 key a voice reference clip occupies. */
export function voiceKey(projectId: string, ref: string): string {
  return `projects/${projectId}/voices/${ref}`
}

/** The two prefixes this copy lists for a project, and so the only places an
 *  original it carries can live. */
export function projectPrefixes(projectId: string): [projects: string, artifacts: string] {
  return [`projects/${projectId}/`, `artifacts/${projectId}/`]
}

/** Whether a referenced original is one THIS project's copy can carry. A
 *  blob row may name a key under another project's prefix — a linked file
 *  whose original belongs to the project it was linked from — and that key is
 *  that project's copy to make, not this one's to list. */
export function isOwnOriginal(projectId: string, key: string): boolean {
  return projectPrefixes(projectId).some((prefix) => key.startsWith(prefix))
}

/**
 * The keys a project's referenced media is expected to occupy in prod — the
 * takes, clips and originals themselves, not their sidecars. A `.peaks`
 * waveform or an `.inworld.json` clone cache legitimately may never have been
 * written, so including them here would report healthy projects as missing
 * media; they ride along in `selectReferencedObjects`, which only ever keeps
 * objects that exist.
 */
export function expectedMediaKeys(projectId: string, refs: ProjectMediaRefs): string[] {
  const keys = new Set<string>()
  for (const ref of refs.audio) keys.add(audioKey(projectId, ref))
  for (const ref of refs.voice) keys.add(voiceKey(projectId, ref))
  for (const key of refs.original) if (isOwnOriginal(projectId, key)) keys.add(key)
  return [...keys].sort()
}

/** What a selected object is to the report: a take or clip the cleanup's
 *  queries protect, or an uploaded source original a blob/artifact row names. */
export type SelectedKind = "media" | "original"

export interface SelectedObject extends ListedObject {
  kind: SelectedKind
}

export interface SelectedObjects {
  /** Objects dev needs: the media the nightly cleanup protects, and the
   *  originals the restored rows read. In listing order. */
  referenced: SelectedObject[]
  /** Objects under the project's prefixes that are neither swept media nor a
   *  referenced original: projection tails and checkpoints, cell attachments,
   *  a legacy original no row names. Out of scope for this copy, and counted
   *  rather than guessed about. */
  skippedUnrecognized: number
  /** Recognized media, or an uploaded original, whose row is gone — prod's
   *  orphans. Never copied: dev's own cleanup would only delete them again. */
  skippedUnreferenced: number
}

/**
 * Partition a listing of prod's `projects/{projectId}/` and
 * `artifacts/{projectId}/` into what dev needs and the rest, using the
 * cleanup's own classifier so the two jobs agree key for key. Sidecars
 * (`.peaks`, `.inworld.json`) classify onto the clip they describe, so a live
 * take brings its waveform with it.
 *
 * Originals are matched on the whole key rather than on an artifact id. The
 * cleanup keeps every object under a live artifact id; a copy needs only the
 * one object the row reads, and the legacy `.../source/original.{ext}` shape
 * has no id at all — the classifier does not recognize it, so only the row's
 * key can say it is wanted.
 */
export function selectReferencedObjects(
  projectId: string,
  objects: readonly ListedObject[],
  refs: ProjectMediaRefs,
): SelectedObjects {
  const out: SelectedObjects = { referenced: [], skippedUnrecognized: 0, skippedUnreferenced: 0 }
  for (const object of objects) {
    // The key IS the classifier's input: neither environment sets an R2 key
    // prefix (`R2_KEY_PREFIX`), which is also why a take's key is identical in
    // both buckets and the copy can be key-for-key at all.
    const classified = classifyKey(object.key)
    // A key under another project cannot appear under this project's prefixes
    // — but if it ever did, it is not this job's to move.
    if (classified && classified.projectId !== projectId) {
      out.skippedUnrecognized++
      continue
    }
    if (!classified || classified.namespace === "artifact") {
      // An uploaded original — `artifacts/{pid}/...`, or a legacy
      // `projects/{pid}/files/{fid}/source/original.{ext}` the classifier does
      // not know — is wanted exactly when a restored row names its key.
      if (refs.original.has(object.key) && isOwnOriginal(projectId, object.key)) {
        out.referenced.push({ ...object, kind: "original" })
      } else if (classified) {
        // Under `artifacts/` with no row: an abandoned upload the cleanup sweeps.
        out.skippedUnreferenced++
      } else {
        out.skippedUnrecognized++
      }
      continue
    }
    const set = classified.namespace === "audio" ? refs.audio : refs.voice
    // Both spellings, for the reason db/shared/media-refs.ts gives: the key was
    // written from whatever the uploader generated, the row is canonical.
    if (!set.has(classified.ref) && !set.has(classified.ref.toLowerCase())) {
      out.skippedUnreferenced++
      continue
    }
    out.referenced.push({ ...object, kind: "media" })
  }
  return out
}

/**
 * The referenced objects dev does not already hold. An object dev has is never
 * re-copied, which is also how a take recorded on dev — with no prod
 * counterpart — survives: it is simply not in the copy set.
 */
export function missingInDev<T extends ListedObject>(
  referenced: readonly T[],
  devKeys: ReadonlySet<string>,
): T[] {
  return referenced.filter((object) => !devKeys.has(object.key))
}

export interface DevAudioCopyDeps {
  /** Drain a bucket prefix. */
  listObjects(bucket: string, prefix: string): Promise<ListedObject[]>
  /** Copy one key, source bucket → destination bucket, same key. */
  copyObject(sourceBucket: string, sourceKey: string, destBucket: string, destKey: string): Promise<void>
  /** The cleanup's reference queries plus `loadOriginalRefs`, against the
   *  dev branch. */
  loadRefs(projectId: string): Promise<ProjectMediaRefs>
}

export interface DevAudioCopyOptions {
  projectId: string
  target: string | undefined
  /** Every read happens, nothing is written. */
  dryRun?: boolean
  source?: string
  destination?: string
}

/** The uploaded-originals slice of a report. Each count is a subset of the
 *  matching total (`referenced`, `alreadyInDev`, `copied`), broken out so the
 *  run log can say whether a file imported on prod will export on dev. */
export interface OriginalsCount {
  referenced: number
  alreadyInDev: number
  copied: number
  /** Rows naming a key under another project's prefix. Not this project's
   *  copy to make (see `isOwnOriginal`); reported so a still-404ing export can
   *  be traced to the project that owns the bytes. */
  outsidePrefix: number
}

export interface DevAudioCopyReport {
  projectId: string
  dryRun: boolean
  source: string
  destination: string
  /** Objects dev needs for this project: the media the cleanup protects plus
   *  the uploaded originals its rows read. */
  referenced: number
  referencedBytes: number
  alreadyInDev: number
  copied: number
  copiedBytes: number
  /** The subset of the three counts above that are uploaded source originals. */
  originals: OriginalsCount
  /** Referenced rows whose object is absent from prod too — reported, not an
   *  error: the row outlived its bytes and nothing here can bring them back. */
  missingInProd: string[]
  /** Keys whose copy threw, with the reason. The run finishes regardless. */
  failed: Array<{ key: string; error: string }>
  skippedUnrecognized: number
  skippedUnreferenced: number
  /** Up to MAX_SAMPLE_KEYS of the keys copied (or that a dry run would copy). */
  samples: string[]
}

/**
 * Copy one project's referenced audio and uploaded originals from prod into dev.
 *
 * Reads: the project's reference sets from the dev branch, prod's listings of
 * `projects/{projectId}/` and `artifacts/{projectId}/`, and dev's. Writes: a
 * CopyObject per missing key, and nothing else — never a delete, never a key
 * outside this project's two prefixes, never a key dev already holds.
 */
export async function copyProjectAudio(
  deps: DevAudioCopyDeps,
  options: DevAudioCopyOptions,
): Promise<DevAudioCopyReport> {
  const source = options.source ?? PROD_MEDIA_BUCKET
  const destination = options.destination ?? DEV_MEDIA_BUCKET
  const refusal = copyRefusal({ target: options.target, source, destination })
  if (refusal) throw new Error(refusal)
  if (!options.projectId.trim()) throw new Error("a project id is required")

  const projectId = options.projectId.trim()
  const dryRun = options.dryRun ?? false
  const [projectsPrefix, artifactsPrefix] = projectPrefixes(projectId)

  const refs = await deps.loadRefs(projectId)
  // Both prefixes, both buckets. The artifacts listing is a second request per
  // project, not a second pass over the bucket: originals are a handful of
  // objects beside hundreds of takes.
  const [prodProjects, prodArtifacts, devProjects, devArtifacts] = await Promise.all([
    deps.listObjects(source, projectsPrefix),
    deps.listObjects(source, artifactsPrefix),
    deps.listObjects(destination, projectsPrefix),
    deps.listObjects(destination, artifactsPrefix),
  ])
  const prodObjects = [...prodProjects, ...prodArtifacts]
  const devObjects = [...devProjects, ...devArtifacts]

  const selected = selectReferencedObjects(projectId, prodObjects, refs)
  const prodKeys = new Set(prodObjects.map((o) => o.key))
  const devKeys = new Set(devObjects.map((o) => o.key))
  const missing = missingInDev(selected.referenced, devKeys)
  const originals = selected.referenced.filter((o) => o.kind === "original")
  const missingOriginals = missing.filter((o) => o.kind === "original")
  let outsidePrefix = 0
  for (const key of refs.original) if (!isOwnOriginal(projectId, key)) outsidePrefix++

  const report: DevAudioCopyReport = {
    projectId,
    dryRun,
    source,
    destination,
    referenced: selected.referenced.length,
    referencedBytes: selected.referenced.reduce((sum, o) => sum + o.size, 0),
    alreadyInDev: selected.referenced.length - missing.length,
    copied: 0,
    copiedBytes: 0,
    originals: {
      referenced: originals.length,
      alreadyInDev: originals.length - missingOriginals.length,
      copied: 0,
      outsidePrefix,
    },
    missingInProd: expectedMediaKeys(projectId, refs).filter((key) => !prodKeys.has(key)),
    failed: [],
    skippedUnrecognized: selected.skippedUnrecognized,
    skippedUnreferenced: selected.skippedUnreferenced,
    samples: missing.slice(0, MAX_SAMPLE_KEYS).map((o) => o.key),
  }
  if (dryRun) return report

  for (const object of missing) {
    try {
      await deps.copyObject(source, object.key, destination, object.key)
      report.copied++
      report.copiedBytes += object.size
      if (object.kind === "original") report.originals.copied++
    } catch (error) {
      // One unreadable object does not cost the operator the other 500.
      report.failed.push({ key: object.key, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return report
}

/** The originals line of the digest: the counts that say whether a file
 *  imported on prod exports on dev, kept apart from the take counts that dwarf
 *  them. */
function formatOriginalsLine(report: DevAudioCopyReport): string {
  const o = report.originals
  const moved = report.dryRun
    ? `would copy ${o.referenced - o.alreadyInDev}`
    : `copied ${o.copied}`
  const parts = [`${o.referenced} referenced`, `${o.alreadyInDev} already in dev`, moved]
  if (o.outsidePrefix) parts.push(`${o.outsidePrefix} under another project's prefix`)
  return `  source originals: ${parts.join(", ")}`
}

/** The one-paragraph digest every run ends with. */
export function formatCopyReport(report: DevAudioCopyReport): string {
  const mb = (bytes: number) => `${(bytes / 1_000_000).toFixed(1)} MB`
  const lines = [
    `${report.projectId}: ${report.referenced} referenced object(s), ${mb(report.referencedBytes)}`,
    `  already in ${report.destination}: ${report.alreadyInDev}`,
    report.dryRun
      ? `  would copy: ${report.referenced - report.alreadyInDev}`
      : `  copied: ${report.copied}, ${mb(report.copiedBytes)}`,
    `  missing in ${report.source}: ${report.missingInProd.length}`,
    `  skipped: ${report.skippedUnrecognized} not swept media, ${report.skippedUnreferenced} unreferenced in prod`,
    formatOriginalsLine(report),
  ]
  if (report.failed.length) lines.push(`  FAILED: ${report.failed.length}`)
  for (const failure of report.failed.slice(0, MAX_SAMPLE_KEYS)) {
    lines.push(`    ${failure.key}: ${failure.error}`)
  }
  if (report.samples.length) {
    lines.push(`  sample key(s)${report.dryRun ? " that would be copied" : ""}:`)
    for (const key of report.samples) lines.push(`    ${key}`)
  }
  return lines.join("\n")
}
