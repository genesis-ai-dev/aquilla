/**
 * AQU-2324: the one door from an older roster (Members, a team, a project's
 * Members pane, a Language lane) into People & access, opened on that place or
 * filter. The old surface keeps its own controls where the access page cannot
 * yet do the same thing for the same people; this link is what makes the new
 * page the obvious place to go.
 *
 * Only an organization member gets it: OrgRouteGate sends a guest (project-only
 * access) from `/orgs/:id/access` back to the org's projects, so a link there
 * would land them somewhere else. Who may open the page is unchanged.
 */
import { KeyRound } from "lucide-react"
import { Link } from "react-router-dom"

import { buttonVariants } from "@/components/ui/button"
import { useActiveOrgOptional } from "@/context/OrgContext"
import { useT } from "@/lib/i18n/I18nProvider"
import { orgAccessPath } from "@/lib/navigation/org-paths"
import { cn } from "@/lib/utils"

export function ManageAccessLink({
  orgId,
  open,
  variant = "button",
  className,
  onNavigate,
}: {
  orgId: number | null | undefined
  open?: Parameters<typeof orgAccessPath>[1]
  /** `link` is a plain underlined link, for tight spots such as a popover. */
  variant?: "button" | "link"
  className?: string
  /** Called on click, e.g. to close the popover the link sits in. */
  onNavigate?: () => void
}) {
  const t = useT()
  // Optional: Project Settings and the lane popover also render outside an
  // org shell. No org context means membership is unknown, so no door.
  const orgs = useActiveOrgOptional()?.orgs ?? []
  if (orgId == null || !orgs.some((o) => o.id === orgId)) return null
  return (
    <Link
      to={orgAccessPath(orgId, open)}
      data-testid="manage-access-link"
      onClick={onNavigate}
      className={cn(
        variant === "button"
          ? cn(buttonVariants({ variant: "outline", size: "sm" }), "shrink-0")
          : "inline-flex items-center gap-1 font-medium text-foreground underline underline-offset-2",
        className,
      )}
    >
      <KeyRound className={variant === "button" ? "size-4" : "size-3"} aria-hidden />
      {t("org.access.manage")}
    </Link>
  )
}
