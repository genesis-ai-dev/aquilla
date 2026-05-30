import { useEffect, useState } from "react"
import { useNavigate } from "react-router-dom"
import { AppShell } from "@/components/AppShell"
import { OrgSidebar } from "./OrgSidebar"
import { OrgBreadcrumb } from "./OrgBreadcrumb"
import { useActiveOrg } from "@/context/OrgContext"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { listTeams, type TeamSummary } from "@/lib/frontier/teams"

export function TeamsList() {
  const { activeOrgId } = useActiveOrg()
  const { session } = useFrontierSession()
  const jwt = session?.jwt ?? null
  const navigate = useNavigate()
  const [teams, setTeams] = useState<TeamSummary[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!jwt || activeOrgId == null) return
    let cancelled = false
    setLoading(true)
    listTeams(jwt, activeOrgId)
      .then((list) => { if (!cancelled) setTeams(list) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [jwt, activeOrgId])

  return (
    <AppShell
      sidebar={<OrgSidebar />}
      header={<OrgBreadcrumb section="Teams" />}
      statusBar={null}
      main={
        <div className="p-6">
          {loading ? <p className="text-sm text-muted-foreground">Loading…</p> : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {teams.map((t) => (
                <button
                  key={t.id}
                  onClick={() => navigate(`/teams/${t.id}`)}
                  className="rounded-lg border p-4 text-left hover:bg-accent/40"
                >
                  <span className="block font-medium">{t.name}</span>
                  <span className="block text-xs text-muted-foreground">
                    {t.memberCount} members · {t.projectCount} projects
                  </span>
                  {t.viewerIsMember && (
                    <span className="mt-1 block text-xs text-muted-foreground/70">Member</span>
                  )}
                </button>
              ))}
              {teams.length === 0 && <p className="text-sm text-muted-foreground">No teams in this org yet.</p>}
            </div>
          )}
        </div>
      }
    />
  )
}
