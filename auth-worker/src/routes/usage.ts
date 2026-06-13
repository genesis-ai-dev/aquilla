// Usage read endpoints — per-user and per-org rollups of AI + TTS usage.
//
// Spec: docs/superpowers/specs/2026-06-13-omnivoice-tts-design.md §4 "Read endpoints".
//
// Routes (mounted at /api/v1/usage in index.ts):
//   GET /me          — caller's own rollup: today + 7-day history. JWT-authed.
//   GET /org/:orgId  — per-member rollup for the org. Maintainer-gated (≥ 600).
//
// Defensive: if tts_usage_daily doesn't exist yet (migration not yet applied),
// degrade to zeros — wrap that query and treat a missing-table error as empty.
// The migration lands separately (sync-worker agent); never block the UI on it.

import { Hono } from "hono"
import { authMiddleware, type AuthHonoEnv } from "../middleware/auth"
import { getEffectiveOrgRole } from "../services/org-permissions"
import { ROLE } from "../types"

const usage = new Hono<AuthHonoEnv>()

usage.use("*", authMiddleware)

// ── Helpers ───────────────────────────────────────────────────────────────────

function utcDateKey(): string {
  return new Date().toISOString().slice(0, 10) // "YYYY-MM-DD"
}

function nDaysAgoUtc(n: number): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - n)
  return d.toISOString().slice(0, 10)
}

/**
 * Return true if the error looks like "relation does not exist" — i.e. the
 * tts_usage_daily migration hasn't been applied to this environment yet.
 */
function isMissingTableError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  // Postgres: 42P01 undefined_table; PGlite/psycopg: "does not exist"
  return msg.includes("does not exist") || msg.includes("undefined_table")
}

/** Today's TTS seconds + request_count for a single user. Returns zeros if table missing. */
async function fetchUserTtsToday(
  db: AquillaDb,
  userId: number,
  today: string,
): Promise<{ audioSeconds: number; ttsRequests: number }> {
  try {
    const row = await db
      .prepare(
        `SELECT COALESCE(SUM(audio_seconds), 0) AS audio_seconds,
                COALESCE(SUM(request_count), 0) AS request_count
           FROM tts_usage_daily
          WHERE user_id = ? AND date_utc = ?`,
      )
      .bind(userId, today)
      .first<{ audio_seconds: number; request_count: number }>()
    return {
      audioSeconds: row?.audio_seconds ?? 0,
      ttsRequests: row?.request_count ?? 0,
    }
  } catch (err) {
    if (isMissingTableError(err)) return { audioSeconds: 0, ttsRequests: 0 }
    throw err
  }
}

/** Today's LLM request_count for a single user. user_id=0 is the global sentinel — skip it. */
async function fetchUserLlmToday(
  db: AquillaDb,
  userId: number,
  today: string,
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(request_count), 0) AS request_count
         FROM ai_usage_daily
        WHERE user_id = ? AND date_utc = ?`,
    )
    .bind(userId, today)
    .first<{ request_count: number }>()
  return row?.request_count ?? 0
}

interface DayEntry {
  date: string
  audioSeconds: number
  ttsRequests: number
  llmRequests: number
}

/** 7-day history for a single user across both tables. Degrades to zeros for missing tts table. */
async function fetchUserHistory(
  db: AquillaDb,
  userId: number,
  since: string,
): Promise<DayEntry[]> {
  // LLM history — always present.
  const llmRows = await db
    .prepare(
      `SELECT date_utc::text AS date_utc, COALESCE(SUM(request_count), 0) AS request_count
         FROM ai_usage_daily
        WHERE user_id = ? AND date_utc >= ?
        GROUP BY date_utc
        ORDER BY date_utc ASC`,
    )
    .bind(userId, since)
    .all<{ date_utc: string; request_count: number }>()

  const llmByDate = new Map<string, number>(
    (llmRows.results ?? []).map((r) => [r.date_utc, r.request_count]),
  )

  // TTS history — degrade if table missing.
  let ttsRows: Array<{ date_utc: string; audio_seconds: number; request_count: number }> = []
  try {
    const res = await db
      .prepare(
        `SELECT date_utc::text AS date_utc,
                COALESCE(SUM(audio_seconds), 0) AS audio_seconds,
                COALESCE(SUM(request_count), 0) AS request_count
           FROM tts_usage_daily
          WHERE user_id = ? AND date_utc >= ?
          GROUP BY date_utc
          ORDER BY date_utc ASC`,
      )
      .bind(userId, since)
      .all<{ date_utc: string; audio_seconds: number; request_count: number }>()
    ttsRows = res.results ?? []
  } catch (err) {
    if (!isMissingTableError(err)) throw err
    // Table missing — leave ttsRows as empty, all zeros.
  }

  const ttsByDate = new Map(ttsRows.map((r) => [r.date_utc, r]))

  // Merge: collect all dates that appear in either table.
  const allDates = new Set([...llmByDate.keys(), ...ttsByDate.keys()])
  const sorted = [...allDates].sort()

  return sorted.map((date) => {
    const tts = ttsByDate.get(date)
    return {
      date,
      audioSeconds: tts?.audio_seconds ?? 0,
      ttsRequests: tts?.request_count ?? 0,
      llmRequests: llmByDate.get(date) ?? 0,
    }
  })
}

// ── GET /me ───────────────────────────────────────────────────────────────────

/**
 * GET /api/v1/usage/me
 *
 * Caller's own usage rollup: today's TTS audio_seconds + request_count (summed
 * over tts_usage_daily where user_id = caller), today's LLM request_count (from
 * ai_usage_daily), and a 7-day history array.
 *
 * Response shape (per spec §4):
 *   {
 *     today: { audioSeconds, ttsRequests, llmRequests },
 *     history: [{ date, audioSeconds, ttsRequests, llmRequests }]  // 7 entries max
 *   }
 *
 * Defensive: if tts_usage_daily doesn't exist (migration not yet applied), all
 * TTS fields degrade to 0 rather than 500-ing.
 */
usage.get("/me", async (c) => {
  const user = c.get("user")
  const today = utcDateKey()
  const since = nDaysAgoUtc(6) // today + 6 prior days = 7 days total

  const [ttsToday, llmToday, history] = await Promise.all([
    fetchUserTtsToday(c.env.AQUILLA_PG, user.id, today),
    fetchUserLlmToday(c.env.AQUILLA_PG, user.id, today),
    fetchUserHistory(c.env.AQUILLA_PG, user.id, since),
  ])

  return c.json({
    today: {
      audioSeconds: ttsToday.audioSeconds,
      ttsRequests: ttsToday.ttsRequests,
      llmRequests: llmToday,
    },
    history,
  })
})

// ── GET /org/:orgId ───────────────────────────────────────────────────────────

interface MemberUsage {
  userId: number
  username: string | null
  audioSeconds: number
  ttsRequests: number
  llmRequests: number
}

interface OrgUsageResponse {
  members: MemberUsage[]
  orgTotal: {
    audioSeconds: number
    ttsRequests: number
    llmRequests: number
  }
}

/**
 * GET /api/v1/usage/org/:orgId
 *
 * Per-member usage rollup for the org, aggregated for the last 7 days.
 * MAINTAINER-GATED: caller must have org role >= 600 (maintainer/owner).
 * Non-managers get 403 — the UI swallows it and hides the section.
 *
 * Response shape (per spec §4):
 *   {
 *     members: [{ userId, username, audioSeconds, ttsRequests, llmRequests }],
 *     orgTotal: { audioSeconds, ttsRequests, llmRequests }
 *   }
 *
 * Defensive: tts_usage_daily missing → all TTS fields are 0.
 */
usage.get("/org/:orgId", async (c) => {
  const user = c.get("user")
  const orgId = parseInt(c.req.param("orgId"), 10)
  if (!Number.isFinite(orgId)) return c.json({ error: "invalid orgId" }, 400)

  // Maintainer gate — mirrors orgs.ts GET /:orgId/assignments/workload.
  const role = await getEffectiveOrgRole(c.env, orgId, user)
  if (role == null || role < ROLE.MAINTAINER) {
    return c.json({ error: "org role >= maintainer required" }, 403)
  }

  const since = nDaysAgoUtc(6) // today + 6 prior = 7 days

  // ── LLM rollup per user for this org — via project membership ────────────────
  // ai_usage_daily has no org_id column; derive by joining through project_members
  // → projects → org_id. A user contributes to the org's LLM count if they are a
  // member of at least one of the org's projects.
  //
  // NOTE: a user who is only an org member (not a direct project member) will not
  // appear here, but that is consistent with the LLM proxy gate (project-scoped
  // sync tokens), so it's correct.
  const llmRows = await c.env.AQUILLA_PG.prepare(
    `SELECT ud.user_id                          AS user_id,
            u.username                          AS username,
            COALESCE(SUM(ud.request_count), 0) AS request_count
       FROM ai_usage_daily ud
       JOIN users u ON u.id = ud.user_id
      WHERE ud.date_utc >= ?
        AND ud.user_id != 0
        AND ud.user_id IN (
          SELECT DISTINCT pm.user_id
            FROM project_members pm
            JOIN projects p ON p.id = pm.project_id
           WHERE p.org_id = ?
        )
      GROUP BY ud.user_id, u.username`,
  )
    .bind(since, orgId)
    .all<{ user_id: number; username: string | null; request_count: number }>()

  const llmByUser = new Map<number, { username: string | null; llmRequests: number }>(
    (llmRows.results ?? []).map((r) => [
      r.user_id,
      { username: r.username, llmRequests: r.request_count },
    ]),
  )

  // ── TTS rollup per user for this org (org_id is stored directly) ─────────────
  let ttsByUser = new Map<number, { username: string | null; audioSeconds: number; ttsRequests: number }>()
  try {
    const ttsRows = await c.env.AQUILLA_PG.prepare(
      `SELECT td.user_id                           AS user_id,
              u.username                           AS username,
              COALESCE(SUM(td.audio_seconds), 0)  AS audio_seconds,
              COALESCE(SUM(td.request_count), 0)  AS request_count
         FROM tts_usage_daily td
         JOIN users u ON u.id = td.user_id
        WHERE td.org_id = ? AND td.date_utc >= ? AND td.user_id != 0
        GROUP BY td.user_id, u.username`,
    )
      .bind(orgId, since)
      .all<{ user_id: number; username: string | null; audio_seconds: number; request_count: number }>()

    ttsByUser = new Map(
      (ttsRows.results ?? []).map((r) => [
        r.user_id,
        { username: r.username, audioSeconds: r.audio_seconds, ttsRequests: r.request_count },
      ]),
    )
  } catch (err) {
    if (!isMissingTableError(err)) throw err
    // Table missing — ttsByUser stays empty; TTS fields will be 0.
  }

  // ── Merge LLM + TTS, keyed by userId ────────────────────────────────────────
  const allUserIds = new Set([...llmByUser.keys(), ...ttsByUser.keys()])
  const members: MemberUsage[] = []

  for (const uid of allUserIds) {
    const llm = llmByUser.get(uid)
    const tts = ttsByUser.get(uid)
    members.push({
      userId: uid,
      username: llm?.username ?? tts?.username ?? null,
      audioSeconds: tts?.audioSeconds ?? 0,
      ttsRequests: tts?.ttsRequests ?? 0,
      llmRequests: llm?.llmRequests ?? 0,
    })
  }

  // Sort by total activity descending (most active first), then by userId.
  members.sort(
    (a, b) =>
      b.audioSeconds + b.ttsRequests + b.llmRequests -
      (a.audioSeconds + a.ttsRequests + a.llmRequests) ||
      a.userId - b.userId,
  )

  const orgTotal = {
    audioSeconds: members.reduce((s, m) => s + m.audioSeconds, 0),
    ttsRequests: members.reduce((s, m) => s + m.ttsRequests, 0),
    llmRequests: members.reduce((s, m) => s + m.llmRequests, 0),
  }

  return c.json({ members, orgTotal } satisfies OrgUsageResponse)
})

export default usage
