/**
 * Gate for `/orgs/:orgId/...` — path is authoritative.
 * Unknown / inaccessible org ids stay on the URL with a not-found / no-access
 * state (no silent fallback to last-org localStorage).
 *
 * FRO-367: every gate state still mounts AccountSwitcher. Switching accounts
 * in another tab can land this tab on an org the new account can't access;
 * without the switcher the user has no way to see who they are or switch back
 * without a reload (and the cross-tab account-menu assertion has nowhere to
 * land).
 */
import type { ReactNode } from "react"
import { Link, Navigate, Outlet, useLocation, useParams } from "react-router-dom"
import { useActiveOrg } from "@/context/OrgContext"
import { orgKeyFromParam, ALL_ORGS_PARAM, orgHomePath, parseOrgPath } from "@/lib/navigation/org-paths"
import { AccountSwitcher } from "@/components/AccountSwitcher"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"

export function OrgRouteGate() {
  const { orgId: orgIdParam } = useParams<{ orgId: string }>()
  const orgKey = orgKeyFromParam(orgIdParam)
  const { orgs, guestOrgs, isLoading, accessibleProjectsLoading, error } = useActiveOrg()
  const location = useLocation()

  // `/orgs/all` is a sibling route — this gate only mounts for `:orgId`.
  if (orgKey == null || orgKey === ALL_ORGS_PARAM) {
    return <OrgAccessProblem reason="invalid" />
  }

  if (isLoading) {
    return (
      <OrgGateChrome>
        <div className="flex items-center justify-center text-muted-foreground">
          <Spinner className="size-5" />
        </div>
      </OrgGateChrome>
    )
  }

  if (error) {
    return <OrgAccessProblem reason="error" detail={error} />
  }

  const isMember = orgs.some((o) => o.id === orgKey)
  const isGuest = !isMember && guestOrgs.some((o) => o.id === orgKey)
  if (!isMember && !isGuest) {
    // AQU-790: guest-org membership is derived from the app-wide project
    // directory. Until it loads we can't tell "not a guest org" from "directory
    // not fetched yet" — wait instead of flashing not-found on a guest reload.
    if (accessibleProjectsLoading) {
      return (
        <OrgGateChrome>
          <div className="flex items-center justify-center text-sm text-muted-foreground">
            Loading…
          </div>
        </OrgGateChrome>
      )
    }
    return <OrgAccessProblem reason="missing" orgId={orgKey} />
  }

  // AQU-790: a guest has project-level access only — the org's member-only tool
  // routes (members/settings/teams/archived/assigned) don't apply. Keep them
  // out of the guest overview even via a typed URL, rather than rendering a
  // member surface for an org they aren't a member of.
  if (isGuest && (parseOrgPath(location.pathname)?.rest ?? "") !== "") {
    return <Navigate to={orgHomePath(orgKey)} replace />
  }

  return <Outlet />
}

function OrgAccessProblem({
  reason,
  orgId,
  detail,
}: {
  reason: "invalid" | "missing" | "error"
  orgId?: number
  detail?: string
}) {
  const title =
    reason === "error"
      ? "Couldn’t load organizations"
      : reason === "invalid"
        ? "Invalid organization"
        : "Organization not found"
  const body =
    reason === "error"
      ? (detail ?? "Something went wrong loading your organizations.")
      : reason === "invalid"
        ? "That organization URL isn’t valid."
        : `You don’t have access to organization #${orgId}, or it doesn’t exist.`

  return (
    <OrgGateChrome>
      <div className="flex flex-col items-center justify-center gap-4 px-6 text-center">
        <div className="space-y-2">
          <h1 className="text-lg font-medium">{title}</h1>
          <p className="max-w-md text-sm text-muted-foreground">{body}</p>
        </div>
        <Button nativeButton={false} render={<Link to={orgHomePath(ALL_ORGS_PARAM)} />}>
          All organizations
        </Button>
      </div>
    </OrgGateChrome>
  )
}

/** Minimal chrome so gate states (loading / not-found / error) still expose
 *  the account menu. Full OrgSidebar is wrong here — it would render member
 *  nav for an org the caller cannot access. */
function OrgGateChrome({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-screen flex-col">
      <div className="flex justify-end border-b px-3 py-2">
        <div className="w-64">
          <AccountSwitcher variant="header" />
        </div>
      </div>
      <div className="flex flex-1 flex-col items-center justify-center">{children}</div>
    </div>
  )
}
