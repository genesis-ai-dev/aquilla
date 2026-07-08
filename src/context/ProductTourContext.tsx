/**
 * FRO-243: Context that exposes the product tour controller to any subtree.
 *
 * The ProductTour component itself is mounted in App.tsx (top-level, so it
 * renders as a portal into document.body regardless of routing). This context
 * lets any nested component (e.g. OrgSidebar's "Take the tour" button) call
 * openTour() without prop-drilling.
 */

import { createContext, useContext, type ReactNode } from "react"
import { ProductTour, useProductTourController } from "@/components/onboarding/ProductTour"
import { useActiveOrg } from "@/context/OrgContext"

interface ProductTourContextValue {
  /** Opens the tour (re-launch or programmatic). */
  openTour: () => void
}

const ProductTourContext = createContext<ProductTourContextValue>({
  openTour: () => { /* no-op outside provider */ },
})

export function useProductTourContext(): ProductTourContextValue {
  return useContext(ProductTourContext)
}

interface Props {
  children: ReactNode
}

/**
 * Wraps the app with the tour controller and renders the ProductTour portal.
 * Mount once at the top of the React tree (inside App).
 */
export function ProductTourProvider({ children }: Props) {
  const [open, openTour, closeTour] = useProductTourController()
  // AQU-512: this is an org-level tour (org-switcher, org nav, org settings),
  // so gate PM-only steps on the org role rather than the active *project*
  // role — a translator can be a project_lead on one project and still be a
  // plain contributor at the org they're currently viewing.
  const { activeOrg } = useActiveOrg()
  const roleLevel = activeOrg?.role.level ?? null
  // SWARM-TODO(AQU-512): verify live — log in as a CONTRIBUTOR-level org
  // member, open the tour (sidebar "Take the tour"), confirm the "Settings &
  // members" step is skipped; log in as PROJECT_LEAD+ and confirm it appears.
  // Note: OrgSidebar currently only renders the nav-settings `data-tour`
  // anchor for role >= MAINTAINER (600) (`isAdmin` in OrgSidebar.tsx), one
  // rung above this gate's PROJECT_LEAD (500) floor — so PROJECT_LEAD (500)
  // callers pass the role check here but the step still gets dropped by the
  // existing DOM-anchor check (anchor absent). Flagged, not fixed here:
  // OrgSidebar.tsx is out of scope for this ticket.

  return (
    <ProductTourContext.Provider value={{ openTour }}>
      {children}
      <ProductTour open={open} onClose={closeTour} roleLevel={roleLevel} />
    </ProductTourContext.Provider>
  )
}
