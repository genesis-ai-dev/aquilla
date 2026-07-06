#!/usr/bin/env tsx
// Extract a curated, PII-scrubbed slice of PROD into a zstd bundle in R2.
// Maintainer-only — needs prod Neon creds and wrangler R2 access.
//
//   set -a; . ./.env; set +a
//   npx tsx scripts/seed-extract.ts            # extract → bundle → R2 → meta
//   npx tsx scripts/seed-extract.ts --no-upload # write local bundle, skip R2 put
//
// Reads db/seed/manifest.json, resolves the identity closure for the listed
// projects, applies a deterministic identity remap (see spec), writes per-table
// JSONL, zstd-compresses it, uploads to the prod aquilla-snapshots bucket, and
// writes db/seed/seed.meta.json (the only committed artifact).
import { Client } from "pg"
import { createHash } from "node:crypto"
import { zstdCompressSync } from "node:zlib"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { neonConfig } from "./pg"
import {
  SEED_TABLES, TABLE_HEADER_KEY, fakeUser, makeAuthorRemap, type IdSet,
} from "./lib/seed-tables"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const SEED_DIR = path.join(ROOT, "db", "seed")
const CACHE_DIR = path.join(SEED_DIR, ".cache")
const PAGE = 10000 // content rows per keyset page (bounds memory; fewer WAN round trips)

interface Manifest {
  version: number
  projectIds: string[]
  scrub: { emailDomain: string; keepDisplayNames: boolean }
  r2: { accountId: string; bucket: string; prefix: string; bundleName: string }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** Upload bundle to R2, then read it back and verify the sha — retrying to absorb
 *  read-after-write lag. Fails loud if the object never matches. */
async function uploadAndVerify(manifest: Manifest, bundlePath: string, r2Key: string, sha256: string) {
  const wenv = { ...process.env, CLOUDFLARE_ACCOUNT_ID: manifest.r2.accountId }
  const obj = `${manifest.r2.bucket}/${r2Key}`
  console.log(`Uploading r2://${obj} …`)
  execFileSync("npx", ["wrangler", "r2", "object", "put", obj, "--file", bundlePath, "--remote"], { stdio: "inherit", env: wenv })
  const verifyPath = bundlePath + ".verify"
  for (let attempt = 1; attempt <= 5; attempt++) {
    await sleep(attempt * 2000)
    fs.rmSync(verifyPath, { force: true })
    try {
      execFileSync("npx", ["wrangler", "r2", "object", "get", obj, "--file", verifyPath, "--remote"], { stdio: "inherit", env: wenv })
      const back = createHash("sha256").update(fs.readFileSync(verifyPath)).digest("hex")
      fs.rmSync(verifyPath, { force: true })
      if (back === sha256) { console.log(`✓ R2 read-back verified (attempt ${attempt})`); return }
      console.warn(`  read-back mismatch (attempt ${attempt}/5): got ${back.slice(0, 12)}…`)
    } catch (e) {
      console.warn(`  read-back failed (attempt ${attempt}/5): ${(e as Error).message.split("\n")[0]}`)
    }
  }
  fs.rmSync(verifyPath, { force: true })
  throw new Error(`R2 read-back never matched sha ${sha256} after 5 attempts — upload did not persist intact`)
}

async function distinct(c: Client, sql: string, params: unknown[]): Promise<Set<string>> {
  const r = await c.query(sql, params)
  const s = new Set<string>()
  for (const row of r.rows) for (const v of Object.values(row)) if (v != null) s.add(String(v))
  return s
}

async function main() {
  const noUpload = process.argv.includes("--no-upload")
  const manifest: Manifest = JSON.parse(fs.readFileSync(path.join(SEED_DIR, "manifest.json"), "utf8"))
  const projectIds = manifest.projectIds
  if (!projectIds.length) throw new Error("manifest.projectIds is empty")
  const { emailDomain, keepDisplayNames } = manifest.scrub

  const c = new Client(neonConfig())
  await c.connect()
  try {
    // ── 1. resolve id closure ──────────────────────────────────────────────
    console.log(`Resolving closure for ${projectIds.length} projects…`)
    const orgIds = new Set<string>()
    const groupIds = new Set<string>()
    const userIds = new Set<string>()
    const usernames = new Set<string>()
    const assignmentIds = new Set<string>()

    const projRows = (await c.query(
      `SELECT id, org_id, created_by, archived_by FROM projects WHERE id = ANY($1)`, [projectIds],
    )).rows
    for (const p of projRows) {
      if (p.org_id != null) orgIds.add(String(p.org_id))
      for (const u of [p.created_by, p.archived_by]) if (u != null) userIds.add(String(u))
    }
    // groups that grant these projects
    for (const v of await distinct(c, `SELECT group_id FROM group_project_grants WHERE project_id = ANY($1)`, [projectIds])) groupIds.add(v)
    for (const v of await distinct(c, `SELECT granted_by FROM group_project_grants WHERE project_id = ANY($1) AND granted_by IS NOT NULL`, [projectIds])) userIds.add(v)
    // groups → their org + creators
    if (groupIds.size) {
      const gr = (await c.query(`SELECT id, org_id, created_by FROM groups WHERE id = ANY($1)`, [[...groupIds]])).rows
      for (const g of gr) { if (g.org_id != null) orgIds.add(String(g.org_id)); if (g.created_by != null) userIds.add(String(g.created_by)) }
    }
    // orgs → owners
    if (orgIds.size) {
      for (const v of await distinct(c, `SELECT owner_user_id FROM organizations WHERE id = ANY($1) AND owner_user_id IS NOT NULL`, [[...orgIds]])) userIds.add(v)
    }
    // members
    if (orgIds.size) for (const col of ["user_id", "granted_by"]) for (const v of await distinct(c, `SELECT ${col} FROM org_members WHERE org_id = ANY($1) AND ${col} IS NOT NULL`, [[...orgIds]])) userIds.add(v)
    if (groupIds.size) for (const col of ["user_id", "added_by"]) for (const v of await distinct(c, `SELECT ${col} FROM group_members WHERE group_id = ANY($1) AND ${col} IS NOT NULL`, [[...groupIds]])) userIds.add(v)
    for (const col of ["user_id", "granted_by"]) for (const v of await distinct(c, `SELECT ${col} FROM project_members WHERE project_id = ANY($1) AND ${col} IS NOT NULL`, [projectIds])) userIds.add(v)
    // assignments → ids + assignee/creator
    const asg = (await c.query(`SELECT assignment_id, assignee_user_id, created_by FROM assignments WHERE project_id = ANY($1)`, [projectIds])).rows
    for (const a of asg) { assignmentIds.add(String(a.assignment_id)); for (const u of [a.assignee_user_id, a.created_by]) if (u != null) userIds.add(String(u)) }
    // checkpoints creators
    for (const v of await distinct(c, `SELECT created_by FROM checkpoints WHERE project_id = ANY($1) AND created_by IS NOT NULL`, [projectIds])) userIds.add(v)
    // authors referenced by username (text) across content
    for (const v of await distinct(c, `SELECT DISTINCT author FROM events WHERE project_id = ANY($1)`, [projectIds])) usernames.add(v)
    for (const v of await distinct(c, `SELECT DISTINCT last_editor FROM cells WHERE project_id = ANY($1) AND last_editor IS NOT NULL`, [projectIds])) usernames.add(v)
    for (const v of await distinct(c, `SELECT DISTINCT username FROM cell_validators WHERE project_id = ANY($1)`, [projectIds])) usernames.add(v)
    for (const v of await distinct(c, `SELECT DISTINCT author FROM cell_backtranslations WHERE project_id = ANY($1)`, [projectIds])) usernames.add(v)
    for (const v of await distinct(c, `SELECT DISTINCT author_id FROM comments WHERE project_id = ANY($1)`, [projectIds])) usernames.add(v)

    // resolve user rows by id OR username → complete closure
    const userRows = (await c.query(
      `SELECT id, username, email, password_hash, preferences, created_at, updated_at, display_name, avatar_url
       FROM users WHERE id = ANY($1) OR username = ANY($2)`,
      [[...userIds], [...usernames]],
    )).rows
    for (const u of userRows) userIds.add(String(u.id))
    console.log(`Closure: ${userRows.length} users, ${orgIds.size} orgs, ${groupIds.size} groups, ${assignmentIds.size} assignments`)

    // ── 2. build deterministic remap ───────────────────────────────────────
    const byUsername = new Map<string, string>()
    const byId = new Map<string, string>()
    const fakeById = new Map<string, ReturnType<typeof fakeUser>>()
    for (const u of userRows) {
      const f = fakeUser(u.id, emailDomain, keepDisplayNames, u.display_name)
      fakeById.set(String(u.id), f)
      byId.set(String(u.id), f.username)
      if (u.username != null) byUsername.set(String(u.username), f.username)
    }
    const unmapped = new Set<string>()
    const remapAuthor = makeAuthorRemap(byUsername, byId, (t) => unmapped.add(t))

    const idSets: Record<IdSet, string[]> = {
      project: projectIds, user: [...userIds], org: [...orgIds], group: [...groupIds], assignment: [...assignmentIds],
    }

    // ── 3. stream rows → JSONL temp file ───────────────────────────────────
    fs.mkdirSync(CACHE_DIR, { recursive: true })
    const tmp = path.join(CACHE_DIR, "seed.bundle.jsonl")
    const out = fs.createWriteStream(tmp)
    const write = (obj: unknown) => new Promise<void>((res, rej) => out.write(JSON.stringify(obj) + "\n", (e) => e ? rej(e) : res()))
    const counts: Record<string, number> = {}

    for (const t of SEED_TABLES) {
      await write({ [TABLE_HEADER_KEY]: t.name })
      const ids = idSets[t.by.set]
      let n = 0
      if (ids.length) {
        // Keyset pagination on the primary key (row-value comparison) — uses the PK
        // btree index, so total cost is O(rows), not the O(rows²) of LIMIT/OFFSET.
        const key = t.pageKey ?? t.pk
        const keyList = key.map((x) => `"${x}"`).join(", ")
        const orderBy = keyList
        let cursor: unknown[] | null = null
        for (;;) {
          let sql: string
          let params: unknown[]
          if (cursor === null) {
            sql = `SELECT * FROM ${t.name} WHERE ${t.by.col} = ANY($1) ORDER BY ${orderBy} LIMIT ${PAGE}`
            params = [ids]
          } else {
            const ph = key.map((_, i) => `$${i + 2}`).join(", ")
            sql = `SELECT * FROM ${t.name} WHERE ${t.by.col} = ANY($1) AND (${keyList}) > (${ph}) ORDER BY ${orderBy} LIMIT ${PAGE}`
            params = [ids, ...cursor]
          }
          const rows = (await c.query(sql, params)).rows
          if (!rows.length) break
          cursor = key.map((col) => rows[rows.length - 1][col])
          for (const row of rows) {
            if (t.name === "users") {
              const f = fakeById.get(String(row.id))!
              row.username = f.username; row.email = f.email; row.display_name = f.display_name
              row.password_hash = ""; row.avatar_url = null; row.preferences = "{}"
            }
            if (t.authorCols) for (const col of t.authorCols) if (col in row) row[col] = remapAuthor(row[col])
            await write(row)
            n++
          }
          if (rows.length < PAGE) break
        }
      }
      counts[t.name] = n
      console.log(`  ${t.name}: ${n}`)
    }
    await new Promise<void>((res) => out.end(res))

    if (unmapped.size) {
      console.warn(`\n⚠ ${unmapped.size} author token(s) had no user match (passed through unscrubbed):`)
      console.warn("  " + [...unmapped].slice(0, 50).join(", ") + (unmapped.size > 50 ? " …" : ""))
    }

    // ── 4. compress + checksum ─────────────────────────────────────────────
    const raw = fs.readFileSync(tmp)
    const compressed = zstdCompressSync(raw)
    const sha256 = createHash("sha256").update(compressed).digest("hex")
    // Content-addressed object name: every extract is a FRESH key, so we never
    // overwrite an existing R2 object (overwrites can briefly read back empty).
    const bundleFileName = `dev-seed-${sha256.slice(0, 12)}.jsonl.zst`
    const bundlePath = path.join(CACHE_DIR, bundleFileName)
    fs.writeFileSync(bundlePath, compressed)
    const schemaHash = createHash("sha256").update(fs.readFileSync(path.join(ROOT, "db", "postgres", "schema.sql"))).digest("hex")
    console.log(`\nBundle: ${(raw.length / 1e6).toFixed(1)} MB raw → ${(compressed.length / 1e6).toFixed(1)} MB zstd → ${bundleFileName}`)

    // ── 5. upload to R2 (with verified read-back) ──────────────────────────
    const r2Key = `${manifest.r2.prefix}${bundleFileName}`
    if (!noUpload) await uploadAndVerify(manifest, bundlePath, r2Key, sha256)
    else console.log("--no-upload: skipping R2 put")

    // ── 6. write committed meta ────────────────────────────────────────────
    const meta = {
      generatedAt: new Date().toISOString(),
      source: "prod neon sweet-paper-88472094",
      r2: { accountId: manifest.r2.accountId, bucket: manifest.r2.bucket, key: r2Key },
      bundleBytes: compressed.length,
      sha256,
      schemaHash,
      projectIds,
      counts,
    }
    fs.writeFileSync(path.join(SEED_DIR, "seed.meta.json"), JSON.stringify(meta, null, 2) + "\n")
    fs.rmSync(tmp, { force: true })
    console.log(`\n✓ wrote db/seed/seed.meta.json (sha256 ${sha256.slice(0, 12)}…)`)
  } finally {
    await c.end()
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
