import { describe, expect, test } from "vitest"
import { LocalStore } from "./db"
import { MIGRATIONS } from "./migrations"

describe("LocalStore.migrate", () => {
  test("creates the expected tables from the initial migration", async () => {
    const store = await LocalStore.open({ name: ":memory:" })
    try {
      await store.migrate(MIGRATIONS)
      const tables = await store.query<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      )
      const names = tables.map((t) => t.name)
      expect(names).toContain("cells")
      expect(names).toContain("commits")
      expect(names).toContain("library_documents")
      expect(names).toContain("library_document_versions")
      expect(names).toContain("outbox")
      expect(names).toContain("project_meta")
    } finally {
      await store.close()
    }
  })

  test("creates the cells_fts virtual table", async () => {
    const store = await LocalStore.open({ name: ":memory:" })
    try {
      await store.migrate(MIGRATIONS)
      const tables = await store.query<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='cells_fts'",
      )
      expect(tables).toHaveLength(1)
    } finally {
      await store.close()
    }
  })

  test("is idempotent — calling twice does not error", async () => {
    const store = await LocalStore.open({ name: ":memory:" })
    try {
      await store.migrate(MIGRATIONS)
      await store.migrate(MIGRATIONS)
      const versions = await store.query<{ version: number }>(
        "SELECT version FROM _migrations ORDER BY version",
      )
      // Whatever migrations are committed in MIGRATIONS, calling migrate
      // twice leaves exactly one row per version. The set itself grows
      // over time; the assertion is "no duplication," not a hardcoded count.
      const expected = MIGRATIONS.map((m) => ({ version: m.version })).sort(
        (a, b) => a.version - b.version,
      )
      expect(versions).toEqual(expected)
    } finally {
      await store.close()
    }
  })

  test("applies migrations in ascending version order regardless of input order", async () => {
    const store = await LocalStore.open({ name: ":memory:" })
    try {
      const m1 = { version: 1, sql: "CREATE TABLE t1 (id INTEGER)" }
      const m2 = { version: 2, sql: "CREATE TABLE t2 (id INTEGER)" }
      const m3 = { version: 3, sql: "CREATE TABLE t3 (id INTEGER)" }
      await store.migrate([m3, m1, m2])
      const versions = await store.query<{ version: number }>(
        "SELECT version FROM _migrations ORDER BY applied_at",
      )
      expect(versions).toEqual([
        { version: 1 },
        { version: 2 },
        { version: 3 },
      ])
    } finally {
      await store.close()
    }
  })

  test("skips already-applied migrations on subsequent runs", async () => {
    const store = await LocalStore.open({ name: ":memory:" })
    try {
      const m1 = { version: 1, sql: "CREATE TABLE t1 (id INTEGER)" }
      const m2 = { version: 2, sql: "CREATE TABLE t2 (id INTEGER)" }
      await store.migrate([m1])
      await store.migrate([m1, m2])
      const versions = await store.query<{ version: number }>(
        "SELECT version FROM _migrations ORDER BY version",
      )
      expect(versions).toEqual([{ version: 1 }, { version: 2 }])
    } finally {
      await store.close()
    }
  })
})
