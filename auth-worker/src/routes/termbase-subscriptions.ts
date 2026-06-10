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
// 1. POST /api/v2/projects/:id/termbase/publish        (maintainer 600+)
//    Project must be org-owned (org_id NOT NULL). Sets org_published_termbase=true.
//    → 200 { projectId, published: true }
//    → 403 no access | role below maintainer
//    → 409 { error: "project is not org-owned; cannot publish to an org" }
//
// 2. DELETE /api/v2/projects/:id/termbase/publish      (maintainer 600+)
//    Unpublish. Sets org_published_termbase=false. Existing subscriptions are
//    NOT cascaded-deleted (left dangling but inert — the listing hides them).
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
//    → 200 { subscriptions: [...] }  (same shape as GET)
//
// 8. GET /api/v2/projects/:termbaseProjectId/termbase/concepts?subscriberProjectId=...
//    The upstream published termbase's ACTIVE concepts, for a subscriber's
//    enforcement merge (consumed by src/hooks/useSubscribedConcepts.ts).
//    Access is the Q19 implicit grant — canReadTermbase, NOT a role check on
//    the upstream. Concepts are read from project_settings.settings.terminology
//    (AD-3 thin-client: project terminology is synced as a top-level settings
//    key, see src/lib/sync/project-settings.ts).
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

import { Hono } from "hono"
import { zValidator } from "@hono/zod-validator"
import { z } from "zod"
import { authMiddleware, type AuthHonoEnv } from "../middleware/auth"
import { ROLE } from "../types"
import { resolveProjectRole } from "../services/project-permissions"
import { getEffectiveOrgRole, canReadTermbase } from "../services/org-permissions"

const termbase = new Hono<AuthHonoEnv>()

// ──────────────────────────────────────────────────────────────────────────
// POST /api/v2/projects/:id/termbase/publish — publish (maintainer 600+)
// ──────────────────────────────────────────────────────────────────────────

termbase.post("/:id/termbase/publish", authMiddleware, async (c) => {
  const user = c.get("user")
  const projectId = c.req.param("id") as string

  const role = await resolveProjectRole(c.env, user, projectId)
  if (!role) return c.json({ error: "no access to project" }, 403)
  if (role.level < ROLE.MAINTAINER) {
    return c.json({ error: "role >= maintainer (600) required" }, 403)
  }

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
  const user = c.get("user")
  const projectId = c.req.param("id") as string

  const role = await resolveProjectRole(c.env, user, projectId)
  if (!role) return c.json({ error: "no access to project" }, 403)
  if (role.level < ROLE.MAINTAINER) {
    return c.json({ error: "role >= maintainer (600) required" }, 403)
  }

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
    const user = c.get("user")
    const projectId = c.req.param("id") as string
    const { termbaseProjectId, priority } = c.req.valid("json")

    const role = await resolveProjectRole(c.env, user, projectId)
    if (!role) return c.json({ error: "no access to project" }, 403)
    if (role.level < ROLE.MAINTAINER) {
      return c.json({ error: "role >= maintainer (600) required" }, 403)
    }

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
  const user = c.get("user")
  const projectId = c.req.param("id") as string
  const termbaseProjectId = c.req.param("termbaseProjectId") as string

  const role = await resolveProjectRole(c.env, user, projectId)
  if (!role) return c.json({ error: "no access to project" }, 403)
  if (role.level < ROLE.MAINTAINER) {
    return c.json({ error: "role >= maintainer (600) required" }, 403)
  }

  await c.env.AQUILLA_PG.prepare(
    "DELETE FROM project_termbase_subscriptions WHERE project_id = ? AND termbase_project_id = ?",
  )
    .bind(projectId, termbaseProjectId)
    .run()

  return c.json({ ok: true })
})

// PATCH /api/v2/projects/:id/termbase/subscriptions — reorder (maintainer 600+)
const reorderBody = z.object({ order: z.array(z.string().min(1)) })

termbase.patch(
  "/:id/termbase/subscriptions",
  authMiddleware,
  zValidator("json", reorderBody),
  async (c) => {
    const user = c.get("user")
    const projectId = c.req.param("id") as string
    const { order } = c.req.valid("json")

    const role = await resolveProjectRole(c.env, user, projectId)
    if (!role) return c.json({ error: "no access to project" }, 403)
    if (role.level < ROLE.MAINTAINER) {
      return c.json({ error: "role >= maintainer (600) required" }, 403)
    }

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

interface Concept {
  id: string
  sourceTerm: string
  renderings: Array<{ rendering: string; status: string }>
  notes?: string
  status: "active" | "draft" | "deprecated"
  createdAt: string
  createdBy?: string
  updatedAt?: string
}

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

  // Project terminology is persisted as a top-level key in the upstream's
  // project_settings JSON (AD-3 thin-client; src/lib/sync/project-settings.ts).
  // Read it directly here rather than round-tripping the settings route, which
  // would require a role on the upstream we deliberately don't grant.
  const row = await c.env.AQUILLA_PG.prepare(
    "SELECT settings FROM project_settings WHERE project_id = ?",
  )
    .bind(termbaseProjectId)
    .first<{ settings: string }>()

  let concepts: Concept[] = []
  if (row?.settings) {
    try {
      const parsed = JSON.parse(row.settings) as { terminology?: Concept[] }
      const all = Array.isArray(parsed.terminology) ? parsed.terminology : []
      concepts = all.filter((c) => c.status === "active")
    } catch {
      // Corrupt settings JSON — return no concepts rather than 500ing the
      // subscriber's enforcement merge.
      concepts = []
    }
  }

  return c.json({ concepts })
})

export default termbase
