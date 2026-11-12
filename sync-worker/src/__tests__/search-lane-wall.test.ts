import { describe, it, expect } from "vitest"
import { makeVerifiedProjectId, queryScopedExact, queryScopedPattern, queryScopedSearch } from "../events/scoped-search"
import type { SyncTokenClaims } from "../auth"
import { makeTestDb } from "./helpers/pg-test-db"

const claims = { userId: 1, projectId: "proj-a", fileId: "", role: 200, aud: "sync", iat: 0, exp: 0 } as SyncTokenClaims
const project = makeVerifiedProjectId(claims)

function cell(cell_id: string, side: "source" | "target", value: string, lane_id: string | null) {
  return {
    project_id: "proj-a",
    file_id: "f1",
    cell_id,
    side,
    value,
    lane_id,
    anchor_cell_id: null,
    event_id: `e-${cell_id}-${side}-${lane_id}`,
    last_editor: null,
    last_edit_at: 0,
    validated: 0,
    word_count: 1,
  }
}

// One source cell, translated in two lanes.
async function seed() {
  const cells = [
    cell("c1", "source", "quokka greeting", null),
    cell("c1", "target", "quokka in lane A", "lane-a"),
    cell("c1", "target", "quokka in lane B", "lane-b"),
  ]
  return makeTestDb({
    lanes: [
      { id: "lane-a", project_id: "proj-a", role: "target", name: "A", lang_code: "sw", legacy_tag: "" },
      { id: "lane-b", project_id: "proj-a", role: "target", name: "B", lang_code: "fr", legacy_tag: "fr" },
    ],
    cells, cells_fts: cells.map((c, i) => ({ rowid: i + 1, value: c.value })) })
}

const values = (rows: Array<{ value: string; pairedValue?: string | null }>) =>
  rows.flatMap((r) => [r.value, r.pairedValue ?? ""])

describe("search honours the lane read wall", () => {
  it("hides other lanes' target text (matched row and paired value)", async () => {
    const { db } = await seed()
    for (const hits of [
      await queryScopedSearch(db, project, "quokka", { laneIds: ["lane-a"] }),
      await queryScopedPattern(db, project, "quokka", { laneIds: ["lane-a"], matchCase: true }),
      await queryScopedExact(db, project, "quokka", { laneIds: ["lane-a"] }),
    ]) {
      expect(values(hits).join("|")).not.toContain("lane B")
      expect(values(hits).join("|")).toContain("lane A")
    }
  })

  it("an empty grant list sees source only, never target text", async () => {
    const { db } = await seed()
    const hits = await queryScopedSearch(db, project, "quokka", { laneIds: [] })
    expect(hits.map((h) => h.side)).toEqual(["source"])
    expect(hits[0]!.pairedValue ?? null).toBeNull()
  })

  it("null (unrestricted) still sees every lane", async () => {
    const { db } = await seed()
    const hits = await queryScopedSearch(db, project, "quokka", { laneIds: null })
    expect(hits).toHaveLength(3)
  })
})
