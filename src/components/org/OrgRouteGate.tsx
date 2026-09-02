/**
 * Gate for `/orgs/:orgId/...` — path is authoritative.
 * Unknown / inaccessible org ids stay on the URL with a not-found / no-access
 * state (no silent fallback to last-org localStorage).
 *
 * FRO-367: not-found / error chrome still mounts AccountSwitcher. Switching
 * accounts in another tab can land this tab on an org the new account can't
 * access; without the switcher the user has no way to see who they are or
 * switch back without a reload (and the cross-tab account-menu assertion has
 * nowhere to land). Loading must not use that header chrome — it flashes a
 * second profile in the navbar before the destination sidebar switcher
 * appears.
 *
 * AQU-1046: with no session at all, the gate must not classify membership from
 * the (empty) org lists and fall through to not-found — that painted
 * "Organization not found" plus a stray "Log in" in the gate chrome for a user
 * who just logged out on `/orgs/:id`. Signed-out visitors get the canonical
 * `SignedOutWorkspace` (route-preserving sign-in link) before any org check,
 * matching OrgHome / OrgOverview / ProjectOverview / ProjectWorkspace.
 */
import type { ReactNode } from "react"
import { Link, Navigate, Outlet, useLocation, useParams } from "react-router-dom"
import { AlertTriangle } from "lucide-react"
import { useActiveOrg } from "@/context/OrgContext"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { orgKeyFromParam, ALL_ORGS_PARAM, orgHomePath, orgProjectsPath, parseOrgPath } from "@/lib/navigation/org-paths"
import { AccountSwitcher } from "@/components/AccountSwitcher"
import { Button } from "@/components/ui/button"
import { NotFoundIcon } from "@/components/ui/empty"
import { LoadingOverlay } from "@/components/ui/loading-overlay"
import { useT } from "@/lib/i18n/I18nProvider"
import { OrgBreadcrumb } from "./OrgBreadcrumb"
import { SignedOutWorkspace } from "./SignedOutWorkspace"

export function OrgRouteGate() {
  const t = useT()
  const { orgId: orgIdParam } = useParams<{ orgId: string }>()
  const orgKey = orgKeyFromParam(orgIdParam)
  const { orgs, guestOrgs, isLoading, accessibleProjectsLoading, error } = useActiveOrg()
  const { session, loading: sessionLoading } = useFrontierSession()
  const jwt = session?.jwt ?? null
  const location = useLocation()

  // Signed-out state: session finished loading but no JWT. Membership can't be
  // judged from empty org lists, and the not-found / error chrome is for
  // signed-in users who really lack access. Sign-in keeps the current path.
  if (!sessionLoading && !jwt) {
    return <SignedOutWorkspace header={<OrgBreadcrumb section="Overview" isProjectsLanding />} />
  }

  // `/orgs/all` is a sibling route — this gate only mounts for `:orgId`.
  if (orgKey == null || orgKey === ALL_ORGS_PARAM) {
    return <OrgAccessProblem reason="invalid" />
  }

  if (isLoading) {
    return <LoadingOverlay label={t("org.routeGate.loading")} data-testid="org-route-loading" />
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
      return <LoadingOverlay label={t("org.routeGate.loading")} data-testid="org-route-loading" />
    }
    return <OrgAccessProblem reason="missing" orgId={orgKey} />
  }

  // AQU-790: a guest has project-level access only — the org's member-only tool
  // routes (members/settings/teams/archived/assigned) don't apply. Keep them
  // out of the guest overview even via a typed URL. `/projects` is the guest
  // org's real home, matching a member org's projects table.
  const rest = parseOrgPath(location.pathname)?.rest ?? ""
  if (isGuest && rest !== "" && rest !== "/projects") {
    return <Navigate to={orgProjectsPath(orgKey)} replace />
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
  const t = useT()
  const title =
    reason === "error"
      ? t("org.routeGate.errorTitle")
      : reason === "invalid"
        ? t("org.routeGate.invalidTitle")
        : t("org.routeGate.missingTitle")
  const body =
    reason === "error"
      ? (detail ?? t("org.routeGate.errorFallbackBody"))
      : reason === "invalid"
        ? t("org.routeGate.invalidBody")
        : t("org.routeGate.missingBody", { orgId: orgId ?? "" })

  return (
    <OrgGateChrome>
      <div className="flex flex-col items-center justify-center gap-4 px-6 text-center">
        <div className="text-muted-foreground">
          {reason === "error" ? (
            <AlertTriangle className="h-10 w-10" aria-hidden />
          ) : (
            <NotFoundIcon className="h-10 w-10" aria-hidden />
          )}
        </div>
        <div className="space-y-2">
          <h1 className="text-lg font-medium">{title}</h1>
          <p className="max-w-md text-sm text-muted-foreground">{body}</p>
        </div>
        <Button nativeButton={false} render={<Link to={orgHomePath(ALL_ORGS_PARAM)} />}>
          {t("org.breadcrumb.allOrganizations")}
        </Button>
      </div>
    </OrgGateChrome>
  )
}

/** Minimal chrome so not-found / error still expose the account menu.
 *  Full OrgSidebar is wrong here — it would render member nav for an org
 *  the caller cannot access. Loading uses LoadingOverlay instead so a
 *  header profile does not flash before the destination sidebar. */
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
