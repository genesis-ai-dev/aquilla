/**
 * Drift detection tests. Once a migration has been applied to a database,
 * its content must never change — see DATA_PERSISTENCE_PLAN.md §13.
 */

import { describe, expect, test } from "vitest"
import { LocalStore, MigrationDriftError } from "./db"

describe("migration drift detection", () => {
  test("reapplying an unchanged migration is a no-op", async () => {
    const store = await LocalStore.open({ name: ":memory:" })
    try {
      const m = { version: 1, sql: "CREATE TABLE t (id INTEGER PRIMARY KEY)" }
      await store.migrate([m])
      await store.migrate([m])
      const versions = await store.query<{ version: number }>(
        "SELECT version FROM _migrations",
      )
      expect(versions).toEqual([{ version: 1 }])
    } finally {
      await store.close()
    }
  })

  test("changing a previously-applied migration's content throws MigrationDriftError", async () => {
    const store = await LocalStore.open({ name: ":memory:" })
    try {
      await store.migrate([
        { version: 1, sql: "CREATE TABLE t (id INTEGER PRIMARY KEY)" },
      ])
      // Same version, different SQL — drift.
      await expect(
        store.migrate([
          { version: 1, sql: "CREATE TABLE t (id INTEGER PRIMARY KEY, label TEXT)" },
        ]),
      ).rejects.toBeInstanceOf(MigrationDriftError)
    } finally {
      await store.close()
    }
  })

  test("MigrationDriftError carries version + both hashes for telemetry", async () => {
    const store = await LocalStore.open({ name: ":memory:" })
    try {
      await store.migrate([{ version: 7, sql: "CREATE TABLE a (x INTEGER)" }])
      try {
        await store.migrate([{ version: 7, sql: "CREATE TABLE a (x TEXT)" }])
        throw new Error("should have thrown")
      } catch (e) {
        if (!(e instanceof MigrationDriftError)) throw e
        expect(e.version).toBe(7)
        expect(e.stored).toMatch(/^[a-f0-9]{64}$/)
        expect(e.current).toMatch(/^[a-f0-9]{64}$/)
        expect(e.stored).not.toBe(e.current)
      }
    } finally {
      await store.close()
    }
  })

  test("drift on one migration does not touch other rows in _migrations", async () => {
    const store = await LocalStore.open({ name: ":memory:" })
    try {
      await store.migrate([
        { version: 1, sql: "CREATE TABLE a (x INTEGER)" },
        { version: 2, sql: "CREATE TABLE b (y INTEGER)" },
      ])
      await expect(
        store.migrate([
          { version: 1, sql: "CREATE TABLE a (x TEXT)" },
          { version: 2, sql: "CREATE TABLE b (y INTEGER)" },
        ]),
      ).rejects.toBeInstanceOf(MigrationDriftError)
      const rows = await store.query<{ version: number }>(
        "SELECT version FROM _migrations ORDER BY version",
      )
      expect(rows).toEqual([{ version: 1 }, { version: 2 }])
    } finally {
      await store.close()
    }
  })

  test("trailing whitespace and CRLF are normalized before hashing", async () => {
    const store = await LocalStore.open({ name: ":memory:" })
    try {
      await store.migrate([
        { version: 1, sql: "CREATE TABLE t (id INTEGER PRIMARY KEY)" },
      ])
      // Same content, different whitespace — must be considered equal.
      await store.migrate([
        {
          version: 1,
          sql: "CREATE TABLE t (id INTEGER PRIMARY KEY)\r\n   ",
        },
      ])
    } finally {
      await store.close()
    }
  })

  test("a failed migration leaves _migrations untouched (atomic)", async () => {
    const store = await LocalStore.open({ name: ":memory:" })
    try {
      await store.migrate([{ version: 1, sql: "CREATE TABLE a (x INTEGER)" }])
      await expect(
        store.migrate([
          { version: 1, sql: "CREATE TABLE a (x INTEGER)" }, // already applied
          { version: 2, sql: "CREATE TABLE a (x INTEGER)" }, // duplicate name → fails
        ]),
      ).rejects.toThrow()
      const versions = await store.query<{ version: number }>(
        "SELECT version FROM _migrations ORDER BY version",
      )
      expect(versions).toEqual([{ version: 1 }])
    } finally {
      await store.close()
    }
  })
})
