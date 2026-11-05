// AQU-1492 — the scripture-reference scope only applies to scripture files.
//
// `resolveScope` narrows the agent's work list by a human ref range ("MRK 4",
// "MRK 4:1-20"). Whether a file can satisfy such a range depends on the SHAPE
// of its cells' canonical refs, and the two shapes the importer produces are
// not interchangeable:
//
//   scripture  "MRK 4:1"   — satisfies a whole-book AND a chapter/verse scope
//   marker     "XXB:h:1"   — satisfies a whole-book scope ONLY
//
// A non-scripture USFM book (a devotional, a curriculum text, front matter)
// carries marker refs, so a CHAPTERED range can never select one of its cells:
// `parseCanonical` needs "<BOOK> <chapter>[:<verse>]" to compare numbers at
// all. The probe that decides whether to keep the range used the same patterns
// for every range shape, so a marker-ref file kept the range and then had every
// cell filtered out — the agent answered "no untranslated cells in scope" for a
// file full of them. These tests pin the rule: the reference filter must never
// be the reason a non-scripture file reports no cells, and it must keep working
// exactly as before on a real scripture file.

import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import { seedUser } from "./helpers/db"
import { AliasMap } from "../lib/agent/compress"
import { executeRead, resolveScope } from "../lib/agent/tools/read"

const PROJECT = "11111111-1111-4111-8111-111111111111"
const FILE = "22222222-2222-4222-8222-222222222222"

const noFocus = () => ({ projectId: PROJECT, aliases: new AliasMap(), lane: "" })

function cellId(suffix: string): string {
  return `33333333-3333-4333-8333-${suffix.padStart(12, "0")}`
}

async function seedProject() {
  await seedUser(1, "alice")
  await env.AQUILLA_PG.prepare(`INSERT INTO projects (id, name, created_by) VALUES (?, 'P', 1)`).bind(PROJECT).run()
}

/** One file plus its source cells, in the given sequence order. */
async function seedFile(
  name: string,
  bookCode: string | null,
  cells: { id: string; ref: string | null; seq: number; source: string }[],
) {
  await env.AQUILLA_PG.prepare(
    `INSERT INTO files (id, project_id, name, book_code, event_id) VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(FILE, PROJECT, name, bookCode, crypto.randomUUID())
    .run()
  for (const c of cells) {
    await env.AQUILLA_PG.prepare(
      `INSERT INTO cells (project_id, file_id, cell_id, side, value, canonical_ref, sequence_index, event_id, last_edit_at)
       VALUES (?, ?, ?, 'source', ?, ?, ?, ?, 0)`,
    )
      .bind(PROJECT, FILE, cellId(c.id), c.source, c.ref, c.seq, crypto.randomUUID())
      .run()
  }
}

// A devotional book: every cell carries a marker ref, none a chapter:verse.
const MARKER_ONLY = [
  { id: "b1", ref: "XXB:h:1", seq: 1, source: "Come Before God Daily" },
  { id: "b2", ref: "XXB:p:1", seq: 2, source: "Day one: draw near." },
  { id: "b3", ref: "XXB:p:2", seq: 3, source: "Day two: be still." },
]

// A real scripture book.
const SCRIPTURE = [
  { id: "c1", ref: "MRK 4:1", seq: 1, source: "And he began again to teach" },
  { id: "c2", ref: "MRK 4:2", seq: 2, source: "And he taught them many things" },
  { id: "c3", ref: "MRK 5:1", seq: 3, source: "And they came to the other side" },
]

describe("resolveScope — the scripture-reference filter only applies to scripture files (AQU-1492)", () => {
  it("widens a chaptered ref to the whole file when the book's cells carry only markers", async () => {
    await seedProject()
    await seedFile("Come Before God Daily", "XXB", MARKER_ONLY)
    const scope = await resolveScope(env.AQUILLA_PG, { fileId: FILE, ref: "XXB 1" }, noFocus())
    expect(scope.ok && scope.fileId).toBe(FILE)
    expect(scope.ok && scope.range).toBeUndefined()
    expect(scope.ok && scope.notice).toContain('"Come Before God Daily"')
    expect(scope.ok && scope.notice).toContain('"XXB 1"')
  })

  it("reads every untranslated cell of a marker-only file asked for by chapter", async () => {
    await seedProject()
    await seedFile("Come Before God Daily", "XXB", MARKER_ONLY)
    // No fileId: the book code resolves the file, then the ref must widen.
    const out = await executeRead(env.AQUILLA_PG, { ref: "XXB 1", filter: "untranslated" }, noFocus())
    expect(out.ok).toBe(true)
    expect(out.data?.cells?.map((c) => c.source)).toEqual([
      "Come Before God Daily",
      "Day one: draw near.",
      "Day two: be still.",
    ])
  })

  it("widens a VERSE range on a marker-only file too", async () => {
    await seedProject()
    await seedFile("Come Before God Daily", "XXB", MARKER_ONLY)
    const scope = await resolveScope(env.AQUILLA_PG, { fileId: FILE, ref: "XXB 1:1-5" }, noFocus())
    expect(scope.ok && scope.range).toBeUndefined()
    expect(scope.ok && scope.notice).toContain("whole file is in scope")
  })

  it("keeps a whole-book scope narrowing on a marker-only file, with no notice", async () => {
    await seedProject()
    await seedFile("Come Before God Daily", "XXB", MARKER_ONLY)
    const scope = await resolveScope(env.AQUILLA_PG, { fileId: FILE, ref: "XXB" }, noFocus())
    expect(scope.ok && scope.range).toEqual({ book: "XXB" })
    expect(scope.ok && scope.notice).toBeUndefined()
  })

  // Negative guards: reference-based requests on a real scripture file are
  // untouched, including a chapter the file does not contain — that genuinely
  // has no cells and must NOT silently widen to the whole book.
  it("keeps a chapter scope on a scripture file", async () => {
    await seedProject()
    await seedFile("Mark", "MRK", SCRIPTURE)
    const scope = await resolveScope(env.AQUILLA_PG, { fileId: FILE, ref: "MRK 4" }, noFocus())
    expect(scope.ok && scope.range).toEqual({ book: "MRK", chapter: 4 })
    expect(scope.ok && scope.notice).toBeUndefined()
    const out = await executeRead(env.AQUILLA_PG, { fileId: FILE, ref: "MRK 4" }, noFocus())
    expect(out.data?.cells?.map((c) => c.ref)).toEqual(["MRK 4:1", "MRK 4:2"])
  })

  it("still scopes a verse range on a scripture file", async () => {
    await seedProject()
    await seedFile("Mark", "MRK", SCRIPTURE)
    const out = await executeRead(env.AQUILLA_PG, { fileId: FILE, ref: "MRK 4:2" }, noFocus())
    expect(out.data?.cells?.map((c) => c.ref)).toEqual(["MRK 4:2"])
  })

  it("does not widen a chapter the scripture file simply does not contain", async () => {
    await seedProject()
    await seedFile("Mark", "MRK", SCRIPTURE)
    const scope = await resolveScope(env.AQUILLA_PG, { fileId: FILE, ref: "MRK 99" }, noFocus())
    expect(scope.ok && scope.range).toEqual({ book: "MRK", chapter: 99 })
    expect(scope.ok && scope.notice).toBeUndefined()
    const out = await executeRead(env.AQUILLA_PG, { fileId: FILE, ref: "MRK 99" }, noFocus())
    expect(out.data?.cells ?? []).toEqual([])
  })
})
