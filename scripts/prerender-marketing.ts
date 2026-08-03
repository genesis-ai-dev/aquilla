/**
 * Build-time prerender for the standalone marketing pages.
 *
 * The workspace is a client-rendered SPA, so the marketing entries shipped a
 * hand-written stub hero in `#root` and left the real page (hero copy, feature
 * sections, case-study body) invisible to anything that doesn't run JS —
 * search crawlers that give up before hydration, AI answer engines, link
 * unfurlers, and no-JS visitors alike.
 *
 * This step runs after `vite build` and, for each marketing entry:
 *   1. renders the same React page to static HTML (Node, react-dom/server),
 *   2. injects it into `dist/<entry>.html` in place of the stub,
 *   3. adds the per-page canonical URL, a truthful `og:url`, and JSON-LD.
 *
 * It also writes `dist/sitemap.xml` and `dist/robots.txt` from the same page
 * manifest, so the crawl surface can't drift from what is actually built.
 *
 * The injected markup is a *fallback*, not a hydration target: the client
 * entries still call `createRoot()`, which clears `#root` and renders the live
 * page over it. That is deliberate — the live pages branch on browser-only
 * state (theme from `sessionStorage`, the `aq_hint` auth cookie) that cannot be
 * known at build time, and hydration would turn those into mismatches.
 *
 * Usage: `tsx scripts/prerender-marketing.ts [brand]` (see package.json build).
 */
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import react from "@vitejs/plugin-react"
import { renderToStaticMarkup } from "react-dom/server"
import { build } from "vite"
import { BRAND_DATA } from "../src/branding/brands/data"
import type { BrandData, BrandId } from "../src/branding/types"
import type { MarketingPageId } from "../src/prerender/pages"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")

// ─── Page manifest ────────────────────────────────────────────────────────
// `entry` is the vite build input key (→ dist/<entry>.html) AND the key in
// src/prerender/marketing-pages.tsx. `path` is the URL the aquilla-web Worker
// serves that file at — keep in sync with STATIC_PAGES in worker/index.ts
// (scripts/prerender-marketing.test.ts asserts the two agree).

export type PageKind = "site" | "article"

export interface MarketingPage {
  entry: MarketingPageId
  /** Canonical public path. */
  path: string
  /** Extra paths the Worker serves the same file at (canonicalised to `path`). */
  aliases?: string[]
  /** Listed in sitemap.xml. Unlisted pages are noindex or duplicate content. */
  indexable: boolean
  /** Relative sitemap priority. */
  priority: number
  kind: PageKind
  /** Source paths whose last commit date becomes the sitemap `lastmod`. */
  sources: string[]
}

export const MARKETING_PAGES: MarketingPage[] = [
  {
    entry: "homepage",
    path: "/",
    // The Worker serves homepage.html at `/` for signed-out visitors and at
    // `/homepage` unconditionally; `/` is canonical so the two don't compete.
    aliases: ["/homepage"],
    indexable: true,
    priority: 1,
    kind: "site",
    sources: ["homepage.html", "src/pages/Homepage/Homepage.tsx", "src/pages/Homepage/homepage.css"],
  },
  {
    entry: "beta",
    path: "/beta",
    indexable: true,
    priority: 0.7,
    kind: "site",
    sources: ["beta.html", "src/pages/Beta/BetaPage.tsx"],
  },
  {
    entry: "case-study",
    path: "/case-studies/come-and-see",
    indexable: true,
    priority: 0.8,
    kind: "article",
    sources: ["case-study.html", "src/pages/CaseStudy/ComeAndSee.tsx"],
  },
  {
    entry: "case-study-biblica",
    path: "/case-studies/biblica",
    indexable: true,
    priority: 0.8,
    kind: "article",
    sources: ["case-study-biblica.html", "src/pages/CaseStudy/Biblica.tsx"],
  },
  {
    // Indexed as of the 2026-07-31 SEO pass (dev), which superseded the
    // unlisted design in 2026-07-07-generic-homepage-bt-unlisted-design.md:
    // the noindex meta came out of its <head> and it joined the sitemap.
    entry: "bible-translation",
    path: "/bible-translation",
    indexable: true,
    priority: 0.9,
    kind: "site",
    sources: ["bible-translation.html", "src/pages/Homepage/BibleTranslationLanding.tsx"],
  },
]

/**
 * App routes that only ever render the SPA shell. They have nothing for a
 * crawler to read and several are private or single-use, so keep them out of
 * the crawl budget entirely.
 */
export const DISALLOWED_APP_PATHS = [
  "/admin",
  "/approve/",
  "/assigned",
  "/debug",
  "/join-org/",
  "/join/",
  "/link/",
  "/login",
  "/members",
  "/oauth/",
  "/onboarding",
  "/preferences",
  "/project/",
  "/projects",
  "/reset-password",
  "/settings",
  "/shared",
  "/teams",
  "/verify-email",
  "/__dev/",
  "/__marketing/",
]

/**
 * Floor for readable text in a shipped page. The old stub hero was ~230 chars;
 * the thinnest real page (/beta) is ~1900.
 */
export const MIN_CRAWLABLE_TEXT = 1200

// ─── HTML transforms (pure — unit-tested) ─────────────────────────────────

/** Escape a string for use inside a JSON-LD `<script>` body. */
function escapeJsonLd(json: string): string {
  // `</script>` inside a JSON string would close the tag early; `<!--` would
  // open an HTML comment. Both are legal JSON escapes.
  return json.replace(/</g, "\\u003c")
}

function extract(html: string, re: RegExp): string {
  return re.exec(html)?.[1]?.trim() ?? ""
}

/** Decode the handful of entities the branding plugin emits. */
function decodeEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
}

export interface PageMeta {
  title: string
  description: string
}

export function readPageMeta(html: string): PageMeta {
  return {
    title: decodeEntities(extract(html, /<title>([^<]*)<\/title>/)),
    description: decodeEntities(extract(html, /<meta name="description" content="([^"]*)"/)),
  }
}

/**
 * Structured data for one page. Search and AI answer engines lean on this to
 * decide what the page *is*; without it a client-rendered page is just a title.
 */
export function buildJsonLd(page: MarketingPage, meta: PageMeta, brand: BrandData, origin: string): string {
  const url = `${origin}${page.path}`
  const organization = {
    "@type": "Organization",
    "@id": `${origin}/#organization`,
    name: brand.app.name,
    url: `${origin}/`,
    ...(brand.deploy?.ogImage ? { logo: `${origin}${brand.deploy.ogImage}` } : {}),
    description: brand.app.description,
  }

  const graph: Record<string, unknown>[] = [organization]

  if (page.kind === "article") {
    graph.push({
      "@type": "Article",
      "@id": `${url}#article`,
      headline: meta.title,
      description: meta.description,
      url,
      isPartOf: { "@id": `${origin}/#website` },
      publisher: { "@id": `${origin}/#organization` },
      ...(brand.deploy?.ogImage ? { image: `${origin}${brand.deploy.ogImage}` } : {}),
    })
  } else {
    graph.push({
      "@type": "WebPage",
      "@id": `${url}#webpage`,
      name: meta.title,
      description: meta.description,
      url,
      isPartOf: { "@id": `${origin}/#website` },
    })
  }

  graph.push({
    "@type": "WebSite",
    "@id": `${origin}/#website`,
    name: brand.app.name,
    url: `${origin}/`,
    publisher: { "@id": `${origin}/#organization` },
  })

  if (page.path === "/") {
    graph.push({
      "@type": "SoftwareApplication",
      name: brand.app.name,
      applicationCategory: "BusinessApplication",
      operatingSystem: "Web, macOS, Windows",
      url: `${origin}/`,
      description: brand.app.description,
      publisher: { "@id": `${origin}/#organization` },
      // Free during the public beta — stated on /beta and the homepage.
      offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
    })
  }

  return JSON.stringify({ "@context": "https://schema.org", "@graph": graph })
}

/**
 * Add the canonical link and JSON-LD, and point `og:url` at this page rather
 * than the site root (the branding plugin stamps every page with the same
 * `%BRAND_OG_URL%`).
 */
export function injectHeadMeta(html: string, page: MarketingPage, brand: BrandData, origin: string): string {
  const url = `${origin}${page.path}`
  const meta = readPageMeta(html)
  const jsonLd = escapeJsonLd(buildJsonLd(page, meta, brand, origin))

  const out = html
    .replace(/(<meta property="og:url" content=")[^"]*(")/, `$1${url}$2`)
    // The source pages ship a hand-written canonical (added in dev's SEO
    // pass). The manifest-derived one below replaces it, so the built page
    // carries exactly one and a non-aquilla brand/origin can't inherit a
    // hardcoded aquilla.app URL.
    .replace(/[ \t]*<link rel="canonical"[^>]*\/?>\n?/g, "")

  const lines = [
    `<link rel="canonical" href="${url}" />`,
    `<script type="application/ld+json">${jsonLd}</script>`,
  ]

  const closing = /\n([ \t]*)<\/head>/.exec(out)
  if (!closing) throw new Error(`no </head> in ${page.entry}.html`)
  const indent = `${closing[1]}  `
  return out.replace(closing[0], `\n${indent}${lines.join(`\n${indent}`)}${closing[0]}`)
}

/**
 * Swap the hand-written stub in `#root` for the prerendered page.
 *
 * The wrapper element is what makes this safe to leave in the document: the
 * client's `createRoot()` clears `#root`, taking the wrapper, its scoped
 * animation reset, and the theme-stamp script with it.
 */
export function injectPrerenderedMarkup(html: string, markup: string): string {
  const open = '<div id="root">'
  const start = html.indexOf(open)
  if (start === -1) throw new Error("could not find the #root container to fill")

  // The stub nests divs, so find #root's own closing tag by depth rather than
  // by the first </div>.
  const from = start + open.length
  const tags = /<\/?div\b/gi
  tags.lastIndex = from
  let depth = 1
  let end = -1
  for (let m = tags.exec(html); m; m = tags.exec(html)) {
    depth += m[0][1] === "/" ? -1 : 1
    if (depth === 0) {
      end = m.index
      break
    }
  }
  if (end === -1) throw new Error("unbalanced markup: no closing tag for #root")

  const shell = `<div id="aq-prerender">${markup}</div>${THEME_STAMP_SCRIPT}`
  return html.slice(0, from) + shell + html.slice(end)
}

/**
 * Resolve the visitor's theme onto the prerendered markup before it paints.
 * The build can't know it, so React renders the dark default; this runs during
 * parse, ahead of the module scripts, and matches the inline pre-paint script
 * in the page `<head>` (same `aq-home-theme` key).
 */
const THEME_STAMP_SCRIPT =
  "<script>(function(){try{var t=sessionStorage.getItem('aq-home-theme')}catch(e){}" +
  "if(t!=='light'&&t!=='dark'){try{t=matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'}catch(e){t='dark'}}" +
  "var n=document.querySelector('#aq-prerender .aq-root');if(n)n.setAttribute('data-theme',t)})()</script>"

// ─── robots.txt / sitemap.xml ─────────────────────────────────────────────

export function buildRobotsTxt(pages: MarketingPage[], origin: string): string {
  const lines = ["User-agent: *"]
  for (const path of DISALLOWED_APP_PATHS) lines.push(`Disallow: ${path}`)
  for (const page of pages) {
    if (!page.indexable) lines.push(`Disallow: ${page.path}`)
  }
  lines.push("", `Sitemap: ${origin}/sitemap.xml`, "")
  return lines.join("\n")
}

export function buildSitemap(pages: MarketingPage[], origin: string, lastmod: Record<string, string>): string {
  const urls = pages
    .filter((p) => p.indexable)
    .map((p) => {
      const parts = [`    <loc>${origin}${p.path}</loc>`]
      if (lastmod[p.entry]) parts.push(`    <lastmod>${lastmod[p.entry]}</lastmod>`)
      parts.push(`    <priority>${p.priority.toFixed(1)}</priority>`)
      return `  <url>\n${parts.join("\n")}\n  </url>`
    })
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`
}

/**
 * Every `/assets/…` URL in the prerendered markup must exist in the client
 * build. The two builds hash asset content the same way today, but nothing
 * enforces that — and a drifted hash would show up only as a broken image in
 * the pre-mount paint, which is exactly the view nobody looks at.
 */
/**
 * What a crawler would take away from the shipped file, with no JS run.
 * `pnpm build` fails on anything that reads as an empty page, so a page that
 * silently stops prerendering can't ship looking fine to humans.
 */
export function crawlerView(html: string): { text: string; headings: number; canonical: string; jsonLd: boolean } {
  const body = /<body[^>]*>([\s\S]*)<\/body>/.exec(html)?.[1] ?? ""
  const visible = body.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ")
  return {
    text: visible.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
    headings: (visible.match(/<h1[\s>]/g) ?? []).length,
    canonical: /<link rel="canonical" href="([^"]*)"/.exec(html)?.[1] ?? "",
    jsonLd: html.includes('<script type="application/ld+json">'),
  }
}

export function missingAssets(markup: string, has: (path: string) => boolean): string[] {
  const refs = new Set([...markup.matchAll(/["'(](\/assets\/[^"')\s]+)/g)].map(([, p]) => p))
  return [...refs].filter((p) => !has(p))
}

/** Last commit date touching a page's sources, as an ISO date (best effort). */
function lastCommitDate(sources: string[]): string {
  try {
    const out = execFileSync("git", ["log", "-1", "--format=%cI", "--", ...sources], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim()
    return out ? out.slice(0, 10) : ""
  } catch {
    return ""
  }
}

// ─── Build driver ─────────────────────────────────────────────────────────

interface PrerenderModule {
  marketingPageElement(id: MarketingPageId): Parameters<typeof renderToStaticMarkup>[0]
}

/** Bundle src/prerender/marketing-pages.tsx for Node and return its module. */
async function bundlePages(brandId: BrandId, outDir: string) {
  await build({
    configFile: false,
    root: repoRoot,
    logLevel: "warn",
    define: {
      "import.meta.env.VITE_BRAND": JSON.stringify(brandId),
      "import.meta.env.VITE_BETA_FLAG": JSON.stringify(process.env.VITE_BETA_FLAG ?? "1"),
      __APP_VERSION__: JSON.stringify(""),
      __APP_BRANCH__: JSON.stringify(""),
      __APP_SHA__: JSON.stringify(""),
    },
    resolve: { alias: [{ find: "@", replacement: resolve(repoRoot, "src") }] },
    plugins: [react()],
    build: {
      ssr: true,
      outDir,
      emptyOutDir: true,
      minify: false,
      copyPublicDir: false,
      rolldownOptions: {
        input: resolve(repoRoot, "src/prerender/marketing-pages.tsx"),
        output: { entryFileNames: "marketing-pages.mjs", format: "esm" },
      },
    },
  })
  const mod = await import(pathToFileURL(resolve(outDir, "marketing-pages.mjs")).href)
  return mod as PrerenderModule
}

async function main(): Promise<void> {
  const brandId = (process.argv[2] ?? process.env.BRAND ?? "aquilla") as BrandId
  const brand = BRAND_DATA[brandId]
  if (!brand) {
    console.error(`[prerender] unknown brand: ${brandId}`)
    process.exit(1)
  }
  const domain = brand.deploy?.domain
  if (!domain) {
    console.log(`[prerender] brand ${brandId} has no deploy domain — skipping`)
    return
  }
  const origin = `https://${domain}`
  const dist = resolve(repoRoot, "dist")
  const ssrDir = resolve(repoRoot, "node_modules/.aquilla-prerender")

  const { marketingPageElement } = await bundlePages(brandId, ssrDir)

  const lastmod: Record<string, string> = {}
  for (const page of MARKETING_PAGES) {
    const file = resolve(dist, `${page.entry}.html`)
    if (!existsSync(file)) {
      console.error(`[prerender] missing build output: dist/${page.entry}.html`)
      process.exit(1)
    }
    const markup = renderToStaticMarkup(marketingPageElement(page.entry))
    if (markup.length < 1000) {
      // A near-empty render means the page threw or bailed to a boundary;
      // shipping that as the crawler's view of the site would be worse than
      // the stub it replaces.
      console.error(`[prerender] ${page.entry}: suspiciously small render (${markup.length} bytes)`)
      process.exit(1)
    }
    const missing = missingAssets(markup, (p) => existsSync(resolve(dist, p.slice(1))))
    if (missing.length) {
      console.error(`[prerender] ${page.entry}: markup references missing assets: ${missing.join(", ")}`)
      process.exit(1)
    }
    const html = readFileSync(file, "utf8")
    const out = injectPrerenderedMarkup(injectHeadMeta(html, page, brand, origin), markup)

    const view = crawlerView(out)
    const problems = [
      view.text.length < MIN_CRAWLABLE_TEXT && `only ${view.text.length} chars of readable text`,
      view.headings !== 1 && `${view.headings} <h1> elements (want exactly 1)`,
      view.canonical !== `${origin}${page.path}` && `canonical is "${view.canonical}"`,
      !view.jsonLd && "no JSON-LD",
    ].filter(Boolean)
    if (problems.length) {
      console.error(`[prerender] ${page.entry}.html would ship a thin page: ${problems.join("; ")}`)
      process.exit(1)
    }

    writeFileSync(file, out)
    lastmod[page.entry] = lastCommitDate(page.sources)
    console.log(
      `✓ ${page.entry}.html — ${(markup.length / 1024).toFixed(1)} kB markup, ${view.text.length} chars readable`,
    )
  }

  writeFileSync(resolve(dist, "sitemap.xml"), buildSitemap(MARKETING_PAGES, origin, lastmod))
  writeFileSync(resolve(dist, "robots.txt"), buildRobotsTxt(MARKETING_PAGES, origin))
  console.log(`✓ sitemap.xml + robots.txt (${origin})`)

  rmSync(ssrDir, { recursive: true, force: true })
}

// Only run when invoked directly — the unit tests import the pure helpers.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
