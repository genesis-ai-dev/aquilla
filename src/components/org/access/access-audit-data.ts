/**
 * AQU-1072: wire shape, read, and CSV for the org access audit.
 * GET /api/v2/orgs/:orgId/access-audit. Effective roles are already resolved
 * on the server; this module only labels and exports them.
 */
import { roleLabel } from "@/components/access/labels"
import { FRONTIER_API_URL } from "@/lib/sync/sync-token"
import type { TFunction } from "@/lib/i18n/I18nProvider"

export type AuditRoleSource = "override" | "group" | "org" | "creator" | "platform"

export interface AccessAuditLane {
  laneId: string
  name: string
  roleLevel: number
}
export interface AccessAuditProject {
  projectId: string
  projectName: string
  role: { level: number; name: string; source: AuditRoleSource }
  lanes: AccessAuditLane[]
}
export interface AccessAuditTeam {
  teamId: string
  name: string
  roleLevel: number | null
}
export interface AccessAuditPerson {
  userId: string
  username: string
  displayName: string
  orgRole: number | null
  teams: AccessAuditTeam[]
  projects: AccessAuditProject[]
}
export interface AccessAuditReport {
  orgId: number
  orgName: string
  generatedAt: string
  people: AccessAuditPerson[]
}

export type AccessAuditResult =
  | { ok: true; report: AccessAuditReport }
  | { ok: false; reason: "forbidden" | "error" }

export async function fetchAccessAudit(
  jwt: string,
  orgId: number,
  apiUrl: string = FRONTIER_API_URL,
): Promise<AccessAuditResult> {
  const res = await fetch(`${apiUrl}/api/v2/orgs/${orgId}/access-audit`, {
    headers: { Authorization: `Bearer ${jwt}` },
  })
  if (res.status === 403) return { ok: false, reason: "forbidden" }
  if (!res.ok) return { ok: false, reason: "error" }
  return { ok: true, report: (await res.json()) as AccessAuditReport }
}

/** The resolver's winning source, in the words the audit uses. */
export function auditSourceLabel(t: TFunction, source: AuditRoleSource): string {
  switch (source) {
    case "override":
      return t("org.accessModelLegend.direct.label")
    case "group":
      return t("editor.navTitle.team")
    case "org":
      return t("org.accessModelLegend.orgWide.label")
    case "creator":
      return t("org.accessModelLegend.creator.label")
    case "platform":
      return t("org.access.origin.platform")
  }
}

export function auditTeamLabel(t: TFunction, team: AccessAuditTeam): string {
  if (team.roleLevel == null) return team.name
  return t("org.accessAudit.teamMembership", { name: team.name, role: roleLabel(t, team.roleLevel) })
}

const csvCell = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)

/** One row per lane grant. A project with no lane grants still gets a row,
 *  and a person with no project access still gets a row. */
export function accessAuditCsv(t: TFunction, report: AccessAuditReport): string {
  const header = [
    t("org.access.page.csvPerson"),
    t("org.accessAudit.csvOrgRole"),
    t("editor.navTitle.teams"),
    t("common.project"),
    t("org.accessAudit.csvEffectiveRole"),
    t("org.accessAudit.csvSource"),
    t("org.accessAudit.csvLane"),
    t("org.accessAudit.csvLaneRole"),
  ]
  const orgRole = (person: AccessAuditPerson) =>
    person.orgRole == null ? t("org.accessAudit.notOrgMember") : roleLabel(t, person.orgRole)
  const teams = (person: AccessAuditPerson) => person.teams.map((team) => auditTeamLabel(t, team)).join("; ")
  const rows: string[][] = []
  for (const person of report.people) {
    const lead = [person.displayName, orgRole(person), teams(person)]
    if (person.projects.length === 0) {
      rows.push([...lead, "", "", "", "", ""])
      continue
    }
    for (const project of person.projects) {
      const projectCells = [
        project.projectName,
        roleLabel(t, project.role.level),
        auditSourceLabel(t, project.role.source),
      ]
      if (project.lanes.length === 0) {
        rows.push([...lead, ...projectCells, "", ""])
        continue
      }
      for (const lane of project.lanes) {
        rows.push([...lead, ...projectCells, lane.name, roleLabel(t, lane.roleLevel)])
      }
    }
  }
  return [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n"
}

export function accessAuditFilename(orgName: string): string {
  const slug = orgName.replace(/[^\w-]+/g, "-").replace(/^-+|-+$/g, "") || "org"
  return `${slug}-access-audit.csv`
}
