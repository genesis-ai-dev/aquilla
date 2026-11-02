import { describe, expect, it, vi } from "vitest"
import type { AquillaDb } from "../../../db/shim/postgres"
import { openPostResponseDb, withPostResponseDb } from "./post-response-db"

// A request-scoped shim after index.ts has closed it: every query rejects the
// way postgres.js does once `end()` has run. Work that lands here is the bug
// this module exists to prevent (password reset minted nothing, 2026-11-02).
function deadRequestDb(): AquillaDb {
  const ended = () => {
    throw Object.assign(new Error("write CONNECTION_ENDED x.hyperdrive.local:5432"), { code: "CONNECTION_ENDED" })
  }
  return { prepare: ended, batch: ended, exec: ended } as unknown as AquillaDb
}

function liveDb(): AquillaDb {
  return { prepare: vi.fn(), batch: vi.fn(), exec: vi.fn() } as unknown as AquillaDb
}

describe("withPostResponseDb", () => {
  it("runs the work on the task's own connection, not the request-scoped one, and releases it", async () => {
    const own = liveDb()
    const close = vi.fn(async () => {})
    const seen: AquillaDb[] = []

    await withPostResponseDb(
      { PG_CONNECTION_STRING: "postgres://own", AQUILLA_PG: deadRequestDb() },
      async (db) => { seen.push(db) },
      () => ({ db: own, close }),
    )

    expect(seen).toEqual([own])
    expect(close).toHaveBeenCalledOnce()
  })

  it("releases the connection even when the work throws, and rethrows", async () => {
    const close = vi.fn(async () => {})

    await expect(withPostResponseDb(
      { PG_CONNECTION_STRING: "postgres://own", AQUILLA_PG: deadRequestDb() },
      async () => { throw new Error("boom") },
      () => ({ db: liveDb(), close }),
    )).rejects.toThrow("boom")

    expect(close).toHaveBeenCalledOnce()
  })

  it("falls back to AQUILLA_PG when there is no connection string to open one from", async () => {
    const requestDb = liveDb()
    const seen: AquillaDb[] = []

    await withPostResponseDb({ AQUILLA_PG: requestDb }, async (db) => { seen.push(db) })

    expect(seen).toEqual([requestDb])
  })
})

describe("openPostResponseDb", () => {
  it("returns null without a connection string (the vitest harness)", () => {
    expect(openPostResponseDb({})).toBeNull()
    expect(openPostResponseDb({ PG_CONNECTION_STRING: "" })).toBeNull()
  })
})
