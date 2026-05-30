import { useEffect, useState } from "react"
import { useParams } from "react-router-dom"
import { AppShell } from "@/components/AppShell"
import { OrgSidebar } from "./OrgSidebar"
import { OrgBreadcrumb } from "./OrgBreadcrumb"
import { useActiveOrg } from "@/context/OrgContext"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { getTeam, type TeamDetail as TeamDetailType } from "@/lib/frontier/teams"

export function TeamDetail() {
  const { groupId } = useParams<{ groupId: string }>()
  const groupIdNum = groupId != null ? Number(groupId) : null
  const { activeOrgId } = useActiveOrg()
  const { session } = useFrontierSession()
  const jwt = session?.jwt ?? null
  const [team, setTeam] = useState<TeamDetailType | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!jwt || activeOrgId == null || groupIdNum == null) return
    let cancelled = false
    setLoading(true)
    getTeam(jwt, activeOrgId, groupIdNum)
      .then((t) => { if (!cancelled) setTeam(t) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [jwt, activeOrgId, groupIdNum])

  return (
    <AppShell
      sidebar={<OrgSidebar />}
      header={<OrgBreadcrumb section={team?.name ?? "Team"} />}
      statusBar={null}
      main={
        <div className="p-6 space-y-8">
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : team == null ? (
            <p className="text-sm text-muted-foreground">Team not found.</p>
          ) : (
            <>
              <section>
                <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">Members</h2>
                {team.members.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No members.</p>
                ) : (
                  <ul className="space-y-2">
                    {team.members.map((m) => (
                      <li key={m.userId} className="flex items-center justify-between rounded-lg border px-4 py-2 text-sm">
                        <span className="font-medium">{m.username}</span>
                        <span className="text-xs text-muted-foreground">
                          {m.roleLevel != null ? `Level ${m.roleLevel}` : "—"}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section>
                <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">Projects</h2>
                {team.projects.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No projects.</p>
                ) : (
                  <ul className="space-y-2">
                    {team.projects.map((p) => (
                      <li key={p.id} className="flex items-center justify-between rounded-lg border px-4 py-2 text-sm">
                        <span className="font-medium">{p.name}</span>
                        <span className="text-xs text-muted-foreground">Level {p.grantedRoleLevel}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </>
          )}
        </div>
      }
    />
  )
}
