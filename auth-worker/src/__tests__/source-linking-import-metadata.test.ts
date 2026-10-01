// AQU-1520: a clone carries the import envelope, so its section navigator
// shows the upstream's real divisions.
//
// `snapshotSourceCells` copied text and structure (`type`, `canonical_ref`,
// `anchor_cell_id`) but not `cells.metadata`. That bucket holds the import
// envelope — `aquillaImport.milestone` — which is what
// `deriveMilestoneNavigation()` builds the section navigator's titles from.
// Dropping it left a cloned Biblica Study Notes file showing app-invented
// "Part N" pages where its upstream shows "Acts Preface" and the named chapter
// sections. A Scripture file was not visibly affected, because its divisions
// come from `canonical_ref`, which was already copied — which is exactly why
// the bug only showed on files whose divisions live in the envelope.
//
// Same family as AQU-1453 (the clone ignored hidden cells).

import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import { snapshotSourceCells } from "../services/source-linking"

const UP = "proj-meta-up"
const DOWN = "proj-meta-down"

async function seedProject(id: string, name: string): Promise<void> {
  await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, created_by) VALUES (?, ?, 1)")
    .bind(id, name)
    .run()
}

/** The envelope an imported study-notes cell carries. */
function envelope(label: string, key: string): string {
  return JSON.stringify({
    aquillaImport: { milestone: { kind: "section", key, label, shortLabel: label } },
  })
}

/**
 * An upstream study-notes file: two cells under "Acts Preface", one under
 * "Acts 1", plus one cell with no envelope at all (the division-less case the
 * acceptance criteria require to stay un-titled downstream).
 */
async function seedUpstream(): Promise<void> {
  await env.AQUILLA_PG.prepare(
    `INSERT INTO files (id, project_id, name, kind, event_id, created_at, updated_at)
     VALUES ('f-act', ?, 'ACT-REV.xml', 'text', 'e-file', 1000, 1000)`,
  )
    .bind(UP)
    .run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO cells (project_id, file_id, cell_id, side, value, event_id, last_edit_at, metadata)
     VALUES
       (?, 'f-act', 'c1', 'source', 'Luke wrote Acts', 'e-c1', 1000, ?::text::jsonb),
       (?, 'f-act', 'c2', 'source', 'It continues the Gospel', 'e-c2', 1000, ?::text::jsonb),
       (?, 'f-act', 'c3', 'source', 'Notes on Acts 1', 'e-c3', 1000, ?::text::jsonb),
       (?, 'f-act', 'c4', 'source', 'An untitled remark', 'e-c4', 1000, NULL)`,
  )
    .bind(
      UP, envelope("Acts Preface", "section:acts-preface"),
      UP, envelope("Acts Preface", "section:acts-preface"),
      UP, envelope("Acts 1", "section:acts-1"),
      UP,
    )
    .run()
}

async function targetMetadata(): Promise<Map<string, Record<string, unknown> | null>> {
  const rows = await env.AQUILLA_PG.prepare(
    `SELECT cell_id, metadata FROM cells WHERE project_id = ? AND side = 'source'`,
  )
    .bind(DOWN)
    .all<{ cell_id: string; metadata: Record<string, unknown> | null }>()
  return new Map((rows.results ?? []).map((r) => [r.cell_id, r.metadata]))
}

/** The milestone label the navigator would derive, read the way it reads it. */
function labelOf(metadata: Record<string, unknown> | null | undefined): string | undefined {
  const envelopeValue = (metadata as { aquillaImport?: unknown } | null | undefined)?.aquillaImport
  const milestone = (envelopeValue as { milestone?: { label?: unknown } } | undefined)?.milestone
  return typeof milestone?.label === "string" ? milestone.label : undefined
}

describe("snapshotSourceCells — the clone carries the import envelope (AQU-1520)", () => {
  it("copies each cell's section title, so the navigator shows 'Acts Preface' not 'Part 1'", async () => {
    await seedProject(UP, "Upstream")
    await seedProject(DOWN, "Downstream")
    await seedUpstream()

    const emitted = await snapshotSourceCells(env, {
      upstreamProjectId: UP,
      targetProjectId: DOWN,
      authorUsername: "lead",
    })
    expect(emitted).toBe(4)

    const metadata = await targetMetadata()
    expect(labelOf(metadata.get("c1"))).toBe("Acts Preface")
    expect(labelOf(metadata.get("c2"))).toBe("Acts Preface")
    expect(labelOf(metadata.get("c3"))).toBe("Acts 1")
  })

  it("invents nothing for a cell the upstream has no envelope for", async () => {
    await seedProject(UP, "Upstream")
    await seedProject(DOWN, "Downstream")
    await seedUpstream()

    await snapshotSourceCells(env, {
      upstreamProjectId: UP,
      targetProjectId: DOWN,
      authorUsername: "lead",
    })

    // An upstream file that genuinely has no divisions keeps showing "Part N"
    // downstream — the fix adds the upstream's titles, it does not manufacture
    // any (acceptance criterion 6).
    const metadata = await targetMetadata()
    expect(metadata.get("c4")).toBeNull()
  })

  it("puts the envelope in the genesis event too, so a log replay rebuilds the navigation", async () => {
    await seedProject(UP, "Upstream")
    await seedProject(DOWN, "Downstream")
    await seedUpstream()

    await snapshotSourceCells(env, {
      upstreamProjectId: UP,
      targetProjectId: DOWN,
      authorUsername: "lead",
    })

    // The `cells` row is a projection of the event log (AD-2), so the title has
    // to be on the event, not only on the row the snapshot wrote directly.
    const rows = await env.AQUILLA_PG.prepare(
      `SELECT cell_id, payload FROM events
        WHERE project_id = ? AND kind = 'source.cell.create'
        ORDER BY server_seq ASC`,
    )
      .bind(DOWN)
      .all<{ cell_id: string; payload: string }>()
    const byCell = new Map(
      (rows.results ?? []).map((r) => [
        r.cell_id,
        JSON.parse(r.payload) as { metadata?: Record<string, unknown> },
      ]),
    )
    expect(labelOf(byCell.get("c1")?.metadata ?? null)).toBe("Acts Preface")
    expect(labelOf(byCell.get("c3")?.metadata ?? null)).toBe("Acts 1")
    // No envelope upstream, no `metadata` key on the event at all.
    expect(byCell.get("c4")).not.toHaveProperty("metadata")
  })

  it("leaves the text, structure and cell set exactly as they were (AQU-1453 intact)", async () => {
    await seedProject(UP, "Upstream")
    await seedProject(DOWN, "Downstream")
    await seedUpstream()

    await snapshotSourceCells(env, {
      upstreamProjectId: UP,
      targetProjectId: DOWN,
      authorUsername: "lead",
    })

    const rows = await env.AQUILLA_PG.prepare(
      `SELECT cell_id, value, hidden_at FROM cells
        WHERE project_id = ? AND side = 'source' ORDER BY cell_id ASC`,
    )
      .bind(DOWN)
      .all<{ cell_id: string; value: string; hidden_at: number | null }>()
    expect((rows.results ?? []).map((r) => [r.cell_id, r.value, r.hidden_at])).toEqual([
      ["c1", "Luke wrote Acts", null],
      ["c2", "It continues the Gospel", null],
      ["c3", "Notes on Acts 1", null],
      ["c4", "An untitled remark", null],
    ])
  })
})
