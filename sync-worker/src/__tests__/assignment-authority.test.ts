// Tests for resolveAllowSelfAssignment (AQU-496). Mirrors
// export-floor.test.ts's makeDb stub pattern.
import { describe, it, expect } from "vitest"
import { resolveAllowSelfAssignment } from "../events/assignment-authority"

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

describe("resolveAllowSelfAssignment", () => {
  it("returns false when the project has no org", async () => {
    const db = makeDb({ orgId: null })
    expect(await resolveAllowSelfAssignment(db, "p1")).toBe(false)
  })

  it("returns false when no org_settings row exists", async () => {
    const db = makeDb({ orgId: 1, orgSettings: null })
    expect(await resolveAllowSelfAssignment(db, "p1")).toBe(false)
  })

  it("returns false when org settings have no allowSelfAssignment key", async () => {
    const db = makeDb({ orgSettings: JSON.stringify({ rules: [] }) })
    expect(await resolveAllowSelfAssignment(db, "p1")).toBe(false)
  })

  it("returns true when org sets allowSelfAssignment=true", async () => {
    const db = makeDb({ orgSettings: JSON.stringify({ allowSelfAssignment: true }) })
    expect(await resolveAllowSelfAssignment(db, "p1")).toBe(true)
  })

  it("returns false when org sets allowSelfAssignment=false", async () => {
    const db = makeDb({ orgSettings: JSON.stringify({ allowSelfAssignment: false }) })
    expect(await resolveAllowSelfAssignment(db, "p1")).toBe(false)
  })

  it("returns false for truthy-but-not-boolean-true values (e.g. \"true\" string)", async () => {
    const db = makeDb({ orgSettings: JSON.stringify({ allowSelfAssignment: "true" }) })
    expect(await resolveAllowSelfAssignment(db, "p1")).toBe(false)
  })

  it("returns false for malformed JSON in org_settings", async () => {
    const db = makeDb({ orgSettings: "NOT_JSON{{" })
    expect(await resolveAllowSelfAssignment(db, "p1")).toBe(false)
  })
})
