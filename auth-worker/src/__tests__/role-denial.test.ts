import { describe, expect, it } from "vitest"
import { roleRequiredBody } from "../lib/role-denial"

// AQU-1352 §3.9 rule 2: denials must carry scope + role + origin so the client
// can explain WHY, while keeping the legacy `error` string for old clients.
describe("roleRequiredBody", () => {
  it("keeps the legacy error string and adds the structured fields", () => {
    const body = roleRequiredBody("maintainer+ required", 600, { level: 400, source: "group" })
    expect(body.error).toBe("maintainer+ required")
    expect(body.code).toBe("role_required")
    expect(body.required.roleLevel).toBe(600)
    expect(body.actual).toEqual({ roleLevel: 400, source: "group" })
  })

  it("reports a caller with no role as null rather than inventing a level", () => {
    const body = roleRequiredBody("x", 600, null, ["Org", "Project"])
    expect(body.actual).toEqual({ roleLevel: null, source: null, scopePath: ["Org", "Project"] })
  })
})
