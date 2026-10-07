#!/usr/bin/env tsx
// AQU-1616 — the only lane-batch backfill.
//
// Dry run by default. It reads today's schema, including a database where
// migrations 0138 and 0152 are not applied yet, and writes a markdown report
// plus a JSON file. The dry-run connection sets
// `default_transaction_read_only=on`, so an accidental write fails.
//
//   pnpm neon:backfill:lane-batch:local
//   pnpm neon:backfill:lane-batch:local -- --apply
//   pnpm neon:backfill:lane-batch:dev -- --project <id> --out <dir>
//
// --apply refuses unless 0138 and 0152 are applied. It does not rewrite
// events, delete lane rows, or change lanes.legacy_tag.
//
// The report may name projects. Do not commit it or paste it into a PR.
import fs from "node:fs"
import path from "node:path"
import { Client } from "pg"
import { PostgresDb, type PgExecutor } from "../db/shim/postgres"
import { eventLaneRef } from "../src/lib/lanes/event-lane"
import {
  LANE_BATCH_SQL,
  laneBatchApplyRefusal,
  laneBatchClientConfig,
  planLaneBatch,
  renderLaneBatchReport,
  selectAudioLaneEvent,
  type AudioLogEvent,
  type LaneBatchAudio,
  type LaneBatchBacktranslation,
  type LaneBatchColumnPresence,
  type LaneBatchConcept,
  type LaneBatchInvite,
  type LaneBatchLane,
  type LaneBatchProgressRow,
  type LaneBatchProject,
  type LaneBatchScope,
  type LaneBatchWrite,
} from "../src/lib/lanes/lane-batch-backfill"
import { fullProgressRecomputeStmts } from "../sync-worker/src/events/progress-projection"

function connectionString(): string {
  const direct = process.env.AQUILLA_DATABASE_URL?.trim()
  if (direct) return direct
  const host = process.env.NEON_PG_HOST?.trim()
  const database = process.env.NEON_PG_DB?.trim() || "neondb"
  const role = process.env.NEON_PG_ROLE?.trim() || "neondb_owner"
  const password = process.env.NEON_PG_PASSWORD
  if (!host || !password) throw new Error("AQUILLA_DATABASE_URL or NEON_PG_HOST and NEON_PG_PASSWORD are required")
  const url = new URL("postgresql://placeholder")
  url.username = role
  url.password = password
  url.hostname = host
  url.pathname = `/${database}`
  url.searchParams.set("sslmode", "require")
  return url.toString()
}

/** The connection string actually opened. Kept so a connect failure can be scrubbed. */
let openedSecret = ""

function scrub(message: string, secret: string): string {
  if (!secret) return message
  let next = message.split(secret).join("[redacted]")
  let password = secret
  try {
    const decoded = decodeURIComponent(new URL(secret).password)
    if (decoded) password = decoded
  } catch {
    /* the secret is a password, not a URL */
  }
  if (password) next = next.split(password).join("[redacted]")
  const encoded = encodeURIComponent(password)
  if (encoded && encoded !== password) next = next.split(encoded).join("[redacted]")
  return next
}

function publicError(error: unknown): string {
  let message = error instanceof Error ? error.message : String(error)
  const secrets = [
    openedSecret,
    process.env.AQUILLA_DATABASE_URL,
    process.env.AQUILLA_LOCAL_PG_URL,
    process.env.NEON_PG_PASSWORD,
  ]
  for (const secret of secrets) {
    if (secret) message = scrub(message, secret.trim())
  }
  return message
}

function flagValue(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  if (index < 0) return undefined
  const value = process.argv[index + 1]
  if (!value || value.startsWith("--")) throw new Error(`${name} needs a value`)
  return value
}

function parseArgs(): { apply: boolean; projectId?: string; outDir: string } {
  const known = new Set(["--apply", "--project", "--out"])
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i] ?? ""
    if (!arg.startsWith("--")) continue
    if (!known.has(arg)) throw new Error(`unknown flag ${arg}`)
    if (arg === "--project" || arg === "--out") i += 1
  }
  return {
    apply: process.argv.includes("--apply"),
    projectId: flagValue("--project"),
    outDir: flagValue("--out") ?? process.cwd(),
  }
}

function textCol(present: Set<string>, table: string, column: string): string {
  return present.has(`${table}.${column}`) ? column : `NULL::text AS ${column}`
}

async function columnPresence(client: Client): Promise<{ present: Set<string>; columns: LaneBatchColumnPresence }> {
  const { rows } = await client.query<{ table_name: string; column_name: string; is_nullable: string }>(
    `SELECT table_name, column_name, is_nullable
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND (
          (table_name = 'lanes' AND column_name IN ('language', 'name'))
          OR (table_name = 'projects' AND column_name = 'source_link_lane_id')
          OR (table_name = 'cell_audio' AND column_name = 'lane_id')
          OR (table_name = 'cell_audio_validators' AND column_name = 'lane_id')
          OR (table_name = 'cell_backtranslations' AND column_name = 'lane_id')
          OR (table_name = 'cells' AND column_name = 'lane_id')
        )`,
  )
  const present = new Set(rows.map((row) => `${row.table_name}.${row.column_name}`))
  const name = rows.find((row) => row.table_name === "lanes" && row.column_name === "name")
  return {
    present,
    columns: {
      laneLanguage: present.has("lanes.language"),
      laneNameNullable: name?.is_nullable === "YES",
      sourceLinkLaneId: present.has("projects.source_link_lane_id"),
      audioLaneId: present.has("cell_audio.lane_id"),
      audioValidatorLaneId: present.has("cell_audio_validators.lane_id"),
      backtranslationLaneId: present.has("cell_backtranslations.lane_id"),
    },
  }
}

async function appliedMigrations(client: Client): Promise<string[]> {
  const reg = await client.query<{ name: string | null }>(`SELECT to_regclass('public.schema_migrations') AS name`)
  if (!reg.rows[0]?.name) return []
  const { rows } = await client.query<{ name: string }>(`SELECT name FROM schema_migrations`)
  return rows.map((row) => row.name)
}

function asText(value: unknown): string | null {
  if (value === null || value === undefined) return null
  return String(value)
}

function parsePayload(raw: unknown): Record<string, unknown> | null {
  if (raw && typeof raw === "object") return raw as Record<string, unknown>
  if (typeof raw !== "string" || !raw.trim()) return null
  try {
    const value = JSON.parse(raw) as unknown
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function laneFromPayload(raw: unknown): { laneId: string | null; targetLang: string | null } {
  const ref = eventLaneRef(parsePayload(raw) ?? raw)
  return { laneId: ref.laneId, targetLang: ref.tagPresent ? ref.tag : null }
}

function parseScopeLanes(raw: unknown): { scopeLanes: string[] | null; invalid: boolean } {
  if (raw === null || raw === undefined || raw === "") return { scopeLanes: null, invalid: false }
  let value: unknown = raw
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw) as unknown
    } catch {
      return { scopeLanes: null, invalid: true }
    }
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    return { scopeLanes: null, invalid: true }
  }
  return { scopeLanes: value, invalid: false }
}

function parseRenderings(raw: unknown): unknown[] {
  let value = raw
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw) as unknown
    } catch {
      return []
    }
  }
  return Array.isArray(value) ? value : []
}

function seq(value: unknown): number {
  const number = typeof value === "number" ? value : Number(value)
  return Number.isFinite(number) ? number : 0
}

async function loadSnapshot(client: Client, present: Set<string>, projectId?: string): Promise<LaneBatchProject[]> {
  const filter = projectId ?? null
  const projects = await client.query<{
    id: string
    name: string
    source_project_id: string | null
    source_link_consumes: string | null
    source_link_lane_id: string | null
  }>(
    `SELECT id, name, source_project_id, source_link_consumes,
            ${textCol(present, "projects", "source_link_lane_id")}
       FROM projects`,
  )
  const settings = await client.query<{ project_id: string; source_language: string | null; target_language: string | null }>(
    `SELECT project_id, source_language, target_language FROM project_settings`,
  )
  const lanes = await client.query<{
    id: string
    project_id: string
    role: string
    name: string | null
    lang_code: string | null
    legacy_tag: string | null
    language: string | null
  }>(
    `SELECT id, project_id, role, name, lang_code, legacy_tag, ${textCol(present, "lanes", "language")}
       FROM lanes`,
  )
  const scopes = await client.query<{ project_id: string; user_id: string; kind: string; value: string }>(
    `SELECT project_id, user_id::text AS user_id, kind, value
       FROM project_member_scopes
      WHERE kind = 'lane' AND ($1::text IS NULL OR project_id = $1)`,
    [filter],
  )
  const invites = await client.query<{ project_id: string; token: string; scope_lanes: string | null }>(
    `SELECT project_id, token, scope_lanes
       FROM project_invites
      WHERE ($1::text IS NULL OR project_id = $1)`,
    [filter],
  )
  const audio = await client.query<{
    project_id: string
    file_id: string
    cell_id: string
    audio_id: string
    role: string
    event_id: string
    lane_id: string | null
  }>(
    `SELECT project_id, file_id, cell_id, audio_id, role, event_id, ${textCol(present, "cell_audio", "lane_id")}
       FROM cell_audio
      WHERE ($1::text IS NULL OR project_id = $1)`,
    [filter],
  )
  const attaches = await client.query<{ project_id: string; id: string; kind: string; server_seq: string; payload: string }>(
    `SELECT project_id, id, kind, server_seq, payload
       FROM events
      WHERE kind = 'cell.audio.attach' AND ($1::text IS NULL OR project_id = $1)`,
    [filter],
  )
  const takeEvents = await client.query<{
    project_id: string
    audio_id: string
    id: string
    kind: string
    server_seq: string
    payload: string
  }>(
    `SELECT a.project_id, a.audio_id, e.id, e.kind, e.server_seq, e.payload
       FROM cell_audio a
       JOIN events e ON e.id = a.event_id
      WHERE ($1::text IS NULL OR a.project_id = $1)`,
    [filter],
  )
  const votes = await client.query<{
    project_id: string
    file_id: string
    cell_id: string
    audio_id: string
    username: string
    lane_id: string | null
  }>(
    `SELECT project_id, file_id, cell_id, audio_id, username, ${textCol(present, "cell_audio_validators", "lane_id")}
       FROM cell_audio_validators
      WHERE ($1::text IS NULL OR project_id = $1)`,
    [filter],
  )
  const cellLane = present.has("cells.lane_id") ? "c.lane_id AS cell_lane_id" : "NULL::text AS cell_lane_id"
  const backtranslations = await client.query<{
    project_id: string
    file_id: string
    cell_id: string
    target_event_id: string
    lane_id: string | null
    event_payload: string | null
    target_payload: string | null
    cell_lane_id: string | null
  }>(
    `SELECT b.project_id, b.file_id, b.cell_id, b.target_event_id,
            ${present.has("cell_backtranslations.lane_id") ? "b.lane_id" : "NULL::text AS lane_id"},
            e.payload AS event_payload,
            te.payload AS target_payload,
            ${cellLane}
       FROM cell_backtranslations b
       LEFT JOIN events e ON e.id = b.event_id
       LEFT JOIN events te ON te.id = b.target_event_id
       LEFT JOIN cells c
         ON c.project_id = b.project_id AND c.file_id = b.file_id
        AND c.cell_id = b.cell_id AND c.event_id = b.target_event_id AND c.side = 'target'
      WHERE ($1::text IS NULL OR b.project_id = $1)`,
    [filter],
  )
  const concepts = await client.query<{ concept_id: string; project_id: string; renderings: unknown }>(
    `SELECT concept_id, project_id, renderings
       FROM concepts
      WHERE deleted_at IS NULL AND ($1::text IS NULL OR project_id = $1)`,
    [filter],
  )
  const files = await client.query<{ project_id: string; id: string }>(
    `SELECT project_id, id FROM files WHERE ($1::text IS NULL OR project_id = $1)`,
    [filter],
  )
  const progress = await client.query<{
    project_id: string
    file_id: string
    scope: string
    section_key: string
    lane_id: string
    target_lang: string
  }>(
    `SELECT project_id, file_id, scope, section_key, lane_id, target_lang
       FROM file_section_progress
      WHERE ($1::text IS NULL OR project_id = $1)`,
    [filter],
  )

  const eventsByTake = new Map<string, AudioLogEvent[]>()
  const addEvent = (project: string, audioId: string, event: AudioLogEvent) => {
    const key = `${project}\0${audioId}`
    const list = eventsByTake.get(key) ?? []
    if (list.some((item) => item.id === event.id)) return
    list.push(event)
    eventsByTake.set(key, list)
  }
  for (const row of attaches.rows) {
    const payload = parsePayload(row.payload)
    const audioId = payload && typeof payload.audioId === "string" ? payload.audioId : ""
    if (!audioId) continue
    const lane = laneFromPayload(payload)
    addEvent(row.project_id, audioId, {
      id: row.id,
      kind: row.kind,
      serverSeq: seq(row.server_seq),
      laneId: lane.laneId,
      targetLang: lane.targetLang,
    })
  }
  for (const row of takeEvents.rows) {
    const lane = laneFromPayload(row.payload)
    addEvent(row.project_id, row.audio_id, {
      id: row.id,
      kind: row.kind,
      serverSeq: seq(row.server_seq),
      laneId: lane.laneId,
      targetLang: lane.targetLang,
    })
  }

  const settingsByProject = new Map(settings.rows.map((row) => [row.project_id, row]))
  const byProject = new Map<string, LaneBatchProject>()
  for (const row of projects.rows) {
    const setting = settingsByProject.get(row.id)
    byProject.set(row.id, {
      id: row.id,
      name: row.name,
      sourceLanguage: setting?.source_language ?? null,
      targetLanguage: setting?.target_language ?? null,
      sourceProjectId: row.source_project_id,
      sourceLinkConsumes: row.source_link_consumes,
      sourceLinkLaneId: asText(row.source_link_lane_id),
      lanes: [],
      scopes: [],
      invites: [],
      audio: [],
      audioValidators: [],
      backtranslations: [],
      concepts: [],
      files: [],
      progress: [],
    })
  }
  const projectFor = (id: string): LaneBatchProject | undefined => byProject.get(id)
  for (const row of lanes.rows) {
    const lane: LaneBatchLane = {
      id: row.id,
      role: row.role === "source" ? "source" : "target",
      name: row.name,
      langCode: row.lang_code,
      legacyTag: row.legacy_tag,
      language: asText(row.language),
    }
    projectFor(row.project_id)?.lanes.push(lane)
  }
  for (const row of scopes.rows) {
    const scope: LaneBatchScope = { userId: row.user_id, kind: row.kind, value: row.value }
    projectFor(row.project_id)?.scopes.push(scope)
  }
  for (const row of invites.rows) {
    const parsed = parseScopeLanes(row.scope_lanes)
    const invite: LaneBatchInvite = {
      token: row.token,
      scopeLanes: parsed.scopeLanes,
      scopeLanesInvalid: parsed.invalid,
    }
    projectFor(row.project_id)?.invites.push(invite)
  }
  for (const row of audio.rows) {
    const chosen = selectAudioLaneEvent(eventsByTake.get(`${row.project_id}\0${row.audio_id}`) ?? [])
    const take: LaneBatchAudio = {
      fileId: row.file_id,
      cellId: row.cell_id,
      audioId: row.audio_id,
      role: row.role,
      laneId: asText(row.lane_id),
      eventLaneId: chosen?.laneId ?? null,
      eventTargetLang: chosen?.targetLang ?? null,
    }
    projectFor(row.project_id)?.audio.push(take)
  }
  for (const row of votes.rows) {
    projectFor(row.project_id)?.audioValidators.push({
      fileId: row.file_id,
      cellId: row.cell_id,
      audioId: row.audio_id,
      username: row.username,
      laneId: asText(row.lane_id),
    })
  }
  const btGroups = new Map<string, LaneBatchBacktranslation & { cellLanes: string[] }>()
  for (const row of backtranslations.rows) {
    const key = `${row.project_id}\0${row.file_id}\0${row.cell_id}\0${row.target_event_id}`
    const event = laneFromPayload(row.event_payload)
    const target = laneFromPayload(row.target_payload)
    const existing = btGroups.get(key)
    if (!existing) {
      const item: LaneBatchBacktranslation & { cellLanes: string[] } = {
        fileId: row.file_id,
        cellId: row.cell_id,
        targetEventId: row.target_event_id,
        laneId: asText(row.lane_id),
        eventLaneId: event.laneId,
        eventTargetLang: event.targetLang,
        targetCellLaneId: null,
        targetEventLaneId: target.laneId,
        targetEventTargetLang: target.targetLang,
        cellLanes: [],
      }
      btGroups.set(key, item)
      projectFor(row.project_id)?.backtranslations.push(item)
    }
    const group = btGroups.get(key)
    if (group && row.cell_lane_id) group.cellLanes.push(row.cell_lane_id)
  }
  for (const group of btGroups.values()) {
    const distinct = [...new Set(group.cellLanes)]
    group.targetCellLaneId = distinct.length === 1 ? distinct[0]! : null
  }
  for (const row of concepts.rows) {
    const concept: LaneBatchConcept = { conceptId: row.concept_id, renderings: parseRenderings(row.renderings) }
    projectFor(row.project_id)?.concepts.push(concept)
  }
  for (const row of files.rows) projectFor(row.project_id)?.files.push({ id: row.id })
  for (const row of progress.rows) {
    const item: LaneBatchProgressRow = {
      fileId: row.file_id,
      scope: row.scope,
      sectionKey: row.section_key ?? "",
      laneId: row.lane_id,
      targetLang: row.target_lang,
    }
    projectFor(row.project_id)?.progress.push(item)
  }
  return [...byProject.values()]
}

async function applyWrite(client: Client, write: LaneBatchWrite): Promise<void> {
  if (write.table === "lanes") {
    await client.query(LANE_BATCH_SQL.updateLane, [write.language, write.name, write.projectId, write.laneId])
  } else if (write.table === "project_member_scopes" && write.action === "update") {
    await client.query(LANE_BATCH_SQL.updateScope, [write.to, write.projectId, write.userId, write.from])
  } else if (write.table === "project_member_scopes") {
    await client.query(LANE_BATCH_SQL.deleteScope, [write.projectId, write.userId, write.from])
  } else if (write.table === "project_invites") {
    await client.query(LANE_BATCH_SQL.updateInvite, [JSON.stringify(write.scopeLanes), write.token, write.projectId])
  } else if (write.table === "projects") {
    await client.query(LANE_BATCH_SQL.updateLink, [write.sourceLinkLaneId, write.projectId])
  } else if (write.table === "cell_audio") {
    await client.query(LANE_BATCH_SQL.updateAudio, [write.laneId, write.projectId, write.fileId, write.cellId, write.audioId])
  } else if (write.table === "cell_audio_validators") {
    await client.query(LANE_BATCH_SQL.updateAudioValidator, [
      write.laneId,
      write.projectId,
      write.fileId,
      write.cellId,
      write.audioId,
      write.username,
    ])
  } else if (write.table === "cell_backtranslations") {
    await client.query(LANE_BATCH_SQL.updateBacktranslation, [
      write.laneId,
      write.projectId,
      write.fileId,
      write.cellId,
      write.targetEventId,
    ])
  } else if (write.table === "concepts") {
    await client.query(LANE_BATCH_SQL.updateConcept, [JSON.stringify(write.renderings), write.conceptId, write.projectId])
  }
}

function pgExecutor(client: Client): PgExecutor {
  const run: PgExecutor["run"] = async (sql, params) => {
    const result = await client.query(sql, params)
    return { rows: result.rows as Record<string, unknown>[], rowCount: result.rowCount ?? 0 }
  }
  return {
    run,
    async begin(fn) {
      await client.query("BEGIN")
      try {
        const tx: PgExecutor = { run, begin: (inner) => inner(tx) }
        const value = await fn(tx)
        await client.query("COMMIT")
        return value
      } catch (error) {
        await client.query("ROLLBACK")
        throw error
      }
    },
  }
}

async function recomputeProgress(client: Client, files: { projectId: string; fileId: string }[]): Promise<void> {
  const db = new PostgresDb(pgExecutor(client))
  let completed = 0
  for (const file of files) {
    const now = Date.now()
    await db.batch([
      db.prepare(
        `INSERT INTO project_seq_counters (project_id, last_seq, rebuilt_seq)
         SELECT ?, COALESCE(MAX(server_seq), 0), 0 FROM events WHERE project_id = ?
         ON CONFLICT (project_id) DO NOTHING`,
      ).bind(file.projectId, file.projectId),
      db.prepare("SELECT project_id FROM project_seq_counters WHERE project_id = ? FOR UPDATE").bind(file.projectId),
      ...fullProgressRecomputeStmts(db, file.projectId, file.fileId, now),
    ])
    completed += 1
    if (completed % 100 === 0 || completed === files.length) {
      console.log(`lane-batch progress: ${completed}/${files.length} files`)
    }
  }
}

async function main(): Promise<void> {
  const args = parseArgs()
  openedSecret = connectionString()
  const client = new Client(laneBatchClientConfig(openedSecret, !args.apply))
  let connected = false
  try {
    await client.connect()
    connected = true
    if (!args.apply) {
      const shown = await client.query<{ default_transaction_read_only: string }>("SHOW default_transaction_read_only")
      if (shown.rows[0]?.default_transaction_read_only !== "on") {
        throw new Error("dry run requires default_transaction_read_only=on")
      }
    }
    const { present, columns } = await columnPresence(client)
    const migrations = await appliedMigrations(client)
    const refusal = laneBatchApplyRefusal(migrations, columns)
    if (args.apply && refusal) throw new Error(refusal)
    const projects = await loadSnapshot(client, present, args.projectId)
    const planned = planLaneBatch({ projects }, args.projectId ? { projectId: args.projectId } : undefined)
    planned.report.mode = args.apply ? "apply" : "dry-run"
    fs.mkdirSync(args.outDir, { recursive: true })
    const markdownPath = path.join(args.outDir, "lane-batch-backfill.md")
    const jsonPath = path.join(args.outDir, "lane-batch-backfill.json")
    const banner = refusal ? `Apply is blocked.\n\n${refusal}\n\n` : "Apply is allowed on this database.\n\n"
    fs.writeFileSync(markdownPath, banner + renderLaneBatchReport(planned.report))
    fs.writeFileSync(
      jsonPath,
      JSON.stringify({ ...planned.report, applyReady: refusal === null, applyRefusal: refusal }, null, 2),
    )
    const counts = planned.report.counts
    console.log(
      `lane-batch ${planned.report.mode}: ${planned.writes.length} writes, ` +
        `${counts.lanes.guessed} guessed languages, ${planned.report.unresolvable.length} unresolvable, ` +
        `${counts.progress.filesToRecompute} files to recompute`,
    )
    console.log(`report: ${markdownPath}`)
    console.log(`report: ${jsonPath}`)
    if (!args.apply) return

    const byProject = new Map<string, LaneBatchWrite[]>()
    for (const write of planned.writes) {
      const list = byProject.get(write.projectId) ?? []
      list.push(write)
      byProject.set(write.projectId, list)
    }
    for (const [projectId, writes] of byProject) {
      await client.query("BEGIN")
      try {
        for (const write of writes) await applyWrite(client, write)
        await client.query("COMMIT")
      } catch (error) {
        await client.query("ROLLBACK")
        throw new Error(`apply failed for project ${projectId}: ${publicError(error)}`)
      }
    }
    await recomputeProgress(client, planned.progressFiles)
    console.log(`lane-batch apply complete: ${planned.writes.length} writes, ${planned.progressFiles.length} files recomputed`)
  } finally {
    if (connected) await client.end()
  }
}

main().catch((error) => {
  console.error(publicError(error))
  process.exit(1)
})
