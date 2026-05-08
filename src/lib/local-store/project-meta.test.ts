import { beforeEach, describe, expect, test } from "vitest"
import { LocalStore } from "./db"
import { MIGRATIONS } from "./migrations"
import {
  advanceLastSeq,
  getLastSeq,
  getProjectMeta,
  upsertProjectMeta,
  type ProjectMetaRow,
} from "./project-meta"

function makeMeta(overrides: Partial<ProjectMetaRow> = {}): ProjectMetaRow {
  return {
    project_id: "proj1",
    org_id: "org1",
    name: "Genesis (es)",
    library_doc_id: "lib1",
    bound_version_id: "ver1",
    source_lang: "hbo",
    target_lang: "spa",
    last_seq: 0,
    snapshot_seq: null,
    loaded_at: 1_700_000_000_000,
    ...overrides,
  }
}

describe("project_meta repository", () => {
  let store: LocalStore

  beforeEach(async () => {
    store = await LocalStore.open({ name: ":memory:" })
    await store.migrate(MIGRATIONS)
  })

  test("upsertProjectMeta inserts a row that getProjectMeta reads back", async () => {
    const meta = makeMeta()
    await upsertProjectMeta(store, meta)
    const got = await getProjectMeta(store, meta.project_id)
    expect(got).toEqual(meta)
  })

  test("getProjectMeta returns null when no row exists", async () => {
    const got = await getProjectMeta(store, "nonexistent")
    expect(got).toBeNull()
  })

  test("upsertProjectMeta updates an existing row", async () => {
    await upsertProjectMeta(store, makeMeta())
    await upsertProjectMeta(
      store,
      makeMeta({ name: "Genesis (es) v2", last_seq: 100 }),
    )
    const got = await getProjectMeta(store, "proj1")
    expect(got?.name).toBe("Genesis (es) v2")
    expect(got?.last_seq).toBe(100)
  })

  test("getLastSeq returns 0 for a project that has no row yet", async () => {
    const seq = await getLastSeq(store, "proj1")
    expect(seq).toBe(0)
  })

  test("getLastSeq returns the row's last_seq when present", async () => {
    await upsertProjectMeta(store, makeMeta({ last_seq: 42 }))
    const seq = await getLastSeq(store, "proj1")
    expect(seq).toBe(42)
  })

  test("advanceLastSeq raises last_seq to the new value", async () => {
    await upsertProjectMeta(store, makeMeta({ last_seq: 10 }))
    await advanceLastSeq(store, "proj1", 50)
    expect(await getLastSeq(store, "proj1")).toBe(50)
  })

  test("advanceLastSeq is monotonic — does not lower last_seq", async () => {
    await upsertProjectMeta(store, makeMeta({ last_seq: 50 }))
    await advanceLastSeq(store, "proj1", 30)
    expect(await getLastSeq(store, "proj1")).toBe(50)
  })
})
