import { describe, expect, test } from "vitest"
import { LocalStore } from "./db"

describe("LocalStore", () => {
  test("opens an in-memory database and answers SELECT 1", async () => {
    const store = await LocalStore.open({ name: ":memory:" })
    try {
      const result = await store.query<{ one: number }>("SELECT 1 as one")
      expect(result).toEqual([{ one: 1 }])
    } finally {
      await store.close()
    }
  })

  test("query supports parameter binding", async () => {
    const store = await LocalStore.open({ name: ":memory:" })
    try {
      const result = await store.query<{ greeting: string }>(
        "SELECT ? || ', ' || ? as greeting",
        ["hello", "world"],
      )
      expect(result).toEqual([{ greeting: "hello, world" }])
    } finally {
      await store.close()
    }
  })

  test("run executes DDL and INSERT, then query reads it back", async () => {
    const store = await LocalStore.open({ name: ":memory:" })
    try {
      await store.run("CREATE TABLE t (id INTEGER PRIMARY KEY, label TEXT)")
      await store.run("INSERT INTO t (id, label) VALUES (?, ?)", [1, "first"])
      await store.run("INSERT INTO t (id, label) VALUES (?, ?)", [2, "second"])
      const rows = await store.query<{ id: number; label: string }>(
        "SELECT id, label FROM t ORDER BY id",
      )
      expect(rows).toEqual([
        { id: 1, label: "first" },
        { id: 2, label: "second" },
      ])
    } finally {
      await store.close()
    }
  })

  test("two stores opened with :memory: are independent", async () => {
    const a = await LocalStore.open({ name: ":memory:" })
    const b = await LocalStore.open({ name: ":memory:" })
    try {
      await a.run("CREATE TABLE t (id INTEGER PRIMARY KEY)")
      await a.run("INSERT INTO t (id) VALUES (1)")
      await expect(b.query("SELECT id FROM t")).rejects.toThrow()
    } finally {
      await a.close()
      await b.close()
    }
  })
})
