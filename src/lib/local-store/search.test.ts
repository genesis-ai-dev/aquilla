import { beforeEach, describe, expect, test } from "vitest"
import { LocalStore } from "./db"
import { MIGRATIONS } from "./migrations"
import { upsertCell, type CellRow } from "./cells"
import { searchCells } from "./search"

function makeCell(overrides: Partial<CellRow> = {}): CellRow {
  const now = 1_700_000_000_000
  return {
    id: "p:c.1",
    project_id: "p",
    scope_id: "s.1",
    address: "c.1",
    ord: 0,
    kind: "text",
    parent_cell_id: null,
    source_text: "",
    source_text_hash: "h",
    source_version_id: "v",
    translation_text: "",
    tag_dictionary: "{}",
    status: "empty",
    approved_at_version: null,
    locked_by_user_id: null,
    version: 0,
    last_edited_by: null,
    last_edited_at: null,
    seq: 1,
    created_at: now,
    updated_at: now,
    org_id: "o",
    source_lang: "eng",
    target_lang: "spa",
    format_meta: "{}",
    ...overrides,
  }
}

describe("searchCells (FTS5)", () => {
  let store: LocalStore

  beforeEach(async () => {
    store = await LocalStore.open({ name: ":memory:" })
    await store.migrate(MIGRATIONS)
  })

  test("matches a token in source_text", async () => {
    await upsertCell(
      store,
      makeCell({
        id: "c1",
        source_text: "In the beginning God created the heavens",
      }),
    )
    await upsertCell(
      store,
      makeCell({
        id: "c2",
        address: "c.2",
        source_text: "And the earth was without form",
      }),
    )
    const results = await searchCells(store, { query: "beginning" })
    expect(results.map((r) => r.id)).toEqual(["c1"])
  })

  test("matches a token in translation_text", async () => {
    await upsertCell(
      store,
      makeCell({ id: "c1", translation_text: "En el principio creó Dios" }),
    )
    await upsertCell(
      store,
      makeCell({ id: "c2", address: "c.2", translation_text: "La tierra estaba" }),
    )
    const results = await searchCells(store, { query: "principio" })
    expect(results.map((r) => r.id)).toEqual(["c1"])
  })

  test("returns empty for a non-matching query", async () => {
    await upsertCell(
      store,
      makeCell({ id: "c1", source_text: "hello world" }),
    )
    const results = await searchCells(store, { query: "nonexistent" })
    expect(results).toEqual([])
  })

  test("scoping by projectId filters results", async () => {
    await upsertCell(
      store,
      makeCell({ id: "p1:c.1", project_id: "p1", source_text: "moonlight" }),
    )
    await upsertCell(
      store,
      makeCell({ id: "p2:c.1", project_id: "p2", source_text: "moonlight" }),
    )
    const results = await searchCells(store, {
      query: "moonlight",
      projectId: "p1",
    })
    expect(results.map((r) => r.id)).toEqual(["p1:c.1"])
  })

  test("reflects updates: edited cell becomes searchable by new text", async () => {
    const initial = makeCell({ id: "c1", source_text: "alpha" })
    await upsertCell(store, initial)
    expect((await searchCells(store, { query: "alpha" })).map((r) => r.id)).toEqual([
      "c1",
    ])
    await upsertCell(store, { ...initial, source_text: "bravo" })
    expect(await searchCells(store, { query: "alpha" })).toEqual([])
    expect((await searchCells(store, { query: "bravo" })).map((r) => r.id)).toEqual([
      "c1",
    ])
  })
})
