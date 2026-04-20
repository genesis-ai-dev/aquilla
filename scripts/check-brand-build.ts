import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { BRAND_DATA } from "../src/branding/brands/data"
import type { BrandId } from "../src/branding/types"

const brandId = (process.argv[2] ?? "codex") as BrandId
const brand = BRAND_DATA[brandId]
if (!brand) {
  console.error(`[check-brand-build] unknown brand: ${brandId}`)
  process.exit(1)
}

const html = readFileSync(resolve(process.cwd(), "dist/index.html"), "utf8")

const checks: Array<[string, boolean]> = [
  [`<title>${brand.app.htmlTitle}</title>`, html.includes(`<title>${brand.app.htmlTitle}</title>`)],
  [`favicon href ${brand.logo.faviconHref}`, html.includes(brand.logo.faviconHref)],
  [`primary token ${brand.theme.light.primary}`, html.includes(brand.theme.light.primary)],
]

let ok = true
for (const [name, pass] of checks) {
  console.log(`${pass ? "✓" : "✗"} ${name}`)
  if (!pass) ok = false
}
if (!ok) process.exit(1)
console.log(`[check-brand-build] ${brandId} OK`)
