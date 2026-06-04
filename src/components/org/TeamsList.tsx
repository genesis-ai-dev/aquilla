import { useEffect, useState } from "react"
import { useNavigate } from "react-router-dom"
import { AppShell } from "@/components/AppShell"
import { OrgSidebar } from "./OrgSidebar"
import { OrgBreadcrumb } from "./OrgBreadcrumb"
import { useActiveOrg } from "@/context/OrgContext"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { listTeams, createTeam, type TeamSummary } from "@/lib/frontier/teams"

/** Three-position filter for the teams portal: all / internal only / public only. */
type GroupFilter = "all" | "internal" | "public"
const GROUP_FILTER_OPTIONS: Array<{ key: GroupFilter; label: string }> = [
  { key: "all", label: "All" },
  { key: "internal", label: "Internal only" },
  { key: "public", label: "Public only" },
]

export function TeamsList() {
  const { activeOrgId, activeOrg } = useActiveOrg()
  const { session } = useFrontierSession()
  const jwt = session?.jwt ?? null
  const navigate = useNavigate()
  const [teams, setTeams] = useState<TeamSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  // Default: "internal" — preserves the prior UX where only internal groups
  // were shown (all existing groups default to isInternal=true via migration).
  const [groupFilter, setGroupFilter] = useState<GroupFilter>("internal")

  const isAdmin = (activeOrg?.role.level ?? 0) >= 600

  useEffect(() => {
    if (!jwt || activeOrgId == null) return
    let cancelled = false
    setLoading(true)
    listTeams(jwt, activeOrgId)
      .then((list) => { if (!cancelled) setTeams(list) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [jwt, activeOrgId])

  const filteredTeams = teams.filter((t) => {
    if (groupFilter === "internal") return t.isInternal
    if (groupFilter === "public") return !t.isInternal
    return true // "all"
  })

  return (
    <AppShell
      sidebar={<OrgSidebar />}
      header={<OrgBreadcrumb section="Teams" />}
      statusBar={null}
      main={
        <div className="h-full overflow-y-auto p-6">
          {isAdmin && (
            <div className="mb-4">
              {!creating ? (
                <button onClick={() => setCreating(true)} className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground">New team</button>
              ) : (
                <form
                  onSubmit={async (e) => {
                    e.preventDefault()
                    if (!jwt || activeOrgId == null || !name.trim()) return
                    const t = await createTeam(jwt, activeOrgId, name.trim(), description.trim() || undefined)
                    navigate(`/teams/${t.id}`)
                  }}
                  className="flex flex-wrap items-center gap-2"
                >
                  <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Team name" className="rounded-md border px-2 py-1 text-sm" />
                  <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Description (optional)" className="rounded-md border px-2 py-1 text-sm" />
                  <button type="submit" className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground">Create</button>
                  <button type="button" onClick={() => setCreating(false)} className="text-sm text-muted-foreground">Cancel</button>
                </form>
              )}
            </div>
          )}

          {/* Three-position toggle: all / internal only / public only */}
          <div className="mb-4 inline-flex rounded-md border bg-muted/20 p-0.5">
            {GROUP_FILTER_OPTIONS.map((opt) => (
              <button
                key={opt.key}
                type="button"
                onClick={() => setGroupFilter(opt.key)}
                className={`inline-flex items-center rounded px-2.5 py-1 text-xs ${
                  groupFilter === opt.key
                    ? "bg-background shadow-sm text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          {loading ? <p className="text-sm text-muted-foreground">Loading…</p> : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {filteredTeams.map((t) => (
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
                  {!t.isInternal && (
                    <span className="mt-1 block text-xs text-muted-foreground/70">Public</span>
                  )}
                </button>
              ))}
              {filteredTeams.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  {teams.length === 0
                    ? "No teams in this org yet."
                    : `No ${groupFilter === "all" ? "" : groupFilter + " "}groups match the current filter.`}
                </p>
              )}
            </div>
          )}
        </div>
      }
    />
  )
}
