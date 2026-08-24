// Sam, 2026-08-21: "Only managers can change the settings, but once they've
// changed the settings, then even contributors can make the changes."
//
// `source.cell.create` / `source.cell.delete` / `source.cell.reorder` dropped
// from their static PROJECT_LEAD floor to CONTRIBUTOR; authorize re-imposes
// PROJECT_LEAD conditionally — all three refused below lead unless
// `allowLineCreation` is on ("that setting is enabling lines being added or
// removed" — one package), deletes additionally only for a cell a person
// added by hand. Reorder is in the set because every add and remove batches
// one in as chain bookkeeping. Mirrors the timing-lock suite: these are the
// tests that hold when the browser lies.
import { describe, it, expect } from "vitest"
import { authorize } from "../events/authorize"
import { makeTestToken } from "./helpers/auth"
import { ROLE } from "../events/role-policy"
import type { RawEvent } from "../events/types"

const SECRET = "test-secret-value-for-line-creation"

/** project_settings -> the opt-in; cells -> the user-inserted delete guard. */
function makeDb(options: { allowed?: boolean; userInserted?: boolean }): AquillaDb {
  const { allowed = false, userInserted = false } = options
  return {
    prepare(sql: string) {
      return {
        bind(..._args: unknown[]) {
          return {
            async first() {
              if (sql.includes("FROM project_settings")) {
                return { settings: JSON.stringify(allowed ? { allowLineCreation: true } : {}) }
              }
              if (sql.includes("FROM cells")) {
                return userInserted
                  ? { metadata: { aquillaOrigin: { version: 1, kind: "user-insert" } } }
                  : { metadata: { cast_name: "JESUS" } }
              }
              return null
            },
            async all() { return { results: [] } },
          }
        },
      }
    },
  } as unknown as AquillaDb
}

/** A db whose settings read throws — the fail-safe leg. */
const brokenDb = {
  prepare() {
    return {
      bind() {
        return {
          async first() { throw new Error("boom") },
          async all() { return { results: [] } },
        }
      },
    }
  },
} as unknown as AquillaDb

function ev(kind: "source.cell.create" | "source.cell.delete" | "source.cell.reorder"): RawEvent<"source.cell.create"> {
  return {
    id: "00000000-0000-7000-0000-00000000beef",
    schemaVersion: 1,
    kind,
    projectId: "proj-a",
    fileId: "file-x",
    cellId: "cell-1",
    parentId: null,
    author: "alice",
    payload: { cellId: "cell-1", value: "a new line" },
    clientTs: Date.now(),
  } as unknown as RawEvent<"source.cell.create">
}

const tokenFor = (role: number) =>
  makeTestToken(SECRET, { projectId: "proj-a", fileId: "file-x", role })

describe("line creation at the perimeter", () => {
  it("refuses a contributor's create while the project has not opted in — the default", async () => {
    const result = await authorize(await tokenFor(ROLE.CONTRIBUTOR), ev("source.cell.create"), SECRET, makeDb({}))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(403)
      expect(result.reason).toMatch(/adding lines is not enabled/)
    }
  })

  it("admits a contributor's create once the setting is on — the point of the change", async () => {
    const result = await authorize(
      await tokenFor(ROLE.CONTRIBUTOR), ev("source.cell.create"), SECRET, makeDb({ allowed: true }),
    )
    expect(result.ok).toBe(true)
  })

  it("never asks a project lead about the setting — their old floor still clears", async () => {
    const result = await authorize(await tokenFor(ROLE.PROJECT_LEAD), ev("source.cell.create"), SECRET, makeDb({}))
    expect(result.ok).toBe(true)
  })

  it("still refuses a viewer outright — the static CONTRIBUTOR floor holds underneath", async () => {
    const result = await authorize(
      await tokenFor(ROLE.VIEWER), ev("source.cell.create"), SECRET, makeDb({ allowed: true }),
    )
    expect(result.ok).toBe(false)
  })

  it("a broken settings read refuses rather than admitting — fail-safe OFF", async () => {
    const result = await authorize(await tokenFor(ROLE.CONTRIBUTOR), ev("source.cell.create"), SECRET, brokenDb)
    expect(result.ok).toBe(false)
  })
})

describe("line removal at the perimeter", () => {
  it("lets a contributor remove a line a person added by hand, while the setting is ON", async () => {
    // "That setting is enabling lines being added or removed" — one package.
    const result = await authorize(
      await tokenFor(ROLE.CONTRIBUTOR), ev("source.cell.delete"), SECRET,
      makeDb({ allowed: true, userInserted: true }),
    )
    expect(result.ok).toBe(true)
  })

  it("refuses a contributor's delete once the setting is OFF — a lead can still tidy up", async () => {
    const result = await authorize(
      await tokenFor(ROLE.CONTRIBUTOR), ev("source.cell.delete"), SECRET,
      makeDb({ allowed: false, userInserted: true }),
    )
    expect(result.ok).toBe(false)
  })

  it("refuses a contributor's delete of an IMPORTED cell, whatever the setting says", async () => {
    const result = await authorize(
      await tokenFor(ROLE.CONTRIBUTOR), ev("source.cell.delete"), SECRET,
      makeDb({ allowed: true, userInserted: false }),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/added by hand/)
  })

  it("leaves a project lead's delete alone — re-imports keep working", async () => {
    const result = await authorize(
      await tokenFor(ROLE.PROJECT_LEAD), ev("source.cell.delete"), SECRET,
      makeDb({ allowed: false, userInserted: false }),
    )
    expect(result.ok).toBe(true)
  })

  it("falls back to the static floor when no db handle is supplied", async () => {
    // Same convention as the timing lock and the self-assign carve-out.
    const result = await authorize(await tokenFor(ROLE.CONTRIBUTOR), ev("source.cell.create"), SECRET)
    expect(result.ok).toBe(true)
  })
})

describe("the reorder that rides every add and remove", () => {
  // handleAddLine and handleRemoveLine batch a source.cell.reorder in as
  // chain bookkeeping; a floor that refused the companion silently killed the
  // whole batch — which is exactly how Matt's "the buttons are there but
  // clicking does nothing" happened.

  it("admits a contributor's reorder while the setting is ON", async () => {
    const result = await authorize(
      await tokenFor(ROLE.CONTRIBUTOR), ev("source.cell.reorder"), SECRET, makeDb({ allowed: true }),
    )
    expect(result.ok).toBe(true)
  })

  it("refuses a contributor's reorder while the setting is OFF", async () => {
    const result = await authorize(
      await tokenFor(ROLE.CONTRIBUTOR), ev("source.cell.reorder"), SECRET, makeDb({ allowed: false }),
    )
    expect(result.ok).toBe(false)
  })

  it("never asks a project lead", async () => {
    const result = await authorize(
      await tokenFor(ROLE.PROJECT_LEAD), ev("source.cell.reorder"), SECRET, makeDb({ allowed: false }),
    )
    expect(result.ok).toBe(true)
  })
})
