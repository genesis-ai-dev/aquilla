// AQU-1068: `cellEditingFloor` decides who may add and remove cells.
//
// The predecessor of this suite tested a boolean (`allowLineCreation`) that
// re-imposed a PROJECT_LEAD floor on whoever fell below it. The setting is now
// a TIER, and the shape of the question changed with it: there is no clearance
// that skips it, so "none" — the default — refuses an owner too. Removing an
// IMPORTED cell needs MAINTAINER on top of the tier. Reorder is in the set
// because every add and remove batches one in as chain bookkeeping; a gate
// that refused the companion silently killed the whole batch, which is exactly
// how Matt's "the buttons are there but clicking does nothing" happened.
//
// Mirrors the timing-lock suite: these are the tests that hold when the
// browser lies.
import { describe, it, expect } from "vitest"
import { authorize } from "../events/authorize"
import { makeTestToken } from "./helpers/auth"
import { ROLE } from "../events/role-policy"
import type { RawEvent } from "../events/types"

const SECRET = "test-secret-value-for-cell-editing"

type Tier = "none" | "commenter" | "reviewer" | "contributor" | "project_lead" | "maintainer"

/** project_settings -> the tier; cells -> the user-inserted delete guard. */
function makeDb(options: { tier?: Tier | null; userInserted?: boolean }): AquillaDb {
  const { tier = null, userInserted = false } = options
  return {
    prepare(sql: string) {
      return {
        bind(..._args: unknown[]) {
          return {
            async first() {
              if (sql.includes("FROM project_settings")) {
                return { settings: JSON.stringify(tier ? { cellEditingFloor: tier } : {}) }
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

describe('cell editing while the project has not opted in ("none")', () => {
  it("refuses a maintainer — the default is nobody, not a floor", async () => {
    const result = await authorize(await tokenFor(ROLE.MAINTAINER), ev("source.cell.create"), SECRET, makeDb({}))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(403)
      expect(result.reason).toMatch(/not enabled for this project/)
    }
  })

  it("refuses an OWNER too — this is a 'whether', not a 'who'", async () => {
    // The clearance term the predecessor block carried is deliberately absent:
    // a rank that skipped the question would be the back door the gate exists
    // to close.
    const result = await authorize(await tokenFor(ROLE.OWNER), ev("source.cell.create"), SECRET, makeDb({}))
    expect(result.ok).toBe(false)
  })

  it("refuses an explicit \"none\" the same as an absent key", async () => {
    const result = await authorize(
      await tokenFor(ROLE.OWNER), ev("source.cell.create"), SECRET, makeDb({ tier: "none" }),
    )
    expect(result.ok).toBe(false)
  })

  it("refuses a tier this build does not recognise — a newer client's value is not permission", async () => {
    const result = await authorize(
      await tokenFor(ROLE.OWNER), ev("source.cell.create"), SECRET,
      makeDb({ tier: "archivist" as unknown as Tier }),
    )
    expect(result.ok).toBe(false)
  })

  it("a broken settings read refuses rather than admitting — fail-safe", async () => {
    const result = await authorize(await tokenFor(ROLE.MAINTAINER), ev("source.cell.create"), SECRET, brokenDb)
    expect(result.ok).toBe(false)
  })
})

describe("the external API surface is exempt", () => {
  // Not a hole: the predecessor block skipped everyone at PROJECT_LEAD and
  // above, and emitEventsFloor holds external callers at exactly that floor,
  // so nothing is reachable here that was not reachable before AQU-1068. The
  // exemption is also load-bearing — an external PlanImport populates a NEW
  // file by chunking file.create + N x source.cell.create through this
  // perimeter, and a project that has not opted into cell EDITING must still
  // be able to receive an import.
  const externalToken = (role: number) =>
    makeTestToken(SECRET, { projectId: "proj-a", fileId: "file-x", role, src: "external" })

  it("admits an external lead's create into a project that never opted in", async () => {
    const result = await authorize(
      await externalToken(ROLE.PROJECT_LEAD), ev("source.cell.create"), SECRET, makeDb({}),
    )
    expect(result.ok).toBe(true)
  })

  it("admits an external lead's delete of an imported cell — as it could before", async () => {
    const result = await authorize(
      await externalToken(ROLE.PROJECT_LEAD), ev("source.cell.delete"), SECRET,
      makeDb({ tier: null, userInserted: false }),
    )
    expect(result.ok).toBe(true)
  })

  it("does NOT exempt an ordinary in-app token — a forged event is still refused", async () => {
    // The in-app agent lands here too: it applies through the user's own
    // outbox with the user's own token, so it may do exactly what that person
    // may do and no more.
    const result = await authorize(
      await tokenFor(ROLE.PROJECT_LEAD), ev("source.cell.create"), SECRET, makeDb({}),
    )
    expect(result.ok).toBe(false)
  })
})

describe("the tier is a role floor", () => {
  it("admits a maintainer at the maintainer tier", async () => {
    const result = await authorize(
      await tokenFor(ROLE.MAINTAINER), ev("source.cell.create"), SECRET, makeDb({ tier: "maintainer" }),
    )
    expect(result.ok).toBe(true)
  })

  it("refuses a project lead at the maintainer tier", async () => {
    const result = await authorize(
      await tokenFor(ROLE.PROJECT_LEAD), ev("source.cell.create"), SECRET, makeDb({ tier: "maintainer" }),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/role too low/)
  })

  it("admits a project lead once the tier is lowered to project_lead", async () => {
    const result = await authorize(
      await tokenFor(ROLE.PROJECT_LEAD), ev("source.cell.create"), SECRET, makeDb({ tier: "project_lead" }),
    )
    expect(result.ok).toBe(true)
  })

  it("admits a contributor at the contributor tier", async () => {
    const result = await authorize(
      await tokenFor(ROLE.CONTRIBUTOR), ev("source.cell.create"), SECRET, makeDb({ tier: "contributor" }),
    )
    expect(result.ok).toBe(true)
  })

  // The two rungs below contributor, added when the list was rebuilt on the
  // product's standard ladder (Matthew's review, Sam approved 2026-09-08).
  // They only mean anything because the static floor in role-policy.ts dropped
  // to COMMENTER at the same time — at CONTRIBUTOR the check at the top of
  // authorize() refused these callers before the tier was ever consulted, so
  // the two tiers would have been options that admitted nobody.
  it("admits a commenter at the commenter tier", async () => {
    const result = await authorize(
      await tokenFor(ROLE.COMMENTER), ev("source.cell.create"), SECRET, makeDb({ tier: "commenter" }),
    )
    expect(result.ok).toBe(true)
  })

  it("refuses that same commenter at the reviewer tier — the tier really is a floor", async () => {
    const result = await authorize(
      await tokenFor(ROLE.COMMENTER), ev("source.cell.create"), SECRET, makeDb({ tier: "reviewer" }),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/role too low/)
  })

  it("admits a reviewer at the reviewer tier", async () => {
    const result = await authorize(
      await tokenFor(ROLE.REVIEWER), ev("source.cell.create"), SECRET, makeDb({ tier: "reviewer" }),
    )
    expect(result.ok).toBe(true)
  })

  it("still refuses a viewer at the LOWEST tier — the static floor holds underneath", async () => {
    // A viewer is below the tier as well, so this only proves the static floor
    // while the tier is the lowest one that exists. That is now "commenter"
    // (200), which is exactly the static floor — so the caller refused here is
    // refused by role-policy.ts, before the settings row is read at all.
    const result = await authorize(
      await tokenFor(ROLE.VIEWER), ev("source.cell.create"), SECRET, makeDb({ tier: "commenter" }),
    )
    expect(result.ok).toBe(false)
  })

  it("falls back to the static floor when no db handle is supplied", async () => {
    // Same convention as the timing lock and the self-assign carve-out.
    const result = await authorize(await tokenFor(ROLE.CONTRIBUTOR), ev("source.cell.create"), SECRET)
    expect(result.ok).toBe(true)
  })

  it("that fallback floor is COMMENTER, not CONTRIBUTOR — a commenter passes it", async () => {
    // With the tier gate skipped, what is left is role-policy.ts alone. This
    // is the assertion that fails if the static floor is ever put back up:
    // the commenter and reviewer tiers would stop admitting anyone.
    const result = await authorize(await tokenFor(ROLE.COMMENTER), ev("source.cell.create"), SECRET)
    expect(result.ok).toBe(true)
  })

  it("...and a VIEWER still does not pass it — the floor dropped, it did not vanish", async () => {
    const result = await authorize(await tokenFor(ROLE.VIEWER), ev("source.cell.create"), SECRET)
    expect(result.ok).toBe(false)
  })
})

describe("removal carries a second gate", () => {
  it("lets a contributor take back a line a person added by hand, at the contributor tier", async () => {
    const result = await authorize(
      await tokenFor(ROLE.CONTRIBUTOR), ev("source.cell.delete"), SECRET,
      makeDb({ tier: "contributor", userInserted: true }),
    )
    expect(result.ok).toBe(true)
  })

  it("refuses a PROJECT LEAD removing an IMPORTED cell — the tier does not buy that", async () => {
    // The imported line is the client's own work. This is the half that
    // changed with AQU-1068: it used to be lead-and-above, it is now
    // maintainer-and-above, whatever tier is configured.
    const result = await authorize(
      await tokenFor(ROLE.PROJECT_LEAD), ev("source.cell.delete"), SECRET,
      makeDb({ tier: "project_lead", userInserted: false }),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/imported cell requires maintainer/)
  })

  it("admits a MAINTAINER removing an imported cell — the feature's whole point", async () => {
    const result = await authorize(
      await tokenFor(ROLE.MAINTAINER), ev("source.cell.delete"), SECRET,
      makeDb({ tier: "maintainer", userInserted: false }),
    )
    expect(result.ok).toBe(true)
  })

  it("refuses a maintainer's delete when the project never opted in", async () => {
    // The first gate runs before the second: rank never substitutes for opt-in.
    const result = await authorize(
      await tokenFor(ROLE.MAINTAINER), ev("source.cell.delete"), SECRET,
      makeDb({ tier: null, userInserted: false }),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/not enabled for this project/)
  })

  it("a cell row it cannot read keeps the maintainer requirement rather than waiving it", async () => {
    // isUserInsertedCell fails closed; the lead is refused on the safe side.
    const result = await authorize(
      await tokenFor(ROLE.PROJECT_LEAD), ev("source.cell.delete"), SECRET,
      makeDb({ tier: "contributor", userInserted: false }),
    )
    expect(result.ok).toBe(false)
  })
})

describe("the reorder that rides every add and remove", () => {
  it("admits a contributor's reorder at the contributor tier", async () => {
    const result = await authorize(
      await tokenFor(ROLE.CONTRIBUTOR), ev("source.cell.reorder"), SECRET, makeDb({ tier: "contributor" }),
    )
    expect(result.ok).toBe(true)
  })

  it("refuses a contributor's reorder when the project has not opted in", async () => {
    const result = await authorize(
      await tokenFor(ROLE.CONTRIBUTOR), ev("source.cell.reorder"), SECRET, makeDb({}),
    )
    expect(result.ok).toBe(false)
  })

  it("carries NO maintainer requirement of its own — only delete does", async () => {
    // A reorder rides a remove batch, so a tier that admits the remove must
    // admit its companion or the batch dies before it writes anything.
    const result = await authorize(
      await tokenFor(ROLE.CONTRIBUTOR), ev("source.cell.reorder"), SECRET,
      makeDb({ tier: "contributor", userInserted: false }),
    )
    expect(result.ok).toBe(true)
  })
})
