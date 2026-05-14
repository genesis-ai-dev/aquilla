import { BRANDS, BRAND_IDS } from "./brands"
import type { BrandId } from "./types"

export function isBrandId(value: string): value is BrandId {
  return (BRAND_IDS as string[]).includes(value)
}

export function resolveBrandId(): BrandId {
  const fromEnv = (import.meta.env.VITE_BRAND as string | undefined) ?? ""
  if (import.meta.env.DEV && typeof window !== "undefined") {
    const override = new URLSearchParams(window.location.search).get("brand")
    if (override && isBrandId(override)) return override
  }
  if (fromEnv && isBrandId(fromEnv)) return fromEnv
  if (fromEnv) console.warn(`[branding] unknown VITE_BRAND="${fromEnv}"; falling back to aquilla`)
  return "aquilla"
}

export const brandId = resolveBrandId()
export const brand = BRANDS[brandId]
