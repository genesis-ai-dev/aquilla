// AQU-2304: the org's configurable import floor, at the perimeter that
// enforces it.
//
// The point of the ticket is that the SERVER refuses the import, not that the
// app hides the button — a stale or hand-crafted client must not be able to
// reshape a project's file inventory after the org has said only maintainers
// may. So the tests that matter are the ones that hold when the browser lies:
// a project lead's `file.create` with the org at Maintainer, and — just as
// important — everything the floor must NOT break (an unset key, a garbage
// value, an unreadable settings row, a project with no org, a maintainer).
import { describe, it, expect } from "vitest"
import { authorize } from "../events/authorize"
import { makeTestToken } from "./helpers/auth"
import { ROLE } from "../events/role-policy"
import {
  DEFAULT_IMPORT_MIN_ROLE,
  resolveImportFloor,
  resolveImportMinRole,
} from "../events/import-authority"
import { makeRequestCache } from "../events/request-cache"
import type { RawEvent } from "../events/types"

const SECRET = "test-secret-value-for-import-floor"

/** Counts the reads so the per-batch memo can be asserted, not assumed. */
interface CountingDb {
  db: AquillaDb
  reads: { projects: number; orgSettings: number }
}

function makeDb(options: {
  orgId?: number | null
  orgSettings?: string | null
  /** Throw on the org_settings read, as an unreachable/overloaded DB would. */
  settingsThrows?: boolean
}): CountingDb {
  const { orgId = 1, orgSettings = null, settingsThrows = false } = options
  const reads = { projects: 0, orgSettings: 0 }
  const db = {
    prepare(sql: string) {
      return {
        bind(..._args: unknown[]) {
          return {
            async first() {
              if (sql.includes("FROM projects")) {
                reads.projects += 1
                return { org_id: orgId }
              }
              if (sql.includes("FROM org_settings")) {
                reads.orgSettings += 1
                if (settingsThrows) throw new Error("org_settings unreadable")
                return orgSettings != null ? { settings: orgSettings } : null
              }
              // project_settings and everything else: no row. `file.create`
              // writes no lane row, so nothing else here is consulted.
              return null
            },
            async all() { return { results: [] } },
          }
        },
      }
    },
  } as unknown as AquillaDb
  return { db, reads }
}

function fileCreate(fileId = "file-x"): RawEvent<"file.create"> {
  return {
    id: "00000000-0000-7000-0000-00000000c0de",
    schemaVersion: 1,
    kind: "file.create",
    projectId: "proj-a",
    fileId,
    cellId: null,
    parentId: null,
    author: "alice",
    payload: { name: "Genesis.md", fileType: "markdown" },
    clientTs: Date.now(),
  } as unknown as RawEvent<"file.create">
}

const tokenFor = (role: number, fileId = "file-x") =>
  makeTestToken(SECRET, { projectId: "proj-a", fileId, role })

const maintainerOrg = JSON.stringify({ importMinRole: ROLE.MAINTAINER })

describe("resolveImportMinRole — the fail-safe (AQU-2304)", () => {
  it("keeps an in-ladder value", () => {
    expect(resolveImportMinRole(ROLE.MAINTAINER)).toBe(600)
    expect(resolveImportMinRole(ROLE.PROJECT_LEAD)).toBe(500)
  })

  it("falls back to project lead for anything that is not a role level", () => {
    // A misconfigured floor must be a no-op, never a lockout — and never a
    // lowering, either: the static `file.create` floor still refuses below 500.
    for (const bad of [undefined, null, "maintainer", -1, 9999, NaN, {}, true]) {
      expect(resolveImportMinRole(bad)).toBe(DEFAULT_IMPORT_MIN_ROLE)
    }
  })

  it("keeps an in-RANGE value that is not a rung, as every sibling floor does", () => {
    // 450 passes `100..700` here and in auth-worker's extractRoleFloor, which
    // is deliberately a range rather than ladder membership (see
    // comment-floors.ts). Ladder membership is enforced on the WRITE, where
    // the org-settings route 400s it — so a value like this can only arrive
    // from a hand-edited row, and treating it as a floor between the rungs is
    // both harmless and what the other floors already do. Pinned so a future
    // tightening has to be deliberate on all four readers at once.
    expect(resolveImportMinRole(450)).toBe(450)
  })
})

describe("resolveImportFloor — reading the org's key (AQU-2304)", () => {
  it("reads the org's explicit floor", async () => {
    const { db } = makeDb({ orgSettings: maintainerOrg })
    expect(await resolveImportFloor(db, "proj-a")).toBe(ROLE.MAINTAINER)
  })

  it("defaults for a project with no org", async () => {
    const { db } = makeDb({ orgId: null })
    expect(await resolveImportFloor(db, "proj-a")).toBe(DEFAULT_IMPORT_MIN_ROLE)
  })

  it("defaults when the org has no settings row", async () => {
    const { db } = makeDb({ orgSettings: null })
    expect(await resolveImportFloor(db, "proj-a")).toBe(DEFAULT_IMPORT_MIN_ROLE)
  })

  it("defaults when the settings blob will not parse", async () => {
    const { db } = makeDb({ orgSettings: "NOT_JSON{{" })
    expect(await resolveImportFloor(db, "proj-a")).toBe(DEFAULT_IMPORT_MIN_ROLE)
  })

  it("defaults when the settings read throws", async () => {
    // An exception at this perimeter must not degrade into a 403 that wedges
    // a durable outbox on one poisoned event.
    const { db } = makeDb({ settingsThrows: true })
    expect(await resolveImportFloor(db, "proj-a")).toBe(DEFAULT_IMPORT_MIN_ROLE)
  })

  it("reads the org's settings once per request cache, not once per file", async () => {
    // A multi-book scripture import emits one `file.create` per book
    // (AQU-1187); the batch must not pay a lookup per file.
    const { db, reads } = makeDb({ orgSettings: maintainerOrg })
    const cache = makeRequestCache(db)
    await Promise.all([
      resolveImportFloor(db, "proj-a", cache),
      resolveImportFloor(db, "proj-a", cache),
      resolveImportFloor(db, "proj-a", cache),
    ])
    expect(reads.projects).toBe(1)
    expect(reads.orgSettings).toBe(1)
  })
})

describe("the import floor at the perimeter (AQU-2304)", () => {
  it("refuses a project lead's file.create when the org asked for maintainer", async () => {
    const { db } = makeDb({ orgSettings: maintainerOrg })
    const result = await authorize(
      await tokenFor(ROLE.PROJECT_LEAD),
      fileCreate(),
      SECRET,
      db,
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(403)
      // The reason names the role the ORG asked for, so the client can say why
      // rather than repeating the static "Project lead" bar.
      expect(result.reason).toMatch(/maintainer/)
      expect(result.reason).toMatch(/600/)
    }
  })

  it("admits a maintainer's file.create under the same floor", async () => {
    const { db } = makeDb({ orgSettings: maintainerOrg })
    const result = await authorize(
      await tokenFor(ROLE.MAINTAINER),
      fileCreate(),
      SECRET,
      db,
    )
    expect(result.ok).toBe(true)
  })

  it("admits an owner's file.create without reading org settings at all", async () => {
    // No in-ladder floor can exceed OWNER, so the common path stays free.
    const { db, reads } = makeDb({ orgSettings: maintainerOrg })
    const result = await authorize(await tokenFor(ROLE.OWNER), fileCreate(), SECRET, db)
    expect(result.ok).toBe(true)
    expect(reads.orgSettings).toBe(0)
  })

  it("admits a project lead's file.create when the org never set the key", async () => {
    // The whole point of the default: an org that never touches the setting
    // sees no behaviour change anywhere.
    const { db } = makeDb({ orgSettings: JSON.stringify({ rules: [] }) })
    const result = await authorize(
      await tokenFor(ROLE.PROJECT_LEAD),
      fileCreate(),
      SECRET,
      db,
    )
    expect(result.ok).toBe(true)
  })

  it("admits a project lead's file.create for a garbage floor", async () => {
    const { db } = makeDb({ orgSettings: JSON.stringify({ importMinRole: "maintainer" }) })
    const result = await authorize(
      await tokenFor(ROLE.PROJECT_LEAD),
      fileCreate(),
      SECRET,
      db,
    )
    expect(result.ok).toBe(true)
  })

  it("admits a project lead's file.create when the settings read throws", async () => {
    const { db } = makeDb({ settingsThrows: true })
    const result = await authorize(
      await tokenFor(ROLE.PROJECT_LEAD),
      fileCreate(),
      SECRET,
      db,
    )
    expect(result.ok).toBe(true)
  })

  it("still refuses a contributor with the generic static refusal", async () => {
    // Below the static PROJECT_LEAD bar the org's floor is not what stopped
    // them, and the reason must not claim otherwise.
    const { db } = makeDb({ orgSettings: maintainerOrg })
    const result = await authorize(
      await tokenFor(ROLE.CONTRIBUTOR),
      fileCreate(),
      SECRET,
      db,
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(403)
      expect(result.reason).toMatch(/role too low for file\.create/)
    }
  })

  it("leaves a translation import alone — target.cell.commit is untouched", async () => {
    // Importing a translation into a file that is already here creates
    // nothing, so a lead under a Maintainer floor still fills a lane.
    const { db } = makeDb({ orgSettings: maintainerOrg })
    const commit = {
      ...fileCreate(),
      kind: "target.cell.commit",
      cellId: "cell-1",
      payload: { html: "<p>hi</p>", targetLang: "" },
    } as unknown as RawEvent<"target.cell.commit">
    const result = await authorize(await tokenFor(ROLE.CONTRIBUTOR), commit, SECRET, db)
    // Whatever else this event has to satisfy, the import floor is not it.
    if (!result.ok) {
      expect(result.reason).not.toMatch(/importing a new source file/)
    }
  })

  it("does not consult the floor when no db handle is supplied", async () => {
    // Every existing caller/test that omits `db` keeps working: the floor
    // falls back to the static table rather than erroring.
    const result = await authorize(await tokenFor(ROLE.PROJECT_LEAD), fileCreate(), SECRET)
    expect(result.ok).toBe(true)
  })
})
