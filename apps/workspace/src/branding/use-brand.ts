import { createContext, useContext } from "react"
import type { Brand } from "./types"

export const BrandContext = createContext<Brand | null>(null)

export function useBrand(): Brand {
  const brand = useContext(BrandContext)
  if (!brand) throw new Error("useBrand must be used inside a <BrandProvider>")
  return brand
}
