import { describe, expect, it } from "vitest"
import { translate } from "@/lib/i18n/translate"
import { en } from "@/lib/i18n/messages/en"
import { DEFAULT_LOCALE } from "@/lib/i18n/locales"
import {
  accessAuditCsv,
  auditSourceLabel,
  type AccessAuditReport,
} from "./access-audit-data"

const t = (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) =>
  translate(en, key, vars, DEFAULT_LOCALE)

const report: AccessAuditReport = {
  orgId: 1,
  orgName: "Come and See",
  generatedAt: "2026-10-07T03:00:00.000Z",
  people: [
    {
      userId: "2",
      username: "anna",
      displayName: "Anna, Jr",
      orgRole: 100,
      teams: [{ teamId: "5", name: "Translators", roleLevel: 500 }],
      projects: [
        {
          projectId: "pa",
          projectName: "John",
          role: { level: 400, name: "contributor", source: "group" },
          lanes: [
            { laneId: "lane-es", name: "Spanish", roleLevel: 100 },
            { laneId: "lane-fr", name: "French", roleLevel: 300 },
          ],
        },
        {
          projectId: "pb",
          projectName: "Mark",
          role: { level: 700, name: "owner", source: "creator" },
          lanes: [],
        },
      ],
    },
    {
      userId: "3",
      username: "gio",
      displayName: "Gio",
      orgRole: null,
      teams: [],
      projects: [],
    },
  ],
}

describe("access audit labels and CSV", () => {
  it("names the resolver sources direct, team, org, creator, and platform", () => {
    expect(auditSourceLabel(t, "override")).toBe("Direct")
    expect(auditSourceLabel(t, "group")).toBe("Team")
    expect(auditSourceLabel(t, "org")).toBe("Org-wide")
    expect(auditSourceLabel(t, "creator")).toBe("Creator")
    expect(auditSourceLabel(t, "platform")).toBe("Platform admin")
  })

  it("writes one row per lane, and still a row when a person has no project", () => {
    const csv = accessAuditCsv(t, report)
    const lines = csv.trim().split("\r\n")
    expect(lines[0]).toBe("Person,Organization role,Teams,Project,Effective role,Comes from,Lane,Lane role")
    expect(lines[1]).toBe('"Anna, Jr",Viewer,Translators (Project lead),John,Contributor,Team,Spanish,Viewer')
    expect(lines[2]).toBe('"Anna, Jr",Viewer,Translators (Project lead),John,Contributor,Team,French,Reviewer')
    expect(lines[3]).toBe('"Anna, Jr",Viewer,Translators (Project lead),Mark,Owner,Creator,,')
    expect(lines[4]).toBe("Gio,Not an organization member,,,,,," )
  })
})
