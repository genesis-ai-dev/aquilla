// Org termbase publish/subscribe routes (terminology Slices 6-7;
// aquilla-specs 04-features/terminology.md §"Termbase — sharing across
// projects"). Mounted at BOTH /api/v2/projects and /api/v2/orgs in
// src/index.ts (the paths are disjoint, so one router serves both prefixes).
//
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║ CLIENT-FACING API CONTRACT (also mirrored in docs/swarm/TERM3-ORG-API.md) ║
// ╚══════════════════════════════════════════════════════════════════════════╝
//
// Role ladder: viewer 100 · contributor 400 · project_lead 500 · maintainer 600
// · owner 700. Project roles resolve via resolveProjectRole (max-wins across
// direct/group/org/creator). All routes require authMiddleware.
//
// OPS-53: every WRITE below additionally requires an ELEVATED session when the
// caller clears its floor on platform-admin power alone — see
// requireTermbaseWriteRole. The three reads do not. A caller in that position
// gets 403 { error: "elevation required to <act> with platform-admin access" }.
//
// 1. POST /api/v2/projects/:id/termbase/publish        (maintainer 600+)
//    Project must be org-owned (org_id NOT NULL). Sets org_published_termbase=true.
//    → 200 { projectId, published: true }
//    → 403 no access | role below maintainer
//    → 409 { error: "project is not org-owned; cannot publish to an org" }
//
// 2. DELETE /api/v2/projects/:id/termbase/publish      (maintainer 600+)
//    Unpublish. Sets org_published_termbase=false. Existing subscriptions are
//    NOT cascaded-deleted and are left dangling but INERT: canReadTermbase
//    re-checks the flag, so the Q19 grant evaporates at once. Route 4 still
//    LISTS such a row, with published:false — the client hides it, not the
//    server (corrected here on the 2026-11-09 pass; this comment previously
//    claimed "the listing hides them", which listSubscriptions does not do).
//    → 200 { projectId, published: false }
//
// 3. GET /api/v2/orgs/:orgId/published-termbases        (any org member)
//    Discoverable published termbase projects in the org.
//    → 200 { termbases: [{ projectId, name, createdBy }] }
//    → 403 not an org member
//
// 4. GET /api/v2/projects/:id/termbase/subscriptions    (viewer 100+ on project)
//    The project's subscriptions, ordered by priority asc then created_at.
//    → 200 { subscriptions: [{ termbaseProjectId, termbaseName, priority, createdAt, published }] }
//
// 5. POST /api/v2/projects/:id/termbase/subscriptions   (maintainer 600+)
//    Body { termbaseProjectId: string, priority?: number }
//    Subscribe to a published termbase in the SAME org. Idempotent on
//    (project_id, termbase_project_id): re-subscribe updates priority.
//    → 200 { subscription: { termbaseProjectId, priority, createdAt } }
//    → 400 { error: "cannot subscribe a project to its own termbase" }
//    → 404 { error: "termbase project not found" }
//    → 409 { error: "termbase is not published to this org" }   (cross-org or unpublished)
//
// 6. DELETE /api/v2/projects/:id/termbase/subscriptions/:termbaseProjectId
//    (maintainer 600+) Unsubscribe. → 200 { ok: true }
//
// 7. PATCH /api/v2/projects/:id/termbase/subscriptions  (maintainer 600+)
//    Reorder priority. Body { order: string[] } — array of termbaseProjectIds
//    in desired precedence (index 0 = highest precedence = priority 0). Only
//    rows that exist as subscriptions are updated; unknown ids are ignored.
//    `order` holds at most MAX_SUBSCRIPTION_ORDER (500) ids of <=256 chars
//    each (OPS-54); past either, zValidator answers 400 before the handler.
//    → 200 { subscriptions: [...] }  (same shape as GET)
//
// 8. GET /api/v2/projects/:termbaseProjectId/termbase/concepts?subscriberProjectId=...
//    The upstream published termbase's ACTIVE concepts, for a subscriber's
//    enforcement merge (consumed by src/hooks/useSubscribedConcepts.ts, which
//    the editor workspace and Settings → Rules call — AQU-1721).
//    Access is the Q19 implicit grant — canReadTermbase, NOT a role check on
//    the upstream. Concepts are read as the editor reads a project's own
//    (lib/concepts-read.ts): the live rows of the `concepts` table, and the
//    legacy settings.terminology blob only while the table has none. Autopilot
//    reads subscribed termbases through the same function, and applies the
//    same published / unarchived / same-org gate as canReadTermbase (AQU-1721).
//    Renderings come back stamped with the SUBSCRIBER's lane ids: each one is
//    mapped from the lane it has in the termbase to the subscriber lane of the
//    same language (mapSubscribedConceptLanes, AQU-1777), so the editor's lane
//    filter treats them like the project's own. A rendering no subscriber lane
//    matches is left out.
//    → 200 { concepts: Concept[] }   // status === "active" only
//    → 400 { error: "subscriberProjectId required" }
//    → 403 { error: "no termbase read access" }  (non-member / no subscription /
//          unpublished / cross-org)
//
// Implicit grant (Q19): a subscription row confers an implicit *viewer* read on
// the upstream termbase project, scoped to termbase data only. This mirrors the
// source-project link pattern (canReadSourceCells). The read is DERIVED from
// the subscription row at resolve time — no project_members write is performed.
// The resolver is `canReadTermbase` in services/org-permissions.ts; route #8
// above is the termbase-data read endpoint that consumes it.

import { Hono, type Context } from "hono"
import { zValidator } from "@hono/zod-validator"
import { z } from "zod"
import { authMiddleware, type AuthHonoEnv } from "../middleware/auth"
import { ROLE } from "../types"
import { resolveProjectRole, type ResolvedRole } from "../services/project-permissions"
import { roleWithoutUnelevatedAdmin } from "../services/elevation-gate"
import { getEffectiveOrgRole, canReadTermbase } from "../services/org-permissions"
import { readProjectConcepts } from "../lib/concepts-read"
import { loadLaneRows } from "../lib/read-lane-language"
import { mapSubscribedConceptLanes } from "../../../src/lib/terminology/rendering-lane"

const termbase = new Hono<AuthHonoEnv>()

// ──────────────────────────────────────────────────────────────────────────
// OPS-53: the MAINTAINER floor below, with un-elevated platform-admin power
// stripped out of it.
//
// `resolveProjectRole` contributes { source: "platform", level: 700 } for
// every platform operator on every project on the platform, and
// ROLE.MAINTAINER is 600 — so `role.level < ROLE.MAINTAINER` was false by
// definition for an un-elevated admin JWT, on all five writes in this file.
// AQU-1322's rule ("admin power applies only while elevated") reaches them for
// two reasons neither of which is "one more un-gated write":
//
//   * `org_published_termbase` is not a setting, it is the org's CONSENT. Both
//     the subscribe route below and `canReadTermbase` treat the flag as the
//     upstream's permission to be read, so an operator who can flip it forges
//     the only consent in the design — for a project they hold no grant on.
//   * a subscription row is a STANDING cross-project read. The Q19 implicit
//     grant is derived from the row at resolve time, so every viewer (100) of
//     the subscriber reads the whole upstream termbase for as long as the row
//     lives. Same shape as OPS-44's PAT, OPS-49's integration link and
//     OPS-51's source link: the artefact outlives the authority that created
//     it, so an elevation check at use time can never reach it.
//
// The floor is checked BEFORE narrowing, so a genuine below-floor member and a
// non-member keep their byte-identical pre-OPS-53 refusals; only a caller who
// cleared the floor on platform power alone sees the elevation wording. An
// operator who genuinely maintains the project is unaffected, which is why
// this de-escalates rather than refusing on `source === "platform"`.
//
// The three READS are deliberately left open — AQU-2003 priced un-elevated
// platform access as read-only on our own content, not refused — and each one
// says so at its own guard.
// ──────────────────────────────────────────────────────────────────────────

async function requireTermbaseWriteRole(
  c: Context<AuthHonoEnv>,
  projectId: string,
  /** Spliced into the 403 as "elevation required to ${action} with …". */
  action: string,
): Promise<ResolvedRole | Response> {
  const user = c.get("user")
  const role = await resolveProjectRole(c.env, user, projectId)
  if (!role) return c.json({ error: "no access to project" }, 403)
  if (role.level < ROLE.MAINTAINER) {
    return c.json({ error: "role >= maintainer (600) required" }, 403)
  }
  const effective = await roleWithoutUnelevatedAdmin(c, user, projectId, role)
  if (!effective || effective.level < ROLE.MAINTAINER) {
    return c.json(
      { error: `elevation required to ${action} with platform-admin access` },
      403,
    )
  }
  return effective
}

// ──────────────────────────────────────────────────────────────────────────
// POST /api/v2/projects/:id/termbase/publish — publish (maintainer 600+)
// ──────────────────────────────────────────────────────────────────────────

termbase.post("/:id/termbase/publish", authMiddleware, async (c) => {
  const projectId = c.req.param("id") as string

  // Publishing IS the org's consent token for every read downstream of it.
  const guard = await requireTermbaseWriteRole(
    c,
    projectId,
    "publish a project's termbase to its org",
  )
  if (guard instanceof Response) return guard

  const project = await c.env.AQUILLA_PG.prepare(
    "SELECT org_id FROM projects WHERE id = ?",
  )
    .bind(projectId)
    .first<{ org_id: number | null }>()
  if (!project) return c.json({ error: "project not found" }, 404)
  if (project.org_id == null) {
    return c.json({ error: "project is not org-owned; cannot publish to an org" }, 409)
  }

  await c.env.AQUILLA_PG.prepare(
    "UPDATE projects SET org_published_termbase = TRUE, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
  )
    .bind(projectId)
    .run()

  return c.json({ projectId, published: true })
})

// ──────────────────────────────────────────────────────────────────────────
// DELETE /api/v2/projects/:id/termbase/publish — unpublish (maintainer 600+)
// ──────────────────────────────────────────────────────────────────────────

termbase.delete("/:id/termbase/publish", authMiddleware, async (c) => {
  const projectId = c.req.param("id") as string

  // Unpublishing evaporates the Q19 grant for every subscriber in the org at
  // once (canReadTermbase re-checks the flag), so their enforcement
  // terminology disappears. Not reversible by the subscribers.
  const guard = await requireTermbaseWriteRole(
    c,
    projectId,
    "unpublish a project's termbase",
  )
  if (guard instanceof Response) return guard

  await c.env.AQUILLA_PG.prepare(
    "UPDATE projects SET org_published_termbase = FALSE, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
  )
    .bind(projectId)
    .run()

  return c.json({ projectId, published: false })
})

// ──────────────────────────────────────────────────────────────────────────
// GET /api/v2/orgs/:orgId/published-termbases — discover (any org member)
// ──────────────────────────────────────────────────────────────────────────

termbase.get("/:orgId/published-termbases", authMiddleware, async (c) => {
  const user = c.get("user")
  const orgId = Number.parseInt(c.req.param("orgId") ?? "", 10)
  if (!Number.isFinite(orgId)) return c.json({ error: "invalid orgId" }, 400)

  const orgRole = await getEffectiveOrgRole(c.env, orgId, user)
  if (orgRole == null) return c.json({ error: "no access to org" }, 403)

  const rows = await c.env.AQUILLA_PG.prepare(
    `SELECT id, name, created_by
       FROM projects
      WHERE org_id = ?
        AND org_published_termbase = TRUE
        AND archived_at IS NULL
      ORDER BY LOWER(name)`,
  )
    .bind(orgId)
    .all<{ id: string; name: string; created_by: number }>()

  return c.json({
    termbases: (rows.results ?? []).map((r) => ({
      projectId: r.id,
      name: r.name,
      createdBy: r.created_by,
    })),
  })
})

// ──────────────────────────────────────────────────────────────────────────
// Subscriptions
// ──────────────────────────────────────────────────────────────────────────

interface SubscriptionRow {
  termbase_project_id: string
  termbase_name: string | null
  priority: number
  created_at: string | null
  published: number | boolean | null
}

async function listSubscriptions(
  env: AuthHonoEnv["Bindings"],
  projectId: string,
): Promise<Array<{ termbaseProjectId: string; termbaseName: string | null; priority: number; createdAt: string | null; published: boolean }>> {
  const rows = await env.AQUILLA_PG.prepare(
    `SELECT s.termbase_project_id AS termbase_project_id,
            p.name                AS termbase_name,
            s.priority            AS priority,
            s.created_at          AS created_at,
            p.org_published_termbase AS published
       FROM project_termbase_subscriptions s
       LEFT JOIN projects p ON p.id = s.termbase_project_id
      WHERE s.project_id = ?
      ORDER BY s.priority ASC, s.created_at ASC`,
  )
    .bind(projectId)
    .all<SubscriptionRow>()

  return (rows.results ?? []).map((r) => ({
    termbaseProjectId: r.termbase_project_id,
    termbaseName: r.termbase_name,
    priority: r.priority,
    createdAt: r.created_at,
    published: r.published === 1 || r.published === true,
  }))
}

// GET /api/v2/projects/:id/termbase/subscriptions — viewer 100+
termbase.get("/:id/termbase/subscriptions", authMiddleware, async (c) => {
  const user = c.get("user")
  const projectId = c.req.param("id") as string

  const role = await resolveProjectRole(c.env, user, projectId)
  if (!role) return c.json({ error: "no access to project" }, 403)

  const subscriptions = await listSubscriptions(c.env, projectId)
  return c.json({ subscriptions })
})

// POST /api/v2/projects/:id/termbase/subscriptions — subscribe (maintainer 600+)
const subscribeBody = z.object({
  termbaseProjectId: z.string().min(1),
  priority: z.number().int().nonnegative().optional(),
})

termbase.post(
  "/:id/termbase/subscriptions",
  authMiddleware,
  zValidator("json", subscribeBody),
  async (c) => {
    const projectId = c.req.param("id") as string
    const { termbaseProjectId, priority } = c.req.valid("json")

    // The row this writes is a standing read grant on the upstream for every
    // member of this project. The UPSTREAM side needs no role check of its
    // own: its consent is the published flag, which the publish route above
    // now narrows — this route only ever reads that flag.
    const guard = await requireTermbaseWriteRole(
      c,
      projectId,
      "subscribe a project to an org termbase",
    )
    if (guard instanceof Response) return guard

    if (termbaseProjectId === projectId) {
      return c.json({ error: "cannot subscribe a project to its own termbase" }, 400)
    }

    // The subscriber's own org — the termbase must be published to the SAME org.
    const subscriber = await c.env.AQUILLA_PG.prepare(
      "SELECT org_id FROM projects WHERE id = ?",
    )
      .bind(projectId)
      .first<{ org_id: number | null }>()
    if (!subscriber) return c.json({ error: "project not found" }, 404)

    const termbaseProject = await c.env.AQUILLA_PG.prepare(
      "SELECT org_id, org_published_termbase FROM projects WHERE id = ? AND archived_at IS NULL",
    )
      .bind(termbaseProjectId)
      .first<{ org_id: number | null; org_published_termbase: number | boolean | null }>()
    if (!termbaseProject) return c.json({ error: "termbase project not found" }, 404)

    const isPublished =
      termbaseProject.org_published_termbase === 1 ||
      termbaseProject.org_published_termbase === true
    if (
      !isPublished ||
      termbaseProject.org_id == null ||
      termbaseProject.org_id !== subscriber.org_id
    ) {
      return c.json({ error: "termbase is not published to this org" }, 409)
    }

    // Default priority: append at the end (max existing + 1).
    let resolvedPriority = priority
    if (resolvedPriority == null) {
      const maxRow = await c.env.AQUILLA_PG.prepare(
        "SELECT COALESCE(MAX(priority), -1) AS max_priority FROM project_termbase_subscriptions WHERE project_id = ?",
      )
        .bind(projectId)
        .first<{ max_priority: number }>()
      resolvedPriority = (maxRow?.max_priority ?? -1) + 1
    }

    await c.env.AQUILLA_PG.prepare(
      `INSERT INTO project_termbase_subscriptions (project_id, termbase_project_id, priority)
       VALUES (?, ?, ?)
       ON CONFLICT(project_id, termbase_project_id)
       DO UPDATE SET priority = excluded.priority`,
    )
      .bind(projectId, termbaseProjectId, resolvedPriority)
      .run()

    const row = await c.env.AQUILLA_PG.prepare(
      "SELECT priority, created_at FROM project_termbase_subscriptions WHERE project_id = ? AND termbase_project_id = ?",
    )
      .bind(projectId, termbaseProjectId)
      .first<{ priority: number; created_at: string | null }>()

    return c.json({
      subscription: {
        termbaseProjectId,
        priority: row?.priority ?? resolvedPriority,
        createdAt: row?.created_at ?? null,
      },
    })
  },
)

// DELETE /api/v2/projects/:id/termbase/subscriptions/:termbaseProjectId — maintainer 600+
termbase.delete("/:id/termbase/subscriptions/:termbaseProjectId", authMiddleware, async (c) => {
  const projectId = c.req.param("id") as string
  const termbaseProjectId = c.req.param("termbaseProjectId") as string

  const guard = await requireTermbaseWriteRole(
    c,
    projectId,
    "unsubscribe a project from an org termbase",
  )
  if (guard instanceof Response) return guard

  await c.env.AQUILLA_PG.prepare(
    "DELETE FROM project_termbase_subscriptions WHERE project_id = ? AND termbase_project_id = ?",
  )
    .bind(projectId, termbaseProjectId)
    .run()

  return c.json({ ok: true })
})

// PATCH /api/v2/projects/:id/termbase/subscriptions — reorder (maintainer 600+)
// OPS-54: `order` was uncapped and became one atomic `batch()` of N
// statements, which db/shim/postgres.ts runs SERIALLY inside a single open
// transaction — so one authenticated maintainer request could pin a pooled
// Hyperdrive connection for as many round trips as it cared to send. This was
// the only one of this worker's three per-element batch() sites with no caller
// bound (routes/langquest.ts caps at 1000, routes/ai-interventions.ts at 60),
// against 42 of the 57 z.array() schemas in routes/ carrying a .max(). The
// client only ever sends the project's OWN subscriptions
// (src/lib/terminology/subscriptions-api.ts), bounded by the published
// termbases in one org, so 500 is far above any real ordering; the id length
// matches routes/invites.ts's `projectIds`.
const MAX_SUBSCRIPTION_ORDER = 500

const reorderBody = z.object({
  order: z.array(z.string().min(1).max(256)).max(MAX_SUBSCRIPTION_ORDER),
})

termbase.patch(
  "/:id/termbase/subscriptions",
  authMiddleware,
  zValidator("json", reorderBody),
  async (c) => {
    const projectId = c.req.param("id") as string
    const { order } = c.req.valid("json")

    // Priority decides which subscribed rendering wins in enforcement, so a
    // reorder silently rewrites what the project's rules say.
    const guard = await requireTermbaseWriteRole(
      c,
      projectId,
      "reorder a project's termbase subscriptions",
    )
    if (guard instanceof Response) return guard

    // Index in the order array = priority. Only existing rows are updated;
    // unknown ids are silently ignored (DELETE/UPDATE no-ops on no match).
    const stmts = order.map((termbaseProjectId, index) =>
      c.env.AQUILLA_PG.prepare(
        "UPDATE project_termbase_subscriptions SET priority = ? WHERE project_id = ? AND termbase_project_id = ?",
      ).bind(index, projectId, termbaseProjectId),
    )
    if (stmts.length > 0) await c.env.AQUILLA_PG.batch(stmts)

    const subscriptions = await listSubscriptions(c.env, projectId)
    return c.json({ subscriptions })
  },
)

// ──────────────────────────────────────────────────────────────────────────
// GET /api/v2/projects/:termbaseProjectId/termbase/concepts — upstream concept
// read via the Q19 implicit subscription grant (canReadTermbase).
// ──────────────────────────────────────────────────────────────────────────

termbase.get("/:termbaseProjectId/termbase/concepts", authMiddleware, async (c) => {
  const user = c.get("user")
  const termbaseProjectId = c.req.param("termbaseProjectId") as string
  const subscriberProjectId = c.req.query("subscriberProjectId")

  if (!subscriberProjectId) {
    return c.json({ error: "subscriberProjectId required" }, 400)
  }

  const allowed = await canReadTermbase(c.env, user, {
    subscriberProjectId,
    termbaseProjectId,
  })
  if (!allowed) return c.json({ error: "no termbase read access" }, 403)

  // Read the upstream's termbase directly rather than round-tripping its
  // settings or concepts routes, which would require a role on the upstream we
  // deliberately don't grant. Since the concepts migration deletes the
  // settings.terminology key, reading only that key returned nothing for every
  // migrated termbase (AQU-1715).
  const db = c.env.AQUILLA_PG
  const [termbaseConcepts, termbaseLanes, subscriberLanes] = await Promise.all([
    readProjectConcepts(db, termbaseProjectId),
    loadLaneRows(db, termbaseProjectId),
    loadLaneRows(db, subscriberProjectId),
  ])
  // AQU-1777: the renderings carry the TERMBASE's lane ids, which never equal
  // the subscriber's. Rewrite them onto the subscriber's lanes by language
  // here, so the editor's lane filter (conceptsForLaneTag over the
  // subscriber's own rows) treats them exactly like local renderings.
  const concepts = mapSubscribedConceptLanes(
    termbaseConcepts.filter((concept) => concept.status === "active"),
    termbaseLanes,
    subscriberLanes,
  )

  return c.json({ concepts })
})

export default termbase
