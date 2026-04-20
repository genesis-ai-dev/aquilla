import { useEffect, useState, type ReactNode } from "react"
import type { Brand } from "./types"
import { BRANDS } from "./brands"
import { resolveBrandId, isBrandId } from "./current-brand"
import { applyTheme } from "./apply-theme"
import { BrandContext } from "./use-brand"

export function BrandProvider({ children }: { children: ReactNode }) {
  const [brand, setBrand] = useState<Brand>(() => BRANDS[resolveBrandId()])

  useEffect(() => {
    if (!import.meta.env.DEV) return
    const recheck = () => {
      const override = new URLSearchParams(window.location.search).get("brand")
      if (override !== null && isBrandId(override) && override !== brand.id) {
        const next = BRANDS[override]
        applyTheme(next)
        setBrand(next)
      }
    }
    window.addEventListener("popstate", recheck)
    return () => window.removeEventListener("popstate", recheck)
  }, [brand.id])

  return <BrandContext.Provider value={brand}>{children}</BrandContext.Provider>
}
