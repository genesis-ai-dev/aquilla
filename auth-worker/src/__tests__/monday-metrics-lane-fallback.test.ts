// AQU-1620: the Monday metrics pre-backfill fallback and multi-lane projects.
//
// `computeProjectMetrics` reads `file_section_progress` and falls back to the
// `files` counters for a file that has no progress rows yet. `files.cell_count`
// counts each cell once, but `files.filled_count` / `approved_count` sum every
// target lane (AQU-1588) — so the fallback used to divide an all-lanes fill by
// a one-lane total and completion could pass 100% on a board people plan
// against. These cases pin the rule: the file counters stand only where they
// describe one lane's work.

import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import { computeProjectMetrics } from "../lib/monday/metrics"

async function seedProject(projectId: string) {
  await env.AQUILLA_PG.prepare(
    "INSERT INTO users (id, username, email, password_hash, preferences) VALUES (1, 'wendi', 'wendi@example.com', 'scrypt:fake$salt$hash', '{}')",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'Come and See', 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO projects (id, name, org_id, created_by) VALUES (?, 'Ruth Translation', 1, 1)",
  )
    .bind(projectId)
    .run()
}

/** One file, no progress rows: counters only. 10 cells, fill summed over lanes. */
async function seedFallbackFile(
  projectId: string,
  counts: { cellCount: number; filledCount: number; approvedCount: number },
) {
  await env.AQUILLA_PG.prepare(
    `INSERT INTO files (id, project_id, name, event_id, cell_count, filled_count, approved_count)
     VALUES ('f1', ?, 'RUT', 'e1', ?, ?, ?)`,
  )
    .bind(projectId, counts.cellCount, counts.filledCount, counts.approvedCount)
    .run()
}

async function seedTargetLanes(projectId: string, tags: readonly string[]) {
  for (const [i, tag] of tags.entries()) {
    await env.AQUILLA_PG.prepare(
      `INSERT INTO lanes (id, project_id, role, name, lang_code, legacy_tag, position)
       VALUES (?, ?, 'target', ?, NULL, ?, ?)`,
    )
      .bind(`lane${i}`, projectId, tag === "" ? "Spanish" : tag, tag, i)
      .run()
  }
}

describe("Monday metrics — pre-backfill file-counter fallback (AQU-1620)", () => {
  it("never reports more than 100% for a two-lane file with no progress rows", async () => {
    await seedProject("proj-1")
    // 10 distinct cells; 14 filled and 12 approved across two lanes — the
    // all-lanes sums that used to be divided by the one-lane total.
    await seedFallbackFile("proj-1", { cellCount: 10, filledCount: 14, approvedCount: 12 })
    await seedTargetLanes("proj-1", ["", "French"])

    const summary = await computeProjectMetrics(env.AQUILLA_PG, "proj-1")

    expect(summary).not.toBeNull()
    const file = summary!.files[0].metrics
    expect(file.completion_pct).toBeLessThanOrEqual(100)
    expect(summary!.project.completion_pct).toBeLessThanOrEqual(100)
    // The denominator still describes the file; the numerators are empty
    // rather than another lane's work.
    expect(file.total_count).toBe(10)
    expect(file.filled_count).toBe(0)
    expect(file.validated_count).toBe(0)
    expect(file.completion_pct).toBe(0)
    expect(file.validated_pct).toBe(0)
    expect(file.status_auto).toBe("Not started")
  })

  it("keeps the file counters on a single-lane project", async () => {
    await seedProject("proj-2")
    await seedFallbackFile("proj-2", { cellCount: 10, filledCount: 6, approvedCount: 4 })
    await seedTargetLanes("proj-2", [""])

    const summary = await computeProjectMetrics(env.AQUILLA_PG, "proj-2")

    const file = summary!.files[0].metrics
    expect(file.total_count).toBe(10)
    expect(file.filled_count).toBe(6)
    expect(file.validated_count).toBe(4)
    expect(file.completion_pct).toBe(60)
    expect(file.validated_pct).toBe(40)
    expect(file.status_auto).toBe("In progress")
  })

  it("treats a project with no lane rows yet as single-lane", async () => {
    await seedProject("proj-3")
    await seedFallbackFile("proj-3", { cellCount: 10, filledCount: 6, approvedCount: 4 })

    const summary = await computeProjectMetrics(env.AQUILLA_PG, "proj-3")

    const file = summary!.files[0].metrics
    expect(file.filled_count).toBe(6)
    expect(file.completion_pct).toBe(60)
  })

  it("counts an archived second lane, because the counters already added it up", async () => {
    await seedProject("proj-4")
    await seedFallbackFile("proj-4", { cellCount: 10, filledCount: 14, approvedCount: 12 })
    await seedTargetLanes("proj-4", ["", "French"])
    await env.AQUILLA_PG.prepare(
      "UPDATE lanes SET archived_at = now() WHERE project_id = ? AND legacy_tag = 'French'",
    )
      .bind("proj-4")
      .run()

    const summary = await computeProjectMetrics(env.AQUILLA_PG, "proj-4")

    expect(summary!.files[0].metrics.filled_count).toBe(0)
    expect(summary!.files[0].metrics.completion_pct).toBe(0)
  })

  it("leaves a two-lane file that has progress rows alone", async () => {
    await seedProject("proj-5")
    await seedFallbackFile("proj-5", { cellCount: 10, filledCount: 14, approvedCount: 12 })
    await seedTargetLanes("proj-5", ["", "French"])
    // Lane-cells over lane-cells: 20 cells across two lanes, 5 filled.
    for (const [laneId, filled] of [["lane0", 3], ["lane1", 2]] as const) {
      await env.AQUILLA_PG.prepare(
        `INSERT INTO file_section_progress
           (project_id, file_id, scope, section_key, lane_id, total_count, filled_count, updated_at)
         VALUES (?, 'f1', 'file', '', ?, 10, ?, 0)`,
      )
        .bind("proj-5", laneId, filled)
        .run()
    }

    const summary = await computeProjectMetrics(env.AQUILLA_PG, "proj-5")

    const file = summary!.files[0].metrics
    expect(file.total_count).toBe(20)
    expect(file.filled_count).toBe(5)
    expect(file.completion_pct).toBe(25)
  })
})
