import type { Plugin } from "vite"
import type { BrandData } from "../src/branding/types"
import { buildBrandThemeStyle } from "../src/branding/theme-vars"

export function brandingHtmlPlugin(brand: BrandData): Plugin {
  return {
    name: "branding-html",
    transformIndexHtml(html: string) {
      const styleTag = `<style id="brand-theme">${buildBrandThemeStyle(brand.theme)}</style>`
      const ogImage = brand.deploy?.ogImage ?? brand.logo.faviconHref
      return html
        .replace(/%BRAND_TITLE%/g, escapeHtml(brand.app.htmlTitle))
        .replace(/%BRAND_DESCRIPTION%/g, escapeHtml(brand.app.description))
        .replace(/%BRAND_FAVICON%/g, escapeHtml(brand.logo.faviconHref))
        .replace(/%BRAND_OG_IMAGE%/g, escapeHtml(ogImage))
        .replace(/%BRAND_THEME_STYLE%/g, styleTag)
    },
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}
