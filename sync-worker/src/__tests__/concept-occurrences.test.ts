import { describe, it, expect } from "vitest"
import { handleConceptOccurrencesRequest } from "../events/concept-occurrences-route"
import { parseTermOccurrencePage } from "../../../src/lib/terminology/occurrence-page"
import { type CellRow } from "./helpers/in-memory-db"
import { makeTestDb } from "./helpers/pg-test-db"
import { makeTestToken } from "./helpers/auth"

const SECRET = "occurrences-secret"
const PROJECT = "proj-a"

function envWith(db: AquillaDb) {
  return { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET }
}

function cell(
  over: Partial<CellRow> &
    Pick<CellRow, "cell_id" | "side" | "value"> & { hidden_at?: number | null; sequence_index?: number | null },
): CellRow & { hidden_at?: number | null; sequence_index?: number | null } {
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

async function seed(opts: {
  term: string
  cells: Array<ReturnType<typeof cell>>
  match?: Record<string, unknown> | null
  renderings?: Array<{ rendering: string; status: string }>
  settings?: Record<string, unknown>
  conceptId?: string
}) {
  return makeTestDb({
    cells: opts.cells,
    concepts: [
      {
        concept_id: opts.conceptId ?? "c1",
        project_id: PROJECT,
        source_term: opts.term,
        renderings: opts.renderings ?? [{ rendering: "favor", status: "preferred" }],
        status: "active",
        case_sensitive: 0,
        match_options: opts.match ?? null,
        created_at: 1,
        updated_at: 1,
      },
    ],
    ...(opts.settings
      ? {
          project_settings: [
            { project_id: PROJECT, settings: JSON.stringify(opts.settings), version: 1 },
          ],
        }
      : {}),
  })
}

async function get(db: AquillaDb, path: string, token?: string) {
  const req = new Request(`https://w${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  return (await handleConceptOccurrencesRequest(req, envWith(db)))!
}

describe("GET concept occurrences", () => {
  it("returns paired source and target for a whole-word match and ignores another project", async () => {
    const { db } = await seed({
      term: "grace",
      cells: [
        cell({ cell_id: "c1", side: "source", value: "by grace alone" }),
        cell({ cell_id: "c1", side: "target", value: "por favor" }),
        cell({ cell_id: "c2", side: "source", value: "graceful speech" }),
        cell({ project_id: "other", cell_id: "c3", side: "source", value: "by grace alone" }),
      ],
    })
    const token = await makeTestToken(SECRET, { projectId: PROJECT })
    const res = await get(db, `/api/v1/projects/${PROJECT}/concepts/c1/occurrences`, token)
    expect(res.status).toBe(200)
    const page = parseTermOccurrencePage(await res.json())
    expect(page).not.toBeNull()
    expect(page!.total).toBe(1)
    expect(page!.scanComplete).toBe(true)
    expect(page!.enforced).toBe(1)
    expect(page!.forms).toEqual([{ surface: "grace", count: 1, excluded: false }])
    expect(page!.occurrences).toEqual([
      expect.objectContaining({
        cellId: "c1",
        fileId: "file-x",
        original: "by grace alone",
        translated: "por favor",
        context: "GEN 1:c1",
      }),
    ])
  })

  it("keeps pointed and wildcard hits that full-text search would drop", async () => {
    const pointed = "\u05D3\u05BC\u05B8\u05D1\u05B8\u05E8"
    const bare = "\u05D3\u05D1\u05E8"
    const { db } = await seed({
      term: `${bare}*`,
      match: { foldMarks: true },
      cells: [
        cell({ cell_id: "pointed", side: "source", value: `and ${pointed} said` }),
        cell({ cell_id: "inflected", side: "source", value: "the covenanting people" }),
        cell({ cell_id: "other", side: "source", value: "in the beginning" }),
      ],
    })
    // Two concepts would be cleaner; this concept is the Hebrew wildcard.
    // Re-seed the English wildcard as its own request below.
    const token = await makeTestToken(SECRET, { projectId: PROJECT })
    const hebrew = parseTermOccurrencePage(
      await (await get(db, `/api/v1/projects/${PROJECT}/concepts/c1/occurrences`, token)).json(),
    )
    expect(hebrew!.occurrences.map((row) => row.cellId)).toEqual(["pointed"])

    const english = await seed({
      term: "covenant*",
      cells: [
        cell({ cell_id: "inflected", side: "source", value: "the covenanting people" }),
        cell({ cell_id: "plain", side: "source", value: "a covenant" }),
        cell({ cell_id: "short", side: "source", value: "cov" }),
      ],
    })
    const page = parseTermOccurrencePage(
      await (await get(english.db, `/api/v1/projects/${PROJECT}/concepts/c1/occurrences`, token)).json(),
    )
    expect(page!.occurrences.map((row) => row.cellId).sort()).toEqual(["inflected", "plain"])
  })

  it("drops an excluded surface and a parked cell", async () => {
    const { db } = await seed({
      term: "covenant*",
      match: { excludedForms: ["covenants"] },
      cells: [
        cell({ cell_id: "kept", side: "source", value: "a covenant" }),
        cell({ cell_id: "excluded", side: "source", value: "the covenants" }),
        cell({ cell_id: "hidden", side: "source", value: "a covenant", hidden_at: 10 }),
      ],
    })
    const token = await makeTestToken(SECRET, { projectId: PROJECT })
    const page = parseTermOccurrencePage(
      await (await get(db, `/api/v1/projects/${PROJECT}/concepts/c1/occurrences`, token)).json(),
    )
    expect(page!.occurrences.map((row) => row.cellId)).toEqual(["kept"])
  })

  it("pages confirmed matches without shrinking the total", async () => {
    const { db } = await seed({
      term: "God",
      cells: [1, 2, 3].flatMap((n) => [
        cell({ cell_id: `g${n}`, side: "source", value: `God ${n}`, sequence_index: n }),
        cell({ cell_id: `g${n}`, side: "target", value: n === 2 ? "forbidden-god" : "Dios" }),
      ]),
      renderings: [
        { rendering: "Dios", status: "preferred" },
        { rendering: "forbidden-god", status: "forbidden" },
      ],
    })
    const token = await makeTestToken(SECRET, { projectId: PROJECT })
    const first = parseTermOccurrencePage(
      await (
        await get(db, `/api/v1/projects/${PROJECT}/concepts/c1/occurrences?limit=2`, token)
      ).json(),
    )
    expect(first!.total).toBe(3)
    expect(first!.occurrences).toHaveLength(2)
    expect(first!.infringed).toBe(1)
    expect(first!.enforced).toBe(2)
    const second = parseTermOccurrencePage(
      await (
        await get(db, `/api/v1/projects/${PROJECT}/concepts/c1/occurrences?limit=2&offset=2`, token)
      ).json(),
    )
    expect(second!.occurrences).toHaveLength(1)
    expect(second!.total).toBe(3)
  })

  it("rejects a missing token and an unknown concept", async () => {
    const { db } = await seed({
      term: "grace",
      cells: [cell({ cell_id: "c1", side: "source", value: "grace" })],
    })
    expect((await get(db, `/api/v1/projects/${PROJECT}/concepts/c1/occurrences`)).status).toBe(401)
    const token = await makeTestToken(SECRET, { projectId: PROJECT })
    expect((await get(db, `/api/v1/projects/${PROJECT}/concepts/missing/occurrences`, token)).status).toBe(404)
    expect(await handleConceptOccurrencesRequest(new Request("https://w/api/v1/projects/p/concepts"), envWith(db))).toBeNull()
  })
})
