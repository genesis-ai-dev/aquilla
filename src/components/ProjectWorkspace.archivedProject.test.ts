// AQU-2453: a member who opened an archived project was told the project was
// "in Trash" and to "restore it to continue editing" — wording for an action
// only Maintainers have, on a state only "Archive project" can reach. The
// screen now names the state it is in and points a reader who cannot restore
// at someone who can. Restore is gated at the floor auth-worker enforces
// (Maintainer+), not the owner-only one the screen used to guess.
import { describe, it, expect } from "vitest"
import { archivedProjectNotice } from "./project-workspace-helpers"
import { ROLE } from "@/lib/frontier/roles"
import { en } from "@/lib/i18n/messages/en"

const syncRole = (level: number) => ({
  level,
  name: "role",
  source: "member",
  fetchedAt: "2026-11-11T00:00:00.000Z",
})

// A cloud-synced project: a server row exists, so the role is what decides.
const cloudProject = (level: number) => ({ syncRole: syncRole(level) })

describe("archivedProjectNotice (what an archived project tells its reader)", () => {
  it.each([
    ["a Viewer", ROLE.VIEWER, false],
    ["a Contributor", ROLE.CONTRIBUTOR, false],
    ["a Project Lead", ROLE.PROJECT_LEAD, false],
    ["a Maintainer", ROLE.MAINTAINER, true],
    ["an Owner", ROLE.OWNER, true],
  ])("lets %s restore: %s → %s", (_who, level, expected) => {
    const notice = archivedProjectNotice({ project: cloudProject(level), hasSession: true })
    expect(notice.canRestore).toBe(expected)
  })

  it("asks a reader who cannot restore to ask someone who can, and offers them no restore", () => {
    const notice = archivedProjectNotice({
      project: cloudProject(ROLE.CONTRIBUTOR),
      hasSession: true,
    })
    expect(notice.canRestore).toBe(false)
    expect(notice.hintKey).toBe("workspace.archivedProject.askHint")
  })

  it("tells a reader who can restore to restore it", () => {
    const notice = archivedProjectNotice({
      project: cloudProject(ROLE.MAINTAINER),
      hasSession: true,
    })
    expect(notice.hintKey).toBe("workspace.archivedProject.restoreHint")
  })

  it("names who archived it only when that is recorded", () => {
    expect(
      archivedProjectNotice({ project: cloudProject(ROLE.OWNER), hasSession: true }).bodyKey,
    ).toBe("workspace.archivedProject.archivedMessage")
    expect(
      archivedProjectNotice({
        project: { ...cloudProject(ROLE.OWNER), deletedBy: "gst" },
        hasSession: true,
      }).bodyKey,
    ).toBe("workspace.archivedProject.archivedByMessage")
  })

  it("keeps the local-first escape hatches restorable: no server row, or no session", () => {
    expect(archivedProjectNotice({ project: {}, hasSession: true }).canRestore).toBe(true)
    expect(
      archivedProjectNotice({ project: cloudProject(ROLE.CONTRIBUTOR), hasSession: false })
        .canRestore,
    ).toBe(true)
  })
})

describe("archived-project copy names the state it is in", () => {
  const keys = [
    "workspace.archivedProject.title",
    "workspace.archivedProject.archivedMessage",
    "workspace.archivedProject.archivedByMessage",
    "workspace.archivedProject.restoreHint",
    "workspace.archivedProject.askHint",
  ] as const

  it.each(keys)("%s never calls archiving 'trash'", (key) => {
    const message = en[key]
    expect(typeof message).toBe("string")
    expect(message as string).not.toMatch(/trash/i)
  })

  it("says archived, and says nothing was deleted", () => {
    expect(en["workspace.archivedProject.title"] as string).toMatch(/archived/i)
    for (const key of [
      "workspace.archivedProject.archivedMessage",
      "workspace.archivedProject.archivedByMessage",
    ] as const) {
      expect(en[key] as string).toMatch(/archived/i)
      expect(en[key] as string).toMatch(/nothing has been deleted/i)
    }
  })

  it("tells a reader who cannot restore to ask, not to restore", () => {
    expect(en["workspace.archivedProject.askHint"] as string).toMatch(/ask/i)
    expect(en["workspace.archivedProject.askHint"] as string).not.toMatch(/^Restore/)
  })
})
