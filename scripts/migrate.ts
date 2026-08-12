#!/usr/bin/env tsx
// Legacy-Codex → Aquilla migration CLI (operator-run, idempotent).
//
// Parses a local Codex project (a `~/.codex-projects/<name>` working copy),
// maps it to a deterministic event stream (src/lib/migrate), and ingests it
// into the local dev stack via the trusted POST /migrate/ingest endpoint.
//
// Idempotent: re-running derives the same UUIDv5 ids, so the server's
// INSERT OR IGNORE makes a second run a no-op (0 new events).
//
// Run (with `pnpm dev` up):
//   npx tsx scripts/migrate.ts tibetan_bod_the_chosen-blgw0jio2lhas2fzul7n68
//   npx tsx scripts/migrate.ts <name> --dry-run     # parse + map only, no network
//
// Targets the local stack by default; override with AUTH_BASE / SYNC_BASE.

import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { parseCodexNotebook } from "../src/lib/codex-editor/parse-codex"
import { projectIdFor, fileIdFor } from "../src/lib/migrate/ids"
import { mapFilePairToEvents, collectSpeakers, type FilePairInput, type MapOptions } from "../src/lib/migrate/map"
import { mapComments } from "../src/lib/migrate/comments"
import { collectCellAudio, audioAttachEvent } from "../src/lib/migrate/audio"
import { buildCastAdditions, castLikeSpeakers } from "../src/lib/import/cast-from-speakers"
import type { ProjectTtsSettings } from "../src/lib/parsers/types"
import type { IngestEvent } from "../src/lib/migrate/types"
import { randomUUID } from "node:crypto"
import type { CodexNotebookFile } from "../src/lib/codex-editor/types"
import {
  assessIdmlPair,
  isIdmlPair,
  type IdmlMigrationAssessment,
} from "../src/lib/migrate/idml"
import {
  resolveLocalIdmlOriginal,
  uploadLocalIdmlOriginal,
  type LocalIdmlOriginal,
} from "./lib/idml-migration-artifacts"

const AUTH = process.env.AUTH_BASE ?? "http://127.0.0.1:8788"
const SYNC = process.env.SYNC_BASE ?? "http://127.0.0.1:8789"
const VITE = process.env.VITE_BASE ?? "http://127.0.0.1:5173"
const INGEST_CHUNK = 1000
const FALLBACK_AUTHOR = "legacy-import"

interface Args {
  project: string
  dryRun: boolean
  audio: boolean
}

function parseArgs(): Args {
  const argv = process.argv.slice(2)
  const project = argv.find((a) => !a.startsWith("--"))
  if (!project) {
    console.error("usage: tsx scripts/migrate.ts <project-dir-or-name> [--dry-run] [--audio]")
    process.exit(2)
  }
  return { project, dryRun: argv.includes("--dry-run"), audio: argv.includes("--audio") }
}

function resolveProjectDir(arg: string): string {
  if (fs.existsSync(arg) && fs.statSync(arg).isDirectory()) return arg
  const inHome = path.join(os.homedir(), ".codex-projects", arg)
  if (fs.existsSync(inHome)) return inHome
  console.error(`project not found: ${arg} (also tried ${inHome})`)
  process.exit(1)
}

function readDevVar(file: string, key: string): string | null {
  if (!fs.existsSync(file)) return null
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
    if (m && m[1] === key) return m[2].trim().replace(/^["']|["']$/g, "")
  }
  return null
}

function extractLanguages(meta: Record<string, unknown>): { source?: string; target?: string } {
  const flat = meta as { sourceLanguage?: { tag?: string }; targetLanguage?: { tag?: string } }
  let source = flat.sourceLanguage?.tag
  let target = flat.targetLanguage?.tag
  const list = (meta as { languages?: Array<{ tag?: string; projectStatus?: string }> }).languages
  if (Array.isArray(list)) {
    for (const l of list) {
      if (l?.projectStatus === "source" && !source) source = l.tag
      if (l?.projectStatus === "target" && !target) target = l.tag
    }
  }
  return { source, target }
}

function listByStem(dir: string, ext: string): Map<string, string> {
  const byStem = new Map<string, string>()
  if (!fs.existsSync(dir)) return byStem
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith(ext)) byStem.set(f.slice(0, -ext.length), path.join(dir, f))
  }
  return byStem
}

function parseNotebook(file: string | undefined): CodexNotebookFile | undefined {
  if (!file) return undefined
  try {
    return parseCodexNotebook(fs.readFileSync(file, "utf8"))
  } catch (err) {
    console.warn(`  ! skipped unreadable notebook ${path.basename(file)}: ${String(err)}`)
    return undefined
  }
}

async function devLogin(): Promise<string> {
  const res = await fetch(`${AUTH}/__dev__/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  })
  if (!res.ok) throw new Error(`dev login HTTP ${res.status}: ${await res.text()}`)
  return ((await res.json()) as { access_token: string }).access_token
}

async function createProject(token: string, id: string, name: string): Promise<void> {
  const res = await fetch(`${AUTH}/api/v2/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ id, name }),
  })
  if (!res.ok) throw new Error(`create project HTTP ${res.status}: ${await res.text()}`)
}

async function ingest(projectId: string, events: IngestEvent[], secret: string): Promise<void> {
  let sent = 0
  for (let i = 0; i < events.length; i += INGEST_CHUNK) {
    const slice = events.slice(i, i + INGEST_CHUNK)
    const res = await fetch(`${SYNC}/migrate/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
      body: JSON.stringify({ projectId, events: slice }),
    })
    if (!res.ok) throw new Error(`ingest HTTP ${res.status}: ${await res.text()}`)
    sent += slice.length
    process.stdout.write(`\r  ingested ${sent}/${events.length} events`)
  }
  if (events.length) process.stdout.write("\n")
}

async function mintSyncToken(jwt: string, projectId: string, fileId: string): Promise<string> {
  const res = await fetch(`${AUTH}/api/v2/sync-token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ projectId, fileId, projectName: "Migrated" }),
  })
  if (!res.ok) throw new Error(`sync-token HTTP ${res.status}: ${await res.text()}`)
  return ((await res.json()) as { token: string }).token
}

// Heavier opt-in pass (--audio): upload each cell's active clip bytes to R2,
// then emit deterministic cell.audio.attach events. Bytes come from the local
// working copy's .project/attachments/files/ (missing = pointer-only clone,
// which needs `migrate-fetch` to LFS-dereference first).
async function importAudio(
  dir: string,
  projectId: string,
  projectKey: string,
  pairs: FilePairInput[],
  jwt: string,
  secret: string,
  fallbackAuthor: string,
  fallbackTs: number,
): Promise<void> {
  const audioEvents: IngestEvent[] = []
  let uploaded = 0
  let missing = 0
  for (const pair of pairs) {
    if (!pair.target) continue
    const fileId = fileIdFor(projectKey, pair.relPath)
    let token: string | null = null
    for (const cell of pair.target.cells) {
      for (const clip of collectCellAudio(cell)) {
        const abs = path.join(dir, clip.diskRelPath)
        if (!fs.existsSync(abs)) {
          missing++
          continue
        }
        if (!token) token = await mintSyncToken(jwt, projectId, fileId)
        const res = await fetch(
          `${SYNC}/audio/${projectId}/${fileId}/${encodeURIComponent(clip.aquillaAudioId)}`,
          {
            method: "PUT",
            headers: {
              "Content-Type": clip.mimeType || "application/octet-stream",
              Authorization: `Bearer ${token}`,
            },
            body: fs.readFileSync(abs),
          },
        )
        if (!res.ok) {
          console.warn(`\n  ! audio PUT ${res.status} for ${clip.aquillaAudioId}`)
          continue
        }
        audioEvents.push(
          audioAttachEvent(cell.metadata.id, clip, { projectId, fileId, fallbackAuthor, fallbackTs }),
        )
        uploaded++
        if (uploaded % 25 === 0) process.stdout.write(`\r  uploaded ${uploaded} clips`)
      }
    }
  }
  process.stdout.write(
    `\r  uploaded ${uploaded} clips${missing ? ` (${missing} missing on disk — pointer-only clone?)` : ""}\n`,
  )
  if (audioEvents.length) {
    console.log("  emitting cell.audio.attach events…")
    await ingest(projectId, audioEvents, secret)
  }
}

// Character labels → project cast. The legacy per-cell `cellLabel` is the
// speaker; buildCastAdditions mints one Voice per distinct character (reusing
// existing ones by name → idempotent) + a cellId→voiceId map, merged into the
// synced project TTS settings via PATCH /settings (mirrors the live import).
// AQU-813: `castLikeSpeakers` first drops label sets that are per-cell
// identifiers rather than a cast, so label-less audio imports as one voice.
async function importCast(projectId: string, pairs: FilePairInput[], jwt: string): Promise<void> {
  const speakers = castLikeSpeakers(pairs.flatMap((p) => collectSpeakers(p)))
  if (speakers.length === 0) return
  const getRes = await fetch(`${AUTH}/api/v2/projects/${projectId}/settings`, {
    headers: { Authorization: `Bearer ${jwt}` },
  })
  const current = getRes.ok
    ? ((await getRes.json()) as { version?: number; settings?: { ttsSettings?: ProjectTtsSettings } })
    : { version: 0, settings: undefined }
  const tts = current.settings?.ttsSettings
  const additions = buildCastAdditions(speakers, tts, () => randomUUID())
  const mergedTts: ProjectTtsSettings = {
    ...(tts ?? {}),
    voices: additions.voices,
    castAssignments: { ...(tts?.castAssignments ?? {}), ...additions.castAssignments },
  }
  const patchRes = await fetch(`${AUTH}/api/v2/projects/${projectId}/settings`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ settings: { ttsSettings: mergedTts }, ifMatchVersion: current.version ?? 0 }),
  })
  if (patchRes.ok) {
    console.log(
      `  cast: ${additions.voices.length} voices, ${Object.keys(additions.castAssignments).length} line assignments`,
    )
  } else {
    console.warn(`  ! cast PATCH ${patchRes.status}: ${(await patchRes.text()).slice(0, 200)}`)
  }
}

function histogram(events: IngestEvent[]): Record<string, number> {
  const h: Record<string, number> = {}
  for (const e of events) h[e.kind] = (h[e.kind] ?? 0) + 1
  return h
}

async function main() {
  const args = parseArgs()
  const dir = resolveProjectDir(args.project)

  const metaPath = path.join(dir, "metadata.json")
  if (!fs.existsSync(metaPath)) {
    console.error(`no metadata.json in ${dir} — not a Codex project`)
    process.exit(1)
  }
  const meta = JSON.parse(fs.readFileSync(metaPath, "utf8")) as Record<string, unknown>
  const legacyKey = (meta.projectId as string) || path.basename(dir)
  const projectName = (meta.projectName as string) || path.basename(dir)
  const { source: sourceLanguage, target: targetLanguage } = extractLanguages(meta)
  const aquillaProjectId = projectIdFor(legacyKey, "local")

  console.log(`Project: ${projectName}`)
  console.log(`  legacy id: ${legacyKey}  →  aquilla id: ${aquillaProjectId}`)
  console.log(`  languages: ${sourceLanguage ?? "?"} → ${targetLanguage ?? "?"}`)

  // Pair .source / .codex files by shared basename stem.
  const targets = listByStem(path.join(dir, "files/target"), ".codex")
  const sources = listByStem(path.join(dir, ".project/sourceTexts"), ".source")
  const stems = [...new Set([...targets.keys(), ...sources.keys()])].sort()

  const opts: MapOptions = {
    projectId: aquillaProjectId,
    projectKey: legacyKey,
    sourceLanguage,
    targetLanguage,
    fallbackAuthor: FALLBACK_AUTHOR,
    fallbackTs: Date.now(),
  }

  const events: IngestEvent[] = []
  const pairs: FilePairInput[] = []
  const idmlPlans: Array<{
    pair: FilePairInput
    original?: LocalIdmlOriginal
    assessment: IdmlMigrationAssessment
  }> = []
  for (const stem of stems) {
    const pair: FilePairInput = {
      relPath: stem,
      name: stem,
      source: parseNotebook(sources.get(stem)),
      target: parseNotebook(targets.get(stem)),
    }
    if (!pair.source && !pair.target) continue
    pairs.push(pair)
    const original = isIdmlPair(pair) ? resolveLocalIdmlOriginal(dir, pair) : undefined
    const assessment = isIdmlPair(pair)
      ? await assessIdmlPair(pair, original?.bytes)
      : undefined
    if (assessment) idmlPlans.push({ pair, ...(original ? { original } : {}), assessment })
    const fileEvents = mapFilePairToEvents(pair, {
      ...opts,
      ...(assessment ? { idmlAssessment: assessment } : {}),
    })
    events.push(...fileEvents)
    console.log(
      `  ${stem.slice(0, 48).padEnd(48)} ${pair.source ? "S" : " "}${pair.target ? "T" : " "}  ${fileEvents.length} events`,
    )
    if (assessment) {
      console.log(
        `    IDML: ${assessment.readiness}`
        + (original ? ` ← ${original.relativePath}` : " (missing files/originals attachment)"),
      )
    }
  }

  // Project-level comments (.project/comments.json) → comment.create/resolve.
  const commentsPath = path.join(dir, ".project", "comments.json")
  if (fs.existsSync(commentsPath)) {
    try {
      const cf: unknown = JSON.parse(fs.readFileSync(commentsPath, "utf8"))
      const commentEvents = mapComments(cf, {
        projectId: aquillaProjectId,
        projectKey: legacyKey,
        fallbackTs: opts.fallbackTs,
      })
      events.push(...commentEvents)
      console.log(`  comments.json → ${commentEvents.length} comment events`)
    } catch (err) {
      console.warn(`  ! comments.json skipped: ${String(err)}`)
    }
  }

  const hist = histogram(events)
  console.log(`\n${stems.length} files → ${events.length} events:`, hist)

  if (args.dryRun) {
    console.log("\n[dry-run] no network calls made.")
    return
  }

  const secret = readDevVar(path.join("sync-worker", ".dev.vars"), "SYNC_SECRET_KEY")
  if (!secret) {
    console.error("SYNC_SECRET_KEY not found in sync-worker/.dev.vars — is the dev stack set up?")
    process.exit(1)
  }

  console.log("\nAuthenticating + creating project…")
  const token = await devLogin()
  await createProject(token, aquillaProjectId, projectName)

  // Source upload requires a projected file row. Project only those genesis
  // events first; canonical/v2 cell events remain withheld until every
  // available original is durably bound.
  const artifactFileIds = new Set(
    idmlPlans
      .filter((plan) => plan.original)
      .map((plan) => fileIdFor(legacyKey, plan.pair.relPath)),
  )
  const prerequisiteEvents = events.filter((event) => (
    event.kind === "file.create"
    && typeof event.fileId === "string"
    && artifactFileIds.has(event.fileId)
  ))
  if (prerequisiteEvents.length > 0) {
    console.log("Projecting IDML file prerequisites…")
    await ingest(aquillaProjectId, prerequisiteEvents, secret)
  }

  for (const plan of idmlPlans) {
    const fileId = fileIdFor(legacyKey, plan.pair.relPath)
    const { original, assessment } = plan
    if (!original) {
      console.warn(
        `  ! ${plan.pair.name}: ${assessment.readiness}; expected the matching .idml under `
        + `.project/attachments/files/originals`,
      )
      continue
    }
    if (assessment.readiness !== "native-ready") {
      console.warn(
        `  ! ${plan.pair.name}: ${assessment.readiness}; original preserved but export remains unavailable`,
      )
    }
    const syncToken = await mintSyncToken(token, aquillaProjectId, fileId)
    await uploadLocalIdmlOriginal({
      syncBase: SYNC,
      projectId: aquillaProjectId,
      fileId,
      token: syncToken,
      original,
    })
    console.log(
      `  source artifact: ${plan.pair.name} ← ${original.relativePath} (${assessment.readiness})`,
    )
  }

  const prerequisiteIds = new Set(prerequisiteEvents.map((event) => event.id))
  const remainingEvents = events.filter((event) => !prerequisiteIds.has(event.id))
  console.log("Ingesting content events…")
  await ingest(aquillaProjectId, remainingEvents, secret)

  // A failed upload above throws before this point, so no canonical IDML cell
  // metadata can enter the event log without its immutable source artifact.
  if (idmlPlans.some((plan) => plan.original) && remainingEvents.length === 0) {
    console.log("  IDML artifacts bound; no remaining content delta")
  }

  if (args.audio) {
    console.log("Uploading audio (heavier pass)…")
    await importAudio(dir, aquillaProjectId, legacyKey, pairs, token, secret, FALLBACK_AUTHOR, opts.fallbackTs)
  }

  // Character labels (cellLabel = speaker) → cast/voices + line assignments.
  await importCast(aquillaProjectId, pairs, token)

  console.log(`\n✓ Done. Open: ${VITE}/project/${aquillaProjectId}/editor`)
  console.log("  (re-run this command to confirm idempotency — it should add 0 new events)")
}

main().catch((e) => {
  console.error("\n" + (e instanceof Error ? e.stack : String(e)))
  process.exit(1)
})
