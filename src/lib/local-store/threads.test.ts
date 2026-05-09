/**
 * Repository tests for threads + thread_messages.
 * Cell-keyed entities — see DATA_PERSISTENCE_PLAN.md §4.12.
 */

import { beforeEach, describe, expect, test } from "vitest"
import { LocalStore } from "./db"
import { MIGRATIONS } from "./migrations"
import {
  appendThreadMessage,
  getMessagesByThread,
  getThread,
  getThreadsByCell,
  resolveThreadStatus,
  upsertThread,
  type ThreadMessageRow,
  type ThreadRow,
} from "./threads"

const NOW = 1_700_000_000_000

function makeThread(overrides: Partial<ThreadRow> = {}): ThreadRow {
  return {
    id: "th-1",
    cell_id: "p1:c1",
    status: "open",
    created_by: "u1",
    created_at: NOW,
    resolved_by: null,
    resolved_at: null,
    seq: 1,
    ...overrides,
  }
}

function makeMessage(overrides: Partial<ThreadMessageRow> = {}): ThreadMessageRow {
  return {
    id: "msg-1",
    thread_id: "th-1",
    author_id: "u1",
    body: "first message",
    created_at: NOW,
    seq: 1,
    ...overrides,
  }
}

describe("threads repository", () => {
  let store: LocalStore

  beforeEach(async () => {
    store = await LocalStore.open({ name: ":memory:" })
    await store.migrate(MIGRATIONS)
  })

  test("upsertThread + getThread round-trip", async () => {
    const t = makeThread()
    await upsertThread(store, t)
    expect(await getThread(store, t.id)).toEqual(t)
  })

  test("upsertThread updates an existing row", async () => {
    await upsertThread(store, makeThread())
    await upsertThread(
      store,
      makeThread({
        status: "resolved",
        resolved_by: "u2",
        resolved_at: NOW + 1,
      }),
    )
    const got = await getThread(store, "th-1")
    expect(got?.status).toBe("resolved")
    expect(got?.resolved_by).toBe("u2")
  })

  test("getThreadsByCell returns threads ordered by created_at", async () => {
    await upsertThread(store, makeThread({ id: "a", created_at: 100 }))
    await upsertThread(store, makeThread({ id: "b", created_at: 50 }))
    await upsertThread(store, makeThread({ id: "c", created_at: 200 }))
    const rows = await getThreadsByCell(store, "p1:c1")
    expect(rows.map((r) => r.id)).toEqual(["b", "a", "c"])
  })

  test("getThreadsByCell scopes by cell", async () => {
    await upsertThread(store, makeThread({ id: "a", cell_id: "p1:c1" }))
    await upsertThread(store, makeThread({ id: "b", cell_id: "p1:c2" }))
    expect((await getThreadsByCell(store, "p1:c1")).map((r) => r.id)).toEqual(["a"])
  })

  test("appendThreadMessage + getMessagesByThread", async () => {
    await upsertThread(store, makeThread())
    await appendThreadMessage(store, makeMessage())
    await appendThreadMessage(
      store,
      makeMessage({ id: "msg-2", body: "second", created_at: NOW + 1 }),
    )
    const rows = await getMessagesByThread(store, "th-1")
    expect(rows.map((m) => m.id)).toEqual(["msg-1", "msg-2"])
    expect(rows.map((m) => m.body)).toEqual(["first message", "second"])
  })

  test("appendThreadMessage is idempotent on the same id (INSERT OR REPLACE)", async () => {
    await upsertThread(store, makeThread())
    await appendThreadMessage(store, makeMessage({ body: "v1" }))
    await appendThreadMessage(store, makeMessage({ body: "v2" }))
    const rows = await getMessagesByThread(store, "th-1")
    expect(rows).toHaveLength(1)
    expect(rows[0].body).toBe("v2")
  })

  test("resolveThreadStatus moves a thread to resolved", async () => {
    await upsertThread(store, makeThread())
    await resolveThreadStatus(store, "th-1", {
      resolved_by: "u3",
      resolved_at: NOW + 5,
    })
    const got = await getThread(store, "th-1")
    expect(got?.status).toBe("resolved")
    expect(got?.resolved_by).toBe("u3")
    expect(got?.resolved_at).toBe(NOW + 5)
  })

  test("resolveThreadStatus on a missing thread is a no-op", async () => {
    await resolveThreadStatus(store, "missing", {
      resolved_by: "u",
      resolved_at: NOW,
    })
    expect(await getThread(store, "missing")).toBeNull()
  })
})
