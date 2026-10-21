// LangQuest live links — mounted at /api/v2/langquest in src/index.ts.
//
//   POST   /inspect                          signed in — { token }: what the token reaches and may do (stores nothing)
//   GET    /projects/:projectId/link         any project member — the link (never the token), or { link: null }
//   PUT    /projects/:projectId/link         project maintainer+ — { token, languageId }: checked with LangQuest, stored encrypted
//   DELETE /projects/:projectId/link         project maintainer+ — unlink (?revoke=1 also revokes the token at LangQuest)
//   GET    /projects/:projectId/state        project lead+ — feed cursor + the passage→cell map, for a sync
//   POST   /projects/:projectId/state        project lead+ — record what a sync imported (map rows, cursor, outcome)
//   GET    /projects/:projectId/changes      project lead+ — LangQuest's change feed (?after=cursor)
//   GET    /projects/:projectId/passages     project lead+ — passages with audio (?after, repeated ?unitIds)
//   GET    /projects/:projectId/audio        project lead+ — one LangQuest audio card (?url=<signed blob url>)
//   POST   /projects/:projectId/releases     project maintainer+ — report approved versions live/taken down on a channel
//
// The browser never holds the token after the paste: LangQuest says tokens
// that can review or release belong on a server (docs/agent-api.md), and a
// project's other members should not be able to lift it. The sync itself runs
// in the browser (src/lib/langquest/sync.ts), which already owns the import
// pipeline; it reads LangQuest through these routes. Reading a linked
// language's data takes project lead, the role that may write source cells.

import { Hono } from "hono"
import { zValidator } from "@hono/zod-validator"
import { z } from "zod"
import type { Context } from "hono"
import { authMiddleware, type AuthHonoEnv } from "../middleware/auth"
import { ROLE, type Env } from "../types"
import { parseJsonColumn } from "../lib/monday/types"
import { MondayForeignConnectionError, runningEnvironment } from "../lib/monday/tokens"
import {
  isLangQuestBlobUrl,
  LangQuestApiError,
  LangQuestClient,
  langquestApiBase,
  type LangQuestCan,
  type LangQuestMe,
  type LangQuestPassage,
  type LangQuestScope,
} from "../lib/langquest/client"
import { encryptLangQuestToken, getLangQuestToken } from "../lib/langquest/tokens"
import { MANAGE_MIN_ROLE, projectGuard } from "./_integration-helpers"

const langquest = new Hono<AuthHonoEnv>()

/** Syncing writes source cells, which takes a project lead (sync-worker role-policy). */
const SYNC_MIN_ROLE = ROLE.PROJECT_LEAD

interface LinkRow {
  project_id: string
  token_enc: string
  environment: string | null
  api_base: string
  lq_org_id: string
  lq_org_name: string | null
  language_id: string
  language_name: string | null
  language_code: string | null
  token_id: string | null
  scopes: unknown
  can: unknown
  token_expires_at: string | Date | null
  feed_cursor: string | null
  needs_reauth: boolean
  last_synced_at: string | Date | null
  last_sync_error: string | null
  created_by: string
  created_at: string | Date
}

const iso = (v: string | Date | null): string | null =>
  v == null ? null : v instanceof Date ? v.toISOString() : new Date(v).toISOString()

/** The link as routes return it: everything but the token. */
function linkOut(row: LinkRow) {
  return {
    projectId: row.project_id,
    apiBase: row.api_base,
    org: { id: row.lq_org_id, name: row.lq_org_name ?? "" },
    language: { id: row.language_id, name: row.language_name ?? "", code: row.language_code ?? "" },
    scopes: parseJsonColumn<LangQuestScope[]>(row.scopes, []),
    can: parseJsonColumn<LangQuestCan | null>(row.can, null),
    tokenExpiresAt: iso(row.token_expires_at),
    needsReauth: row.needs_reauth,
    lastSyncedAt: iso(row.last_synced_at),
    lastSyncError: row.last_sync_error,
    linkedBy: row.created_by,
    linkedAt: iso(row.created_at),
  }
}

async function getLink(env: Env, projectId: string): Promise<LinkRow | null> {
  return env.AQUILLA_PG.prepare("SELECT * FROM langquest_links WHERE project_id = ?")
    .bind(projectId)
    .first<LinkRow>()
}

/** What a LangQuest failure becomes here. A rejected token marks the link for a new one. */
async function langquestFailure(
  c: Context<AuthHonoEnv>,
  err: unknown,
  projectId?: string,
): Promise<Response> {
  if (err instanceof MondayForeignConnectionError) {
    return c.json({ error: err.message, reason: "foreign_environment", needsReauth: true }, 409)
  }
  if (err instanceof LangQuestApiError) {
    if (err.tokenRejected && projectId) {
      await c.env.AQUILLA_PG.prepare(
        "UPDATE langquest_links SET needs_reauth = TRUE, updated_at = now() WHERE project_id = ?",
      )
        .bind(projectId)
        .run()
    }
    // 410 is LangQuest's expired feed cursor: the caller starts over from a full listing.
    const status = err.status === 410 ? 410 : err.tokenRejected ? 401 : err.status === 403 ? 403 : 502
    return c.json(
      { error: err.message, reason: err.code ?? "langquest_error", needsReauth: err.tokenRejected },
      status,
    )
  }
  console.warn("[langquest] request failed:", err)
  return c.json({ error: "Couldn't reach LangQuest", reason: "unreachable" }, 502)
}

/** Guard + the link + a client holding its token, or the Response to return. */
async function linkClient(
  c: Context<AuthHonoEnv>,
  minRole: number,
): Promise<{ projectId: string; link: LinkRow; client: LangQuestClient } | Response> {
  const guard = await projectGuard(c, minRole)
  if (guard instanceof Response) return guard
  const link = await getLink(c.env, guard.projectId)
  if (!link) return c.json({ error: "project is not linked to LangQuest" }, 404)
  try {
    const token = await getLangQuestToken(c.env, link)
    return { projectId: guard.projectId, link, client: new LangQuestClient(link.api_base, token) }
  } catch (err) {
    return langquestFailure(c, err)
  }
}

const tokenSchema = z.object({ token: z.string().trim().regex(/^lqp_[A-Za-z0-9_-]{16,}$/, "not a LangQuest token") })

langquest.post("/inspect", authMiddleware, zValidator("json", tokenSchema), async (c) => {
  const { token } = c.req.valid("json")
  const base = langquestApiBase(c.env)
  try {
    const me = await new LangQuestClient(base, token).me()
    return c.json({ apiBase: base, ...inspection(me) })
  } catch (err) {
    return langquestFailure(c, err)
  }
})

function inspection(me: LangQuestMe) {
  return {
    org: me.org,
    token: {
      id: me.token.id,
      name: me.token.name,
      scopes: me.token.scopes,
      expiresAt: me.token.expiresAt,
      allLanguages: me.token.languageIds == null,
    },
    languages: me.languages,
  }
}

langquest.get("/projects/:projectId/link", authMiddleware, async (c) => {
  const guard = await projectGuard(c, null)
  if (guard instanceof Response) return guard
  const link = await getLink(c.env, guard.projectId)
  return c.json({ link: link ? linkOut(link) : null })
})

const putLinkSchema = tokenSchema.extend({ languageId: z.string().min(1).max(500) })

langquest.put("/projects/:projectId/link", authMiddleware, zValidator("json", putLinkSchema), async (c) => {
  const guard = await projectGuard(c, MANAGE_MIN_ROLE)
  if (guard instanceof Response) return guard
  const { token, languageId } = c.req.valid("json")
  const base = langquestApiBase(c.env)
  let me: LangQuestMe
  try {
    me = await new LangQuestClient(base, token).me()
  } catch (err) {
    return langquestFailure(c, err)
  }
  const language = me.languages.find((l) => l.languageId === languageId)
  if (!language || language.can.read == null) {
    return c.json({ error: "this token cannot read that language", reason: "language_not_readable" }, 400)
  }
  const existing = await getLink(c.env, guard.projectId)
  const stmts = [
    c.env.AQUILLA_PG.prepare(
      `INSERT INTO langquest_links (project_id, token_enc, environment, api_base, lq_org_id, lq_org_name,
         language_id, language_name, language_code, token_id, scopes, can, token_expires_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (project_id) DO UPDATE SET
         token_enc = excluded.token_enc, environment = excluded.environment, api_base = excluded.api_base,
         lq_org_id = excluded.lq_org_id, lq_org_name = excluded.lq_org_name,
         language_id = excluded.language_id, language_name = excluded.language_name,
         language_code = excluded.language_code, token_id = excluded.token_id, scopes = excluded.scopes,
         can = excluded.can, token_expires_at = excluded.token_expires_at,
         needs_reauth = FALSE, updated_at = now()`,
    ).bind(
      guard.projectId,
      await encryptLangQuestToken(c.env, token),
      runningEnvironment(c.env),
      base,
      me.org.id,
      me.org.name,
      language.languageId,
      language.name,
      language.code,
      me.token.id,
      JSON.stringify(me.token.scopes),
      JSON.stringify(language.can),
      me.token.expiresAt,
      c.get("user").username,
    ),
  ]
  // A new token for the same language keeps what was imported; another
  // language starts from a full listing with an empty map.
  if (existing && existing.language_id !== language.languageId) {
    stmts.push(
      c.env.AQUILLA_PG.prepare("DELETE FROM langquest_passages WHERE project_id = ?").bind(guard.projectId),
      c.env.AQUILLA_PG.prepare("UPDATE langquest_links SET feed_cursor = NULL WHERE project_id = ?").bind(
        guard.projectId,
      ),
    )
  }
  await c.env.AQUILLA_PG.batch(stmts)
  const link = await getLink(c.env, guard.projectId)
  return c.json({ link: link ? linkOut(link) : null })
})

langquest.delete("/projects/:projectId/link", authMiddleware, async (c) => {
  const guard = await projectGuard(c, MANAGE_MIN_ROLE)
  if (guard instanceof Response) return guard
  const link = await getLink(c.env, guard.projectId)
  if (!link) return c.json({ ok: true, revoked: false })
  let revoked = false
  if (c.req.query("revoke") === "1") {
    // Best-effort: unlinking must not depend on LangQuest answering.
    try {
      await new LangQuestClient(link.api_base, await getLangQuestToken(c.env, link)).revoke()
      revoked = true
    } catch (err) {
      console.warn("[langquest] revoke on unlink failed:", err)
    }
  }
  await c.env.AQUILLA_PG.prepare("DELETE FROM langquest_links WHERE project_id = ?").bind(guard.projectId).run()
  return c.json({ ok: true, revoked })
})

langquest.get("/projects/:projectId/state", authMiddleware, async (c) => {
  const guard = await projectGuard(c, SYNC_MIN_ROLE)
  if (guard instanceof Response) return guard
  const link = await getLink(c.env, guard.projectId)
  if (!link) return c.json({ error: "project is not linked to LangQuest" }, 404)
  const { results } = await c.env.AQUILLA_PG.prepare(
    `SELECT unit_id, file_id, cell_id, label, sort_order, take_id
       FROM langquest_passages WHERE project_id = ? ORDER BY sort_order, unit_id`,
  )
    .bind(guard.projectId)
    .all<{ unit_id: string; file_id: string; cell_id: string; label: string | null; sort_order: string | null; take_id: string | null }>()
  return c.json({
    link: linkOut(link),
    cursor: link.feed_cursor,
    passages: results.map((r) => ({
      unitId: r.unit_id,
      fileId: r.file_id,
      cellId: r.cell_id,
      label: r.label ?? "",
      order: r.sort_order ?? "",
      takeId: r.take_id,
    })),
  })
})

const passageRowSchema = z.object({
  unitId: z.string().min(1).max(500),
  fileId: z.string().min(1).max(255),
  cellId: z.string().min(1).max(255),
  label: z.string().max(1000),
  order: z.string().max(500),
  takeId: z.string().max(500).nullable(),
})

const postStateSchema = z.object({
  upserts: z.array(passageRowSchema).max(1000).default([]),
  removed: z.array(z.string().min(1).max(500)).max(1000).default([]),
  /** Omit to leave the cursor where it is; null starts the next sync from a full listing. */
  cursor: z.string().max(100).nullable().optional(),
  /** Set when a sync finished: null for success, else what went wrong. */
  outcome: z.object({ error: z.string().max(1000).nullable() }).optional(),
})

langquest.post("/projects/:projectId/state", authMiddleware, zValidator("json", postStateSchema), async (c) => {
  const guard = await projectGuard(c, SYNC_MIN_ROLE)
  if (guard instanceof Response) return guard
  if (!(await getLink(c.env, guard.projectId))) return c.json({ error: "project is not linked to LangQuest" }, 404)
  const body = c.req.valid("json")
  const db = c.env.AQUILLA_PG
  const stmts = [
    ...body.upserts.map((p) =>
      db
        .prepare(
          `INSERT INTO langquest_passages (project_id, unit_id, file_id, cell_id, label, sort_order, take_id)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (project_id, unit_id) DO UPDATE SET file_id = excluded.file_id, cell_id = excluded.cell_id,
             label = excluded.label, sort_order = excluded.sort_order, take_id = excluded.take_id`,
        )
        .bind(guard.projectId, p.unitId, p.fileId, p.cellId, p.label, p.order, p.takeId),
    ),
    ...body.removed.map((unitId) =>
      db.prepare("DELETE FROM langquest_passages WHERE project_id = ? AND unit_id = ?").bind(guard.projectId, unitId),
    ),
  ]
  if (body.cursor !== undefined) {
    stmts.push(
      db.prepare("UPDATE langquest_links SET feed_cursor = ?, updated_at = now() WHERE project_id = ?").bind(
        body.cursor,
        guard.projectId,
      ),
    )
  }
  if (body.outcome) {
    stmts.push(
      db
        .prepare(
          `UPDATE langquest_links SET last_synced_at = now(), last_sync_error = ?, updated_at = now()
            WHERE project_id = ?`,
        )
        .bind(body.outcome.error, guard.projectId),
    )
  }
  if (stmts.length > 0) await db.batch(stmts)
  return c.json({ ok: true })
})

langquest.get("/projects/:projectId/changes", authMiddleware, async (c) => {
  const ctx = await linkClient(c, SYNC_MIN_ROLE)
  if (ctx instanceof Response) return ctx
  try {
    return c.json(await ctx.client.changes(ctx.link.language_id, c.req.query("after") ?? null))
  } catch (err) {
    return langquestFailure(c, err, ctx.projectId)
  }
})

langquest.get("/projects/:projectId/passages", authMiddleware, async (c) => {
  const ctx = await linkClient(c, SYNC_MIN_ROLE)
  if (ctx instanceof Response) return ctx
  const unitIds = c.req.queries("unitIds") ?? []
  if (unitIds.length > 100) return c.json({ error: "at most 100 unitIds per page" }, 400)
  try {
    return c.json(
      await ctx.client.passages(ctx.link.language_id, {
        unitIds,
        after: c.req.query("after") ?? null,
        limit: unitIds.length > 0 ? 100 : 50,
      }),
    )
  } catch (err) {
    return langquestFailure(c, err, ctx.projectId)
  }
})

langquest.get("/projects/:projectId/audio", authMiddleware, async (c) => {
  const guard = await projectGuard(c, SYNC_MIN_ROLE)
  if (guard instanceof Response) return guard
  const link = await getLink(c.env, guard.projectId)
  if (!link) return c.json({ error: "project is not linked to LangQuest" }, 404)
  const url = c.req.query("url") ?? ""
  // Signed links play without a token; the only check that matters is that
  // this route never fetches anything but LangQuest's own audio.
  if (!isLangQuestBlobUrl(link.api_base, url)) return c.json({ error: "not a LangQuest audio link" }, 400)
  const upstream = await fetch(url)
  if (!upstream.ok || !upstream.body) {
    return c.json({ error: `LangQuest audio answered ${upstream.status}`, reason: "audio_unavailable" }, 502)
  }
  return new Response(upstream.body, {
    status: 200,
    headers: {
      "Content-Type": upstream.headers.get("Content-Type") ?? "application/octet-stream",
      ...(upstream.headers.get("Content-Length")
        ? { "Content-Length": upstream.headers.get("Content-Length") as string }
        : {}),
      "Cache-Control": "private, no-store",
    },
  })
})

const releaseSchema = z.object({
  channel: z.string().trim().min(1).max(200),
  live: z.boolean(),
  url: z.string().url().max(2000).optional(),
})

/**
 * Report the language's approved versions as live on `channel` (or take them
 * down). LangQuest lets only the approved version go live, and a release is a
 * fact it records, not a verdict, so this walks every passage and skips those
 * with nothing approved or already in the asked-for state on that channel.
 */
langquest.post("/projects/:projectId/releases", authMiddleware, zValidator("json", releaseSchema), async (c) => {
  const ctx = await linkClient(c, MANAGE_MIN_ROLE)
  if (ctx instanceof Response) return ctx
  const { channel, live, url } = c.req.valid("json")
  if (!parseJsonColumn<LangQuestScope[]>(ctx.link.scopes, []).includes("release")) {
    return c.json({ error: "this link's token cannot report releases", reason: "missing_release_scope" }, 403)
  }
  let released = 0
  let unchanged = 0
  const failed: { unitId: string; error: string }[] = []
  try {
    let after: string | null = null
    do {
      const page: { passages: LangQuestPassage[]; nextAfter: string | null } = await ctx.client.request(
        `/languages/${encodeURIComponent(ctx.link.language_id)}/passages?limit=500${after ? `&after=${encodeURIComponent(after)}` : ""}`,
      )
      for (const p of page.passages) {
        if (!p.approvedVersion) {
          unchanged++
          continue
        }
        const current = p.releases.find((r) => r.channel === channel)
        // Going live: skip when the approved version already is. Taking down:
        // skip when nothing is live on this channel at all.
        const nothingToDo = live ? current?.takeId === p.approvedVersion.takeId : !current
        if (nothingToDo) {
          unchanged++
          continue
        }
        try {
          await ctx.client.release(ctx.link.language_id, p.unitId, { channel, live, ...(url ? { url } : {}) })
          released++
        } catch (err) {
          if (err instanceof LangQuestApiError && err.tokenRejected) throw err
          failed.push({ unitId: p.unitId, error: err instanceof Error ? err.message : String(err) })
        }
      }
      after = page.nextAfter
    } while (after)
  } catch (err) {
    return langquestFailure(c, err, ctx.projectId)
  }
  return c.json({ released, unchanged, failed })
})

export default langquest
