// AQU-1068: what the /events perimeter still decides about cell structure,
// and what it deliberately no longer does.
//
// THE PROJECT'S `cellEditingFloor` TIER IS NOT CHECKED HERE ANY MORE (Sam,
// 2026-09-09). It is a PRODUCT rule enforced where the buttons are drawn — the
// row menu, the timeline's add and remove, and the agent's proposal staging in
// auth-worker. Checking it at this perimeter silently refused three flows that
// emit these same kinds through the user's own outbox: audio-cue re-import,
// DCS upstream import and repair, and diarization. All three replace imported
// content wholesale and are maintainer-gated at their own buttons.
//
// ONE RULE SURVIVED, and it is the one that protects the client's file rather
// than the UI: removing an IMPORTED cell needs MAINTAINER. Below that rank a
// person only ever takes back a line somebody added by hand here.
//
// So this suite's job changed. It used to prove a tier gate; it now proves the
// tier gate is GONE and that its one surviving clause did not go with it. The
// tests that pass a tier do so to prove it makes no difference.
import { describe, it, expect } from "vitest"
import { authorize } from "../events/authorize"
import { makeTestToken } from "./helpers/auth"
import { ROLE } from "../events/role-policy"
import type { RawEvent } from "../events/types"

const SECRET = "test-secret-value-for-cell-editing"

type Tier = "none" | "commenter" | "reviewer" | "contributor" | "project_lead" | "maintainer"

/** project_settings -> the tier (now inert here); cells -> the delete guard. */
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

/** A db whose every read throws — the fail-closed leg. */
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

describe("the tier is not a perimeter rule", () => {
  // Every one of these was refused before 2026-09-09. They are the flows the
  // old gate broke: a maintainer reconciling audio cues, running a DCS import,
  // or diarizing, on a project that never opted into cell editing.
  it("admits a maintainer's create on a project with NO tier set", async () => {
    const result = await authorize(await tokenFor(ROLE.MAINTAINER), ev("source.cell.create"), SECRET, makeDb({}))
    expect(result.ok).toBe(true)
  })

  it("admits a maintainer's create at an explicit \"none\"", async () => {
    const result = await authorize(
      await tokenFor(ROLE.MAINTAINER), ev("source.cell.create"), SECRET, makeDb({ tier: "none" }),
    )
    expect(result.ok).toBe(true)
  })

  it("admits a commenter's create with no tier — the static floor is the only floor", async () => {
    // role-policy.ts holds create/delete/reorder at COMMENTER. That table is
    // now the whole of the server's answer for a create.
    const result = await authorize(await tokenFor(ROLE.COMMENTER), ev("source.cell.create"), SECRET, makeDb({}))
    expect(result.ok).toBe(true)
  })

  it("admits a commenter's create even where the tier names MAINTAINER", async () => {
    // The tier is read by the client and by agent staging, never here. A tier
    // above the caller's rank must not refuse at this layer, or the three
    // re-import flows break again.
    const result = await authorize(
      await tokenFor(ROLE.COMMENTER), ev("source.cell.create"), SECRET, makeDb({ tier: "maintainer" }),
    )
    expect(result.ok).toBe(true)
  })

  it("admits a create when the settings row cannot be read at all", async () => {
    // The old gate failed CLOSED on an unreadable settings row. Nothing reads
    // it for this kind now, so a broken read is simply not consulted.
    const result = await authorize(await tokenFor(ROLE.MAINTAINER), ev("source.cell.create"), SECRET, brokenDb)
    expect(result.ok).toBe(true)
  })

  it("still refuses a VIEWER — the static floor dropped, it did not vanish", async () => {
    const result = await authorize(await tokenFor(ROLE.VIEWER), ev("source.cell.create"), SECRET, makeDb({}))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/role too low/)
  })

  it("falls back to the same answer with no db handle", async () => {
    const result = await authorize(await tokenFor(ROLE.COMMENTER), ev("source.cell.create"), SECRET)
    expect(result.ok).toBe(true)
  })

  it("...and a VIEWER is refused there too", async () => {
    const result = await authorize(await tokenFor(ROLE.VIEWER), ev("source.cell.create"), SECRET)
    expect(result.ok).toBe(false)
  })
})

describe("the external API surface is exempt", () => {
  // Unchanged, and still not a hole: `emitEventsFloor`
  // (external/commands-emit-events.ts) hard-codes PROJECT_LEAD for these three
  // kinds. Since the tier check went away that hard-coded floor is the ONLY
  // thing holding an integration above COMMENTER, which is why it has a test
  // of its own in role-policy.test.ts.
  const externalToken = (role: number) =>
    makeTestToken(SECRET, { projectId: "proj-a", fileId: "file-x", role, src: "external" })

  it("admits an external lead's create", async () => {
    const result = await authorize(
      await externalToken(ROLE.PROJECT_LEAD), ev("source.cell.create"), SECRET, makeDb({}),
    )
    expect(result.ok).toBe(true)
  })

  it("admits an external lead's delete of an IMPORTED cell — as it always could", async () => {
    // The exemption wraps the surviving maintainer rule too. That is a
    // documented gap rather than an accident: it is the behaviour this surface
    // had before AQU-1068, and narrowing it here would be an unrelated policy
    // change. An in-app project lead is refused the same delete two tests down.
    const result = await authorize(
      await externalToken(ROLE.PROJECT_LEAD), ev("source.cell.delete"), SECRET,
      makeDb({ tier: null, userInserted: false }),
    )
    expect(result.ok).toBe(true)
  })
})

describe("removing an IMPORTED cell needs maintainer", () => {
  it("lets a contributor take back a line a person added by hand", async () => {
    const result = await authorize(
      await tokenFor(ROLE.CONTRIBUTOR), ev("source.cell.delete"), SECRET,
      makeDb({ userInserted: true }),
    )
    expect(result.ok).toBe(true)
  })

  it("refuses a PROJECT LEAD removing an imported cell", async () => {
    const result = await authorize(
      await tokenFor(ROLE.PROJECT_LEAD), ev("source.cell.delete"), SECRET,
      makeDb({ userInserted: false }),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/imported cell requires maintainer/)
  })

  it("refuses that lead whatever the tier says — the rule does not depend on it", async () => {
    // A tier of "project_lead" would once have been the deciding term. It is
    // not consulted; the cell's own provenance decides.
    const result = await authorize(
      await tokenFor(ROLE.PROJECT_LEAD), ev("source.cell.delete"), SECRET,
      makeDb({ tier: "project_lead", userInserted: false }),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/imported cell requires maintainer/)
  })

  it("admits a MAINTAINER removing an imported cell, with no tier set", async () => {
    // The flow this unblocks: a maintainer reconciling audio cues or running a
    // DCS import deletes imported cells by the hundred.
    const result = await authorize(
      await tokenFor(ROLE.MAINTAINER), ev("source.cell.delete"), SECRET,
      makeDb({ userInserted: false }),
    )
    expect(result.ok).toBe(true)
  })

  it("a cell row it cannot read keeps the requirement rather than waiving it", async () => {
    // isUserInsertedCell fails closed, so a lead is refused on the safe side.
    const result = await authorize(
      await tokenFor(ROLE.PROJECT_LEAD), ev("source.cell.delete"), SECRET, brokenDb,
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/imported cell requires maintainer/)
  })

  it("skips the whole check with no db handle, as its neighbours do", async () => {
    // Same convention as the timing lock and the self-assign carve-out: the
    // check needs a database and an absent one disables it rather than erroring.
    const result = await authorize(await tokenFor(ROLE.CONTRIBUTOR), ev("source.cell.delete"), SECRET)
    expect(result.ok).toBe(true)
  })
})

describe("the reorder that rides every add and remove", () => {
  it("admits a commenter's reorder with no tier set", async () => {
    // A reorder is batched into every add and every remove. A gate that
    // refused the companion killed the whole batch — which is exactly how this
    // went wrong on 2026-08-21.
    const result = await authorize(
      await tokenFor(ROLE.COMMENTER), ev("source.cell.reorder"), SECRET, makeDb({}),
    )
    expect(result.ok).toBe(true)
  })

  it("carries NO maintainer requirement of its own — only delete does", async () => {
    const result = await authorize(
      await tokenFor(ROLE.CONTRIBUTOR), ev("source.cell.reorder"), SECRET,
      makeDb({ userInserted: false }),
    )
    expect(result.ok).toBe(true)
  })

  it("still refuses a viewer", async () => {
    const result = await authorize(
      await tokenFor(ROLE.VIEWER), ev("source.cell.reorder"), SECRET, makeDb({}),
    )
    expect(result.ok).toBe(false)
  })
})
