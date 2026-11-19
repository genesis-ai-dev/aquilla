import { describe, it, expect } from "vitest"
import { handleTerminologyScanRequest } from "../events/terminology-scan-route"
import {
  parsePredictedEquivalents,
  parseTerminologyCandidatesPage,
  parseTerminologyViolationsPage,
} from "../../../src/lib/terminology/project-scan"
import { type CellRow } from "./helpers/in-memory-db"
import { makeTestDb } from "./helpers/pg-test-db"
import { makeTestToken } from "./helpers/auth"

const SECRET = "scan-secret"
const PROJECT = "proj-a"

function envWith(db: AquillaDb) {
  return { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET }
}

function cell(
  over: Partial<CellRow> & Pick<CellRow, "cell_id" | "side" | "value">,
): CellRow {
  return {
    project_id: PROJECT,
    file_id: "file-x",
    anchor_cell_id: null,
    event_id: `e-${over.cell_id}-${over.side}`,
    last_editor: null,
    last_edit_at: 0,
    validated: 0,
    word_count: 1,
    canonical_ref: over.side === "source" ? `GEN 1:${over.cell_id}` : null,
    ...over,
  }
}

async function get(db: AquillaDb, path: string, token?: string) {
  const req = new Request(`https://w${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  return (await handleTerminologyScanRequest(req, envWith(db)))!
}

describe("terminology project scans", () => {
  it("returns only infringements, and skips drafts and other projects", async () => {
    const { db } = await makeTestDb({
      cells: [
        cell({ cell_id: "ok", side: "source", value: "by grace alone" }),
        cell({ cell_id: "ok", side: "target", value: "favor" }),
        cell({ cell_id: "miss", side: "source", value: "by grace alone" }),
        cell({ cell_id: "miss", side: "target", value: "otra" }),
        cell({ cell_id: "bad", side: "source", value: "by grace alone" }),
        cell({ cell_id: "bad", side: "target", value: "a curse" }),
        cell({ cell_id: "drafted", side: "source", value: "show mercy" }),
        cell({ cell_id: "drafted", side: "target", value: "nope" }),
        cell({ project_id: "other", cell_id: "foreign", side: "source", value: "by grace alone" }),
        cell({ project_id: "other", cell_id: "foreign", side: "target", value: "otra" }),
      ],
      concepts: [
        {
          concept_id: "grace",
          project_id: PROJECT,
          source_term: "grace",
          renderings: [
            { rendering: "favor", status: "preferred" },
            { rendering: "curse", status: "forbidden" },
          ],
          status: "active",
          case_sensitive: 0,
          match_options: null,
          created_at: 1,
          updated_at: 1,
        },
        {
          concept_id: "mercy",
          project_id: PROJECT,
          source_term: "mercy",
          renderings: [{ rendering: "misericordia", status: "preferred" }],
          status: "draft",
          case_sensitive: 0,
          match_options: null,
          created_at: 2,
          updated_at: 2,
        },
      ],
    })
    const token = await makeTestToken(SECRET, { projectId: PROJECT })
    const res = await get(db, `/api/v1/projects/${PROJECT}/terminology/violations`, token)
    expect(res.status).toBe(200)
    const page = parseTerminologyViolationsPage(await res.json())
    expect(page).not.toBeNull()
    expect(page!.scanComplete).toBe(true)
    expect(page!.truncated).toBe(false)
    const ids = page!.violations.map((row) => `${row.cellId}:${row.kind}`).sort()
    expect(ids).toEqual([
      "bad:forbidden-present",
      "bad:missing-approved",
      "miss:missing-approved",
    ])
    expect(page!.violations.every((row) => row.conceptId === "grace")).toBe(true)
    expect(page!.violations.find((row) => row.cellId === "miss")!.context).toBe("GEN 1:miss")
  })

  it("returns candidate terms without the verses", async () => {
    const texts = ["the covenant of peace", "the covenant of peace", "the covenant of peace"]
    const { db } = await makeTestDb({
      cells: texts.map((value, index) => cell({ cell_id: `s${index}`, side: "source", value })),
      concepts: [
        {
          concept_id: "grace",
          project_id: PROJECT,
          source_term: "grace",
          renderings: [],
          status: "active",
          case_sensitive: 0,
          match_options: null,
          created_at: 1,
          updated_at: 1,
        },
      ],
    })
    const token = await makeTestToken(SECRET, { projectId: PROJECT })
    const res = await get(db, `/api/v1/projects/${PROJECT}/terminology/candidates`, token)
    expect(res.status).toBe(200)
    const page = parseTerminologyCandidatesPage(await res.json())
    expect(page).not.toBeNull()
    const covenant = page!.candidates.find((row) => row.term === "covenant")
    expect(covenant).toEqual({ term: "covenant", isManaged: false })
  })

  it("returns suggested renderings for one concept", async () => {
    const cells: CellRow[] = []
    for (let i = 0; i < 30; i++) {
      cells.push(cell({ cell_id: `g${i}`, side: "source", value: `god is good number ${i}` }))
      cells.push(cell({ cell_id: `g${i}`, side: "target", value: `dios es bueno numero ${i}` }))
    }
    const { db } = await makeTestDb({
      cells,
      concepts: [
        {
          concept_id: "god",
          project_id: PROJECT,
          source_term: "god",
          renderings: [],
          status: "active",
          case_sensitive: 0,
          match_options: null,
          created_at: 1,
          updated_at: 1,
        },
      ],
    })
    const token = await makeTestToken(SECRET, { projectId: PROJECT })
    const res = await get(db, `/api/v1/projects/${PROJECT}/concepts/god/suggestions`, token)
    expect(res.status).toBe(200)
    const suggestions = parsePredictedEquivalents(await res.json())
    expect(suggestions?.some((row) => row.target === "dios")).toBe(true)
  })

  it("rejects a missing token and an unknown concept", async () => {
    const { db } = await makeTestDb({
      cells: [],
      concepts: [
        {
          concept_id: "god",
          project_id: PROJECT,
          source_term: "god",
          renderings: [],
          status: "active",
          case_sensitive: 0,
          match_options: null,
          created_at: 1,
          updated_at: 1,
        },
      ],
    })
    const token = await makeTestToken(SECRET, { projectId: PROJECT })
    expect((await get(db, `/api/v1/projects/${PROJECT}/terminology/violations`)).status).toBe(401)
    expect((await get(db, `/api/v1/projects/${PROJECT}/concepts/missing/suggestions`, token)).status).toBe(404)
  })

  it("each lane's check sees only that lane's renderings", async () => {
    const { db } = await makeTestDb({
      lanes: [
        { id: "aaaaaaaa", project_id: PROJECT, role: "target", legacy_tag: "", position: 0 },
        { id: "bbbbbbbb", project_id: PROJECT, role: "target", legacy_tag: "es", language: "Spanish", position: 1 },
      ],
      cells: [
        cell({ cell_id: "c1", side: "source", value: "grace" }),
        { ...cell({ cell_id: "c1", side: "target", value: "a curse", target_lang: "" }), lane_id: "aaaaaaaa" },
        { ...cell({ cell_id: "c1", side: "target", value: "otra", target_lang: "es" }), lane_id: "bbbbbbbb" },
      ],
      concepts: [
        {
          concept_id: "grace",
          project_id: PROJECT,
          source_term: "grace",
          renderings: [
            { rendering: "favor", status: "preferred" },
            { rendering: "curse", status: "forbidden" },
            { rendering: "gracia", status: "preferred", laneId: "bbbbbbbb" },
          ],
          status: "active",
          case_sensitive: 0,
          match_options: null,
          created_at: 1,
          updated_at: 1,
        },
      ],
    })
    const token = await makeTestToken(SECRET, { projectId: PROJECT })
    const english = parseTerminologyViolationsPage(
      await (await get(db, `/api/v1/projects/${PROJECT}/terminology/violations?lane=`, token)).json(),
    )
    const spanish = parseTerminologyViolationsPage(
      await (await get(db, `/api/v1/projects/${PROJECT}/terminology/violations?lane=es`, token)).json(),
    )
    expect(english!.violations.map((row) => `${row.cellId}:${row.kind}`).sort()).toEqual([
      "c1:forbidden-present",
      "c1:missing-approved",
    ])
    expect(spanish!.violations.map((row) => row.kind).sort()).toEqual(["missing-approved"])
    expect(spanish!.violations.every((row) => row.cellId === "c1")).toBe(true)
  })

  // AQU-730: violations and suggestions are built from the requested lane's
  // target text, and the lane is the caller's choice.
  it("answers a lane the caller was not granted as an empty one", async () => {
    const { db } = await makeTestDb({
      lanes: [
        { id: "aaaaaaaa", project_id: PROJECT, role: "target", legacy_tag: "", position: 0 },
        { id: "bbbbbbbb", project_id: PROJECT, role: "target", legacy_tag: "es", language: "Spanish", position: 1 },
      ],
      cells: [
        cell({ cell_id: "c1", side: "source", value: "grace" }),
        { ...cell({ cell_id: "c1", side: "target", value: "a curse", target_lang: "" }), lane_id: "aaaaaaaa" },
        { ...cell({ cell_id: "c1", side: "target", value: "otra maldicion", target_lang: "es" }), lane_id: "bbbbbbbb" },
      ],
      concepts: [
        {
          concept_id: "grace",
          project_id: PROJECT,
          source_term: "grace",
          renderings: [
            { rendering: "favor", status: "preferred" },
            { rendering: "gracia", status: "preferred", laneId: "bbbbbbbb" },
          ],
          status: "active",
          case_sensitive: 0,
          match_options: null,
          created_at: 1,
          updated_at: 1,
        },
      ],
    })
    const call = async (path: string, claims: Record<string, unknown>, wall: string | undefined) => {
      const token = await makeTestToken(SECRET, { projectId: PROJECT, ...claims })
      const req = new Request(`https://w/api/v1/projects/${PROJECT}${path}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      return (await handleTerminologyScanRequest(req, { ...envWith(db), LANE_READ_WALL: wall }))!
    }
    const walled = { role: 400, laneGrants: [{ lane: "aaaaaaaa", level: 400 }] }

    const hidden = await call("/terminology/violations?lane=es", walled, "1")
    expect(hidden.status).toBe(200)
    expect(await hidden.json()).toEqual({ violations: [], scanComplete: true, truncated: false })
    const hiddenSuggestions = await call("/concepts/grace/suggestions?lane=es", walled, "1")
    expect(await hiddenSuggestions.json()).toEqual({ suggestions: [] })

    // Their own lane still reads, as does every lane for a Maintainer and for
    // anyone while the wall is off.
    const count = async (claims: Record<string, unknown>, wall: string | undefined, lane: string) =>
      parseTerminologyViolationsPage(await (await call(`/terminology/violations?lane=${lane}`, claims, wall)).json())!
        .violations.length
    expect(await count(walled, "1", "")).toBeGreaterThan(0)
    expect(await count({ role: 600 }, "1", "es")).toBeGreaterThan(0)
    expect(await count(walled, undefined, "es")).toBeGreaterThan(0)
    // Candidates read source text only, so the wall does not apply.
    expect((await call("/terminology/candidates", walled, "1")).status).toBe(200)
  })
})
