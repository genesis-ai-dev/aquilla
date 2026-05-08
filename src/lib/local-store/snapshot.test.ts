import { beforeEach, describe, expect, test } from "vitest"
import { LocalStore } from "./db"
import { MIGRATIONS } from "./migrations"
import { getCell } from "./cells"
import { getLastSeq, getProjectMeta } from "./project-meta"
import { ingestSnapshot } from "./snapshot"

async function* asLines(arr: string[]): AsyncIterable<string> {
  for (const line of arr) yield line
}

const META = JSON.stringify({
  type: "snapshot_meta",
  snapshot_seq: 1234,
  project_id: "p1",
  generated_at: 1_700_000_000_000,
})

const PROJECT = JSON.stringify({
  type: "project_meta",
  project_id: "p1",
  org_id: "o1",
  name: "Genesis",
  library_doc_id: "lib1",
  bound_version_id: "ver1",
  source_lang: "hbo",
  target_lang: "spa",
})

function cellLine(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "cell",
    id: "p1:gen.1.1",
    project_id: "p1",
    scope_id: "gen.1",
    address: "gen.1.1",
    ord: 0,
    kind: "text",
    parent_cell_id: null,
    source_text: "In the beginning",
    source_text_hash: "abc",
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
    created_at: 1,
    updated_at: 1,
    org_id: "o1",
    source_lang: "hbo",
    target_lang: "spa",
    format_meta: "{}",
    ...overrides,
  })
}

describe("ingestSnapshot", () => {
  let store: LocalStore

  beforeEach(async () => {
    store = await LocalStore.open({ name: ":memory:" })
    await store.migrate(MIGRATIONS)
  })

  test("rejects when the first line is not snapshot_meta", async () => {
    await expect(
      ingestSnapshot(store, asLines([PROJECT])),
    ).rejects.toThrow(/snapshot_meta/i)
  })

  test("rejects when the stream is empty", async () => {
    await expect(ingestSnapshot(store, asLines([]))).rejects.toThrow()
  })

  test("sets project_meta with snapshot_seq and last_seq from header", async () => {
    await ingestSnapshot(store, asLines([META, PROJECT]))
    const meta = await getProjectMeta(store, "p1")
    expect(meta?.last_seq).toBe(1234)
    expect(meta?.snapshot_seq).toBe(1234)
    expect(meta?.org_id).toBe("o1")
    expect(await getLastSeq(store, "p1")).toBe(1234)
  })

  test("inserts cells from the snapshot", async () => {
    await ingestSnapshot(
      store,
      asLines([
        META,
        PROJECT,
        cellLine({ id: "p1:gen.1.1", address: "gen.1.1", ord: 0 }),
        cellLine({ id: "p1:gen.1.2", address: "gen.1.2", ord: 1 }),
      ]),
    )
    expect(await getCell(store, "p1:gen.1.1")).not.toBeNull()
    expect(await getCell(store, "p1:gen.1.2")).not.toBeNull()
  })

  test("returns counts of ingested rows", async () => {
    const result = await ingestSnapshot(
      store,
      asLines([
        META,
        PROJECT,
        cellLine({ id: "p1:a" }),
        cellLine({ id: "p1:b" }),
        cellLine({ id: "p1:c" }),
      ]),
    )
    expect(result.snapshotSeq).toBe(1234)
    expect(result.projectId).toBe("p1")
    expect(result.counts.cells).toBe(3)
  })

  test("is idempotent: re-ingest produces the same end state", async () => {
    const inputs = [META, PROJECT, cellLine({ id: "p1:a" }), cellLine({ id: "p1:b" })]
    await ingestSnapshot(store, asLines(inputs))
    await ingestSnapshot(store, asLines(inputs))
    const cells = await store.query<{ count: number }>(
      "SELECT COUNT(*) as count FROM cells",
    )
    expect(cells[0]?.count).toBe(2)
  })

  test("rolls back the entire ingest when a line is malformed", async () => {
    await expect(
      ingestSnapshot(
        store,
        asLines([
          META,
          PROJECT,
          cellLine({ id: "p1:a" }),
          "not-json-at-all",
          cellLine({ id: "p1:b" }),
        ]),
      ),
    ).rejects.toThrow()
    const cells = await store.query<{ count: number }>(
      "SELECT COUNT(*) as count FROM cells",
    )
    expect(cells[0]?.count).toBe(0)
    const meta = await getProjectMeta(store, "p1")
    expect(meta).toBeNull()
  })

  test("ignores blank lines between records", async () => {
    await ingestSnapshot(
      store,
      asLines([META, "", PROJECT, "", cellLine({ id: "p1:a" }), ""]),
    )
    expect(await getCell(store, "p1:a")).not.toBeNull()
  })

  test("snapshot for one project does not touch another project's data", async () => {
    // pre-populate p2 data
    await store.run(
      `INSERT INTO project_meta
        (project_id, org_id, name, library_doc_id, bound_version_id,
         source_lang, target_lang, last_seq, snapshot_seq, loaded_at)
       VALUES ('p2', 'o', 'Other', 'lib2', 'verX', 'eng', 'fra', 5, 5, 1)`,
    )
    await ingestSnapshot(store, asLines([META, PROJECT]))
    const p2 = await getProjectMeta(store, "p2")
    expect(p2?.last_seq).toBe(5)
  })
})
