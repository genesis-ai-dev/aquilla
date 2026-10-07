// AQU-1721 — the editor and autopilot must apply the same subscribed termbases.
//
// The editor reads a subscribed termbase through route #8
// (GET /api/v2/projects/:termbaseProjectId/termbase/concepts), and
// canReadTermbase gates that read: the termbase must be published, not in the
// Trash (archived), and in the subscriber's org. Autopilot reads subscribed
// termbases straight from Postgres (loadSubscribedConcepts). Before AQU-1721 it
// applied every subscription row, so an unpublished, trashed, deleted or
// other-org termbase kept steering drafts that the editor no longer checked
// against. This test runs both reads over one fixture that has a termbase in
// each state, and requires the same concepts in the same order.
import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { loadProjectContext } from "../lib/contextual/project-context"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

const db = env.AQUILLA_PG

interface TermbaseCase {
  id: string
  priority: number
  orgId: number
  published: boolean
  trashed: boolean
  /** False = the project was permanently deleted. Nothing cascades from
   *  `projects`, so its settings and subscription rows stay behind. */
  hasProjectRow: boolean
}

// Inserted out of priority order, so the expected order comes from priority.
const TERMBASES: TermbaseCase[] = [
  { id: "tb-second", priority: 1, orgId: 1, published: true, trashed: false, hasProjectRow: true },
  { id: "tb-first", priority: 0, orgId: 1, published: true, trashed: false, hasProjectRow: true },
  { id: "tb-unpublished", priority: 2, orgId: 1, published: false, trashed: false, hasProjectRow: true },
  { id: "tb-trashed", priority: 3, orgId: 1, published: true, trashed: true, hasProjectRow: true },
  { id: "tb-other-org", priority: 4, orgId: 2, published: true, trashed: false, hasProjectRow: true },
  { id: "tb-deleted", priority: 5, orgId: 1, published: true, trashed: false, hasProjectRow: false },
]

async function seed() {
  await seedUser(1, "owner")
  await seedUser(2, "member")
  await db.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'Org', 1), (2, 'Other', 1)").run()
  await db.prepare("INSERT INTO projects (id, name, org_id, created_by) VALUES ('consumer', 'Consumer', 1, 1)").run()
  // loadProjectContext reads nothing, subscriptions included, for a project
  // with no settings row. A real project has one: its languages live there.
  await db.prepare("INSERT INTO project_settings (project_id, settings) VALUES ('consumer', '{}')").run()
  await db
    .prepare("INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('consumer', 2, 100, 1)")
    .run()

  for (const tb of TERMBASES) {
    if (tb.hasProjectRow) {
      await db
        .prepare(
          `INSERT INTO projects (id, name, org_id, created_by, org_published_termbase, archived_at)
           VALUES (?, ?, ?, 1, ${tb.published ? "TRUE" : "FALSE"}, ${tb.trashed ? "now()" : "NULL"})`,
        )
        .bind(tb.id, tb.id, tb.orgId)
        .run()
    }
    // One active concept per termbase, plus a draft that no consumer applies.
    await db
      .prepare("INSERT INTO project_settings (project_id, settings) VALUES (?, ?)")
      .bind(
        tb.id,
        JSON.stringify({
          terminology: [
            {
              id: `c-${tb.id}`,
              sourceTerm: `term-${tb.id}`,
              status: "active",
              renderings: [{ rendering: `r-${tb.id}`, status: "preferred" }],
            },
            { id: `draft-${tb.id}`, sourceTerm: `draft-${tb.id}`, status: "draft", renderings: [] },
          ],
        }),
      )
      .run()
    await db
      .prepare("INSERT INTO project_termbase_subscriptions (project_id, termbase_project_id, priority) VALUES ('consumer', ?, ?)")
      .bind(tb.id, tb.priority)
      .run()
  }
}

/**
 * The editor's read, made the way src/hooks/useSubscribedConcepts.ts makes it:
 * list the subscriptions (priority, then age), skip the unpublished ones, then
 * read each termbase through route #8. A 403 is a gated-off termbase, which
 * contributes no concepts. Returns the active concept ids in that order.
 */
async function editorRead(username: string, projectId: string): Promise<string[]> {
  const headers = authHeader(await jwtFor(username))
  const list = await app.request(`/api/v2/projects/${projectId}/termbase/subscriptions`, { headers }, env)
  expect(list.status).toBe(200)
  const { subscriptions } = (await list.json()) as {
    subscriptions: Array<{ termbaseProjectId: string; published: boolean }>
  }
  const ids: string[] = []
  for (const sub of subscriptions.filter((s) => s.published)) {
    const res = await app.request(
      `/api/v2/projects/${sub.termbaseProjectId}/termbase/concepts?subscriberProjectId=${projectId}`,
      { headers },
      env,
    )
    if (res.status === 403) continue
    expect(res.status).toBe(200)
    const { concepts } = (await res.json()) as { concepts: Array<{ id: string; status: string }> }
    ids.push(...concepts.filter((c) => c.status === "active").map((c) => c.id))
  }
  return ids
}

describe("subscribed termbases: the editor and autopilot apply the same set (AQU-1721)", () => {
  it("applies only published, untrashed, same-org termbases, in subscription order", async () => {
    await seed()

    const editor = await editorRead("member", "consumer")
    // The rule under test (decided 2026-10-06): an unpublished, trashed,
    // deleted or other-org termbase contributes nothing.
    expect(editor).toEqual(["c-tb-first", "c-tb-second"])

    const ctx = await loadProjectContext(db, "consumer")
    expect(ctx.concepts.map((c) => c.id)).toEqual(editor)
  })
})
