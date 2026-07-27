#!/usr/bin/env tsx
// Org/team-aware GitLab → Aquilla sweep (Layer B + content).
//
// Prereq: Layer A (scripts/migrate-groups.ts --apply) has created the orgs +
// teams (idempotent, keyed on legacy_uuid). This sweep then, per project:
//   1. resolves the project's org + team from its GitLab namespace via the
//      group tree → prod organizations.id / groups.id (by legacy_uuid)
//   2. D1-direct: INSERT projects (id, org_id, created_by=org owner) +
//      group_project_grants  — both ON CONFLICT DO NOTHING (idempotent)
//   3. content: parse + map → POST /migrate/ingest (SYNC_SECRET_KEY)
//   4. cast: cellLabel speakers → buildCastAdditions → project_settings UPSERT
//   Audio is DEFERRED (separate pass).
//
// Project ids are deterministic: projectIdFor(String(gitlabId), "gitlab"). All
// writes are idempotent, so the whole sweep is safe to re-run / cron.
//
// Run (load creds + secret first):
//   set -a; . ./.env; set +a
//   npx tsx scripts/migrate-all.ts --only 47               # dry-run ONE (canary)
//   npx tsx scripts/migrate-all.ts --only 47 --apply       # write ONE to prod
//   npx tsx scripts/migrate-all.ts --apply                 # full sweep
//   npx tsx scripts/migrate-all.ts --audio-fast --only 47  # one project, dry-run
//   npx tsx scripts/migrate-all.ts --audio-fast --apply    # fast audio (all takes)
//   flags: --search <term>  --limit N  --target local|remote (default remote/prod)
//
// Audio passes (run AFTER content): --audio re-uploads active clips pulled from
// GitLab LFS (slow, bytes over the wire); --audio-fast imports EVERY take by
// copying bytes R2→R2 inside Cloudflare (needs the sync-worker's LFS_SRC binding
// deployed). Prefer --audio-fast.

import fs from "node:fs"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { randomUUID } from "node:crypto"
import { resolveCredentialsFromEnv, type GitLabCredentials } from "../src/lib/migrate/gitlab/auth"
import {
  discoverCodexProjects,
  getProjectById,
  type CodexProjectMatch,
} from "../src/lib/migrate/gitlab/api"
import { projectIdFor, fileIdFor } from "../src/lib/migrate/ids"
import { syncGroupsToNeon, type Placement } from "../src/lib/migrate/group-sync"
import { parseCodexNotebook } from "../src/lib/codex-editor/parse-codex"
import { mapFilePairToEvents, collectSpeakers, type FilePairInput } from "../src/lib/migrate/map"
import { collectCellAudio, audioAttachEvent } from "../src/lib/migrate/audio"
import type { AudioImport } from "../src/lib/migrate/audio"
import { buildOidIndex, planCellAudio, buildCellAudioEvents } from "../src/lib/migrate/audio-copy"
import { discoverPointers } from "../src/lib/migrate/gitlab/lfs"
import { R2Client, gitlabLfsKey, audioDestKey } from "../src/lib/migrate/r2-s3"
import { mapComments } from "../src/lib/migrate/comments"
import { buildCastAdditions } from "../src/lib/import/cast-from-speakers"
import type { ProjectTtsSettings } from "../src/lib/parsers/types"
import type { IngestEvent } from "../src/lib/migrate/types"
import type { CodexNotebookFile } from "../src/lib/codex-editor/types"
import {
  assessIdmlPair,
  isIdmlPair,
  type IdmlMigrationAssessment,
} from "../src/lib/migrate/idml"
import {
  copyGitlabIdmlOriginal,
  downloadGitlabIdmlOriginalBytes,
  resolveGitlabIdmlOriginal,
  type GitlabIdmlOriginal,
} from "./lib/idml-migration-artifacts"

const SYNC = process.env.SYNC_BASE ?? "https://api.aquilla.app/sync"
const INGEST_CHUNK = 2500
const FALLBACK_AUTHOR = "legacy-import"
const execFileP = promisify(execFile)

// ── fast asset copy (--audio-fast): server-side R2 CopyObject (no bytes move,
// no worker hop), globally bounded concurrency. The LFS bucket + the destination
// media bucket are the SAME account, so CopyObject is a metadata op. ──────────
const LFS_BUCKET = process.env.R2_LFS_BUCKET ?? "codex-attachments-v1-1"
const DEST_BUCKET = process.env.R2_DEST_BUCKET ?? "aquilla-snapshots"
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID ?? "6a80496d1e59948a9cbaa3c643ba81d7"
const COPY_CONCURRENCY = Number(process.env.COPY_CONCURRENCY ?? 200)
let R2: R2Client | null = null
const r2 = (): R2Client => {
  if (!R2) throw new Error("R2 client not initialized (set R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY)")
  return R2
}

// Bounded async concurrency: at most `max` copies in flight at once across ALL
// projects (the streaming sink). Keeps us at the latency ceiling without
// unbounded socket fan-out.
function createLimiter(max: number) {
  let active = 0
  const queue: Array<() => void> = []
  return async function run<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= max) await new Promise<void>((resolve) => queue.push(resolve))
    active++
    try {
      return await fn()
    } finally {
      active--
      queue.shift()?.()
    }
  }
}
const copyLimit = createLimiter(COPY_CONCURRENCY)

// One CopyObject with a small retry. 404 ⇒ the LFS object isn't in the bucket
// (lfs-miss, surfaced not dropped); other errors retry then give up.
async function copyAsset(srcKey: string, destKey: string): Promise<"copied" | "lfs-miss" | "failed"> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await r2().copyObject(LFS_BUCKET, srcKey, DEST_BUCKET, destKey)
      return "copied"
    } catch (e) {
      if ((e as { status?: number }).status === 404) return "lfs-miss"
      if (attempt === 3) return "failed"
      await sleep(300 * attempt)
    }
  }
  return "failed"
}

// ── change-detection: skip a project whose GitLab HEAD is unchanged since the
// last successful pass (separate markers for content vs audio). State persists
// in .migrate-state.json so re-runs are cheap. --force ignores it. ───────────
let CREDS: GitLabCredentials
const STATE_FILE = ".migrate-state.json"
type MigState = Record<string, { contentSha?: string; audioSha?: string; audioFastSha?: string }>
let STATE: MigState = {}
let FORCE = false
function loadState(): MigState {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as MigState
  } catch {
    return {}
  }
}
function saveState(): void {
  fs.writeFileSync(STATE_FILE, JSON.stringify(STATE, null, 2))
}
async function headSha(id: number): Promise<string | null> {
  try {
    const res = await fetch(`${CREDS.gitlabUrl}/api/v4/projects/${id}/repository/commits?per_page=1`, {
      headers: { Authorization: `Bearer ${CREDS.gitlabToken}` },
    })
    if (!res.ok) return null
    return ((await res.json()) as Array<{ id: string }>)[0]?.id ?? null
  } catch {
    return null
  }
}

interface Args {
  only?: number
  search?: string
  limit?: number
  apply: boolean
  remote: boolean
  audio: boolean
  audioFast: boolean
  force: boolean
  concurrency: number
  eventsOnly: boolean
}
function parseArgs(): Args {
  const a = process.argv.slice(2)
  const val = (f: string) => {
    const i = a.indexOf(f)
    return i >= 0 ? a[i + 1] : undefined
  }
  const target = val("--target") ?? "remote"
  return {
    only: val("--only") ? Number(val("--only")) : undefined,
    search: val("--search"),
    limit: val("--limit") ? Number(val("--limit")) : undefined,
    apply: a.includes("--apply"),
    remote: target !== "local",
    audio: a.includes("--audio"),
    audioFast: a.includes("--audio-fast"),
    force: a.includes("--force"),
    concurrency: val("--concurrency") ? Number(val("--concurrency")) : 8,
    eventsOnly: a.includes("--events-only"),
  }
}

// Bounded worker pool: pulls many projects in parallel but caps in-flight work
// so we never overwhelm D1 / the GitLab box. Each project's *internal* ingest
// stays serial (server_seq is per-project); only different projects overlap.
async function pool<T>(items: T[], n: number, fn: (item: T, idx: number) => Promise<void>): Promise<void> {
  let i = 0
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (true) {
        const idx = i++
        if (idx >= items.length) break
        await fn(items[idx], idx)
      }
    }),
  )
}

// Preload all orgs + teams once (by legacy_uuid) from NEON via the trusted
// /migrate/org-team-maps endpoint, so the hot loop does in-memory lookups. (Was
// `wrangler d1 execute aquilla-db` — stale after the D1→Neon cutover; the maps
// now come from the same datastore the writes land in.)
type OrgRow = { id: number; owner_user_id: number }
async function fetchOrgTeamMaps(): Promise<{ orgMap: Map<string, OrgRow>; teamMap: Map<string, number> }> {
  const res = await fetch(`${SYNC}/migrate/org-team-maps`, { headers: authHeaders() })
  if (!res.ok) throw new Error(`org-team-maps HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const body = (await res.json()) as {
    orgs: { legacyUuid: string; id: number; ownerUserId: number }[]
    groups: { legacyUuid: string; id: number }[]
  }
  return {
    orgMap: new Map(body.orgs.map((o) => [o.legacyUuid, { id: o.id, owner_user_id: o.ownerUserId }])),
    teamMap: new Map(body.groups.map((g) => [g.legacyUuid, g.id])),
  }
}

// Trusted HTTP writes (no wrangler subprocess → safe to fan out under concurrency).
function authHeaders(): Record<string, string> {
  const secret = process.env.SYNC_SECRET_KEY
  if (!secret) throw new Error("SYNC_SECRET_KEY not set (load .env: `set -a; . ./.env; set +a`)")
  return { "Content-Type": "application/json", Authorization: `Bearer ${secret}` }
}
async function upsertProject(body: {
  projectId: string
  name: string
  orgId: number
  ownerUserId: number
  teamId: number | null
}): Promise<void> {
  const res = await fetch(`${SYNC}/migrate/project`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`project HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
}
async function getSettings(projectId: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${SYNC}/migrate/settings?projectId=${encodeURIComponent(projectId)}`, {
    headers: authHeaders(),
  })
  if (!res.ok) throw new Error(`settings GET HTTP ${res.status}`)
  return ((await res.json()) as { settings?: Record<string, unknown> }).settings ?? {}
}

// Delta-sync: the set of event ids already in D1 for a project (paginated by
// server_seq). We ingest only the events whose deterministic id is NOT present,
// so re-syncs / partial completions send just the delta instead of the firehose.
async function fetchExistingEventIds(projectId: string): Promise<Set<string>> {
  const existing = new Set<string>()
  let after = 0
  for (;;) {
    const res = await fetch(
      `${SYNC}/migrate/event-ids?projectId=${encodeURIComponent(projectId)}&after=${after}&limit=50000`,
      { headers: authHeaders() },
    )
    if (!res.ok) throw new Error(`event-ids HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
    const page = (await res.json()) as { ids: string[]; lastSeq: number; more: boolean }
    for (const id of page.ids) existing.add(id)
    if (!page.more) break
    after = page.lastSeq
  }
  return existing
}

// Recompute every file's rollup counters once per project (set-based), since the
// ingest deferred the per-cell recompute. Must run AFTER all of a project's
// events are ingested.
async function finalizeCounters(projectId: string): Promise<void> {
  const res = await fetch(`${SYNC}/migrate/finalize`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ projectId }),
  })
  if (!res.ok) throw new Error(`finalize HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
}

// Org/team placement comes from syncGroupsToNeon (src/lib/migrate/group-sync):
// it walks the GitLab group tree, builds the full_path→Placement index, AND (on
// apply) creates any missing orgs/teams in Neon — so a content delta fully pulls
// in new orgs. Placement type is imported from there.

// ── local working copy (fetched by migrate-fetch) → events + speakers ───────
function listByStem(dir: string, ext: string): Map<string, string> {
  const m = new Map<string, string>()
  if (!fs.existsSync(dir)) return m
  for (const f of fs.readdirSync(dir)) if (f.endsWith(ext)) m.set(f.slice(0, -ext.length), path.join(dir, f))
  return m
}
function parseNb(file: string | undefined): CodexNotebookFile | undefined {
  if (!file) return undefined
  try {
    return parseCodexNotebook(fs.readFileSync(file, "utf8"))
  } catch {
    return undefined
  }
}
function buildPairs(dir: string): FilePairInput[] {
  const targets = listByStem(path.join(dir, "files/target"), ".codex")
  const sources = listByStem(path.join(dir, ".project/sourceTexts"), ".source")
  const stems = [...new Set([...targets.keys(), ...sources.keys()])].sort()
  const pairs: FilePairInput[] = []
  for (const stem of stems) {
    const source = parseNb(sources.get(stem))
    const target = parseNb(targets.get(stem))
    if (source || target) pairs.push({ relPath: stem, name: stem, source, target })
  }
  return pairs
}

// Shell out to migrate-fetch (clone + LFS, reuses existing checkout) → dir.
// Async (non-blocking) so concurrent workers' clones overlap. execFileSync
// would block the single event loop and serialize the whole pool.
async function fetchProject(gitlabId: number, noLfs: boolean): Promise<string> {
  const fa = ["tsx", "scripts/migrate-fetch.ts", String(gitlabId)]
  if (noLfs) fa.push("--no-lfs")
  const { stdout } = await execFileP("npx", fa, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: process.env,
  })
  const m = stdout.match(/Ready to import:\s*npx tsx scripts\/migrate\.ts\s+(.+)\s*$/m)
  if (!m) throw new Error(`could not parse fetch output dir for project ${gitlabId}`)
  return m[1].trim()
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function ingest(
  projectId: string,
  events: IngestEvent[],
  eventsOnly = false,
  chunkSize = INGEST_CHUNK,
): Promise<void> {
  const secret = process.env.SYNC_SECRET_KEY
  if (!secret) throw new Error("SYNC_SECRET_KEY not set (load .env: `set -a; . ./.env; set +a`)")
  for (let i = 0; i < events.length; i += chunkSize) {
    const body = JSON.stringify({
      projectId,
      events: events.slice(i, i + chunkSize),
      eventsOnly,
      // Skip the O(N²) per-cell file-counter recompute; finalizeCounters() runs
      // it once per project after ingest (the single biggest throughput win).
      deferFileCounters: true,
    })
    // Retry transient failures: a single heavy ingest POST can have its
    // connection dropped at the edge ("fetch failed", no HTTP status) or hit a
    // 5xx/429. Ingest is idempotent (INSERT OR IGNORE on deterministic ids), so
    // a retried chunk is safe. A non-429 4xx is a real client error → fatal.
    let ok = false
    let lastErr = ""
    for (let attempt = 1; attempt <= 4 && !ok; attempt++) {
      try {
        const res = await fetch(`${SYNC}/migrate/ingest`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
          body,
        })
        if (res.ok) {
          ok = true
          break
        }
        const detail = (await res.text().catch(() => "")).slice(0, 300)
        if (res.status < 500 && res.status !== 429) {
          throw new Error(`ingest HTTP ${res.status}: ${detail}`)
        }
        lastErr = `HTTP ${res.status}: ${detail}`
      } catch (e) {
        if (e instanceof Error && /^ingest HTTP [4]/.test(e.message)) throw e
        lastErr = e instanceof Error ? e.message : String(e)
      }
      if (!ok && attempt < 4) await sleep(750 * attempt)
    }
    if (!ok) throw new Error(`ingest failed after retries: ${lastErr}`)
  }
}

async function applyCast(projectId: string, pairs: FilePairInput[]): Promise<number> {
  const speakers = pairs.flatMap((p) => collectSpeakers(p))
  if (speakers.length === 0) return 0
  const settings = (await getSettings(projectId)) as { ttsSettings?: ProjectTtsSettings }
  const tts = settings.ttsSettings
  const add = buildCastAdditions(speakers, tts, () => randomUUID())
  const merged: ProjectTtsSettings = {
    ...(tts ?? {}),
    voices: add.voices,
    castAssignments: { ...(tts?.castAssignments ?? {}), ...add.castAssignments },
  }
  // Parameterized write via the trusted settings endpoint — the cast JSON
  // (thousands of line-assignments) exceeds D1's inline SQL-statement limit, so
  // it can't go through `wrangler d1 execute`.
  const secret = process.env.SYNC_SECRET_KEY
  if (!secret) throw new Error("SYNC_SECRET_KEY not set")
  const res = await fetch(`${SYNC}/migrate/settings`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
    body: JSON.stringify({ projectId, settings: { ...settings, ttsSettings: merged } }),
  })
  if (!res.ok) throw new Error(`settings HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  return add.voices.length
}

async function doProject(
  p: CodexProjectMatch,
  placeIdx: Map<string, Placement>,
  orgMap: Map<string, OrgRow>,
  teamMap: Map<string, number>,
  args: Args,
) {
  const place = placeIdx.get(p.namespace)
  console.log(`\n• ${p.name}  [${p.namespace}]  (gitlab ${p.id})`)
  const sha = await headSha(p.id)
  if (args.apply && !FORCE && sha && STATE[String(p.id)]?.contentSha === sha) {
    console.log(`  ↩ content unchanged (${sha.slice(0, 8)}) — skipped`)
    return
  }
  if (!place) {
    console.warn(`  ! no org/team match for namespace "${p.namespace}" — skipped`)
    return
  }
  const org = orgMap.get(place.orgLegacyUuid)
  if (!org) {
    console.warn(`  ! org not on target (run migrate-groups --apply first) — skipped`)
    return
  }
  const teamId = place.teamLegacyUuid ? teamMap.get(place.teamLegacyUuid) : undefined
  const team = teamId !== undefined ? { id: teamId } : undefined

  const projectId = projectIdFor(String(p.id), "gitlab")
  const dir = await fetchProject(p.id, true) // content sweep: text only (no LFS)
  const pairs = buildPairs(dir)
  const events: IngestEvent[] = []
  const idmlPlans: Array<{
    pair: FilePairInput
    original?: GitlabIdmlOriginal
    assessment: IdmlMigrationAssessment
  }> = []
  for (const pair of pairs) {
    const original = isIdmlPair(pair) ? resolveGitlabIdmlOriginal(dir, pair) : undefined
    const originalBytes = original
      ? await downloadGitlabIdmlOriginalBytes({
          original,
          repositoryUrl: p.httpUrlToRepo,
          gitlabToken: CREDS.gitlabToken,
        })
      : undefined
    const assessment = isIdmlPair(pair)
      ? await assessIdmlPair(pair, originalBytes)
      : undefined
    if (assessment) idmlPlans.push({ pair, ...(original ? { original } : {}), assessment })
    events.push(
      ...mapFilePairToEvents(pair, {
        projectId,
        projectKey: String(p.id),
        fallbackAuthor: FALLBACK_AUTHOR,
        fallbackTs: Date.now(),
        ...(assessment ? { idmlAssessment: assessment } : {}),
      }),
    )
  }
  const commentsPath = path.join(dir, ".project", "comments.json")
  if (fs.existsSync(commentsPath)) {
    try {
      const cf: unknown = JSON.parse(fs.readFileSync(commentsPath, "utf8"))
      events.push(...mapComments(cf, { projectId, projectKey: String(p.id), fallbackTs: Date.now() }))
    } catch {
      /* skip bad comments */
    }
  }
  const speakerCount = new Set(pairs.flatMap((x) => collectSpeakers(x)).map((s) => s.speaker)).size

  console.log(
    `  → aquilla ${projectId}  org_id=${org.id}${team ? ` team_id=${team.id}` : " (no team)"}  files=${pairs.length} events=${events.length} characters=${speakerCount}`,
  )
  if (!args.apply) {
    for (const plan of idmlPlans) {
      console.log(
        `  [idml] ${plan.pair.name}: ${plan.assessment.readiness}`
        + (plan.original ? ` ← ${plan.original.relativePath}` : " (missing pointers/originals attachment)"),
      )
    }
    console.log("  [dry-run] no writes")
    return
  }
  if (
    args.eventsOnly
    && idmlPlans.some((plan) => plan.original)
  ) {
    throw new Error(
      "IDML original binding is required before IDML content ingestion; "
      + "--events-only cannot migrate projects with IDML source artifacts",
    )
  }

  await upsertProject({
    projectId,
    name: p.name,
    orgId: org.id,
    ownerUserId: org.owner_user_id,
    teamId: team?.id ?? null,
  })
  // Delta-sync: send only events not already in D1 (no-op for a fresh project,
  // a tiny tail for a partially-imported one, a few edits on a re-sync).
  const existing = await fetchExistingEventIds(projectId)
  const newEvents = existing.size ? events.filter((e) => !existing.has(e.id)) : events
  if (existing.size) {
    console.log(`  ↳ delta: ${newEvents.length} new / ${events.length} total (${existing.size} already in D1)`)
  }
  const artifactFileIds = new Set(
    idmlPlans
      .filter((plan) => plan.original)
      .map((plan) => fileIdFor(String(p.id), plan.pair.relPath)),
  )
  const prerequisiteEvents = newEvents.filter((event) => (
    event.kind === "file.create"
    && typeof event.fileId === "string"
    && artifactFileIds.has(event.fileId)
  ))
  if (prerequisiteEvents.length > 0) {
    await ingest(projectId, prerequisiteEvents, false)
  }
  for (const plan of idmlPlans) {
    if (!plan.original) {
      console.warn(
        `  ! ${plan.pair.name}: needs-artifact; expected matching Git LFS pointer under `
        + `.project/attachments/pointers/originals`,
      )
      continue
    }
    const fileId = fileIdFor(String(p.id), plan.pair.relPath)
    await copyGitlabIdmlOriginal({
      syncBase: SYNC,
      secret: process.env.SYNC_SECRET_KEY!,
      projectId,
      fileId,
      original: plan.original,
    })
    console.log(
      `  source artifact: ${plan.pair.name} ← ${plan.original.relativePath} `
      + `(${plan.assessment.readiness})`,
    )
  }
  const prerequisiteIds = new Set(prerequisiteEvents.map((event) => event.id))
  const remainingEvents = newEvents.filter((event) => !prerequisiteIds.has(event.id))
  await ingest(projectId, remainingEvents, args.eventsOnly)
  // Deferred file-counters: recompute them once now that all cells are projected.
  if (!args.eventsOnly) await finalizeCounters(projectId)
  let voices = 0
  if (!args.eventsOnly) {
    try {
      voices = await applyCast(projectId, pairs)
    } catch (e) {
      // Large casts exceed D1's 100KB inline-statement limit; cast is a separate
      // parameterized pass. Never let it fail the (already-landed) content.
      console.warn(`  ! cast deferred (${e instanceof Error ? e.message.split("\n")[0] : String(e)})`)
    }
  }
  console.log(
    `  ✓ project + ${team ? "team grant + " : ""}content${voices ? ` + cast(${voices})` : " (cast deferred)"}`,
  )
  STATE[String(p.id)] = { ...STATE[String(p.id)], contentSha: sha ?? undefined }
  saveState()
}

// Audio pass (--audio): assumes content + org/team already migrated. Fetches
// WITH LFS, uploads each cell's active clip bytes to R2 via /migrate/audio, then
// emits cell.audio.attach (frontier-audio://). Deferred from the content sweep
// because it copies real bytes (GBs).
async function doProjectAudio(p: CodexProjectMatch, args: Args) {
  const projectId = projectIdFor(String(p.id), "gitlab")
  console.log(`\n• [audio] ${p.name} (gitlab ${p.id}) → ${projectId}`)
  const sha = await headSha(p.id)
  if (args.apply && !FORCE && sha && STATE[String(p.id)]?.audioSha === sha) {
    console.log(`  ↩ audio unchanged (${sha.slice(0, 8)}) — skipped`)
    return
  }
  const secret = process.env.SYNC_SECRET_KEY
  if (args.apply && !secret) throw new Error("SYNC_SECRET_KEY not set")
  const dir = await fetchProject(p.id, false) // need LFS bytes
  const pairs = buildPairs(dir)
  const events: IngestEvent[] = []
  let uploaded = 0
  let missing = 0
  for (const pair of pairs) {
    if (!pair.target) continue
    const fileId = fileIdFor(String(p.id), pair.relPath)
    for (const cell of pair.target.cells) {
      for (const clip of collectCellAudio(cell)) {
        const abs = path.join(dir, clip.diskRelPath)
        if (!fs.existsSync(abs)) {
          missing++
          continue
        }
        if (!args.apply) {
          uploaded++
          continue
        }
        const res = await fetch(
          `${SYNC}/migrate/audio/${projectId}/${fileId}/${encodeURIComponent(clip.aquillaAudioId)}`,
          {
            method: "PUT",
            headers: {
              "Content-Type": clip.mimeType || "application/octet-stream",
              Authorization: `Bearer ${secret}`,
            },
            body: fs.readFileSync(abs),
          },
        )
        if (!res.ok) {
          console.warn(`\n  ! audio PUT ${res.status} ${clip.aquillaAudioId}`)
          continue
        }
        events.push(
          audioAttachEvent(cell.metadata.id, clip, {
            projectId,
            fileId,
            fallbackAuthor: FALLBACK_AUTHOR,
            fallbackTs: Date.now(),
          }),
        )
        uploaded++
        if (uploaded % 50 === 0) process.stdout.write(`\r    uploaded ${uploaded} clips`)
      }
    }
  }
  process.stdout.write(
    `\r    ${args.apply ? "uploaded" : "would upload"} ${uploaded} clips${missing ? ` (${missing} missing on disk)` : ""}\n`,
  )
  if (args.apply && events.length) await ingest(projectId, events)
  console.log(`  ✓ audio${args.apply ? "" : " (dry-run)"}`)
  if (args.apply) {
    STATE[String(p.id)] = { ...STATE[String(p.id)], audioSha: sha ?? undefined }
    saveState()
  }
}

// Fast asset pass (--audio-fast): imports EVERY historical take by copying its
// bytes bucket→bucket with direct server-side R2 CopyObject (a metadata op — no
// bytes move, no worker hop), streamed through a globally-bounded concurrent
// sink. Fetches with --no-lfs (pointers + metadata only); the oid in each
// pointer is the LFS key. Emits cell.audio.attach per landed take + a
// cell.audio.select to pin the legacy active take. Delta-filtered, idempotent
// (CopyObject overwrites), state-tracked under audioFastSha.
async function doProjectAudioFast(p: CodexProjectMatch, args: Args) {
  const projectId = projectIdFor(String(p.id), "gitlab")
  console.log(`\n• [audio-fast] ${p.name} (gitlab ${p.id}) → ${projectId}`)
  const sha = await headSha(p.id)
  if (args.apply && !FORCE && sha && STATE[String(p.id)]?.audioFastSha === sha) {
    console.log(`  ↩ audio unchanged (${sha.slice(0, 8)}) — skipped`)
    return
  }
  if (args.apply && !process.env.SYNC_SECRET_KEY) throw new Error("SYNC_SECRET_KEY not set")
  const tFetch = Date.now()
  const dir = await fetchProject(p.id, true) // --no-lfs: pointers + metadata only
  const tParse = Date.now()
  const oidIndex = buildOidIndex(discoverPointers(dir).pointers)
  const pairs = buildPairs(dir)
  const secs = (from: number, to: number) => `${((to - from) / 1000).toFixed(1)}s`
  console.log(`  ⏱ fetch ${secs(tFetch, tParse)}`)

  // 1) Flatten the whole project to a stream of independent copy units. Each
  //    carries its source LFS key + destination app key; per-cell we remember
  //    the active take so we can pin it once its bytes land.
  interface Unit { cellId: string; take: AudioImport; srcKey: string; destKey: string }
  interface CellInfo { fileId: string; cellId: string; selected: string | null }
  const units: Unit[] = []
  const cells: CellInfo[] = []
  let noOid = 0
  for (const pair of pairs) {
    if (!pair.target) continue
    const fileId = fileIdFor(String(p.id), pair.relPath)
    for (const cell of pair.target.cells) {
      const plan = planCellAudio(cell, oidIndex)
      noOid += plan.missingOid.length
      if (plan.copies.length === 0 && !plan.selectedAquillaAudioId) continue
      cells.push({ fileId, cellId: cell.metadata.id, selected: plan.selectedAquillaAudioId })
      for (const c of plan.copies) {
        units.push({
          cellId: cell.metadata.id,
          take: c.take,
          srcKey: gitlabLfsKey(c.oid),
          destKey: audioDestKey(projectId, fileId, c.take.aquillaAudioId),
        })
      }
    }
  }

  if (!args.apply) {
    console.log(`    would copy ${units.length}${noOid ? ` / no-oid ${noOid}` : ""} (dry-run)`)
    return
  }

  // 2) Copy phase: fire every unit through the global CopyObject sink. JS is
  //    single-threaded so the per-success bookkeeping is race-free.
  let copied = 0
  let lfsMiss = 0
  let failed = 0
  const landedByCell = new Map<string, AudioImport[]>()
  const tCopy = Date.now()
  await Promise.all(
    units.map((u) =>
      copyLimit(async () => {
        const r = await copyAsset(u.srcKey, u.destKey)
        if (r === "copied") {
          copied++
          const arr = landedByCell.get(u.cellId) ?? []
          arr.push(u.take)
          landedByCell.set(u.cellId, arr)
          if (copied % 100 === 0) process.stdout.write(`\r    copied ${copied}/${units.length}`)
        } else if (r === "lfs-miss") {
          lfsMiss++
          if (lfsMiss <= 5) console.warn(`\n  ! lfs-miss ${u.take.aquillaAudioId} (oid key ${u.srcKey})`)
        } else {
          failed++
          if (failed <= 5) console.warn(`\n  ! copy failed ${u.take.aquillaAudioId}`)
        }
      }),
    ),
  )
  const tEvents = Date.now()
  process.stdout.write(
    `\r    copied ${copied}/${units.length}` +
      (lfsMiss ? ` / lfs-miss ${lfsMiss}` : "") +
      (noOid ? ` / no-oid ${noOid}` : "") +
      (failed ? ` / failed ${failed}` : "") +
      ` (${secs(tCopy, tEvents)})\n`,
  )

  // 3) Events: attach per landed take + select per cell (only if its active take
  //    actually landed). Built from the in-place set, so we never reference bytes
  //    that didn't copy.
  const events: IngestEvent[] = []
  const fallbackTs = Date.now()
  for (const ci of cells) {
    const landed = landedByCell.get(ci.cellId) ?? []
    if (landed.length === 0) continue
    events.push(
      ...buildCellAudioEvents(ci.cellId, landed, ci.selected, {
        projectId,
        fileId: ci.fileId,
        fallbackAuthor: FALLBACK_AUTHOR,
        fallbackTs,
      }),
    )
  }

  if (events.length) {
    const tDelta = Date.now()
    const existing = await fetchExistingEventIds(projectId)
    const newEvents = existing.size ? events.filter((e) => !existing.has(e.id)) : events
    const tIngest = Date.now()
    if (existing.size) console.log(`  ↳ delta: ${newEvents.length} new / ${events.length} total (event-ids ${secs(tDelta, tIngest)})`)
    // Smaller chunks than the content pass: each audio event's projection does a
    // deselect + upsert, so a big single POST can exceed the edge timeout.
    if (newEvents.length) await ingest(projectId, newEvents, false, 300)
    console.log(`  ⏱ ingest ${secs(tIngest, Date.now())}`)
  }
  console.log(`  ✓ audio-fast`)
  // Only mark complete when nothing transient failed (lfs-miss / copy failures
  // retry next run; no-oid is a permanent data gap and doesn't block).
  if (lfsMiss === 0 && failed === 0) {
    STATE[String(p.id)] = { ...STATE[String(p.id)], audioFastSha: sha ?? undefined }
    saveState()
  } else {
    console.log(`  ⚠ not marking complete (${lfsMiss} lfs-miss, ${failed} failed) — will retry next run`)
  }
}

async function main() {
  const args = parseArgs()
  if (args.apply && !process.env.SYNC_SECRET_KEY) {
    console.error("SYNC_SECRET_KEY not set. Run: set -a; . ./.env; set +a")
    process.exit(1)
  }
  if (args.audioFast && args.apply) {
    const ak = process.env.R2_ACCESS_KEY_ID
    const sk = process.env.R2_SECRET_ACCESS_KEY
    if (!ak || !sk) {
      console.error("R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY required for --audio-fast (add to .env).")
      process.exit(1)
    }
    R2 = new R2Client({ accountId: R2_ACCOUNT_ID, accessKeyId: ak, secretAccessKey: sk })
    console.log(
      `R2 CopyObject: ${LFS_BUCKET} → ${DEST_BUCKET}  (concurrency ${COPY_CONCURRENCY}, account ${R2_ACCOUNT_ID.slice(0, 8)}…)`,
    )
  }
  const creds = await resolveCredentialsFromEnv(process.env)
  CREDS = creds
  STATE = loadState()
  FORCE = args.force
  console.log(
    `GitLab: ${creds.gitlabUrl}   target: ${args.remote ? "REMOTE/prod" : "local"}   ${args.audioFast ? "AUDIO-FAST" : args.audio ? "AUDIO" : "content"}   ${args.apply ? "APPLY" : "dry-run"}${args.force ? "   FORCE" : ""}`,
  )
  let placeIdx = new Map<string, Placement>()
  let orgMap = new Map<string, OrgRow>()
  let teamMap = new Map<string, number>()
  if (!args.audio && !args.audioFast) {
    console.log("Syncing org/team structure to Neon from the GitLab group tree…")
    const gs = await syncGroupsToNeon(creds, { syncBase: SYNC, headers: authHeaders() }, { apply: args.apply })
    placeIdx = gs.placeIdx
    if (gs.plan.conflicts.length) {
      const unresolved = gs.plan.conflicts.filter((c) => c.kind === "unresolved-user").length
      const noOwner = gs.plan.conflicts.filter((c) => c.kind === "no-owner").length
      console.log(`  ⚠ group conflicts: ${noOwner} no-owner, ${unresolved} unresolved-user (those memberships skipped)`)
    }
    console.log(
      `  ${placeIdx.size} groups indexed; ${gs.plan.orgs.length} orgs / ${gs.plan.teams.length} teams ${args.apply ? "upserted" : "planned (dry-run)"} to Neon`,
    )
    // Re-read full maps from Neon (now incl. any orgs just created) — fetchOrgTeamMaps
    // also carries owner_user_id, which the project upsert needs.
    const maps = await fetchOrgTeamMaps()
    orgMap = maps.orgMap
    teamMap = maps.teamMap
  }

  let projects: CodexProjectMatch[]
  if (args.only) {
    const gp = await getProjectById(creds, args.only)
    if (!gp) throw new Error(`project ${args.only} not found`)
    projects = [
      {
        id: gp.id,
        name: gp.name,
        namespace: gp.namespace?.full_path ?? gp.path_with_namespace.split("/").slice(0, -1).join("/"),
        lastActivityAt: gp.last_activity_at,
        httpUrlToRepo: gp.http_url_to_repo,
        defaultBranch: gp.default_branch ?? "main",
      },
    ]
  } else {
    console.log("Discovering Codex projects…")
    projects = await discoverCodexProjects(creds, args.search ? { search: args.search } : {})
    if (args.limit) projects = projects.slice(0, args.limit)
    console.log(`  ${projects.length} Codex projects`)
  }

  let done = 0
  const n = Math.max(1, args.concurrency)
  console.log(`Processing ${projects.length} projects with concurrency ${n}…`)
  await pool(projects, n, async (p) => {
    try {
      if (args.audioFast) await doProjectAudioFast(p, args)
      else if (args.audio) await doProjectAudio(p, args)
      else await doProject(p, placeIdx, orgMap, teamMap, args)
      done++
      if (done % 10 === 0) console.log(`  …${done}/${projects.length} done`)
    } catch (e) {
      console.error(`  ✗ ${p.name}: ${e instanceof Error ? e.message : String(e)}`)
    }
  })
  console.log(`\n${args.apply ? "Applied" : "Planned"} ${done}/${projects.length} projects.`)
}

main().catch((e) => {
  console.error("\n" + (e instanceof Error ? e.stack : String(e)))
  process.exit(1)
})
