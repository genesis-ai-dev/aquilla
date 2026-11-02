import type { ReactNode } from "react"
import { render } from "@testing-library/react"
import { BrandProvider } from "@/branding/BrandProvider"

/** Render standalone app pages with their real brand identity. */
export function renderWithBrand(ui: ReactNode) {
  return render(<BrandProvider>{ui}</BrandProvider>)
}
