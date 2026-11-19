import { describe, expect, it } from "vitest"

import {
  isLostProjectAccess,
  mint403QuarantineReason,
  revokedOpenProjectListPath,
  syncTokenDenialMessage,
} from "./lost-project-access"

describe("lost project access (AQU-2455)", () => {
  it("treats a removed member as lost access and leaves archive, freeze, and role refusals alone", () => {
    const cases: Array<[string | null, boolean]> = [
      ["No access to project", true],
      ["no access to this change's project", true],
      ["membership revoked", true],
      ["Project is archived", false],
      ["Project is frozen", false],
      ["lane 'Spanish' is archived", false],
      ["elevation required to mint a project sync token with platform-admin access", false],
      ["file 'f1' not in scope for cell.validate", false],
      ["role too low for target.cell.commit", false],
      ["HTTP 403", false],
      [null, false],
    ]
    expect(cases.map(([reason]) => isLostProjectAccess(reason))).toEqual(
      cases.map(([, lost]) => lost),
    )
  })

  it("keeps a named mint denial and falls back when the body does not name one", () => {
    expect(syncTokenDenialMessage(JSON.stringify({ error: "No access to project" }))).toBe(
      "No access to project",
    )
    expect(syncTokenDenialMessage(JSON.stringify({ error: "Project is archived" }))).toBe(
      "Project is archived",
    )
    expect(syncTokenDenialMessage(JSON.stringify({ error: "Project is frozen" }))).toBe(
      "Project is frozen",
    )
    expect(mint403QuarantineReason("No access to project")).toBe("No access to project")
    expect(mint403QuarantineReason("Project is archived")).toBe("Project is archived")
    expect(mint403QuarantineReason("Project is frozen")).toBe("Project is frozen")
    expect(mint403QuarantineReason("Forbidden")).toBe("no access to this change's project")
    expect(mint403QuarantineReason(null)).toBe("no access to this change's project")
  })

  it("sends a concrete org to its project list and everyone else to the all-orgs list", () => {
    expect(revokedOpenProjectListPath(7, false)).toBe("/orgs/7/projects")
    expect(revokedOpenProjectListPath(7, true)).toBe("/orgs/all")
    expect(revokedOpenProjectListPath(null, false)).toBe("/orgs/all")
  })
})
