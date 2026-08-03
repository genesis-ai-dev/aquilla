/**
 * Gate for `/orgs/:orgId/...` — path is authoritative.
 * Unknown / inaccessible org ids stay on the URL with a not-found / no-access
 * state (no silent fallback to last-org localStorage).
 */
import { Link, Outlet, useParams } from "react-router-dom"
import { useActiveOrg } from "@/context/OrgContext"
import { orgKeyFromParam, ALL_ORGS_PARAM, orgHomePath } from "@/lib/navigation/org-paths"
import { Button } from "@/components/ui/button"

export function OrgRouteGate() {
  const { orgId: orgIdParam } = useParams<{ orgId: string }>()
  const orgKey = orgKeyFromParam(orgIdParam)
  const { orgs, guestOrgs, isLoading, error } = useActiveOrg()

  // `/orgs/all` is a sibling route — this gate only mounts for `:orgId`.
  if (orgKey == null || orgKey === ALL_ORGS_PARAM) {
    return <OrgAccessProblem reason="invalid" />
  }

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center text-sm text-muted-foreground">
        Loading…
      </div>
    )
  }

  if (error) {
    return <OrgAccessProblem reason="error" detail={error} />
  }

  const known =
    orgs.some((o) => o.id === orgKey) || guestOrgs.some((o) => o.id === orgKey)
  if (!known) {
    return <OrgAccessProblem reason="missing" orgId={orgKey} />
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
    <div className="flex h-screen flex-col items-center justify-center gap-4 px-6 text-center">
      <div className="space-y-2">
        <h1 className="text-lg font-medium">{title}</h1>
        <p className="max-w-md text-sm text-muted-foreground">{body}</p>
      </div>
      <Button nativeButton={false} render={<Link to={orgHomePath(ALL_ORGS_PARAM)} />}>
        All organizations
      </Button>
    </div>
  )
}
