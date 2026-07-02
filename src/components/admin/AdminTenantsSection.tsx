import { Fragment, useMemo, useState } from "react"
import { Building2, ChevronRight, ExternalLink, Search, Users } from "lucide-react"
import { Input } from "@/components/ui/input"
import { EmptyState } from "@/components/ui/page"
import { cn } from "@/lib/utils"
import { fmtDate } from "@/lib/admin/format"
import type { AdminOrg, AdminTeam } from "@/lib/frontier/admin"

/**
 * Tenants — the merge of the old Orgs and Teams tabs. Orgs are the rows;
 * expanding one reveals its teams inline (teams always nest under an org), so
 * the two flat tables become one navigable hierarchy. "Open" drills into the
 * org workspace (platform admins resolve owner-level everywhere).
 */

/** GitLab full_paths lead with the org's own path; drop it so a team reads locally. */
function relativeTeamPath(name: string): string {
  const i = name.indexOf("/")
  return i === -1 ? name : name.slice(i + 1)
}

export function AdminTenantsSection({
  orgs,
  teams,
  onOpenOrg,
}: {
  orgs: AdminOrg[]
  teams: AdminTeam[]
  onOpenOrg: (orgId: number) => void
}) {
  const [query, setQuery] = useState("")
  const [expanded, setExpanded] = useState<Set<number>>(new Set())

  const teamsByOrg = useMemo(() => {
    const map = new Map<number, AdminTeam[]>()
    for (const t of teams) {
      const list = map.get(t.orgId) ?? []
      list.push(t)
      map.set(t.orgId, list)
    }
    return map
  }, [teams])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return orgs
    return orgs.filter(
      (o) => (o.name ?? `#${o.id}`).toLowerCase().includes(q) || (o.ownerUsername ?? "").toLowerCase().includes(q),
    )
  }, [orgs, query])

  const toggle = (orgId: number) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(orgId)) next.delete(orgId)
      else next.add(orgId)
      return next
    })

  if (orgs.length === 0) {
    return (
      <EmptyState icon={Building2} title="No organizations yet" description="Tenants appear here as orgs are created." />
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-0 flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search organizations…"
            aria-label="Search organizations"
            className="pl-8"
          />
        </div>
        <span className="ml-auto text-xs tabular-nums text-muted-foreground">
          {filtered.length === orgs.length ? `${orgs.length} orgs` : `${filtered.length} of ${orgs.length} orgs`}
        </span>
      </div>

      <div className="overflow-x-auto rounded-2xl border bg-card">
        <table className="w-full text-sm" data-testid="admin-tenants-table">
          <thead>
            <tr className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
              <th className="w-8 px-3 py-2" />
              <th className="px-3 py-2 font-medium">Organization</th>
              <th className="px-3 py-2 font-medium">Owner</th>
              <th className="px-3 py-2 text-right font-medium">Members</th>
              <th className="px-3 py-2 text-right font-medium">Projects</th>
              <th className="px-3 py-2 text-right font-medium">Teams</th>
              <th className="px-3 py-2 font-medium">Created</th>
              <th className="px-3 py-2 font-medium" />
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-3 py-8 text-center text-sm text-muted-foreground">
                  No matches for “{query}”.
                </td>
              </tr>
            ) : (
              filtered.map((o) => {
                const orgTeams = teamsByOrg.get(o.id) ?? []
                const isOpen = expanded.has(o.id)
                return (
                  <Fragment key={o.id}>
                    <tr className="border-t transition-colors hover:bg-muted/30">
                      <td className="px-3 py-2">
                        <button
                          type="button"
                          onClick={() => toggle(o.id)}
                          disabled={orgTeams.length === 0}
                          aria-expanded={isOpen}
                          aria-label={isOpen ? `Collapse ${o.name ?? o.id}` : `Expand ${o.name ?? o.id}`}
                          className="flex size-5 items-center justify-center rounded text-muted-foreground transition-colors hover:text-foreground disabled:opacity-30"
                        >
                          <ChevronRight className={cn("size-4 transition-transform", isOpen && "rotate-90")} />
                        </button>
                      </td>
                      <td className="px-3 py-2 font-medium text-foreground">{o.name ?? `#${o.id}`}</td>
                      <td className="px-3 py-2 text-muted-foreground">{o.ownerUsername ?? "—"}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{o.memberCount}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{o.projectCount}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{orgTeams.length}</td>
                      <td className="px-3 py-2 text-muted-foreground">{fmtDate(o.createdAt)}</td>
                      <td className="px-3 py-2">
                        <button
                          type="button"
                          onClick={() => onOpenOrg(o.id)}
                          className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                        >
                          Open <ExternalLink className="size-3" />
                        </button>
                      </td>
                    </tr>
                    {isOpen && orgTeams.length > 0 && (
                      <tr className="border-t bg-muted/20">
                        <td />
                        <td colSpan={7} className="px-3 py-2">
                          <ul className="space-y-1">
                            {orgTeams.map((t) => (
                              <li key={t.id} className="flex items-center gap-2 text-xs">
                                <Users className="size-3 text-muted-foreground" />
                                <span className="font-medium text-foreground">{relativeTeamPath(t.name)}</span>
                                <span className="text-muted-foreground">
                                  {t.memberCount} {t.memberCount === 1 ? "member" : "members"} · {t.projectCount}{" "}
                                  {t.projectCount === 1 ? "project" : "projects"}
                                </span>
                              </li>
                            ))}
                          </ul>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
