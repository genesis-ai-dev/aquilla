import { useEffect, useState, type ReactNode } from "react"
import type { Brand, BrandId } from "./types"
import { BRANDS, BRAND_IDS } from "./brands"
import { applyTheme } from "./apply-theme"
import { BrandContext } from "./use-brand"

function isBrandId(value: string | null): value is BrandId {
  return value !== null && (BRAND_IDS as string[]).includes(value)
}

function resolveBrandId(): BrandId {
  const fromEnv = (import.meta.env.VITE_BRAND as string | undefined) ?? ""
  if (import.meta.env.DEV && typeof window !== "undefined") {
    const override = new URLSearchParams(window.location.search).get("brand")
    if (override && isBrandId(override)) return override
  }
  if (fromEnv && isBrandId(fromEnv)) return fromEnv
  return "codex"
}

export function BrandProvider({ children }: { children: ReactNode }) {
  const [brand, setBrand] = useState<Brand>(() => {
    const brandId = resolveBrandId()
    return BRANDS[brandId]
  })

  useEffect(() => {
    if (!import.meta.env.DEV) return
    const recheck = () => {
      const override = new URLSearchParams(window.location.search).get("brand")
      if (isBrandId(override) && override !== brand.id) {
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
