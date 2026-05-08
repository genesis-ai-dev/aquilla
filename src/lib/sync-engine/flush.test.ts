import { beforeEach, describe, expect, test, vi } from "vitest"
import {
  enqueueOutboxRecord,
  getCell,
  getOutboxRecord,
  LocalStore,
  MIGRATIONS,
  upsertProjectMeta,
} from "../local-store"
import { flushOutbox, type FlushDeps } from "./flush"

const PROJECT_ID = "p1"
const NOW = 1_700_000_000_000

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
    last_seq: 0,
    snapshot_seq: null,
    loaded_at: NOW,
  })
  return store
}

async function enqueueOne(
  store: LocalStore,
  overrides: { local_id?: string; payload?: string; expected_version?: number } = {},
): Promise<void> {
  await enqueueOutboxRecord(store, {
    local_id: overrides.local_id ?? "loc-1",
    project_id: PROJECT_ID,
    endpoint: `/projects/${PROJECT_ID}/cells/p1:gen.1.1`,
    payload:
      overrides.payload ??
      JSON.stringify({ translation_text: "En el principio" }),
    expected_version: overrides.expected_version ?? 0,
    created_at: NOW,
  })
}

const SUCCESS_CELL = {
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
  translation_text: "En el principio",
  tag_dictionary: "{}",
  status: "draft",
  approved_at_version: null,
  locked_by_user_id: null,
  version: 1,
  last_edited_by: "u1",
  last_edited_at: NOW,
  seq: 5,
  created_at: 1,
  updated_at: NOW,
  org_id: "o",
  source_lang: "hbo",
  target_lang: "spa",
  format_meta: "{}",
}

function makeDeps(
  fetchImpl: ReturnType<typeof vi.fn>,
  overrides: Partial<FlushDeps> = {},
): FlushDeps {
  return {
    fetchImpl: fetchImpl as unknown as typeof fetch,
    baseUrl: "https://api.example.com",
    getAuthToken: () => Promise.resolve("test-token"),
    now: () => NOW,
    maxAttempts: 3,
    ...overrides,
  }
}

describe("flushOutbox", () => {
  let store: LocalStore

  beforeEach(async () => {
    store = await setup()
  })

  test("drains a pending record on 200 and upserts the returned cell", async () => {
    await enqueueOne(store)
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ cell: SUCCESS_CELL }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )

    const result = await flushOutbox(store, makeDeps(fetchMock))

    expect(result).toMatchObject({ drained: 1, conflicts: 0, failed: 0 })
    expect(await getOutboxRecord(store, "loc-1")).toBeNull()
    expect(await getCell(store, "p1:gen.1.1")).toMatchObject({
      translation_text: "En el principio",
      version: 1,
    })
  })

  test("sends with Authorization header and JSON body", async () => {
    await enqueueOne(store)
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ cell: SUCCESS_CELL }), { status: 200 }),
    )

    await flushOutbox(store, makeDeps(fetchMock))

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(
      "https://api.example.com/projects/p1/cells/p1:gen.1.1",
    )
    expect((init as RequestInit).method).toBe("POST")
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: "Bearer test-token",
      "Content-Type": "application/json",
    })
    expect((init as RequestInit).body).toBe(
      JSON.stringify({ translation_text: "En el principio" }),
    )
  })

  test("marks conflict on 409 with error from response body", async () => {
    await enqueueOne(store)
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ error: "version_mismatch", current_version: 3 }),
        { status: 409 },
      ),
    )

    const result = await flushOutbox(store, makeDeps(fetchMock))

    expect(result.conflicts).toBe(1)
    expect(result.drained).toBe(0)
    const record = await getOutboxRecord(store, "loc-1")
    expect(record?.status).toBe("conflict")
    expect(record?.last_error).toContain("version_mismatch")
  })

  test("on transient 5xx with attempts < max, returns to pending for retry", async () => {
    await enqueueOne(store)
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("internal error", { status: 503 }))

    const result = await flushOutbox(
      store,
      makeDeps(fetchMock, { maxAttempts: 3 }),
    )

    expect(result.drained).toBe(0)
    expect(result.failed).toBe(0)
    const record = await getOutboxRecord(store, "loc-1")
    expect(record?.status).toBe("pending")
    expect(record?.attempts).toBe(1)
  })

  test("on 5xx after max attempts, marks failed", async () => {
    await enqueueOne(store)
    // simulate two prior failures by sending twice with maxAttempts=3
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("err", { status: 503 }))
    await flushOutbox(store, makeDeps(fetchMock, { maxAttempts: 3 })) // attempts→1, pending
    await flushOutbox(store, makeDeps(fetchMock, { maxAttempts: 3 })) // attempts→2, pending
    const result = await flushOutbox(
      store,
      makeDeps(fetchMock, { maxAttempts: 3 }),
    )
    // attempts→3 now equals max — flusher decides this attempt is the last.
    expect(result.failed).toBe(1)
    const record = await getOutboxRecord(store, "loc-1")
    expect(record?.status).toBe("failed")
    expect(record?.attempts).toBe(3)
  })

  test("network error is treated as retryable failure", async () => {
    await enqueueOne(store)
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("network down"))

    const result = await flushOutbox(store, makeDeps(fetchMock))

    expect(result.drained).toBe(0)
    expect(result.failed).toBe(0)
    const record = await getOutboxRecord(store, "loc-1")
    expect(record?.status).toBe("pending")
    expect(record?.last_error).toContain("network down")
  })

  test("non-409 4xx (e.g. 400, 403) marks failed immediately", async () => {
    await enqueueOne(store)
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("bad request", { status: 400 }))

    const result = await flushOutbox(store, makeDeps(fetchMock))

    expect(result.failed).toBe(1)
    const record = await getOutboxRecord(store, "loc-1")
    expect(record?.status).toBe("failed")
  })

  test("processes pending records in FIFO order", async () => {
    await enqueueOne(store, { local_id: "a" })
    await enqueueOutboxRecord(store, {
      local_id: "b",
      project_id: PROJECT_ID,
      endpoint: `/projects/${PROJECT_ID}/cells/p1:gen.1.2`,
      payload: "{}",
      expected_version: 0,
      created_at: NOW + 10,
    })
    const seenOrder: string[] = []
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      seenOrder.push(url as string)
      return new Response(JSON.stringify({ cell: SUCCESS_CELL }), {
        status: 200,
      })
    })

    await flushOutbox(store, makeDeps(fetchMock))

    expect(seenOrder).toEqual([
      "https://api.example.com/projects/p1/cells/p1:gen.1.1",
      "https://api.example.com/projects/p1/cells/p1:gen.1.2",
    ])
  })

  test("returns drained=0 when there is nothing pending", async () => {
    const fetchMock = vi.fn()
    const result = await flushOutbox(store, makeDeps(fetchMock))
    expect(result).toEqual({ drained: 0, conflicts: 0, failed: 0 })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("does not attempt to send when no auth token is available", async () => {
    await enqueueOne(store)
    const fetchMock = vi.fn()
    const result = await flushOutbox(
      store,
      makeDeps(fetchMock, { getAuthToken: () => Promise.resolve(null) }),
    )
    expect(result).toEqual({ drained: 0, conflicts: 0, failed: 0 })
    expect(fetchMock).not.toHaveBeenCalled()
    const record = await getOutboxRecord(store, "loc-1")
    expect(record?.status).toBe("pending")
  })
})
