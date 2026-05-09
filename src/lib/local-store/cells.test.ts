import { beforeEach, describe, expect, test } from "vitest"
import { LocalStore } from "./db"
import { MIGRATIONS } from "./migrations"
import { upsertCell, getCell, getCellsByScope, type CellRow } from "./cells"

function makeCell(overrides: Partial<CellRow> = {}): CellRow {
  const now = 1_700_000_000_000
  return {
    id: "proj1:gen.1.1",
    project_id: "proj1",
    scope_id: "gen.1",
    address: "gen.1.1",
    ord: 0,
    kind: "text",
    parent_cell_id: null,
    source_text: "In the beginning God created the heavens and the earth.",
    source_text_hash: "abc123",
    source_version_id: "ver1",
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
    org_id: "org1",
    source_lang: "hbo",
    target_lang: "spa",
    format_meta: "{}",
    label: null,
    backtranslation_pinned_id: null,
    ...overrides,
  }
}

async function migratedStore(): Promise<LocalStore> {
  const store = await LocalStore.open({ name: ":memory:" })
  await store.migrate(MIGRATIONS)
  return store
}

describe("cells repository", () => {
  let store: LocalStore

  beforeEach(async () => {
    store = await migratedStore()
  })

  test("upsertCell inserts a row that getCell can read back", async () => {
    const cell = makeCell()
    await upsertCell(store, cell)
    const got = await getCell(store, cell.id)
    expect(got).toEqual(cell)
  })

  test("getCell returns null for an unknown id", async () => {
    const got = await getCell(store, "missing")
    expect(got).toBeNull()
  })

  test("upsertCell updates an existing row", async () => {
    const cell = makeCell()
    await upsertCell(store, cell)
    await upsertCell(store, {
      ...cell,
      translation_text: "En el principio creó Dios los cielos y la tierra.",
      version: 1,
    })
    const got = await getCell(store, cell.id)
    expect(got?.translation_text).toBe(
      "En el principio creó Dios los cielos y la tierra.",
    )
    expect(got?.version).toBe(1)
  })

  test("getCellsByScope returns cells in ord order, scoped to project + scope", async () => {
    await upsertCell(store, makeCell({ id: "p:s.2", address: "s.2", ord: 1 }))
    await upsertCell(store, makeCell({ id: "p:s.1", address: "s.1", ord: 0 }))
    await upsertCell(store, makeCell({ id: "p:s.3", address: "s.3", ord: 2 }))
    await upsertCell(
      store,
      makeCell({
        id: "p:other.1",
        scope_id: "other",
        address: "other.1",
        ord: 0,
      }),
    )
    const rows = await getCellsByScope(store, "proj1", "gen.1")
    expect(rows.map((r) => r.id)).toEqual(["p:s.1", "p:s.2", "p:s.3"])
  })

  test("getCellsByScope on a different project returns empty", async () => {
    await upsertCell(store, makeCell())
    const rows = await getCellsByScope(store, "other-proj", "gen.1")
    expect(rows).toEqual([])
  })
})
