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

  return (
    <ProductTourContext.Provider value={{ openTour }}>
      {children}
      <ProductTour open={open} onClose={closeTour} />
    </ProductTourContext.Provider>
  )
}
