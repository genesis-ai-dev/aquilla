// Replay corpus tooling for the events replay gate
// (sync-worker/src/__tests__/replay-corpus.test.ts, docs/RELEASE-RISK-GATES.md).
//
//   node scripts/replay-corpus.mjs synthetic
//       Regenerates the committed synthetic corpora and pins them in the
//       manifest. Deterministic: same bytes every run.
//   node scripts/replay-corpus.mjs export --url <postgres url> --project <id> [--slug <name>]
//       Captures one real project (events + the rows the rebuild reads) into
//       replay-corpus/cache/<slug>.json and pins it in the manifest as an
//       `r2` entry. Client content: never commit the file, upload it.
//   node scripts/replay-corpus.mjs upload [--slug <name>]
//       Puts cache files for r2 entries into the snapshots bucket.
//   node scripts/replay-corpus.mjs fetch [--slug <name>]
//       Pulls every r2 entry's file into replay-corpus/cache/.
//
// Upload/fetch use wrangler against the production snapshots bucket
// (sync-worker/wrangler.toml SNAPSHOTS) under the replay-corpus/ prefix, so
// they need Cloudflare credentials; CI gets CLOUDFLARE_API_TOKEN.
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

export const CORPUS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../sync-worker/replay-corpus")
export const R2_BUCKET = "aquilla-snapshots"
export const R2_PREFIX = "replay-corpus/"
export const INPUT_TABLES = ["projects", "lanes", "project_seq_counters", "chain_claims", "events"]

export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex")
}

// A row as JSON the harness can bind back into PGlite: bigint columns as
// numbers (every seq/ts in the schema fits), timestamps as ISO strings,
// JSONB kept as the object postgres.js parsed (the harness re-stringifies).
export function serializeRow(row) {
  const out = {}
  for (const [key, value] of Object.entries(row)) {
    if (typeof value === "bigint") out[key] = Number(value)
    else if (value instanceof Date) out[key] = value.toISOString()
    else if (typeof value === "string" && /^\d{1,18}$/.test(value) && /_(seq|ts|at|epoch)$/.test(key)) out[key] = Number(value)
    else out[key] = value
  }
  return out
}

// The corpus file's bytes: table order fixed, rows in the order captured
// (events by server_seq), so the same project captured twice is the same
// bytes and the same sha256.
export function corpusBytes(rows) {
  const ordered = {}
  for (const table of INPUT_TABLES) ordered[table] = rows[table] ?? []
  return `${JSON.stringify(ordered, null, 1)}\n`
}

export function manifestEntry({ slug, projectId, source, file, bytes, events, capturedAt }) {
  const maxSeq = events.reduce((max, event) => Math.max(max, Number(event.server_seq ?? 0)), 0)
  return { slug, projectId, source, file, sha256: sha256Hex(bytes), events: events.length, maxSeq, capturedAt }
}

export function upsertEntry(manifest, entry) {
  const projects = manifest.projects.filter((candidate) => candidate.slug !== entry.slug)
  projects.push(entry)
  projects.sort((a, b) => a.slug.localeCompare(b.slug))
  return { format: 1, projects }
}

export function readManifest(dir = CORPUS_DIR) {
  const file = path.join(dir, "manifest.json")
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { format: 1, projects: [] }
}

export function writeManifest(manifest, dir = CORPUS_DIR) {
  writeFileSync(path.join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`)
}

// ── synthetic corpus ─────────────────────────────────────────────────────
//
// A small project that exercises the chain rules the rebuild arbitrates:
// chained target commits, a sibling race decided by chain_claims rather than
// seq order (AQU-1844), validate then re-commit, a second target lane keyed
// by laneId, a deleted cell, and comments. Not a stand-in for a real log; it
// is what keeps the harness honest when no real corpus is fetched.
export function buildSyntheticCorpus() {
  const projectId = "replay-synthetic-1"
  const lanes = [
    { id: "aa000001", project_id: projectId, role: "source", language: "en", legacy_tag: null, position: 0, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" },
    { id: "aa000002", project_id: projectId, role: "target", language: "fr", legacy_tag: "", position: 1, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" },
    { id: "aa000003", project_id: projectId, role: "target", language: "es", legacy_tag: "es", position: 2, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" },
  ]
  const events = []
  let seq = 0
  const ev = (kind, { fileId = "f-gen", cellId = null, parentId = null, author = "alice", payload = {} } = {}) => {
    seq += 1
    const id = `ev-${String(seq).padStart(4, "0")}`
    events.push({
      id,
      schema_version: 1,
      project_id: projectId,
      file_id: fileId,
      cell_id: cellId,
      kind,
      author,
      payload: JSON.stringify(payload),
      client_ts: 1_700_000_000_000 + seq * 1000,
      server_ts: 1_700_000_000_000 + seq * 1000 + 7,
      parent_id: parentId,
      server_seq: seq,
    })
    return id
  }
  ev("file.create", { payload: { name: "Genesis", fileType: "scripture", sourceLanguage: "en", targetLanguage: "fr" } })
  const cells = ["GEN 1:1", "GEN 1:2", "GEN 1:3", "GEN 1:4", "GEN 1:5"]
  const created = {}
  for (const cellId of cells) {
    created[cellId] = ev("source.cell.create", { cellId, payload: { cellId, value: `Source text of ${cellId}`, valueHtml: `<p>Source text of ${cellId}</p>` } })
  }
  // Chained commits with a validation that a later commit resets.
  const c1 = ev("target.cell.commit", { cellId: cells[0], parentId: created[cells[0]], payload: { value: "Au commencement", valueHtml: "<p>Au commencement</p>", sourceEventId: created[cells[0]] } })
  ev("cell.validate", { cellId: cells[0], author: "bob", payload: { editEventId: c1 } })
  const c2 = ev("target.cell.commit", { cellId: cells[0], parentId: c1, payload: { value: "Au commencement, Dieu", valueHtml: "<p>Au commencement, Dieu</p>", sourceEventId: created[cells[0]] } })
  ev("cell.validate", { cellId: cells[0], author: "bob", payload: { editEventId: c2 } })
  ev("cell.validate", { cellId: cells[0], author: "carol", payload: { editEventId: c2 } })
  // Sibling race: the higher-seq sibling holds the live claim and must win.
  const loser = ev("target.cell.commit", { cellId: cells[1], parentId: created[cells[1]], author: "bob", payload: { value: "perdant", valueHtml: "<p>perdant</p>", sourceEventId: created[cells[1]] } })
  const winner = ev("target.cell.commit", { cellId: cells[1], parentId: created[cells[1]], author: "alice", payload: { value: "gagnant", valueHtml: "<p>gagnant</p>", sourceEventId: created[cells[1]] } })
  ev("target.cell.commit", { cellId: cells[1], parentId: winner, author: "alice", payload: { value: "gagnant, révisé", valueHtml: "<p>gagnant, révisé</p>", sourceEventId: created[cells[1]] } })
  // Second target lane by laneId.
  ev("target.cell.commit", { cellId: cells[2], parentId: created[cells[2]], author: "dora", payload: { value: "Y dijo Dios", valueHtml: "<p>Y dijo Dios</p>", sourceEventId: created[cells[2]], laneId: "aa000003" } })
  // Plain commit then a deleted cell.
  const c4 = ev("target.cell.commit", { cellId: cells[3], parentId: created[cells[3]], payload: { value: "Dieu vit", valueHtml: "<p>Dieu vit</p>", sourceEventId: created[cells[3]] } })
  ev("target.cell.delete", { cellId: cells[4], parentId: created[cells[4]], payload: {} })
  // Comments on a cell and on the file.
  ev("comment.create", { cellId: cells[3], payload: { commentId: "cm-1", scope: { kind: "cell", fileId: "f-gen", cellId: cells[3] }, body: "Check the tense", parentCommentId: null } })
  ev("comment.create", { cellId: cells[3], author: "bob", payload: { commentId: "cm-2", scope: { kind: "cell", fileId: "f-gen", cellId: cells[3] }, body: "Agreed", parentCommentId: "cm-1" } })
  ev("comment.resolve", { cellId: cells[3], payload: { commentId: "cm-1", resolved: true } })
  void c4
  const chainClaims = [
    { project_id: projectId, file_id: "f-gen", cell_id: cells[1], parent_key: created[cells[1]], event_id: winner },
  ]
  void loser
  return {
    projectId,
    rows: {
      projects: [{ id: projectId, name: "Replay synthetic", created_by: 1, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" }],
      lanes,
      project_seq_counters: [{ project_id: projectId, last_seq: seq, rebuilt_seq: 0, project_epoch: 1 }],
      chain_claims: chainClaims,
      events,
    },
  }
}

// ── live export ──────────────────────────────────────────────────────────

export async function exportProject(sql, projectId) {
  const rows = {}
  rows.projects = (await sql.unsafe("SELECT * FROM projects WHERE id = $1", [projectId])).map(serializeRow)
  rows.lanes = (await sql.unsafe("SELECT * FROM lanes WHERE project_id = $1 ORDER BY position, id", [projectId])).map(serializeRow)
  rows.project_seq_counters = (await sql.unsafe("SELECT * FROM project_seq_counters WHERE project_id = $1", [projectId])).map(serializeRow)
  rows.chain_claims = (
    await sql.unsafe("SELECT * FROM chain_claims WHERE project_id = $1 ORDER BY file_id, cell_id, parent_key", [projectId])
  ).map(serializeRow)
  rows.events = (await sql.unsafe("SELECT * FROM events WHERE project_id = $1 ORDER BY server_seq, id", [projectId])).map(serializeRow)
  return rows
}

function arg(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

function wrangler(args) {
  execFileSync("npx", ["wrangler", ...args], { cwd: path.resolve(CORPUS_DIR, ".."), stdio: "inherit" })
}

async function main() {
  const command = process.argv[2]
  const manifest = readManifest()
  if (command === "synthetic") {
    const { projectId, rows } = buildSyntheticCorpus()
    const file = "genesis-sample.json"
    const bytes = corpusBytes(rows)
    mkdirSync(path.join(CORPUS_DIR, "synthetic"), { recursive: true })
    writeFileSync(path.join(CORPUS_DIR, "synthetic", file), bytes)
    const entry = manifestEntry({ slug: "synthetic-genesis", projectId, source: "synthetic", file, bytes, events: rows.events, capturedAt: "2026-10-30T00:00:00.000Z" })
    writeManifest(upsertEntry(manifest, entry))
    console.log(JSON.stringify(entry))
    return
  }
  if (command === "export") {
    const url = arg("--url") ?? process.env.DATABASE_URL
    const projectId = arg("--project")
    if (!url || !projectId) throw new Error("export needs --url (or DATABASE_URL) and --project")
    const slug = arg("--slug") ?? projectId.replace(/[^a-z0-9-]+/gi, "-").toLowerCase()
    const { default: postgres } = await import("postgres")
    const sql = postgres(url, { max: 1, prepare: false })
    try {
      const rows = await exportProject(sql, projectId)
      const file = `${slug}.json`
      const bytes = corpusBytes(rows)
      mkdirSync(path.join(CORPUS_DIR, "cache"), { recursive: true })
      writeFileSync(path.join(CORPUS_DIR, "cache", file), bytes)
      const entry = manifestEntry({ slug, projectId, source: "r2", file, bytes, events: rows.events, capturedAt: new Date().toISOString() })
      writeManifest(upsertEntry(manifest, entry))
      console.log(JSON.stringify(entry))
    } finally {
      await sql.end()
    }
    return
  }
  if (command === "upload" || command === "fetch") {
    const only = arg("--slug")
    const entries = manifest.projects.filter((entry) => entry.source === "r2" && (!only || entry.slug === only))
    mkdirSync(path.join(CORPUS_DIR, "cache"), { recursive: true })
    for (const entry of entries) {
      const local = path.join(CORPUS_DIR, "cache", entry.file)
      const key = `${R2_BUCKET}/${R2_PREFIX}${entry.sha256}-${entry.file}`
      if (command === "upload") wrangler(["r2", "object", "put", key, "--file", local, "--remote"])
      else wrangler(["r2", "object", "get", key, "--file", local, "--remote"])
    }
    console.log(`${command}: ${entries.length} corpus file(s)`)
    return
  }
  throw new Error("usage: replay-corpus.mjs synthetic | export --url <pg> --project <id> | upload | fetch")
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
