import type { Plugin } from "vite"
import type { BrandData } from "../src/branding/types.ts"
import { buildBrandThemeStyle } from "../src/branding/theme-vars.ts"

export function brandingHtmlPlugin(brand: BrandData): Plugin {
  return {
    name: "branding-html",
    transformIndexHtml(html: string) {
      const styleTag = `<style id="brand-theme">${buildBrandThemeStyle(brand.theme)}</style>`
      const ogUrl = brand.deploy?.domain ? `https://${brand.deploy.domain}/` : ""
      // Only emit social-image tags when the brand ships a real raster image.
      // SVG favicons (the old fallback) are rejected by most link unfurlers, so
      // a brand without an ogImage gets no og:image and the lighter summary card.
      const ogImagePath = brand.deploy?.ogImage
      const socialImageTags = ogImagePath ? buildSocialImageTags(brand, ogImagePath) : ""
      const twitterCard = ogImagePath ? "summary_large_image" : "summary"
      const iconTags = buildIconTags(brand)
      return html
        .replace(/%BRAND_TITLE%/g, escapeHtml(brand.app.htmlTitle))
        .replace(/%BRAND_NAME%/g, escapeHtml(brand.app.name))
        .replace(/%BRAND_DESCRIPTION%/g, escapeHtml(brand.app.description))
        .replace(/%BRAND_FAVICON%/g, escapeHtml(brand.logo.faviconHref))
        .replace(/%BRAND_ICON_TAGS%/g, iconTags)
        .replace(/%BRAND_OG_URL%/g, escapeHtml(ogUrl))
        .replace(/%BRAND_TWITTER_CARD%/g, twitterCard)
        .replace(/%BRAND_SOCIAL_IMAGE_TAGS%/g, socialImageTags)
        .replace(/%BRAND_THEME_STYLE%/g, styleTag)
    },
  }
}

// PNG fallbacks for browsers/contexts that don't render SVG favicons (e.g.
// Safari's apple-touch-icon). Only emitted for brands that ship them.
function buildIconTags(brand: BrandData): string {
  const lines: string[] = []
  if (brand.logo.icon32) {
    lines.push(`<link rel="icon" type="image/png" sizes="32x32" href="${escapeHtml(brand.logo.icon32)}" />`)
  }
  if (brand.logo.appleTouchIcon) {
    lines.push(`<link rel="apple-touch-icon" href="${escapeHtml(brand.logo.appleTouchIcon)}" />`)
  }
  return lines.join("\n    ")
}

function buildSocialImageTags(brand: BrandData, ogImagePath: string): string {
  const url = escapeHtml(absolutize(ogImagePath, brand.deploy?.domain))
  const alt = escapeHtml(brand.deploy?.ogImageAlt ?? brand.app.description)
  const w = brand.deploy?.ogImageWidth
  const h = brand.deploy?.ogImageHeight
  const dims =
    w && h
      ? `    <meta property="og:image:width" content="${w}" />\n` +
        `    <meta property="og:image:height" content="${h}" />\n`
      : ""
  return (
    `<meta property="og:image" content="${url}" />\n` +
    dims +
    `    <meta property="og:image:alt" content="${alt}" />\n` +
    `    <meta name="twitter:image" content="${url}" />\n` +
    `    <meta name="twitter:image:alt" content="${alt}" />`
  )
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
