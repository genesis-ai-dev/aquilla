// AQU-1472: a `.txt` file exports its translations, the same bytes the in-app
// plain-text export builds (`exportPlainTextStructured`). `?mode=raw` still
// returns the untouched upload, which the project export's "source documents"
// folder depends on.

import { describe, it, expect } from "vitest"
import { handleExportSourceRequest } from "../events/export-route"
import { sourceObjectKey } from "../events/source-upload-route"
import { makeTestDb } from "./helpers/pg-test-db"
import { makeTestToken } from "./helpers/auth"

const SECRET = "export-plaintext-test-secret"

function makeStubBucket() {
  const store = new Map<string, ArrayBuffer>()
  return {
    async get(key: string) {
      const obj = store.get(key)
      if (!obj) return null
      return { arrayBuffer: async () => obj }
    },
    _seed(key: string, bytes: Uint8Array) {
      store.set(key, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)
    },
  }
}

const ORIGINAL = "Hello there. How are you?\n\nSecond paragraph.\n\nThird paragraph.\n"

interface CellSeed {
  cell_id: string
  side: "source" | "target"
  value: string
  anchor_cell_id?: string | null
  canonical_ref?: string | null
  lane_id?: string
  target_lang?: string
  validated?: number
  hidden_at?: number | null
}

function cell(seed: CellSeed) {
  return {
    project_id: "p1",
    file_id: "f1",
    value_html: null,
    type: "text",
    anchor_cell_id: null,
    canonical_ref: null,
    event_id: `ev-${seed.cell_id}-${seed.side}`,
    source_event_id: null,
    last_editor: "test",
    last_edit_at: 1700000000000,
    validated: 0,
    word_count: 1,
    content_hash: null,
    target_lang: "",
    ...(seed.side === "source" ? { lane_id: "srclane1" } : { lane_id: "deflane1" }),
    ...seed,
  }
}

// Three paragraphs as the plaintext importer writes them: the first split into
// two segments that share a group, each later one a single segment. Rows are
// seeded out of document order so only the anchor chain can order them.
const SOURCE_CELLS = [
  cell({ cell_id: "c3", side: "source", value: "Second paragraph.", anchor_cell_id: "c2", canonical_ref: "g2" }),
  cell({ cell_id: "c1", side: "source", value: "Hello there.", canonical_ref: "g1" }),
  cell({ cell_id: "c4", side: "source", value: "Third paragraph.", anchor_cell_id: "c3", canonical_ref: "g3" }),
  cell({ cell_id: "c2", side: "source", value: "How are you?", anchor_cell_id: "c1", canonical_ref: "g1" }),
]

async function exportTxt(
  cells: ReturnType<typeof cell>[],
  query = "",
): Promise<Response> {
  const SNAPSHOTS = makeStubBucket()
  const key = sourceObjectKey({ R2_KEY_PREFIX: "" }, "p1", "f1", "txt")
  SNAPSHOTS._seed(key, new TextEncoder().encode(ORIGINAL))
  const { db } = await makeTestDb({
    projects: [{ id: "p1", name: "Test Project", created_by: 1 }],
    lanes: [
      { id: "srclane1", project_id: "p1", role: "source", name: "Source", legacy_tag: "" },
      { id: "deflane1", project_id: "p1", role: "target", name: "Spanish", legacy_tag: "" },
      { id: "frlane01", project_id: "p1", role: "target", name: "French", legacy_tag: "fr" },
    ],
    files: [{ id: "f1", project_id: "p1", name: "blog.txt", event_id: "ev1" }],
    file_source_blobs: [
      { file_id: "f1", project_id: "p1", format: "txt", raw_source: null, r2_key: key },
    ],
    cells,
  })
  const token = await makeTestToken(SECRET, { projectId: "p1", fileId: "f1", role: 600 })
  const res = await handleExportSourceRequest(
    new Request(`https://x/api/v1/projects/p1/files/f1/source${query}`, {
      headers: { Authorization: `Bearer ${token}` },
    }),
    { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET, SNAPSHOTS } as any,
  )
  return res!
}

describe("GET /source — plain text (AQU-1472)", () => {
  it("exports translations, falling back to source for untranslated cells", async () => {
    const res = await exportTxt([
      ...SOURCE_CELLS,
      cell({ cell_id: "c1", side: "target", value: "Hola." }),
      cell({ cell_id: "c3", side: "target", value: "Segundo &amp; párrafo." }),
    ])

    expect(res.status).toBe(200)
    expect(res.headers.get("X-Export-Mode")).toBeNull()
    expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="blog.txt"')
    // c2 is untranslated and keeps its source text inside the first paragraph;
    // c4 is untranslated and stands as its own paragraph.
    expect(await res.text()).toBe("Hola. How are you?\n\nSegundo & párrafo.\n\nThird paragraph.\n")
  })

  it("exports the requested lane only", async () => {
    const res = await exportTxt(
      [
        ...SOURCE_CELLS,
        cell({ cell_id: "c1", side: "target", value: "Hola." }),
        cell({ cell_id: "c1", side: "target", value: "Bonjour.", lane_id: "frlane01", target_lang: "fr" }),
      ],
      "?lane=fr",
    )

    expect(await res.text()).toBe("Bonjour. How are you?\n\nSecond paragraph.\n\nThird paragraph.\n")
  })

  it("leaves hidden cells out, as the in-app export does", async () => {
    const res = await exportTxt([
      ...SOURCE_CELLS.map((c) => (c.cell_id === "c3" ? { ...c, hidden_at: 1700000000001 } : c)),
      cell({ cell_id: "c3", side: "target", value: "Segundo párrafo." }),
    ])

    expect(await res.text()).toBe("Hello there. How are you?\n\nThird paragraph.\n")
  })

  it("?validated=1 omits every cell that is not validated", async () => {
    const res = await exportTxt(
      [
        ...SOURCE_CELLS,
        cell({ cell_id: "c1", side: "target", value: "Hola.", validated: 1 }),
        cell({ cell_id: "c3", side: "target", value: "Segundo párrafo." }),
      ],
      "?validated=1",
    )

    expect(await res.text()).toBe("Hola.\n")
  })

  it("?mode=raw still returns the untouched upload", async () => {
    const res = await exportTxt(
      [...SOURCE_CELLS, cell({ cell_id: "c1", side: "target", value: "Hola." })],
      "?mode=raw",
    )

    expect(res.status).toBe(200)
    expect(res.headers.get("X-Export-Mode")).toBe("raw-original")
    expect(await res.text()).toBe(ORIGINAL)
  })
})
