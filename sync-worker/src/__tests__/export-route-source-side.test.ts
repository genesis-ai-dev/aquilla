// AQU-1449: GET /source?side=source returns the CURATED SOURCE — the original
// upload with source edits applied, hidden and deleted verses dropped, added
// cells' source text in place, and no translation anywhere.
//
// This runs the whole seam rather than the plan alone, because the two halves
// are only correct together: the plan decides WHICH verses get an override, and
// the serializer decides what an absent override means. An untouched verse has
// to survive byte-for-byte, footnotes and character markers included, and the
// only thing that guarantees that is the plan declining to override it — so a
// plan-only test would pass while the file shipped as stripped plain text.

import { describe, it, expect } from "vitest"
import { handleExportSourceRequest } from "../events/export-route"
import { sourceObjectKey } from "../events/source-upload-route"
import { makeTestDb } from "./helpers/pg-test-db"
import { makeTestToken } from "./helpers/auth"

const SECRET = "export-source-side-test-secret"

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

// v1 carries a footnote, v2 a character marker, v4 poetry — the markers a
// plain-text overlay silently eats. Only v3 is ever edited below, so everything
// else has to come back exactly as written here.
const ORIGINAL =
  "\\id GEN\n" +
  "\\c 1\n" +
  "\\v 1 In the beginning God created\\f + \\fr 1.1 \\ft Or: when God began.\\f* the heavens.\n" +
  "\\v 2 Now the earth was \\w formless|strong=\"H8414\"\\w* and empty.\n" +
  "\\v 3 And God said, Let there be light.\n" +
  "\\v 4 And God saw the light,\n" +
  "\\q1 that it was good.\n"

interface CellSeed {
  cell_id: string
  side: "source" | "target"
  value: string
  canonical_ref?: string | null
  anchor_cell_id?: string | null
  target_lang?: string
  hidden_at?: number | null
  metadata?: string | null
  /** Which event the projection recorded as this row's chain head. */
  event_id?: string
}

function cell(seed: CellSeed) {
  return {
    project_id: "p1",
    file_id: "f1",
    value_html: null,
    type: "text",
    anchor_cell_id: null,
    canonical_ref: null,
    event_id: `ev-${seed.cell_id}-${seed.side}-${seed.target_lang ?? ""}`,
    source_event_id: null,
    last_editor: "test",
    last_edit_at: 1700000000000,
    validated: 0,
    word_count: 1,
    content_hash: null,
    target_lang: "",
    ...seed,
  }
}

/** An event row, only as far as the export cares: its id and its kind.
 *  `server_seq` is unique per project, so it counts up as rows are built. */
let seq = 0
function event(id: string, kind: string, cellId: string) {
  seq += 1
  return {
    id,
    schema_version: 1,
    project_id: "p1",
    file_id: "f1",
    cell_id: cellId,
    kind,
    author: "alice",
    payload: "{}",
    client_ts: 1,
    server_ts: 1,
    server_seq: seq,
  }
}

const ADDED_META = JSON.stringify({ aquillaOrigin: { version: 1, kind: "user-insert" } })

/**
 * c1  GEN 1:1 — imported, untouched (head is its create).
 * c2  GEN 1:2 — imported, HIDDEN.
 * c3  GEN 1:3 — imported, then EDITED (head is a source.cell.commit).
 * c4  GEN 1:4 — imported, untouched, but translated in the active lane.
 * c5  added after c3, carries source text.
 * c6  added after c4, carries source text but is HIDDEN.
 *
 * Every imported cell also has a translation, so a source export that leaked one
 * would be obvious.
 */
const SOURCE_CELLS = [
  cell({ cell_id: "c1", side: "source", value: "In the beginning God created the heavens.", canonical_ref: "GEN 1:1", event_id: "ev-create-c1" }),
  cell({ cell_id: "c2", side: "source", value: "Now the earth was formless and empty.", canonical_ref: "GEN 1:2", event_id: "ev-create-c2", hidden_at: 1700000000001 }),
  cell({ cell_id: "c3", side: "source", value: "And God said: Let there be light!", canonical_ref: "GEN 1:3", event_id: "ev-commit-c3" }),
  cell({ cell_id: "c4", side: "source", value: "And God saw the light, that it was good.", canonical_ref: "GEN 1:4", event_id: "ev-create-c4" }),
  cell({ cell_id: "c5", side: "source", value: "A scribal note.", anchor_cell_id: "c3", metadata: ADDED_META, event_id: "ev-create-c5" }),
  cell({ cell_id: "c6", side: "source", value: "A parked note.", anchor_cell_id: "c4", metadata: ADDED_META, event_id: "ev-create-c6", hidden_at: 1700000000002 }),
]

const TARGET_CELLS = [
  cell({ cell_id: "c1", side: "target", value: "TRANSLATION ONE" }),
  cell({ cell_id: "c2", side: "target", value: "TRANSLATION TWO" }),
  cell({ cell_id: "c3", side: "target", value: "TRANSLATION THREE" }),
  cell({ cell_id: "c4", side: "target", value: "TRANSLATION FOUR" }),
  cell({ cell_id: "c5", side: "target", value: "TRANSLATION FIVE" }),
]

const EVENTS = [
  event("ev-create-c1", "source.cell.create", "c1"),
  event("ev-create-c2", "source.cell.create", "c2"),
  event("ev-create-c3", "source.cell.create", "c3"),
  event("ev-commit-c3", "source.cell.commit", "c3"),
  event("ev-create-c4", "source.cell.create", "c4"),
  event("ev-create-c5", "source.cell.create", "c5"),
  event("ev-create-c6", "source.cell.create", "c6"),
]

async function exportUsfm(
  options: {
    cells?: ReturnType<typeof cell>[]
    events?: ReturnType<typeof event>[]
    format?: string
    query?: string
  } = {},
): Promise<Response> {
  const {
    cells: cellRows = [...SOURCE_CELLS, ...TARGET_CELLS],
    events: eventRows = EVENTS,
    format = "usfm",
    query = "?side=source",
  } = options
  const SNAPSHOTS = makeStubBucket()
  const key = sourceObjectKey({ R2_KEY_PREFIX: "" }, "p1", "f1", format)
  SNAPSHOTS._seed(key, new TextEncoder().encode(ORIGINAL))
  const { db } = await makeTestDb({
    projects: [{ id: "p1", name: "Test Project", created_by: 1 }],
    lanes: [
      { id: "srclane1", project_id: "p1", role: "source", name: "Source", legacy_tag: "" },
      { id: "deflane1", project_id: "p1", role: "target", name: "Spanish", legacy_tag: "" },
      { id: "frlane01", project_id: "p1", role: "target", name: "French", legacy_tag: "fr" },
    ],
    files: [{ id: "f1", project_id: "p1", name: "01-GEN.usfm", event_id: "ev1" }],
    file_source_blobs: [{ file_id: "f1", project_id: "p1", format, raw_source: null, r2_key: key }],
    events: eventRows,
    cells: cellRows,
  })
  const token = await makeTestToken(SECRET, { projectId: "p1", fileId: "f1", role: 600 })
  const res = await handleExportSourceRequest(
    new Request(`https://x/api/v1/projects/p1/files/f1/source${query}`, {
      headers: { Authorization: `Bearer ${token}` },
    }),
    { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET, SNAPSHOTS } as never,
  )
  return res!
}

describe("GET /source?side=source — the curated source (AQU-1449)", () => {
  it("applies source edits, drops hidden verses, places added source text, and carries no translation", async () => {
    const res = await exportUsfm()

    expect(res.status).toBe(200)
    expect(res.headers.get("X-Export-Side")).toBe("source")
    expect(await res.text()).toBe(
      "\\id GEN\n" +
      "\\c 1\n" +
      // Untouched: byte-identical, footnote and all.
      "\\v 1 In the beginning God created\\f + \\fr 1.1 \\ft Or: when God began.\\f* the heavens.\n" +
      // GEN 1:2 is hidden — gone, its \v marker with it.
      // Edited source text, then the added cell that follows this verse.
      "\\v 3 And God said: Let there be light! A scribal note.\n" +
      // Untouched, translated, and carrying poetry markup.
      "\\v 4 And God saw the light,\n" +
      "\\q1 that it was good.\n",
    )
  })

  it("contains no translation text at all", async () => {
    const body = await (await exportUsfm()).text()
    expect(body).not.toContain("TRANSLATION")
  })

  it("is byte-identical whichever lane the client is on", async () => {
    const cells = [
      ...SOURCE_CELLS,
      ...TARGET_CELLS,
      cell({ cell_id: "c1", side: "target", value: "BONJOUR", target_lang: "fr" }),
      cell({ cell_id: "c3", side: "target", value: "LUMIERE", target_lang: "fr" }),
    ]
    const [defaultLane, french] = await Promise.all([
      exportUsfm({ cells, query: "?side=source" }).then((r) => r.text()),
      exportUsfm({ cells, query: "?side=source&lane=fr" }).then((r) => r.text()),
    ])
    expect(french).toBe(defaultLane)
  })

  it("ignores ?validated=1 — the source side has no validation threshold", async () => {
    const [plain, validated] = await Promise.all([
      exportUsfm({ query: "?side=source" }).then((r) => r.text()),
      exportUsfm({ query: "?side=source&validated=1" }).then((r) => r.text()),
    ])
    expect(validated).toBe(plain)
  })

  it("brings a hidden verse back once it is shown again", async () => {
    const shown = SOURCE_CELLS.map((c) =>
      c.cell_id === "c2" ? { ...c, hidden_at: null } : c,
    )
    const body = await (await exportUsfm({ cells: [...shown, ...TARGET_CELLS] })).text()
    // Back in place, with its character marker intact — it was never edited.
    expect(body).toContain('\\v 2 Now the earth was \\w formless|strong="H8414"\\w* and empty.\n')
  })

  it("keeps a verse's source edit through a hide and a show", async () => {
    // `source.cell.visibility.set` is not chain-mutating, so hiding never
    // advances `cells.event_id`. The edit's commit is still the head when the
    // cell comes back, and the corrected text has to come back with it.
    const hiddenEdit = SOURCE_CELLS.map((c) =>
      c.cell_id === "c3" ? { ...c, hidden_at: 1700000000003 } : c,
    )
    const whileHidden = await (await exportUsfm({ cells: [...hiddenEdit, ...TARGET_CELLS] })).text()
    expect(whileHidden).not.toContain("\\v 3")

    const shownAgain = await (await exportUsfm()).text()
    expect(shownAgain).toContain("\\v 3 And God said: Let there be light!")
  })

  it("leaves a hidden ADDED cell out of the file", async () => {
    const body = await (await exportUsfm()).text()
    expect(body).not.toContain("A parked note")
  })

  it("drops a verse whose cell was deleted outright", async () => {
    const withoutC4 = SOURCE_CELLS.filter((c) => c.cell_id !== "c4")
    const body = await (
      await exportUsfm({
        cells: [...withoutC4, ...TARGET_CELLS],
        events: [
          ...EVENTS,
          { ...event("ev-create-c4-payload", "source.cell.create", "c4"), payload: JSON.stringify({ canonicalRef: "GEN 1:4" }) },
          event("ev-delete-c4", "source.cell.delete", "c4"),
        ],
      })
    ).text()
    expect(body).not.toContain("And God saw the light")
    expect(body).not.toContain("\\v 4")
  })

  it("does not overlay a verse whose source edit lost its chain slot", async () => {
    // The commit event exists, but the projection's head is still the create —
    // the edit never applied, so the verse must stay byte-identical rather than
    // being rewritten as stripped plain text.
    const staleEdit = SOURCE_CELLS.map((c) =>
      c.cell_id === "c3" ? { ...c, event_id: "ev-create-c3" } : c,
    )
    const body = await (await exportUsfm({ cells: [...staleEdit, ...TARGET_CELLS] })).text()
    // The verse keeps the upload's own words. The added cell still rides it —
    // an addition is placed by the anchor chain and has nothing to do with
    // whether the verse it follows was edited.
    expect(body).toContain("\\v 3 And God said, Let there be light. A scribal note.\n")
    expect(body).not.toContain("Let there be light!")
  })

  it("reports 0 lossy verses when no edited verse had intra-verse markers", async () => {
    const res = await exportUsfm()
    expect(res.headers.get("X-Usfm-Lossy-Verse-Count")).toBe("0")
  })

  it("501s rather than silently returning the target side for a format without a source serializer", async () => {
    const res = await exportUsfm({ format: "txt" })
    expect(res.status).toBe(501)
    expect(await res.text()).toContain("source-side export is not yet supported")
  })
})

describe("GET /source — the target side is unchanged (AQU-1449 regression)", () => {
  it("still injects the active lane's translations and adds no source text", async () => {
    const res = await exportUsfm({ query: "" })

    expect(res.status).toBe(200)
    expect(res.headers.get("X-Export-Side")).toBeNull()
    const body = await res.text()
    expect(body).toContain("\\v 1 TRANSLATION ONE")
    // The hidden verse leaves the target file too (AQU-1423), and the added
    // cell rides its anchor verse — both unchanged by this issue.
    expect(body).not.toContain("\\v 2")
    expect(body).toContain("\\v 3 TRANSLATION THREE TRANSLATION FIVE")
    expect(body).toContain("\\v 4 TRANSLATION FOUR")
    // No curated source text leaked into the target export.
    expect(body).not.toContain("Let there be light!")
  })
})
