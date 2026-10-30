// AQU-2305: a PROJECT's own import floor at the perimeter that enforces it.
//
// AQU-2304's tests (authorize-import-floor.test.ts) cover the org's half. The
// ticket here is the stricter-only rule, and the thing that matters is that it
// holds in BOTH directions on the server, not in the picker:
//
//   - a project stricter than its org is enforced, so a lead the project
//     locked out cannot import by pointing a stale client at /events;
//   - a project value that is NOT stricter is INERT, so a row written before
//     the org raised its floor — or one slipped past the settings route — can
//     never hand back an import the org closed.
//
// Plus the cost: a multi-book import emits one `file.create` per book
// (AQU-1187), and the project's own value must ride the write-path row the
// batch already loads rather than adding a read per file.
import { describe, it, expect } from "vitest"
import { authorize } from "../events/authorize"
import { makeTestToken } from "./helpers/auth"
import { ROLE } from "../events/role-policy"
import { DEFAULT_IMPORT_MIN_ROLE, resolveImportFloor } from "../events/import-authority"
import { makeRequestCache } from "../events/request-cache"
import type { AquillaDb } from "../../../db/shim/postgres"
import type { RawEvent } from "../events/types"

const SECRET = "test-secret-value-for-project-import-floor"

interface CountingDb {
  db: AquillaDb
  reads: { projects: number; orgSettings: number; projectSettings: number }
}

/**
 * `projectFloor` is what the project's own settings blob holds under
 * `importMinRole`. It comes back on the `wp_import_min_role` column the write
 * path selects (migration 0192), which is the same row the timing and
 * validation questions read.
 */
function makeDb(options: {
  orgFloor?: unknown
  projectFloor?: unknown
  /** No project_settings row at all. */
  noProjectRow?: boolean
  /** Throw on the project_settings read, as an unreachable DB would. */
  projectSettingsThrows?: boolean
}): CountingDb {
  const { orgFloor, projectFloor, noProjectRow = false, projectSettingsThrows = false } = options
  const reads = { projects: 0, orgSettings: 0, projectSettings: 0 }
  const db = {
    prepare(sql: string) {
      return {
        bind(..._args: unknown[]) {
          return {
            async first() {
              if (sql.includes("FROM projects")) {
                reads.projects += 1
                return { org_id: 1 }
              }
              if (sql.includes("FROM org_settings")) {
                reads.orgSettings += 1
                return orgFloor === undefined
                  ? null
                  : { settings: JSON.stringify({ importMinRole: orgFloor }) }
              }
              if (sql.includes("FROM project_settings")) {
                reads.projectSettings += 1
                if (projectSettingsThrows) throw new Error("project_settings unreadable")
                if (noProjectRow) return null
                // The `wp_` projection hands the value over with its JSON type
                // intact; an absent key is a NULL column.
                return { wp_import_min_role: projectFloor ?? null }
              }
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

describe("resolveImportFloor — the project's own value (AQU-2305)", () => {
  it("enforces the project's value when it is stricter than the org's", async () => {
    const { db } = makeDb({ orgFloor: ROLE.PROJECT_LEAD, projectFloor: ROLE.MAINTAINER })
    expect(await resolveImportFloor(db, "proj-a")).toBe(ROLE.MAINTAINER)
  })

  it("keeps the org's value when the project's equals it", async () => {
    const { db } = makeDb({ orgFloor: ROLE.MAINTAINER, projectFloor: ROLE.MAINTAINER })
    expect(await resolveImportFloor(db, "proj-a")).toBe(ROLE.MAINTAINER)
  })

  it("ignores a project value LOOSER than the org's — it is inert", async () => {
    // The whole point of stricter-only: a stored 500 under an org at 600 can
    // never hand imports back to a lead, however it got into the blob.
    const { db } = makeDb({ orgFloor: ROLE.MAINTAINER, projectFloor: ROLE.PROJECT_LEAD })
    expect(await resolveImportFloor(db, "proj-a")).toBe(ROLE.MAINTAINER)
  })

  it("ignores a project value that is not a role-ladder level", async () => {
    for (const bad of ["maintainer", 450, 9999, -1, true, {}, null]) {
      const { db } = makeDb({ orgFloor: ROLE.PROJECT_LEAD, projectFloor: bad })
      expect(await resolveImportFloor(db, "proj-a")).toBe(DEFAULT_IMPORT_MIN_ROLE)
    }
  })

  it("applies the project's own value when the org never set one", async () => {
    // The org's unset key resolves to the PROJECT_LEAD default, and the
    // project may still be stricter than that.
    const { db } = makeDb({ projectFloor: ROLE.MAINTAINER })
    expect(await resolveImportFloor(db, "proj-a")).toBe(ROLE.MAINTAINER)
  })

  it("defaults when the project has no settings row", async () => {
    const { db } = makeDb({ orgFloor: ROLE.PROJECT_LEAD, noProjectRow: true })
    expect(await resolveImportFloor(db, "proj-a")).toBe(DEFAULT_IMPORT_MIN_ROLE)
  })

  it("defaults when the project_settings read throws", async () => {
    // An exception at this perimeter must not degrade into a 403 that wedges a
    // durable outbox on one poisoned event.
    const { db } = makeDb({ orgFloor: ROLE.MAINTAINER, projectSettingsThrows: true })
    expect(await resolveImportFloor(db, "proj-a")).toBe(DEFAULT_IMPORT_MIN_ROLE)
  })

  it("reads each settings row once per request cache, not once per file", async () => {
    const { db, reads } = makeDb({ orgFloor: ROLE.PROJECT_LEAD, projectFloor: ROLE.MAINTAINER })
    const cache = makeRequestCache(db)
    await Promise.all([
      resolveImportFloor(db, "proj-a", cache),
      resolveImportFloor(db, "proj-a", cache),
      resolveImportFloor(db, "proj-a", cache),
    ])
    expect(reads.projects).toBe(1)
    expect(reads.orgSettings).toBe(1)
    expect(reads.projectSettings).toBe(1)
  })
})

describe("the project's import floor at the perimeter (AQU-2305)", () => {
  it("refuses a project lead's file.create in a project that asked for maintainer", async () => {
    const { db } = makeDb({ orgFloor: ROLE.PROJECT_LEAD, projectFloor: ROLE.MAINTAINER })
    const result = await authorize(await tokenFor(ROLE.PROJECT_LEAD), fileCreate(), SECRET, db)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(403)
      expect(result.reason).toMatch(/600/)
    }
  })

  it("admits the same lead in a sibling project that follows the org", async () => {
    // The acceptance criterion in one assertion: tightening project A must not
    // reach project B.
    const { db } = makeDb({ orgFloor: ROLE.PROJECT_LEAD })
    const result = await authorize(await tokenFor(ROLE.PROJECT_LEAD), fileCreate(), SECRET, db)
    expect(result.ok).toBe(true)
  })

  it("admits a maintainer under the project's own maintainer floor", async () => {
    const { db } = makeDb({ orgFloor: ROLE.PROJECT_LEAD, projectFloor: ROLE.MAINTAINER })
    const result = await authorize(await tokenFor(ROLE.MAINTAINER), fileCreate(), SECRET, db)
    expect(result.ok).toBe(true)
  })

  it("admits a project lead when the project's stored value is not stricter", async () => {
    const { db } = makeDb({ orgFloor: ROLE.PROJECT_LEAD, projectFloor: ROLE.CONTRIBUTOR })
    const result = await authorize(await tokenFor(ROLE.PROJECT_LEAD), fileCreate(), SECRET, db)
    expect(result.ok).toBe(true)
  })

  it("admits an owner without reading either settings row", async () => {
    const { db, reads } = makeDb({ orgFloor: ROLE.PROJECT_LEAD, projectFloor: ROLE.MAINTAINER })
    const result = await authorize(await tokenFor(ROLE.OWNER), fileCreate(), SECRET, db)
    expect(result.ok).toBe(true)
    expect(reads.orgSettings).toBe(0)
    expect(reads.projectSettings).toBe(0)
  })

  it("leaves a translation import alone — target.cell.commit is untouched", async () => {
    const { db } = makeDb({ orgFloor: ROLE.PROJECT_LEAD, projectFloor: ROLE.MAINTAINER })
    const commit = {
      ...fileCreate(),
      kind: "target.cell.commit",
      cellId: "cell-1",
      payload: { html: "<p>hi</p>", targetLang: "" },
    } as unknown as RawEvent<"target.cell.commit">
    const result = await authorize(await tokenFor(ROLE.CONTRIBUTOR), commit, SECRET, db)
    if (!result.ok) {
      expect(result.reason).not.toMatch(/importing a new source file/)
    }
  })
})
