import { beforeEach, describe, expect, test } from "vitest"
import { LocalStore } from "./db"
import { MIGRATIONS } from "./migrations"
import {
  deleteOutboxRecord,
  enqueueOutboxRecord,
  getOutboxRecord,
  listPending,
  markConflict,
  markFailed,
  markInFlight,
  type NewOutboxRecord,
} from "./outbox"

function makeRecord(overrides: Partial<NewOutboxRecord> = {}): NewOutboxRecord {
  return {
    local_id: "loc-1",
    project_id: "proj1",
    endpoint: "POST /projects/proj1/cells/proj1:gen.1.1",
    payload: JSON.stringify({ translation_text: "hola" }),
    expected_version: 0,
    created_at: 1_700_000_000_000,
    ...overrides,
  }
}

describe("outbox repository", () => {
  let store: LocalStore

  beforeEach(async () => {
    store = await LocalStore.open({ name: ":memory:" })
    await store.migrate(MIGRATIONS)
  })

  test("enqueue stores a record with status pending and attempts 0", async () => {
    await enqueueOutboxRecord(store, makeRecord())
    const got = await getOutboxRecord(store, "loc-1")
    expect(got).toMatchObject({
      local_id: "loc-1",
      status: "pending",
      attempts: 0,
      last_error: null,
    })
  })

  test("listPending returns rows in created_at ascending order", async () => {
    await enqueueOutboxRecord(
      store,
      makeRecord({ local_id: "a", created_at: 100 }),
    )
    await enqueueOutboxRecord(
      store,
      makeRecord({ local_id: "b", created_at: 50 }),
    )
    await enqueueOutboxRecord(
      store,
      makeRecord({ local_id: "c", created_at: 200 }),
    )
    const pending = await listPending(store)
    expect(pending.map((r) => r.local_id)).toEqual(["b", "a", "c"])
  })

  test("listPending excludes non-pending records", async () => {
    await enqueueOutboxRecord(store, makeRecord({ local_id: "a" }))
    await enqueueOutboxRecord(store, makeRecord({ local_id: "b" }))
    await markInFlight(store, "a", 1_700_000_000_001)
    const pending = await listPending(store)
    expect(pending.map((r) => r.local_id)).toEqual(["b"])
  })

  test("listPending filters by projectId when provided", async () => {
    await enqueueOutboxRecord(
      store,
      makeRecord({ local_id: "a", project_id: "p1" }),
    )
    await enqueueOutboxRecord(
      store,
      makeRecord({ local_id: "b", project_id: "p2" }),
    )
    const pending = await listPending(store, { projectId: "p1" })
    expect(pending.map((r) => r.local_id)).toEqual(["a"])
  })

  test("markInFlight sets status and increments attempts", async () => {
    await enqueueOutboxRecord(store, makeRecord())
    await markInFlight(store, "loc-1", 1_700_000_000_001)
    const got = await getOutboxRecord(store, "loc-1")
    expect(got).toMatchObject({
      status: "in_flight",
      attempts: 1,
      updated_at: 1_700_000_000_001,
    })
  })

  test("markConflict sets status and stores error", async () => {
    await enqueueOutboxRecord(store, makeRecord())
    await markInFlight(store, "loc-1", 1)
    await markConflict(store, "loc-1", "version_mismatch", 2)
    const got = await getOutboxRecord(store, "loc-1")
    expect(got).toMatchObject({
      status: "conflict",
      last_error: "version_mismatch",
      updated_at: 2,
    })
  })

  test("markFailed sets status and stores error", async () => {
    await enqueueOutboxRecord(store, makeRecord())
    await markInFlight(store, "loc-1", 1)
    await markFailed(store, "loc-1", "5xx_max_retries", 2)
    const got = await getOutboxRecord(store, "loc-1")
    expect(got).toMatchObject({
      status: "failed",
      last_error: "5xx_max_retries",
    })
  })

  test("deleteOutboxRecord removes the row", async () => {
    await enqueueOutboxRecord(store, makeRecord())
    await deleteOutboxRecord(store, "loc-1")
    const got = await getOutboxRecord(store, "loc-1")
    expect(got).toBeNull()
  })
})
