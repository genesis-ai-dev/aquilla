import { beforeEach, describe, expect, test, vi } from "vitest"
import {
  getCell,
  getLastSeq,
  LocalStore,
  MIGRATIONS,
} from "../local-store"
import { loadSnapshot, type SnapshotLoaderDeps } from "./load-snapshot"

const PROJECT_ID = "p1"

const META = JSON.stringify({
  type: "snapshot_meta",
  snapshot_seq: 7777,
  project_id: PROJECT_ID,
  generated_at: 1,
})

const PROJECT_META = JSON.stringify({
  type: "project_meta",
  project_id: PROJECT_ID,
  org_id: "o",
  name: "Genesis",
  library_doc_id: "lib1",
  bound_version_id: "ver1",
  source_lang: "hbo",
  target_lang: "spa",
})

const CELL = JSON.stringify({
  type: "cell",
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
})

const JSONL_BODY = [META, PROJECT_META, CELL].join("\n")

function makeDeps(
  fetchImpl: ReturnType<typeof vi.fn>,
  overrides: Partial<SnapshotLoaderDeps> = {},
): SnapshotLoaderDeps {
  return {
    fetchImpl: fetchImpl as unknown as typeof fetch,
    baseUrl: "https://api.example.com",
    projectId: PROJECT_ID,
    getAuthToken: () => Promise.resolve("test-token"),
    ...overrides,
  }
}

describe("loadSnapshot", () => {
  let store: LocalStore

  beforeEach(async () => {
    store = await LocalStore.open({ name: ":memory:" })
    await store.migrate(MIGRATIONS)
  })

  test("fetches the snapshot URL and ingests the JSONL body", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSONL_BODY, { status: 200 }))

    const result = await loadSnapshot(store, makeDeps(fetchMock))

    expect(result.snapshotSeq).toBe(7777)
    expect(result.projectId).toBe(PROJECT_ID)
    expect(result.counts.cells).toBe(1)
    expect(await getCell(store, "p1:gen.1.1")).not.toBeNull()
    expect(await getLastSeq(store, PROJECT_ID)).toBe(7777)
  })

  test("uses the correct URL and Authorization header", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSONL_BODY, { status: 200 }))

    await loadSnapshot(store, makeDeps(fetchMock))

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("https://api.example.com/projects/p1/snapshot")
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: "Bearer test-token",
    })
  })

  test("omits Authorization header when no token is available", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSONL_BODY, { status: 200 }))

    await loadSnapshot(
      store,
      makeDeps(fetchMock, { getAuthToken: () => Promise.resolve(null) }),
    )

    const [, init] = fetchMock.mock.calls[0]
    const headers = (init as RequestInit).headers as Record<string, string>
    expect(headers).not.toHaveProperty("Authorization")
  })

  test("throws on non-2xx response", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("forbidden", { status: 403 }))

    await expect(loadSnapshot(store, makeDeps(fetchMock))).rejects.toThrow(
      /403/,
    )
  })

  test("throws when fetch itself rejects (network error)", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("network down"))

    await expect(loadSnapshot(store, makeDeps(fetchMock))).rejects.toThrow(
      /network down/,
    )
  })
})
