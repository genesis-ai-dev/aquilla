// Tests for the shared comment-floor resolver (AQU-1002).
// Mirrors export-floor.test.ts — same org_settings lookup, same fail-safe
// defaulting. The regression to guard is that an org which has set nothing
// keeps post-AQU-999 behaviour byte-for-byte: COMMENTER (200) to open a
// thread, CONTRIBUTOR (400) to resolve one somebody else opened.
import { describe, it, expect } from "vitest"
import {
  resolveCommentFloors,
  createCommentFloorsCache,
  DEFAULT_COMMENT_FLOORS,
} from "../events/comment-floors"
import { ROLE } from "../events/role-policy"

/**
 * Build a minimal AquillaDb stub that returns the given project org_id and
 * optional org_settings JSON, counting reads so the cache can be observed.
 */
function makeDb(options: {
  orgId?: number | null
  orgSettings?: string | null
  counter?: { reads: number }
}): AquillaDb {
  const { orgId = 1, orgSettings = null, counter } = options
  return {
    prepare(sql: string) {
      return {
        bind(..._args: unknown[]) {
          return {
            async first() {
              if (counter) counter.reads++
              if (sql.includes("FROM projects")) return { org_id: orgId }
              if (sql.includes("FROM org_settings")) {
                return orgSettings != null ? { settings: orgSettings } : null
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

describe("resolveCommentFloors", () => {
  it("returns the stock defaults when the project has no org", async () => {
    const db = makeDb({ orgId: null })
    expect(await resolveCommentFloors(db, "p1")).toEqual(DEFAULT_COMMENT_FLOORS)
  })

  it("returns the stock defaults when no org_settings row exists", async () => {
    const db = makeDb({ orgId: 1, orgSettings: null })
    expect(await resolveCommentFloors(db, "p1")).toEqual(DEFAULT_COMMENT_FLOORS)
  })

  it("defaults match the pre-AQU-1002 static floors", () => {
    expect(DEFAULT_COMMENT_FLOORS.createMinRole).toBe(ROLE.COMMENTER)
    expect(DEFAULT_COMMENT_FLOORS.resolveMinRole).toBe(ROLE.CONTRIBUTOR)
  })

  it("reads configured floors", async () => {
    const db = makeDb({
      orgSettings: JSON.stringify({
        commentCreateMinRole: ROLE.CONTRIBUTOR,
        commentResolveMinRole: ROLE.MAINTAINER,
      }),
    })
    expect(await resolveCommentFloors(db, "p1")).toEqual({
      createMinRole: ROLE.CONTRIBUTOR,
      resolveMinRole: ROLE.MAINTAINER,
    })
  })

  it("defaults each floor independently", async () => {
    const db = makeDb({
      orgSettings: JSON.stringify({ commentResolveMinRole: ROLE.COMMENTER }),
    })
    expect(await resolveCommentFloors(db, "p1")).toEqual({
      createMinRole: ROLE.COMMENTER,
      resolveMinRole: ROLE.COMMENTER,
    })
  })

  it("lets an org open foreign resolve below AQU-999's contributor default", async () => {
    const db = makeDb({
      orgSettings: JSON.stringify({ commentResolveMinRole: ROLE.COMMENTER }),
    })
    const floors = await resolveCommentFloors(db, "p1")
    expect(floors.resolveMinRole).toBe(ROLE.COMMENTER)
  })

  it("ignores out-of-ladder values rather than clamping them", async () => {
    const db = makeDb({
      orgSettings: JSON.stringify({
        commentCreateMinRole: 9999,
        commentResolveMinRole: -1,
      }),
    })
    expect(await resolveCommentFloors(db, "p1")).toEqual(DEFAULT_COMMENT_FLOORS)
  })

  it("ignores non-numeric values", async () => {
    const db = makeDb({
      orgSettings: JSON.stringify({
        commentCreateMinRole: "contributor",
        commentResolveMinRole: null,
      }),
    })
    expect(await resolveCommentFloors(db, "p1")).toEqual(DEFAULT_COMMENT_FLOORS)
  })

  it("falls back to the defaults on a malformed settings blob", async () => {
    const db = makeDb({ orgSettings: "{not json" })
    expect(await resolveCommentFloors(db, "p1")).toEqual(DEFAULT_COMMENT_FLOORS)
  })
})

describe("createCommentFloorsCache", () => {
  it("resolves a project once however many times it is asked", async () => {
    const counter = { reads: 0 }
    const db = makeDb({
      orgSettings: JSON.stringify({ commentResolveMinRole: ROLE.MAINTAINER }),
      counter,
    })
    const floorsFor = createCommentFloorsCache(db)

    const results = await Promise.all([
      floorsFor("p1"),
      floorsFor("p1"),
      floorsFor("p1"),
    ])

    for (const floors of results) {
      expect(floors.resolveMinRole).toBe(ROLE.MAINTAINER)
    }
    // One projects read + one org_settings read, not three of each.
    expect(counter.reads).toBe(2)
  })

  it("keeps separate entries per project", async () => {
    const counter = { reads: 0 }
    const db = makeDb({ orgSettings: null, counter })
    const floorsFor = createCommentFloorsCache(db)
    await floorsFor("p1")
    await floorsFor("p2")
    expect(counter.reads).toBe(4)
  })
})
