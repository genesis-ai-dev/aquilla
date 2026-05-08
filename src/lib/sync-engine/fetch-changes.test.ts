import { beforeEach, describe, expect, test, vi } from "vitest"
import {
  getCell,
  getLastSeq,
  LocalStore,
  MIGRATIONS,
  upsertProjectMeta,
} from "../local-store"
import { fetchChanges, type ChangesFetchDeps } from "./fetch-changes"

const PROJECT_ID = "p1"

function cellRecord(overrides: Record<string, unknown> = {}) {
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
    seq: 11,
    created_at: 1,
    updated_at: 1,
    org_id: "o",
    source_lang: "hbo",
    target_lang: "spa",
    format_meta: "{}",
    ...overrides,
  }
}

async function setup(): Promise<LocalStore> {
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

function makeDeps(
  fetchImpl: ReturnType<typeof vi.fn>,
  overrides: Partial<ChangesFetchDeps> = {},
): ChangesFetchDeps {
  return {
    fetchImpl: fetchImpl as unknown as typeof fetch,
    baseUrl: "https://api.example.com",
    projectId: PROJECT_ID,
    getAuthToken: () => Promise.resolve("test-token"),
    ...overrides,
  }
}

describe("fetchChanges", () => {
  let store: LocalStore

  beforeEach(async () => {
    store = await setup()
  })

  test("applies a single page of changes and advances last_seq", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          seq: 11,
          cells: [cellRecord({ translation_text: "En el principio" })],
          commits: [],
          more: false,
        }),
        { status: 200 },
      ),
    )

    const result = await fetchChanges(store, makeDeps(fetchMock))

    expect(result.batchesApplied).toBe(1)
    expect(result.finalSeq).toBe(11)
    expect(await getLastSeq(store, PROJECT_ID)).toBe(11)
    expect(await getCell(store, "p1:gen.1.1")).toMatchObject({
      translation_text: "En el principio",
    })
  })

  test("paginates while more=true", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            seq: 20,
            cells: [cellRecord({ id: "p1:a", seq: 20 })],
            commits: [],
            more: true,
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            seq: 30,
            cells: [cellRecord({ id: "p1:b", seq: 30 })],
            commits: [],
            more: true,
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ seq: 30, cells: [], commits: [], more: false }),
          { status: 200 },
        ),
      )

    const result = await fetchChanges(store, makeDeps(fetchMock))

    expect(result.batchesApplied).toBe(2)
    expect(result.finalSeq).toBe(30)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(await getLastSeq(store, PROJECT_ID)).toBe(30)
  })

  test("uses since=last_seq from local store on first call", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ seq: 10, cells: [], commits: [], more: false }),
        { status: 200 },
      ),
    )

    await fetchChanges(store, makeDeps(fetchMock))

    const url = fetchMock.mock.calls[0][0] as string
    expect(url).toContain("since=10")
    expect(url).toContain("/projects/p1/changes")
  })

  test("on subsequent pages, since advances to the previous batch's seq", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            seq: 50,
            cells: [cellRecord({ id: "p1:a", seq: 50 })],
            commits: [],
            more: true,
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ seq: 50, cells: [], commits: [], more: false }),
          { status: 200 },
        ),
      )

    await fetchChanges(store, makeDeps(fetchMock))

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[0][0]).toContain("since=10")
    expect(fetchMock.mock.calls[1][0]).toContain("since=50")
  })

  test("returns immediately when first page reports zero changes", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ seq: 10, cells: [], commits: [], more: false }),
        { status: 200 },
      ),
    )

    const result = await fetchChanges(store, makeDeps(fetchMock))

    expect(result.batchesApplied).toBe(0)
    expect(result.finalSeq).toBe(10)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test("sends the Authorization header", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ seq: 10, cells: [], commits: [], more: false }),
        { status: 200 },
      ),
    )

    await fetchChanges(store, makeDeps(fetchMock))

    const init = fetchMock.mock.calls[0][1]
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: "Bearer test-token",
    })
  })

  test("throws on non-2xx", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("err", { status: 500 }))

    await expect(fetchChanges(store, makeDeps(fetchMock))).rejects.toThrow(
      /500/,
    )
  })

  test("includes optional limit query param when provided", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ seq: 10, cells: [], commits: [], more: false }),
        { status: 200 },
      ),
    )

    await fetchChanges(store, makeDeps(fetchMock, { limit: 500 }))

    const url = fetchMock.mock.calls[0][0] as string
    expect(url).toContain("limit=500")
  })
})
