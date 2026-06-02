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
//   flags: --search <term>  --limit N  --target local|remote (default remote/prod)

import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { resolveCredentialsFromEnv, type GitLabCredentials } from "../src/lib/migrate/gitlab/auth"
import {
  discoverCodexProjects,
  getProjectById,
  listTopLevelGroups,
  listDescendantGroups,
  type CodexProjectMatch,
} from "../src/lib/migrate/gitlab/api"
import { projectIdFor, fileIdFor, orgLegacyUuidFor, teamLegacyUuidFor } from "../src/lib/migrate/ids"
import { parseCodexNotebook } from "../src/lib/codex-editor/parse-codex"
import { mapFilePairToEvents, collectSpeakers, type FilePairInput } from "../src/lib/migrate/map"
import { collectCellAudio, audioAttachEvent } from "../src/lib/migrate/audio"
import { mapComments } from "../src/lib/migrate/comments"
import { buildCastAdditions } from "../src/lib/import/cast-from-speakers"
import type { ProjectTtsSettings } from "../src/lib/parsers/types"
import type { IngestEvent } from "../src/lib/migrate/types"
import type { CodexNotebookFile } from "../src/lib/codex-editor/types"

const SYNC = process.env.SYNC_BASE ?? "https://api.aquilla.app/sync"
const AQUILLA_DB = "aquilla-db"
const PERSIST = ".wrangler-dev-state"
const INGEST_CHUNK = 1000
const FALLBACK_AUTHOR = "legacy-import"

// ── change-detection: skip a project whose GitLab HEAD is unchanged since the
// last successful pass (separate markers for content vs audio). State persists
// in .migrate-state.json so re-runs are cheap. --force ignores it. ───────────
let CREDS: GitLabCredentials
const STATE_FILE = ".migrate-state.json"
type MigState = Record<string, { contentSha?: string; audioSha?: string }>
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
  force: boolean
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
    force: a.includes("--force"),
  }
}

function d1<T>(sql: string, remote: boolean): T[] {
  const args = ["d1", "execute", AQUILLA_DB, remote ? "--remote" : "--local", "--json"]
  if (!remote) args.push("--persist-to", PERSIST)
  args.push("--command", sql)
  const out = execFileSync("wrangler", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 })
  const start = out.indexOf("[")
  if (start < 0) throw new Error(`unexpected wrangler output: ${out.slice(0, 200)}`)
  return (JSON.parse(out.slice(start)) as Array<{ results: T[] }>)[0]?.results ?? []
}
function d1File(sqlText: string, remote: boolean): void {
  const tmp = path.join(os.tmpdir(), `migrate-all-${randomUUID()}.sql`)
  fs.writeFileSync(tmp, sqlText)
  const args = ["d1", "execute", AQUILLA_DB, remote ? "--remote" : "--local", "--file", tmp]
  if (!remote) args.push("--persist-to", PERSIST)
  execFileSync("wrangler", args, { stdio: ["ignore", "ignore", "inherit"] })
  fs.unlinkSync(tmp)
}
const sql = (s: string | null | undefined) => `'${(s ?? "").replace(/'/g, "''")}'`

// ── group tree → namespace placement ───────────────────────────────────────
interface Placement {
  orgLegacyUuid: string
  teamLegacyUuid: string | null // null for a bare top-level-group project
}
async function buildPlacementIndex(creds: Awaited<ReturnType<typeof resolveCredentialsFromEnv>>) {
  const byFullPath = new Map<string, Placement>()
  const tops = await listTopLevelGroups(creds)
  for (const top of tops) {
    byFullPath.set(top.full_path, { orgLegacyUuid: orgLegacyUuidFor(top.id), teamLegacyUuid: null })
    const descendants = await listDescendantGroups(creds, top.id)
    for (const d of descendants) {
      byFullPath.set(d.full_path, {
        orgLegacyUuid: orgLegacyUuidFor(top.id),
        teamLegacyUuid: teamLegacyUuidFor(d.id),
      })
    }
  }
  return byFullPath
}

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
function fetchProject(gitlabId: number, noLfs: boolean): string {
  const fa = ["tsx", "scripts/migrate-fetch.ts", String(gitlabId)]
  if (noLfs) fa.push("--no-lfs")
  const out = execFileSync("npx", fa, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: process.env,
  })
  const m = out.match(/Ready to import:\s*npx tsx scripts\/migrate\.ts\s+(.+)\s*$/m)
  if (!m) throw new Error(`could not parse fetch output dir for project ${gitlabId}`)
  return m[1].trim()
}

async function ingest(projectId: string, events: IngestEvent[]): Promise<void> {
  const secret = process.env.SYNC_SECRET_KEY
  if (!secret) throw new Error("SYNC_SECRET_KEY not set (load .env: `set -a; . ./.env; set +a`)")
  for (let i = 0; i < events.length; i += INGEST_CHUNK) {
    const res = await fetch(`${SYNC}/migrate/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
      body: JSON.stringify({ projectId, events: events.slice(i, i + INGEST_CHUNK) }),
    })
    if (!res.ok) throw new Error(`ingest HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`)
    process.stdout.write(`\r    ingested ${Math.min(i + INGEST_CHUNK, events.length)}/${events.length}`)
  }
  if (events.length) process.stdout.write("\n")
}

async function applyCast(projectId: string, pairs: FilePairInput[], remote: boolean): Promise<number> {
  const speakers = pairs.flatMap((p) => collectSpeakers(p))
  if (speakers.length === 0) return 0
  const row = d1<{ settings: string }>(
    `SELECT settings FROM project_settings WHERE project_id = ${sql(projectId)}`,
    remote,
  )[0]
  let settings: { ttsSettings?: ProjectTtsSettings } = {}
  try {
    if (row?.settings) settings = JSON.parse(row.settings)
  } catch {
    /* start fresh */
  }
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

async function doProject(p: CodexProjectMatch, placeIdx: Map<string, Placement>, args: Args) {
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
  const org = d1<{ id: number; owner_user_id: number }>(
    `SELECT id, owner_user_id FROM organizations WHERE legacy_uuid = ${sql(place.orgLegacyUuid)}`,
    args.remote,
  )[0]
  if (!org) {
    console.warn(`  ! org not on target (run migrate-groups --apply first) — skipped`)
    return
  }
  const team = place.teamLegacyUuid
    ? d1<{ id: number }>(`SELECT id FROM groups WHERE legacy_uuid = ${sql(place.teamLegacyUuid)}`, args.remote)[0]
    : undefined

  const projectId = projectIdFor(String(p.id), "gitlab")
  const dir = fetchProject(p.id, true) // content sweep: text only (no LFS)
  const pairs = buildPairs(dir)
  const events: IngestEvent[] = []
  for (const pair of pairs) {
    events.push(
      ...mapFilePairToEvents(pair, {
        projectId,
        projectKey: String(p.id),
        fallbackAuthor: FALLBACK_AUTHOR,
        fallbackTs: Date.now(),
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
    console.log("  [dry-run] no writes")
    return
  }

  d1File(
    `INSERT INTO projects (id, name, org_id, created_by, created_at, updated_at)
       VALUES (${sql(projectId)}, ${sql(p.name)}, ${org.id}, ${org.owner_user_id}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT(id) DO NOTHING;
     ${team ? `INSERT INTO group_project_grants (group_id, project_id, role_level, granted_by, granted_at) VALUES (${team.id}, ${sql(projectId)}, 400, ${org.owner_user_id}, CURRENT_TIMESTAMP) ON CONFLICT(group_id, project_id) DO NOTHING;` : ""}`,
    args.remote,
  )
  await ingest(projectId, events)
  let voices = 0
  try {
    voices = await applyCast(projectId, pairs, args.remote)
  } catch (e) {
    // Large casts exceed D1's 100KB inline-statement limit; cast is a separate
    // parameterized pass. Never let it fail the (already-landed) content.
    console.warn(`  ! cast deferred (${e instanceof Error ? e.message.split("\n")[0] : String(e)})`)
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
  const dir = fetchProject(p.id, false) // need LFS bytes
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

async function main() {
  const args = parseArgs()
  if (args.apply && !process.env.SYNC_SECRET_KEY) {
    console.error("SYNC_SECRET_KEY not set. Run: set -a; . ./.env; set +a")
    process.exit(1)
  }
  const creds = await resolveCredentialsFromEnv(process.env)
  CREDS = creds
  STATE = loadState()
  FORCE = args.force
  console.log(
    `GitLab: ${creds.gitlabUrl}   target: ${args.remote ? "REMOTE/prod" : "local"}   ${args.audio ? "AUDIO" : "content"}   ${args.apply ? "APPLY" : "dry-run"}${args.force ? "   FORCE" : ""}`,
  )
  let placeIdx = new Map<string, Placement>()
  if (!args.audio) {
    console.log("Building org/team placement index from group tree…")
    placeIdx = await buildPlacementIndex(creds)
    console.log(`  ${placeIdx.size} groups indexed`)
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
  for (const p of projects) {
    try {
      if (args.audio) await doProjectAudio(p, args)
      else await doProject(p, placeIdx, args)
      done++
    } catch (e) {
      console.error(`  ✗ ${p.name}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  console.log(`\n${args.apply ? "Applied" : "Planned"} ${done}/${projects.length} projects.`)
}

main().catch((e) => {
  console.error("\n" + (e instanceof Error ? e.stack : String(e)))
  process.exit(1)
})
