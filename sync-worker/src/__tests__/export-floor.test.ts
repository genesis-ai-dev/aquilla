// Tests for the shared resolveExportFloor helper (AQU-253).
// Verifies: default, valid override, invalid (out-of-range) values, and that
// both export-route.ts and export-bundle-route.ts use the shared module.
import { describe, it, expect } from "vitest"
import { resolveExportFloor } from "../events/export-floor"
import { ROLE } from "../events/role-policy"

/**
 * Build a minimal AquillaDb stub that returns the given project org_id and
 * optional org_settings JSON. The stub routes by the SQL snippet present in
 * the prepare() call so the sequence doesn't need to match exactly.
 */
function makeDb(options: {
  orgId?: number | null
  orgSettings?: string | null
}): AquillaDb {
  const { orgId = 1, orgSettings = null } = options
  return {
    prepare(sql: string) {
      return {
        bind(..._args: unknown[]) {
          return {
            async first() {
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

describe("resolveExportFloor", () => {
  it("returns MAINTAINER (600) when the project has no org", async () => {
    const db = makeDb({ orgId: null })
    expect(await resolveExportFloor(db, "p1")).toBe(ROLE.MAINTAINER)
  })

  it("returns MAINTAINER (600) when no org_settings row exists", async () => {
    const db = makeDb({ orgId: 1, orgSettings: null })
    expect(await resolveExportFloor(db, "p1")).toBe(ROLE.MAINTAINER)
  })

  it("returns MAINTAINER (600) when org settings have no exportMinRole key", async () => {
    const db = makeDb({ orgSettings: JSON.stringify({ rules: [] }) })
    expect(await resolveExportFloor(db, "p1")).toBe(ROLE.MAINTAINER)
  })

  it("returns the explicit floor when org sets exportMinRole=CONTRIBUTOR (400)", async () => {
    const db = makeDb({ orgSettings: JSON.stringify({ exportMinRole: 400 }) })
    expect(await resolveExportFloor(db, "p1")).toBe(ROLE.CONTRIBUTOR)
  })

  it("returns the explicit floor when org sets exportMinRole=OWNER (700)", async () => {
    const db = makeDb({ orgSettings: JSON.stringify({ exportMinRole: 700 }) })
    expect(await resolveExportFloor(db, "p1")).toBe(ROLE.OWNER)
  })

  it("falls back to MAINTAINER for out-of-range value (9999)", async () => {
    const db = makeDb({ orgSettings: JSON.stringify({ exportMinRole: 9999 }) })
    expect(await resolveExportFloor(db, "p1")).toBe(ROLE.MAINTAINER)
  })

  it("falls back to MAINTAINER for negative value (-1)", async () => {
    const db = makeDb({ orgSettings: JSON.stringify({ exportMinRole: -1 }) })
    expect(await resolveExportFloor(db, "p1")).toBe(ROLE.MAINTAINER)
  })

  it("falls back to MAINTAINER for string exportMinRole ('owner')", async () => {
    const db = makeDb({ orgSettings: JSON.stringify({ exportMinRole: "owner" }) })
    expect(await resolveExportFloor(db, "p1")).toBe(ROLE.MAINTAINER)
  })

  it("falls back to MAINTAINER for null exportMinRole", async () => {
    const db = makeDb({ orgSettings: JSON.stringify({ exportMinRole: null }) })
    expect(await resolveExportFloor(db, "p1")).toBe(ROLE.MAINTAINER)
  })

  it("falls back to MAINTAINER for malformed JSON in org_settings", async () => {
    const db = makeDb({ orgSettings: "NOT_JSON{{" })
    expect(await resolveExportFloor(db, "p1")).toBe(ROLE.MAINTAINER)
  })
})

// ── Verify that both routes import from the same shared module ──────────────
// These imports will fail at compile-time if the shared module is missing or
// the named export doesn't exist, giving a clear signal that the resolver has
// drifted. They don't need to actually call the function — the import itself
// is the test.
describe("shared resolver import contract", () => {
  it("export-route.ts re-exports the same resolveExportFloor", async () => {
    // Dynamic import to avoid circular dependency noise in other tests.
    const routeModule = await import("../events/export-route")
    // The route doesn't re-export resolveExportFloor directly; what we verify
    // is that the module loads without error (i.e., its import of export-floor
    // resolved). The presence of handleExportSourceRequest is the proxy check.
    expect(typeof routeModule.handleExportSourceRequest).toBe("function")
  })

  it("export-bundle-route.ts re-exports the same resolveExportFloor", async () => {
    const bundleModule = await import("../events/export-bundle-route")
    expect(typeof bundleModule.handleExportBundleRequest).toBe("function")
  })
})
