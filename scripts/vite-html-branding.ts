import type { Plugin } from "vite"
import type { BrandData } from "../apps/workspace/src/branding/types"
import { buildBrandThemeStyle } from "../apps/workspace/src/branding/theme-vars"

export function brandingHtmlPlugin(brand: BrandData): Plugin {
  return {
    name: "branding-html",
    transformIndexHtml(html: string) {
      const styleTag = `<style id="brand-theme">${buildBrandThemeStyle(brand.theme)}</style>`
      const ogImagePath = brand.deploy?.ogImage ?? brand.logo.faviconHref
      const ogImage = absolutize(ogImagePath, brand.deploy?.domain)
      const ogUrl = brand.deploy?.domain ? `https://${brand.deploy.domain}/` : ""
      return html
        .replace(/%BRAND_TITLE%/g, escapeHtml(brand.app.htmlTitle))
        .replace(/%BRAND_DESCRIPTION%/g, escapeHtml(brand.app.description))
        .replace(/%BRAND_FAVICON%/g, escapeHtml(brand.logo.faviconHref))
        .replace(/%BRAND_OG_IMAGE%/g, escapeHtml(ogImage))
        .replace(/%BRAND_OG_URL%/g, escapeHtml(ogUrl))
        .replace(/%BRAND_THEME_STYLE%/g, styleTag)
    },
  }
}

function absolutize(path: string, domain: string | undefined): string {
  if (!domain) return path
  if (/^https?:\/\//i.test(path)) return path
  const trimmed = path.startsWith("/") ? path : `/${path}`
  return `https://${domain}${trimmed}`
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}
