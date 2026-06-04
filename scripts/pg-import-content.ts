#!/usr/bin/env tsx
// Stage C, step 2: re-import projects + files + events from GitLab straight into
// Neon Postgres — EVENTS ONLY, all projections deferred (cells/files/validators
// are built later, set-based, by pg-build-projections.ts).
//
// Why this is fast: Postgres has no single-writer ceiling, so the bottleneck is
// GitLab clone/parse (parallelized), not the DB. Events go in via batched
// multi-row INSERT. Org/team resolved from the already-copied identity layer.
//
// Writes: projects (base) + group_project_grants (base) + events (the log).
// Defers: cells, files, cell_validators, cell_audio, comments, counters, FTS.
//
// Run (load creds): set -a; . ./.env; set +a
//   npx tsx scripts/pg-import-content.ts                 # all Codex projects
//   npx tsx scripts/pg-import-content.ts --limit 8       # canary
//   flags: --search <term>  --only <gitlabId>  --concurrency N (default 10)
import fs from "node:fs"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { Pool } from "pg"
import { resolveCredentialsFromEnv, type GitLabCredentials } from "../src/lib/migrate/gitlab/auth"
import {
  discoverCodexProjects,
  getProjectById,
  listTopLevelGroups,
  listDescendantGroups,
  type CodexProjectMatch,
} from "../src/lib/migrate/gitlab/api"
import { projectIdFor, orgLegacyUuidFor, teamLegacyUuidFor } from "../src/lib/migrate/ids"
import { parseCodexNotebook } from "../src/lib/codex-editor/parse-codex"
import { mapFilePairToEvents, type FilePairInput } from "../src/lib/migrate/map"
import { mapComments } from "../src/lib/migrate/comments"
import type { IngestEvent } from "../src/lib/migrate/types"
import type { CodexNotebookFile } from "../src/lib/codex-editor/types"
import { neonConfig } from "./pg"

const execFileP = promisify(execFile)
const FALLBACK_AUTHOR = "legacy-import"
const EVENT_COLS = [
  "id", "schema_version", "project_id", "file_id", "cell_id", "parent_id",
  "kind", "author", "payload", "client_ts", "server_ts", "server_seq",
]
const EVENT_BATCH = 2000 // 2000 × 12 cols = 24k params (< PG's 65535 limit)

interface Args {
  only?: number
  search?: string
  limit?: number
  concurrency: number
}
function parseArgs(): Args {
  const a = process.argv.slice(2)
  const val = (f: string) => (a.indexOf(f) >= 0 ? a[a.indexOf(f) + 1] : undefined)
  return {
    only: val("--only") ? Number(val("--only")) : undefined,
    search: val("--search"),
    limit: val("--limit") ? Number(val("--limit")) : undefined,
    concurrency: val("--concurrency") ? Number(val("--concurrency")) : 10,
  }
}

async function pool<T>(items: T[], n: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) await fn(items[i++])
    }),
  )
}

interface Placement {
  orgLegacyUuid: string
  teamLegacyUuid: string | null
}
async function buildPlacementIndex(creds: GitLabCredentials): Promise<Map<string, Placement>> {
  const byPath = new Map<string, Placement>()
  for (const top of await listTopLevelGroups(creds)) {
    byPath.set(top.full_path, { orgLegacyUuid: orgLegacyUuidFor(top.id), teamLegacyUuid: null })
    for (const d of await listDescendantGroups(creds, top.id)) {
      byPath.set(d.full_path, { orgLegacyUuid: orgLegacyUuidFor(top.id), teamLegacyUuid: teamLegacyUuidFor(d.id) })
    }
  }
  return byPath
}

function parseNb(file: string | undefined): CodexNotebookFile | undefined {
  if (!file) return undefined
  try {
    return parseCodexNotebook(fs.readFileSync(file, "utf8"))
  } catch {
    return undefined
  }
}
function listByStem(dir: string, ext: string): Map<string, string> {
  const m = new Map<string, string>()
  if (!fs.existsSync(dir)) return m
  for (const f of fs.readdirSync(dir)) if (f.endsWith(ext)) m.set(f.slice(0, -ext.length), path.join(dir, f))
  return m
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

async function fetchProject(gitlabId: number): Promise<string> {
  const { stdout } = await execFileP("npx", ["tsx", "scripts/migrate-fetch.ts", String(gitlabId), "--no-lfs"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: process.env,
  })
  const m = stdout.match(/Ready to import:\s*npx tsx scripts\/migrate\.ts\s+(.+)\s*$/m)
  if (!m) throw new Error(`could not parse fetch dir for project ${gitlabId}`)
  return m[1].trim()
}

type OrgRow = { id: number; owner_user_id: number }
async function preload(pg: Pool) {
  const orgs = await pg.query<{ legacy_uuid: string; id: number; owner_user_id: number }>(
    "SELECT legacy_uuid, id, owner_user_id FROM organizations WHERE legacy_uuid IS NOT NULL",
  )
  const teams = await pg.query<{ legacy_uuid: string; id: number }>(
    "SELECT legacy_uuid, id FROM groups WHERE legacy_uuid IS NOT NULL",
  )
  return {
    orgMap: new Map(orgs.rows.map((r) => [r.legacy_uuid, { id: r.id, owner_user_id: r.owner_user_id } as OrgRow])),
    teamMap: new Map(teams.rows.map((r) => [r.legacy_uuid, r.id])),
  }
}

async function insertEvents(pg: Pool, projectId: string, events: IngestEvent[]): Promise<number> {
  let serverTs = Date.now()
  let seq = 0
  let n = 0
  for (let i = 0; i < events.length; i += EVENT_BATCH) {
    const chunk = events.slice(i, i + EVENT_BATCH)
    const params: unknown[] = []
    const tuples = chunk.map((e) => {
      const row = [
        e.id, 1, projectId, e.fileId ?? null, e.cellId ?? null, e.parentId ?? null,
        e.kind, e.author, JSON.stringify(e.payload), e.clientTs, serverTs++, ++seq,
      ]
      const ph = row.map((v) => {
        params.push(v)
        return `$${params.length}`
      })
      return `(${ph.join(",")})`
    })
    const res = await pg.query(
      `INSERT INTO events (${EVENT_COLS.join(",")}) VALUES ${tuples.join(",")} ON CONFLICT (id) DO NOTHING`,
      params,
    )
    n += res.rowCount ?? 0
  }
  return n
}

async function doProject(
  pg: Pool,
  p: CodexProjectMatch,
  placeIdx: Map<string, Placement>,
  orgMap: Map<string, OrgRow>,
  teamMap: Map<string, number>,
): Promise<{ events: number; skipped?: string }> {
  const place = placeIdx.get(p.namespace)
  if (!place) return { events: 0, skipped: `no org/team for ${p.namespace}` }
  const org = orgMap.get(place.orgLegacyUuid)
  if (!org) return { events: 0, skipped: "org not in PG" }
  const teamId = place.teamLegacyUuid ? teamMap.get(place.teamLegacyUuid) : undefined

  const projectId = projectIdFor(String(p.id), "gitlab")
  const dir = await fetchProject(p.id)
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

  // base rows: project + grant (NOT projections)
  await pg.query(
    `INSERT INTO projects (id, name, org_id, created_by, created_at, updated_at)
     VALUES ($1,$2,$3,$4, now(), now()) ON CONFLICT (id) DO NOTHING`,
    [projectId, p.name, org.id, org.owner_user_id],
  )
  if (teamId !== undefined) {
    await pg.query(
      `INSERT INTO group_project_grants (group_id, project_id, role_level, granted_by, granted_at)
       VALUES ($1,$2,400,$3, now()) ON CONFLICT (group_id, project_id) DO NOTHING`,
      [teamId, projectId, org.owner_user_id],
    )
  }
  const inserted = await insertEvents(pg, projectId, events)
  return { events: inserted }
}

async function main() {
  const args = parseArgs()
  const creds = await resolveCredentialsFromEnv(process.env)
  const pg = new Pool({ ...neonConfig(), max: Math.max(4, args.concurrency + 2) })
  console.log(`GitLab: ${creds.gitlabUrl}  →  Neon (events-only, projections deferred)`)

  console.log("Building org/team placement index…")
  const placeIdx = await buildPlacementIndex(creds)
  const { orgMap, teamMap } = await preload(pg)
  console.log(`  ${placeIdx.size} groups indexed; ${orgMap.size} orgs, ${teamMap.size} teams in PG`)

  let projects: CodexProjectMatch[]
  if (args.only) {
    const gp = await getProjectById(creds, args.only)
    if (!gp) throw new Error(`project ${args.only} not found`)
    projects = [{
      id: gp.id, name: gp.name,
      namespace: gp.namespace?.full_path ?? gp.path_with_namespace.split("/").slice(0, -1).join("/"),
      lastActivityAt: gp.last_activity_at, httpUrlToRepo: gp.http_url_to_repo, defaultBranch: gp.default_branch ?? "main",
    }]
  } else {
    console.log("Discovering Codex projects…")
    projects = await discoverCodexProjects(creds, args.search ? { search: args.search } : {})
    if (args.limit) projects = projects.slice(0, args.limit)
    console.log(`  ${projects.length} projects`)
  }

  const t0 = Date.now()
  let done = 0
  let totalEvents = 0
  const skips: string[] = []
  await pool(projects, args.concurrency, async (p) => {
    try {
      const r = await doProject(pg, p, placeIdx, orgMap, teamMap)
      if (r.skipped) skips.push(`${p.name}: ${r.skipped}`)
      else {
        totalEvents += r.events
        done++
        if (done % 10 === 0) console.log(`  …${done} projects, ${totalEvents} events, ${Math.round((Date.now() - t0) / 1000)}s`)
      }
    } catch (e) {
      console.error(`  ✗ ${p.name}: ${e instanceof Error ? e.message : String(e)}`)
    }
  })
  const secs = (Date.now() - t0) / 1000
  await pg.end()
  console.log(
    `\n✓ ${done}/${projects.length} projects, ${totalEvents} events in ${secs.toFixed(1)}s ` +
      `(${Math.round(totalEvents / Math.max(secs, 1))} events/s)`,
  )
  if (skips.length) console.log(`  skipped ${skips.length}: ${skips.slice(0, 5).join("; ")}${skips.length > 5 ? " …" : ""}`)
}

main().catch((e) => {
  console.error("\n" + (e instanceof Error ? e.stack : String(e)))
  process.exit(1)
})
