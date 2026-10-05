import { env } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"
import {
  summarizePortfolioProjects,
  type PortfolioMetricsProject,
} from "../../../src/lib/frontier/portfolio-metrics"
import { PORTFOLIO_ORG_IDS_MAX } from "../routes/orgs"

interface SummaryBody {
  projectCount: number
  avgTranslatedPct: number
  avgValidatedPct: number
  avgAudioPct: number
  stalledCount: number
  overdueCount: number
  attentionCount: number
  orgs: Array<{ orgId: number; projectCount: number }>
  projects?: unknown
  portfolios?: unknown
}

interface PortfolioBody {
  portfolios: Array<{
    orgId: number
    projects: Array<PortfolioMetricsProject & { id: string }>
  }>
}

const DAY = 24 * 60 * 60 * 1000

async function postSummary(username: string, body: Record<string, unknown>): Promise<Response> {
  return app.request(
    "/api/v2/orgs/portfolio/summary",
    {
      method: "POST",
      headers: authHeader(await jwtFor(username)),
      body: JSON.stringify(body),
    },
    env,
  )
}

describe("POST /api/v2/orgs/portfolio/summary", () => {
  it("matches the client rollup of the unpaged portfolio, including lane activity", async () => {
    const now = Date.now()
    const soon = new Date(now + 3 * DAY).toISOString().slice(0, 10)
    const far = new Date(now + 40 * DAY).toISOString().slice(0, 10)
    const recent = now - 60 * 60 * 1000
    const stale = now - 30 * DAY

    await seedUser(1, "wendi")
    await env.AQUILLA_PG.prepare(
      "INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'CAS', 1), (2, 'Waha', 1)",
    ).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1), (2, 1, 700, 1)",
    ).run()

    const rows = [
      { id: "active", org: 1, total: 100, filled: 80, approved: 40, edit: recent, deadline: null as string | null, laneAt: null as number | null, behind: false },
      { id: "stalled", org: 1, total: 100, filled: 10, approved: 0, edit: stale, deadline: null, laneAt: null, behind: false },
      { id: "fresh-import", org: 1, total: 50, filled: 0, approved: 0, edit: stale, deadline: null, laneAt: null, behind: false },
      { id: "lane-fresh", org: 1, total: 100, filled: 40, approved: 10, edit: stale, deadline: null, laneAt: recent, behind: false },
      { id: "overdue", org: 1, total: 100, filled: 100, approved: 100, edit: recent, deadline: "2020-01-01", laneAt: null, behind: false },
      { id: "soon", org: 1, total: 20, filled: 10, approved: 0, edit: recent, deadline: soon, laneAt: null, behind: false },
      { id: "behind", org: 1, total: 10, filled: 5, approved: 2, edit: recent, deadline: far, laneAt: null, behind: true },
      { id: "empty", org: 1, total: 0, filled: 0, approved: 0, edit: null, deadline: null, laneAt: null, behind: false },
      { id: "waha", org: 2, total: 4, filled: 1, approved: 1, edit: recent, deadline: null, laneAt: null, behind: false },
    ]

    for (const row of rows) {
      const eventId = `e-${row.id}`
      await env.AQUILLA_PG.prepare(
        "INSERT INTO projects (id, name, org_id, created_by, deadline_at) VALUES (?, ?, ?, 1, ?)",
      ).bind(row.id, row.id, row.org, row.deadline).run()
      await env.AQUILLA_PG.prepare(
        `INSERT INTO events (id, schema_version, project_id, kind, author, payload, client_ts, server_ts, server_seq)
         VALUES (?, 1, ?, 'file.create', 'wendi', '{}', 1, 1, 1)`,
      ).bind(eventId, row.id).run()
      await env.AQUILLA_PG.prepare(
        `INSERT INTO files (id, project_id, name, event_id, cell_count, filled_count, approved_count, last_edit_at)
         VALUES (?, ?, 'GEN', ?, ?, ?, ?, ?)`,
      ).bind(`f-${row.id}`, row.id, eventId, row.total, row.filled, row.approved, row.edit).run()
      if (row.laneAt != null) {
        await env.AQUILLA_PG.prepare(
          `INSERT INTO file_section_progress
             (project_id, file_id, scope, section_key, target_lang, total_count, filled_count, validator_histogram, revision, updated_at)
           VALUES (?, ?, 'file', '', '', ?, ?, '{}', 1, ?)`,
        ).bind(row.id, `f-${row.id}`, row.total, row.filled, row.laneAt).run()
      }
      if (row.behind) {
        await env.AQUILLA_PG.prepare(
          `INSERT INTO plan_units (project_id, file_id, section_key, target_date, updated_at)
           VALUES (?, ?, '', '2020-01-01', 1)`,
        ).bind(row.id, `f-${row.id}`).run()
      }
    }
    // Archived work must stay out of the overview the same way it stays out of the list.
    await env.AQUILLA_PG.prepare(
      "INSERT INTO projects (id, name, org_id, created_by, archived_at) VALUES ('archived', 'Old', 1, 1, '2020-01-01')",
    ).run()

    const listed = await app.request(
      "/api/v2/orgs/portfolio",
      {
        method: "POST",
        headers: authHeader(await jwtFor("wendi")),
        body: JSON.stringify({ orgIds: [1, 2] }),
      },
      env,
    )
    expect(listed.status).toBe(200)
    const portfolio = (await listed.json()) as PortfolioBody
    const visible = portfolio.portfolios.flatMap((entry) =>
      entry.projects.map((project) => ({ ...project, orgId: entry.orgId })),
    )

    const summaryRes = await postSummary("wendi", { orgIds: [1, 2] })
    expect(summaryRes.status).toBe(200)
    const summary = (await summaryRes.json()) as SummaryBody

    const expected = summarizePortfolioProjects(visible, Date.now())
    expect(summary.projectCount).toBe(visible.length)
    expect(summary.projectCount).toBe(rows.length)
    expect(summary.avgTranslatedPct).toBeCloseTo(expected.avgTranslatedPct)
    expect(summary.avgValidatedPct).toBeCloseTo(expected.avgValidatedPct)
    expect(summary.avgAudioPct).toBeCloseTo(expected.avgAudioPct)
    expect(summary.stalledCount).toBe(expected.stalledCount)
    expect(summary.overdueCount).toBe(expected.overdueCount)
    expect(summary.attentionCount).toBe(expected.attentionCount)
    // Independent of summarizePortfolioProjects: a scalar-only activity clock
    // would also flag lane-fresh, and dropping zero-cell projects would change the mean.
    expect(summary.stalledCount).toBe(1)
    expect(summary.overdueCount).toBe(1)
    expect(summary.attentionCount).toBe(4)
    const translated = rows.reduce((sum, row) => sum + (row.total > 0 ? row.filled / row.total : 0), 0) / rows.length
    const validated = rows.reduce((sum, row) => sum + (row.total > 0 ? row.approved / row.total : 0), 0) / rows.length
    expect(summary.avgTranslatedPct).toBeCloseTo(translated)
    expect(summary.avgValidatedPct).toBeCloseTo(validated)
    expect(summary.orgs).toEqual(expect.arrayContaining([
      expect.objectContaining({ orgId: 1, projectCount: 8 }),
      expect.objectContaining({ orgId: 2, projectCount: 1 }),
    ]))
    expect(summary.projects).toBeUndefined()
    expect(summary.portfolios).toBeUndefined()
    expect(JSON.stringify(summary)).not.toContain("lane-fresh")
  })

  it("counts only projects the caller can see", async () => {
    await seedUser(1, "owner")
    await seedUser(2, "contributor")
    await env.AQUILLA_PG.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'CAS', 1)").run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1), (1, 2, 400, 1)",
    ).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO projects (id, name, org_id, created_by) VALUES ('pa', 'Algerian', 1, 1), ('pb', 'Bambara', 1, 1), ('pc', 'Cebuano', 1, 1)",
    ).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('pc', 2, 400, 1)",
    ).run()

    const contributor = await postSummary("contributor", { orgIds: [1] })
    expect(contributor.status).toBe(200)
    const contributorBody = (await contributor.json()) as SummaryBody
    expect(contributorBody.projectCount).toBe(1)
    expect(contributorBody.orgs).toEqual([expect.objectContaining({ orgId: 1, projectCount: 1 })])
    expect(JSON.stringify(contributorBody)).not.toContain("Algerian")
    expect(JSON.stringify(contributorBody)).not.toContain("Bambara")

    const owner = await postSummary("owner", { orgIds: [1] })
    expect(((await owner.json()) as SummaryBody).projectCount).toBe(3)
  })

  it("resolves every membership when orgIds is omitted, past the explicit-list cap", async () => {
    await seedUser(1, "wendi")
    const count = PORTFOLIO_ORG_IDS_MAX + 1
    await env.AQUILLA_PG.prepare(
      `INSERT INTO organizations (id, name, owner_user_id)
       SELECT g, 'Org ' || g, 1 FROM generate_series(1, ${count}) AS g`,
    ).run()
    await env.AQUILLA_PG.prepare(
      `INSERT INTO org_members (org_id, user_id, role_level, granted_by)
       SELECT g, 1, 700, 1 FROM generate_series(1, ${count}) AS g`,
    ).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO projects (id, name, org_id, created_by) VALUES ('p1', 'First', 1, 1), ('p501', 'Last', ?, 1)",
    ).bind(count).run()

    const omitted = await postSummary("wendi", {})
    expect(omitted.status).toBe(200)
    const omittedBody = (await omitted.json()) as SummaryBody
    expect(omittedBody.projectCount).toBe(2)
    expect(omittedBody.orgs).toHaveLength(count)
    expect(omittedBody.orgs).toEqual(expect.arrayContaining([
      expect.objectContaining({ orgId: 1, projectCount: 1 }),
      expect.objectContaining({ orgId: count, projectCount: 1 }),
    ]))

    const tooManyIds = Array.from({ length: count }, (_, i) => i + 1)
    const rejected = await postSummary("wendi", { orgIds: tooManyIds })
    expect(rejected.status).toBe(400)

    const atCap = await postSummary("wendi", { orgIds: tooManyIds.slice(0, PORTFOLIO_ORG_IDS_MAX) })
    expect(atCap.status).toBe(200)
    expect(((await atCap.json()) as SummaryBody).projectCount).toBe(1)
  })

  it("treats an empty orgIds array as no orgs and rejects a non-member", async () => {
    await seedUser(1, "wendi")
    await seedUser(9, "outsider")
    await env.AQUILLA_PG.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'CAS', 1)").run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1)",
    ).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO projects (id, name, org_id, created_by) VALUES ('pa', 'John', 1, 1)",
    ).run()

    const none = await postSummary("wendi", { orgIds: [] })
    expect(none.status).toBe(200)
    expect(await none.json()).toMatchObject({ projectCount: 0, orgs: [] })

    const denied = await postSummary("outsider", { orgIds: [1] })
    expect(denied.status).toBe(403)
  })
})
