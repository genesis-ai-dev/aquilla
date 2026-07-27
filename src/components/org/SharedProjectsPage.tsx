import { useEffect, useState } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { Share2 } from "lucide-react"
import { AppShell } from "@/components/AppShell"
import { EmptyState } from "@/components/ui/page"
import { Badge } from "@/components/ui/badge"
import { RoleLabel } from "@/components/RoleLabel"
import { OrgSidebar } from "./OrgSidebar"
import { OrgBreadcrumb } from "./OrgBreadcrumb"
import { useActiveOrg } from "@/context/OrgContext"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { fetchAccessibleProjects, type CloudProjectSummary } from "@/lib/sync/cloud-projects"
import { partitionSharedProjects } from "@/lib/frontier/shared-projects"
import { isProjectNew, readProjectOpenedAt } from "@/lib/frontier/opened-shared-store"

/**
 * AQU-417: the single, dedicated home for "shared with you" projects — every
 * accessible project in an organization the caller is NOT a member of (or with
 * no org at all), gathered in one place.
 *
 * Previously these were listed under a "Shared with you" section at the bottom
 * of whichever org you were viewing (both the sidebar and the dashboard), which
 * repeated the same list under every org and felt scattered — especially for
 * grants from orgs you don't belong to. This page collects them once; the
 * sidebar links here instead of re-listing per org.
 *
 * Org-agnostic by design (AQU-475 "all-orgs" partition scope): the list is the
 * same regardless of which org is active, and it works for a project-only
 * invitee with zero org memberships — for whom the all-orgs overview is not
 * reachable (isAllOrgs requires 2+ member orgs, see OrgContext).
 */
export function SharedProjectsPage() {
  const { orgs, activeOrgId, isLoading: orgLoading } = useActiveOrg()
  const { session } = useFrontierSession()
  const jwt = session?.jwt ?? null
  const username = session?.username ?? null

  // AQU-624: the org switcher sends a guest org's click here scoped to that org
  // (`/shared?org=<id>`). When present, this page acts as that org's overview —
  // narrowed to its shared projects. Unscoped, it stays the org-agnostic
  // "everything shared with you" list (AQU-417/AQU-475).
  const [searchParams] = useSearchParams()
  const scopedOrgParam = searchParams.get("org")
  const scopedOrgId =
    scopedOrgParam != null && Number.isFinite(Number(scopedOrgParam))
      ? Number(scopedOrgParam)
      : null

  const [accessibleProjects, setAccessibleProjects] = useState<CloudProjectSummary[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!jwt) {
      setAccessibleProjects([])
      setLoading(false)
      return
    }
    if (orgLoading) return
    let cancelled = false
    setLoading(true)
    fetchAccessibleProjects(jwt)
      .then((all) => { if (!cancelled) setAccessibleProjects(all) })
      .catch(() => { if (!cancelled) setAccessibleProjects([]) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [jwt, orgs, activeOrgId, orgLoading])

  const allSharedProjects = partitionSharedProjects(
    accessibleProjects,
    orgs,
    activeOrgId,
    "all-orgs",
  ).sharedWithMe
  const sharedProjects =
    scopedOrgId == null
      ? allSharedProjects
      : allSharedProjects.filter((p) => p.orgId === scopedOrgId)
  const scopedOrgName =
    scopedOrgId == null
      ? null
      : sharedProjects.find((p) => p.orgName)?.orgName ?? `Org #${scopedOrgId}`

  return (
    <AppShell
      sidebar={<OrgSidebar />}
      header={<OrgBreadcrumb section={scopedOrgName ?? "Shared with you"} />}
      statusBar={null}
      main={
        // See ProjectsList.tsx / AssignedToMe.tsx for why `h-full overflow-y-auto
        // overscroll-contain` is the correct scroll surface inside AppShell.
        <div
          className="h-full overflow-y-auto overscroll-contain space-y-4 p-6"
          data-testid="shared-projects-scroll"
        >
          <div>
            <h1 className="text-lg font-semibold">{scopedOrgName ?? "Shared with you"}</h1>
            <p className="text-sm text-muted-foreground">
              {scopedOrgName
                ? `Projects in ${scopedOrgName} shared with you.`
                : "Projects shared with you from organizations you’re not a member of, gathered in one place."}
            </p>
          </div>
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading&hellip;</p>
          ) : sharedProjects.length === 0 ? (
            <EmptyState
              icon={Share2}
              title={scopedOrgName ? `Nothing shared with you from ${scopedOrgName} yet.` : "Nothing shared with you yet."}
              description="When someone invites you to a project in another organization, it shows up here."
            />
          ) : (
            <section data-testid="shared-with-you" className="rounded-2xl border divide-y">
              {sharedProjects.map((p) => {
                const orgLabel = p.orgName ?? (p.orgId != null ? `Org #${p.orgId}` : null)
                // AQU-696: new until the user has opened it (recorded on
                // project landing). Read synchronously — the page remounts on
                // navigation, so returning here after opening re-reads a fresh
                // "opened" record and drops the badge.
                const isNew = username
                  ? isProjectNew(p.grantedAt, readProjectOpenedAt(username, p.id))
                  : false
                return (
                  <Link
                    key={p.id}
                    to={`/projects/${p.id}`}
                    className="flex items-center gap-4 p-4 hover:bg-muted/50 transition-colors"
                  >
                    <p className="flex-1 min-w-0 truncate font-medium">{p.name}</p>
                    {isNew && (
                      <Badge className="shrink-0" data-testid="new-shared-badge">
                        New
                      </Badge>
                    )}
                    {orgLabel && (
                      <Badge variant="secondary" className="shrink-0 truncate">
                        {orgLabel}
                      </Badge>
                    )}
                    <RoleLabel name={p.role.name} className="shrink-0 text-xs text-muted-foreground" />
                  </Link>
                )
              })}
            </section>
          )}
        </div>
      }
    />
  )
}
