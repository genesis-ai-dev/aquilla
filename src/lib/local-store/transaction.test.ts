import { describe, expect, test } from "vitest"
import { LocalStore } from "./db"

async function setupStore() {
  const store = await LocalStore.open({ name: ":memory:" })
  await store.run("CREATE TABLE t (id INTEGER PRIMARY KEY, label TEXT)")
  return store
}

describe("LocalStore.transaction", () => {
  test("commits writes when the function resolves", async () => {
    const store = await setupStore()
    try {
      await store.transaction(async () => {
        await store.run("INSERT INTO t (id, label) VALUES (1, 'a')")
        await store.run("INSERT INTO t (id, label) VALUES (2, 'b')")
      })
      const rows = await store.query<{ id: number }>(
        "SELECT id FROM t ORDER BY id",
      )
      expect(rows).toEqual([{ id: 1 }, { id: 2 }])
    } finally {
      await store.close()
    }
  })

  test("rolls back when the function throws", async () => {
    const store = await setupStore()
    try {
      await expect(
        store.transaction(async () => {
          await store.run("INSERT INTO t (id, label) VALUES (1, 'a')")
          throw new Error("boom")
        }),
      ).rejects.toThrow("boom")
      const rows = await store.query<{ id: number }>("SELECT id FROM t")
      expect(rows).toEqual([])
    } finally {
      await store.close()
    }
  })

  test("returns the value the function resolves to", async () => {
    const store = await setupStore()
    try {
      const result = await store.transaction(async () => {
        await store.run("INSERT INTO t (id, label) VALUES (1, 'a')")
        return "ok"
      })
      expect(result).toBe("ok")
    } finally {
      await store.close()
    }
  })

  test("supports synchronous callbacks too", async () => {
    const store = await setupStore()
    try {
      const result = await store.transaction(() => 42)
      expect(result).toBe(42)
    } finally {
      await store.close()
    }
  })
})
