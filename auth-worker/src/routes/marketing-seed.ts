// Marketing/demo seed + login bypass — a curated, polished sibling of the
// dev seed (routes/dev-seed.ts). Where the dev seed is an empty scaffold for
// tests, this one stands up a *beautiful, populated* project so screenshots
// and showcase recordings show the real product full of real content (paired
// source/target scripture, validated cells) without anyone hand-entering it.
//
// Endpoints (404 unless gated open):
//   POST /__marketing__/seed   — idempotent (re)seed of the curated demo.
//   POST /__marketing__/login  — seeds, then mints a JWT for the demo user.
//
// GATE: WRANGLER_LOCAL=1 (same hard gate as the dev seed / test reset). This
// covers local + the recording stack (e2e-up passes --var WRANGLER_LOCAL:1).
// A public demo deployment would add a dedicated DEMO_MODE flag here; we keep
// the local gate for now so the surface is invisible in real prod.
//
// Content is PUBLIC DOMAIN: source = KJV (English), target = Louis Segond 1910
// (French). No customer data, no copyright risk — anonymized by construction.

import { Hono } from "hono"
import type { AuthHonoEnv } from "../middleware/auth"
import { JWTService } from "../auth/jwt"
import { hashPasswordWerkzeugScrypt } from "../utils/password"
import { ROLE } from "../types"

const M_USERNAME = "demo"
const M_EMAIL = "demo@aquilla.demo"
const M_PASSWORD = "demo"
const M_ORG_NAME = "Riverstone Bible Society"
const M_PROJECT_ID = "demo-john"
const M_PROJECT_NAME = "John — Plainspeak Draft"
const M_FILE_ID = "demo-john-1"
const M_FILE_NAME = "John 1"
const SOURCE_LANG = "en"
const TARGET_LANG = "fr"

// John 1:1–6 — public domain. [ref, sourceKJV, targetSegond1910].
// A couple of target rows are left blank to make "in progress" honest, and
// the filled ones are marked validated so health indicators light up.
const VERSES: Array<[ref: string, source: string, target: string]> = [
  ["JHN 1:1", "In the beginning was the Word, and the Word was with God, and the Word was God.", "Au commencement était la Parole, et la Parole était avec Dieu, et la Parole était Dieu."],
  ["JHN 1:2", "The same was in the beginning with God.", "Elle était au commencement avec Dieu."],
  ["JHN 1:3", "All things were made by him; and without him was not any thing made that was made.", "Toutes choses ont été faites par elle, et rien de ce qui a été fait n’a été fait sans elle."],
  ["JHN 1:4", "In him was life; and the life was the light of men.", "En elle était la vie, et la vie était la lumière des hommes."],
  ["JHN 1:5", "And the light shineth in darkness; and the darkness comprehended it not.", "La lumière luit dans les ténèbres, et les ténèbres ne l’ont point reçue."],
  ["JHN 1:6", "There was a man sent from God, whose name was John.", ""],
]

interface IdRow { id: number }

function words(s: string): number {
  const t = s.trim()
  return t ? t.split(/\s+/).length : 0
}

async function seedMarketing(db: D1Database): Promise<{
  userId: number
  orgId: number
  projectId: string
}> {
  const passwordHash = await hashPasswordWerkzeugScrypt(M_PASSWORD)

  await db
    .prepare(
      `INSERT INTO users (username, email, password_hash, created_at, updated_at)
       VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT(username) DO UPDATE SET
         email = excluded.email, password_hash = excluded.password_hash,
         updated_at = CURRENT_TIMESTAMP`,
    )
    .bind(M_USERNAME, M_EMAIL, passwordHash)
    .run()
  const userRow = await db.prepare("SELECT id FROM users WHERE username = ?").bind(M_USERNAME).first<IdRow>()
  if (!userRow) throw new Error("demo user not found after upsert")
  const userId = userRow.id

  let orgRow = await db
    .prepare("SELECT id FROM organizations WHERE owner_user_id = ? AND name = ?")
    .bind(userId, M_ORG_NAME)
    .first<IdRow>()
  if (!orgRow) {
    await db
      .prepare(
        `INSERT INTO organizations (name, owner_user_id, created_at, updated_at)
         VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      )
      .bind(M_ORG_NAME, userId)
      .run()
    orgRow = await db
      .prepare("SELECT id FROM organizations WHERE owner_user_id = ? AND name = ?")
      .bind(userId, M_ORG_NAME)
      .first<IdRow>()
  }
  if (!orgRow) throw new Error("demo org not found after insert")
  const orgId = orgRow.id

  await db
    .prepare(
      `INSERT INTO org_members (org_id, user_id, role_level, granted_by, granted_at)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(org_id, user_id) DO UPDATE SET role_level = excluded.role_level`,
    )
    .bind(orgId, userId, ROLE.OWNER, userId)
    .run()

  await db
    .prepare(
      `INSERT INTO projects (id, name, org_id, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, org_id = excluded.org_id,
         updated_at = CURRENT_TIMESTAMP`,
    )
    .bind(M_PROJECT_ID, M_PROJECT_NAME, orgId, userId)
    .run()

  await db
    .prepare(
      `INSERT INTO project_members (project_id, user_id, role_level, granted_by, granted_at)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(project_id, user_id) DO UPDATE SET role_level = excluded.role_level`,
    )
    .bind(M_PROJECT_ID, userId, ROLE.OWNER, userId)
    .run()

  // Idempotent content reseed: drop any prior demo file/cells/events first.
  // Order matters: cells.event_id FKs events(id), so cells before events.
  await db.prepare("DELETE FROM cells WHERE project_id = ? AND file_id = ?").bind(M_PROJECT_ID, M_FILE_ID).run()
  await db.prepare("DELETE FROM events WHERE project_id = ? AND file_id = ?").bind(M_PROJECT_ID, M_FILE_ID).run()
  await db.prepare("DELETE FROM files WHERE id = ? AND project_id = ?").bind(M_FILE_ID, M_PROJECT_ID).run()

  const now = Date.now()

  // server_seq is NOT NULL + UNIQUE(project_id, server_seq) — assign a
  // monotonic per-project sequence. Start past any existing max so re-seeds
  // never collide.
  const seqRow = await db
    .prepare("SELECT COALESCE(MAX(server_seq), 0) AS m FROM events WHERE project_id = ?")
    .bind(M_PROJECT_ID)
    .first<{ m: number }>()
  let seq = Number(seqRow?.m ?? 0)

  async function insertEvent(opts: { id: string; cellId: string | null; kind: string; payload: unknown }): Promise<void> {
    seq += 1
    await db
      .prepare(
        `INSERT INTO events (id, schema_version, project_id, file_id, cell_id, kind, author, payload, client_ts, server_ts, parent_id, server_seq)
         VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      )
      .bind(opts.id, M_PROJECT_ID, M_FILE_ID, opts.cellId, opts.kind, M_USERNAME, JSON.stringify(opts.payload), now, now, seq)
      .run()
  }

  // File-level genesis event — files.event_id is NOT NULL (AD-2 chain head).
  const fileEventId = crypto.randomUUID()
  await insertEvent({ id: fileEventId, cellId: null, kind: "file.create", payload: { name: M_FILE_NAME, book: "JHN" } })

  let totalWords = 0
  let filled = 0
  let approved = 0
  let prevCellId: string | null = null

  // Paired source/target rows. Each cell row gets a backing event (FK), and
  // target rows pin the source event_id (AD-9 staleness basis). Column order
  // matches the sync-worker's cells read/write contract.
  for (const [ref, source, target] of VERSES) {
    const cellId = crypto.randomUUID()

    const srcEventId = crypto.randomUUID()
    await insertEvent({ id: srcEventId, cellId, kind: "source.cell.commit", payload: { value: source, ref } })
    await db
      .prepare(
        `INSERT INTO cells (project_id, file_id, cell_id, side, value, value_html, type, canonical_ref, anchor_cell_id, event_id, source_event_id, last_editor, last_edit_at, validated, word_count, content_hash)
         VALUES (?, ?, ?, 'source', ?, NULL, 'verse', ?, ?, ?, NULL, ?, ?, 0, ?, NULL)`,
      )
      .bind(M_PROJECT_ID, M_FILE_ID, cellId, source, ref, prevCellId, srcEventId, M_USERNAME, now, words(source))
      .run()

    const hasTarget = target.trim().length > 0
    const tgtEventId = crypto.randomUUID()
    await insertEvent({ id: tgtEventId, cellId, kind: "target.cell.commit", payload: { value: target, ref } })
    await db
      .prepare(
        `INSERT INTO cells (project_id, file_id, cell_id, side, value, value_html, type, canonical_ref, anchor_cell_id, event_id, source_event_id, last_editor, last_edit_at, validated, word_count, content_hash)
         VALUES (?, ?, ?, 'target', ?, NULL, 'verse', ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .bind(M_PROJECT_ID, M_FILE_ID, cellId, target, ref, prevCellId, tgtEventId, srcEventId, M_USERNAME, now, hasTarget ? 1 : 0, words(target))
      .run()

    totalWords += words(source) + words(target)
    if (hasTarget) { filled += 1; approved += 1 }
    prevCellId = cellId
  }

  // files: 0012 shape — no file_type/source_language columns (those live in
  // `meta`); event_id NOT NULL; meta NOT NULL. fileType is derived by the
  // read route as kind ?? role ?? 'codex'.
  const meta = JSON.stringify({ source_language: SOURCE_LANG, target_language: TARGET_LANG, import_format: "usfm" })
  await db
    .prepare(
      `INSERT INTO files (id, project_id, name, role, kind, book_code, event_id,
         cell_count, approved_count, word_count, last_edit_at, created_by, created_at, updated_at, meta, filled_count)
       VALUES (?, ?, ?, 'target', 'scripture', 'JHN', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(M_FILE_ID, M_PROJECT_ID, M_FILE_NAME, fileEventId, VERSES.length, approved, totalWords, now, M_USERNAME, now, now, meta, filled)
    .run()

  return { userId, orgId, projectId: M_PROJECT_ID }
}

const marketing = new Hono<AuthHonoEnv>()

function gateOpen(c: { env: AuthHonoEnv["Bindings"] }): boolean {
  return c.env.WRANGLER_LOCAL === "1"
}

marketing.post("/seed", async (c) => {
  if (!gateOpen(c)) return c.json({ error: "Not found" }, 404)
  try {
    const ids = await seedMarketing(c.env.AQUILLA_DB)
    return c.json({ ok: true, user: { id: ids.userId, username: M_USERNAME }, org: { id: ids.orgId, name: M_ORG_NAME }, project: { id: ids.projectId, name: M_PROJECT_NAME } })
  } catch (err) {
    console.error("[marketing-seed] failed:", err)
    return c.json({ error: "seed failed", detail: err instanceof Error ? err.message : String(err) }, 500)
  }
})

marketing.post("/login", async (c) => {
  if (!gateOpen(c)) return c.json({ error: "Not found" }, 404)
  if (!c.env.SECRET_KEY || !c.env.ALGORITHM) {
    return c.json({ error: "Authentication is not configured (SECRET_KEY/ALGORITHM)" }, 503)
  }
  try {
    const ids = await seedMarketing(c.env.AQUILLA_DB)
    const jwt = new JWTService(c.env)
    const accessToken = await jwt.createAccessToken(M_USERNAME)
    return c.json({
      access_token: accessToken,
      token_type: "bearer",
      username: M_USERNAME,
      user: { id: ids.userId, username: M_USERNAME, email: M_EMAIL },
      org: { id: ids.orgId, name: M_ORG_NAME },
      project: { id: ids.projectId, name: M_PROJECT_NAME },
    })
  } catch (err) {
    console.error("[marketing-login] failed:", err)
    return c.json({ error: "marketing login failed", detail: err instanceof Error ? err.message : String(err) }, 500)
  }
})

export default marketing
