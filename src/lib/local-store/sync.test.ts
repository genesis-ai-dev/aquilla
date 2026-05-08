import { beforeEach, describe, expect, test } from "vitest"
import { LocalStore } from "./db"
import { MIGRATIONS } from "./migrations"
import { getCell, type CellRow } from "./cells"
import {
  advanceLastSeq,
  getLastSeq,
  upsertProjectMeta,
} from "./project-meta"
import { applyChangeBatch, type ChangeBatch } from "./sync"

const PROJECT_ID = "p1"

function makeCell(overrides: Partial<CellRow> = {}): CellRow {
  return {
    id: "p1:gen.1.1",
    project_id: PROJECT_ID,
    scope_id: "gen.1",
    address: "gen.1.1",
    ord: 0,
    kind: "text",
    parent_cell_id: null,
    source_text: "In the beginning",
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
    created_at: 1,
    updated_at: 1,
    org_id: "o",
    source_lang: "hbo",
    target_lang: "spa",
    format_meta: "{}",
    ...overrides,
  }
}

async function setupStoreWithProject(): Promise<LocalStore> {
  const store = await LocalStore.open({ name: ":memory:" })
  await store.migrate(MIGRATIONS)
  await upsertProjectMeta(store, {
    project_id: PROJECT_ID,
    org_id: "o",
    name: "Genesis",
    library_doc_id: "lib1",
    bound_version_id: "ver1",
    source_lang: "hbo",
    target_lang: "spa",
    last_seq: 10,
    snapshot_seq: 10,
    loaded_at: 1,
  })
  return store
}

describe("applyChangeBatch", () => {
  let store: LocalStore

  beforeEach(async () => {
    store = await setupStoreWithProject()
  })

  test("upserts cells from the batch", async () => {
    const batch: ChangeBatch = {
      project_id: PROJECT_ID,
      seq: 11,
      cells: [makeCell({ id: "p1:gen.1.1", translation_text: "En el principio" })],
    }
    await applyChangeBatch(store, batch)
    const cell = await getCell(store, "p1:gen.1.1")
    expect(cell?.translation_text).toBe("En el principio")
  })

  test("inserts commits from the batch", async () => {
    const batch: ChangeBatch = {
      project_id: PROJECT_ID,
      seq: 11,
      commits: [
        {
          id: "c1",
          project_id: PROJECT_ID,
          seq: 11,
          kind: "scope_finalized",
          actor_id: "u1",
          message: "Genesis 1 reviewed",
          payload: "{}",
          created_at: 100,
        },
      ],
    }
    await applyChangeBatch(store, batch)
    const rows = await store.query<{ id: string }>("SELECT id FROM commits")
    expect(rows).toEqual([{ id: "c1" }])
  })

  test("advances last_seq after applying", async () => {
    await applyChangeBatch(store, {
      project_id: PROJECT_ID,
      seq: 42,
      cells: [makeCell()],
    })
    expect(await getLastSeq(store, PROJECT_ID)).toBe(42)
  })

  test("drops batches whose seq is not greater than last_seq", async () => {
    await advanceLastSeq(store, PROJECT_ID, 100)
    await applyChangeBatch(store, {
      project_id: PROJECT_ID,
      seq: 50,
      cells: [makeCell({ id: "p1:should-not-appear", translation_text: "x" })],
    })
    const cell = await getCell(store, "p1:should-not-appear")
    expect(cell).toBeNull()
    expect(await getLastSeq(store, PROJECT_ID)).toBe(100)
  })

  test("handles a batch with no cells and no commits — only advances last_seq", async () => {
    await applyChangeBatch(store, { project_id: PROJECT_ID, seq: 20 })
    expect(await getLastSeq(store, PROJECT_ID)).toBe(20)
  })

  test("is atomic — partial batch with bad data does not advance last_seq", async () => {
    const malformedCell = makeCell()
    // null project_id will violate NOT NULL during the inner upsert
    ;(malformedCell as unknown as { project_id: unknown }).project_id = null
    await expect(
      applyChangeBatch(store, {
        project_id: PROJECT_ID,
        seq: 50,
        cells: [makeCell({ id: "p1:gen.1.5" }), malformedCell],
      }),
    ).rejects.toThrow()
    const beforeCell = await getCell(store, "p1:gen.1.5")
    expect(beforeCell).toBeNull()
    expect(await getLastSeq(store, PROJECT_ID)).toBe(10)
  })

  test("is idempotent on re-apply of the same batch", async () => {
    const batch: ChangeBatch = {
      project_id: PROJECT_ID,
      seq: 11,
      cells: [makeCell({ id: "p1:gen.1.1", translation_text: "En el principio" })],
    }
    await applyChangeBatch(store, batch)
    // The second call should drop because seq <= last_seq, but the cell stays.
    await applyChangeBatch(store, batch)
    const cell = await getCell(store, "p1:gen.1.1")
    expect(cell?.translation_text).toBe("En el principio")
    expect(await getLastSeq(store, PROJECT_ID)).toBe(11)
  })
})
