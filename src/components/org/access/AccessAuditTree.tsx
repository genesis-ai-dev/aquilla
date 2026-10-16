import { roleLabel } from "@/components/access/labels"
import { useT } from "@/lib/i18n/I18nProvider"
import {
  auditSourceLabel,
  auditTeamLabel,
  type AccessAuditPerson,
  type AccessAuditReport,
} from "./access-audit-data"

/** Person → teams, and person → projects → lane grants. Fully expanded so a
 *  browser print includes every row. */
export function AccessAuditTree({ report }: { report: AccessAuditReport }) {
  const t = useT()
  if (report.people.length === 0) {
    return <p className="text-sm text-muted-foreground">{t("org.accessAudit.empty")}</p>
  }
  return (
    <ul className="flex flex-col gap-4" data-testid="access-audit-tree">
      {report.people.map((person) => (
        <PersonNode key={person.userId} person={person} />
      ))}
    </ul>
  )
}

function PersonNode({ person }: { person: AccessAuditPerson }) {
  const t = useT()
  const orgRole = person.orgRole == null
    ? t("org.accessAudit.notOrgMember")
    : roleLabel(t, person.orgRole)
  return (
    <li className="access-audit-person rounded-md border bg-card px-3 py-3" data-testid={`access-audit-person-${person.userId}`}>
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-medium">{person.displayName}</span>
        {person.displayName !== person.username && (
          <span className="text-sm text-muted-foreground">{person.username}</span>
        )}
        <span className="text-sm text-muted-foreground">{orgRole}</span>
      </div>
      <ul className="ms-4 mt-2 flex flex-col gap-2 border-s ps-3">
        <li>
          <div className="text-xs text-muted-foreground">{t("editor.navTitle.teams")}</div>
          {person.teams.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("org.accessAudit.noTeams")}</p>
          ) : (
            <ul className="mt-1 flex flex-col gap-0.5 text-sm">
              {person.teams.map((team) => (
                <li key={team.teamId}>{auditTeamLabel(t, team)}</li>
              ))}
            </ul>
          )}
        </li>
        <li>
          <div className="text-xs text-muted-foreground">{t("nav.projects")}</div>
          {person.projects.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("org.accessAudit.noProjects")}</p>
          ) : (
            <ul className="mt-1 flex flex-col gap-2">
              {person.projects.map((project) => (
                <li key={project.projectId} data-testid={`access-audit-project-${person.userId}-${project.projectId}`}>
                  <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
                    <span className="font-medium">{project.projectName}</span>
                    <span>
                      {t("org.accessAudit.projectAccess", {
                        role: roleLabel(t, project.role.level),
                        source: auditSourceLabel(t, project.role.source),
                      })}
                    </span>
                  </div>
                  {project.lanes.length === 0 ? (
                    <p className="ms-4 text-sm text-muted-foreground">{t("org.accessAudit.noLanes")}</p>
                  ) : (
                    <ul className="ms-4 mt-0.5 flex flex-col text-sm">
                      {project.lanes.map((lane) => (
                        <li key={lane.laneId}>
                          {t("org.accessAudit.laneGrant", {
                            lane: lane.name,
                            role: roleLabel(t, lane.roleLevel),
                          })}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          )}
        </li>
      </ul>
    </li>
  )
}
