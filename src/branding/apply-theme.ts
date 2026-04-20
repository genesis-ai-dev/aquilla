import type { Brand } from "./types"
import { buildBrandThemeStyle } from "./theme-vars"

const DYNAMIC_STYLE_ID = "brand-theme-dynamic"

export function applyTheme(brand: Brand): void {
  const root = document.documentElement
  root.setAttribute("data-brand", brand.id)

  let style = document.getElementById(DYNAMIC_STYLE_ID) as HTMLStyleElement | null
  if (!style) {
    style = document.createElement("style")
    style.id = DYNAMIC_STYLE_ID
    document.head.appendChild(style)
  }
  style.textContent = buildBrandThemeStyle(brand.theme)

  if (brand.typography?.sansFamily) {
    root.style.setProperty("--font-sans", brand.typography.sansFamily)
  }
  if (brand.typography?.headingFamily) {
    root.style.setProperty("--font-heading", brand.typography.headingFamily)
  }
}
