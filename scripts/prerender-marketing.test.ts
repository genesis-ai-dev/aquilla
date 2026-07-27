import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { BRAND_DATA } from "../src/branding/brands/data"
import {
  DISALLOWED_APP_PATHS,
  MARKETING_PAGES,
  MIN_CRAWLABLE_TEXT,
  buildJsonLd,
  buildRobotsTxt,
  buildSitemap,
  crawlerView,
  injectHeadMeta,
  injectPrerenderedMarkup,
  missingAssets,
  readPageMeta,
} from "./prerender-marketing"

const ORIGIN = "https://aquilla.app"
const brand = BRAND_DATA.aquilla
const homepage = MARKETING_PAGES.find((p) => p.entry === "homepage")!
const caseStudy = MARKETING_PAGES.find((p) => p.entry === "case-study")!

/**
 * Shape of a built marketing page: branding placeholders resolved, and the
 * entry script hoisted into <head> by vite — the stub in #root is the only
 * thing in the body.
 */
function builtHtml(): string {
  return [
    "<!doctype html>",
    '<html lang="en">',
    "  <head>",
    '    <meta name="description" content="Aquilla — translators, lifted." />',
    "    <title>Aquilla</title>",
    '    <meta property="og:url" content="https://aquilla.app/" />',
    '    <script type="module" crossorigin src="/assets/homepage-abc.js"></script>',
    "  </head>",
    "  <body>",
    '    <div id="root">',
    '      <main class="aq-pre">',
    "        <h1>Translation, <em>lifted.</em></h1>",
    '        <div class="row"><a href="/onboarding">Create account</a></div>',
    "      </main>",
    "    </div>",
    "  </body>",
    "</html>",
  ].join("\n")
}

describe("injectPrerenderedMarkup", () => {
  it("replaces the mount stub with the prerendered page", () => {
    const out = injectPrerenderedMarkup(builtHtml(), '<div class="aq-root">real page</div>')
    expect(out).not.toContain('class="aq-pre"')
    expect(out).toContain('<div id="aq-prerender"><div class="aq-root">real page</div></div>')
  })

  it("consumes the whole stub, not just up to its first nested </div>", () => {
    const out = injectPrerenderedMarkup(builtHtml(), "<p>real</p>")
    expect(out).not.toContain("Create account")
    expect(out).toContain("</body>")
    // #root is still a single well-formed element around the shell.
    expect(out).toContain('<div id="root"><div id="aq-prerender">')
  })

  it("keeps the client entry script so React still takes over", () => {
    const out = injectPrerenderedMarkup(builtHtml(), "<div>x</div>")
    expect(out).toContain('<script type="module" crossorigin src="/assets/homepage-abc.js"></script>')
  })

  it("stamps the visitor's theme onto the prerendered markup before it paints", () => {
    const out = injectPrerenderedMarkup(builtHtml(), '<div class="aq-root">x</div>')
    expect(out).toContain("aq-home-theme")
    expect(out).toContain("#aq-prerender .aq-root")
    // The stamp patches markup above it, so it has to come after.
    expect(out.indexOf("aq-home-theme")).toBeGreaterThan(out.indexOf('id="aq-prerender"'))
  })

  it("fails loudly rather than shipping an unprerendered page", () => {
    expect(() => injectPrerenderedMarkup("<html><body></body></html>", "<div>x</div>")).toThrow()
    expect(() => injectPrerenderedMarkup('<div id="root"><div>', "<div>x</div>")).toThrow(/unbalanced/)
  })
})

describe("injectHeadMeta", () => {
  it("adds a canonical URL for the page's own path", () => {
    const out = injectHeadMeta(builtHtml(), caseStudy, brand, ORIGIN)
    expect(out).toContain('<link rel="canonical" href="https://aquilla.app/case-studies/come-and-see" />')
  })

  it("canonicalises the homepage to / rather than its /homepage alias", () => {
    const out = injectHeadMeta(builtHtml(), homepage, brand, ORIGIN)
    expect(out).toContain('<link rel="canonical" href="https://aquilla.app/" />')
  })

  it("points og:url at the page instead of the site root", () => {
    const out = injectHeadMeta(builtHtml(), caseStudy, brand, ORIGIN)
    expect(out).toContain('<meta property="og:url" content="https://aquilla.app/case-studies/come-and-see" />')
  })

  it("emits parseable JSON-LD inside head", () => {
    const out = injectHeadMeta(builtHtml(), homepage, brand, ORIGIN)
    const json = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(out)?.[1]
    expect(json).toBeTruthy()
    expect(() => JSON.parse(json!)).not.toThrow()
    expect(out.indexOf("ld+json")).toBeLessThan(out.indexOf("</head>"))
  })
})

describe("buildJsonLd", () => {
  const meta = readPageMeta(builtHtml())

  it("describes case studies as Articles", () => {
    const graph = JSON.parse(buildJsonLd(caseStudy, meta, brand, ORIGIN))["@graph"] as { "@type": string }[]
    expect(graph.map((n) => n["@type"])).toContain("Article")
  })

  it("describes the homepage as the product, not an article", () => {
    const graph = JSON.parse(buildJsonLd(homepage, meta, brand, ORIGIN))["@graph"] as { "@type": string }[]
    const types = graph.map((n) => n["@type"])
    expect(types).toContain("SoftwareApplication")
    expect(types).toContain("Organization")
    expect(types).not.toContain("Article")
  })

  it("escapes markup from page copy so it can't close the JSON-LD tag early", () => {
    const html = builtHtml().replace(
      'content="Aquilla — translators, lifted."',
      'content="a</script><script>alert(1)</script>b"',
    )
    const out = injectHeadMeta(html, caseStudy, brand, ORIGIN)
    const embedded = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(out)![1]
    expect(embedded).not.toContain("<")
    expect(JSON.parse(embedded)["@graph"][1].description).toContain("</script>")
  })
})

describe("crawlerView", () => {
  it("reads the stub as too thin to ship", () => {
    // The pre-change page: this is exactly what the build must now reject.
    expect(crawlerView(builtHtml()).text.length).toBeLessThan(MIN_CRAWLABLE_TEXT)
  })

  it("counts the prerendered page as readable", () => {
    const markup = `<div class="aq-root"><h1>Translators, lifted.</h1><p>${"copy ".repeat(400)}</p></div>`
    const full = injectPrerenderedMarkup(injectHeadMeta(builtHtml(), homepage, brand, ORIGIN), markup)
    const view = crawlerView(full)
    expect(view.text.length).toBeGreaterThan(MIN_CRAWLABLE_TEXT)
    expect(view.headings).toBe(1)
    expect(view.canonical).toBe("https://aquilla.app/")
    expect(view.jsonLd).toBe(true)
  })

  it("does not count script or style text as readable copy", () => {
    const noise = `<script>${"x".repeat(5000)}</script><style>${"y".repeat(5000)}</style>`
    expect(crawlerView(`<html><body>${noise}<p>hi</p></body></html>`).text).toBe("hi")
  })
})

describe("missingAssets", () => {
  const markup = '<img src="/assets/mark-CzbQ.svg"/><link href="/assets/mark-CzbQ.svg"/><i style="background:url(/assets/grain-XY.png)"></i>'

  it("passes when every referenced asset exists in the client build", () => {
    expect(missingAssets(markup, () => true)).toEqual([])
  })

  it("catches a hash that drifted between the SSR and client builds", () => {
    const missing = missingAssets(markup, (p) => p !== "/assets/grain-XY.png")
    expect(missing).toEqual(["/assets/grain-XY.png"])
  })
})

describe("sitemap.xml", () => {
  const xml = buildSitemap(MARKETING_PAGES, ORIGIN, { homepage: "2026-07-01" })

  it("lists every indexable marketing page", () => {
    for (const page of MARKETING_PAGES.filter((p) => p.indexable)) {
      expect(xml).toContain(`<loc>${ORIGIN}${page.path}</loc>`)
    }
  })

  it("omits the unlisted BT landing page", () => {
    expect(xml).not.toContain("/bible-translation")
  })

  it("omits alias paths so they don't compete with the canonical URL", () => {
    expect(xml).not.toContain("<loc>https://aquilla.app/homepage</loc>")
  })

  it("emits lastmod only where a date is known", () => {
    expect(xml).toContain("<lastmod>2026-07-01</lastmod>")
    expect(xml.match(/<lastmod>/g)).toHaveLength(1)
  })
})

describe("robots.txt", () => {
  const txt = buildRobotsTxt(MARKETING_PAGES, ORIGIN)

  it("points crawlers at the sitemap", () => {
    expect(txt).toContain(`Sitemap: ${ORIGIN}/sitemap.xml`)
  })

  it("keeps crawlers out of the client-rendered app routes", () => {
    for (const path of DISALLOWED_APP_PATHS) expect(txt).toContain(`Disallow: ${path}`)
  })

  it("keeps the unlisted BT landing page out of search", () => {
    expect(txt).toContain("Disallow: /bible-translation")
  })

  it("leaves the indexable marketing pages crawlable", () => {
    expect(txt).not.toContain("Disallow: /beta")
    expect(txt).not.toContain("Disallow: /case-studies")
  })
})

// The manifest decides what gets prerendered, canonicalised, and listed in the
// sitemap; worker/index.ts decides what URL actually serves each file. A page
// present in one and missing from the other is a silently broken URL.
describe("worker STATIC_PAGES parity", () => {
  const workerSrc = readFileSync(resolve(__dirname, "../worker/index.ts"), "utf8")
  const block = /const STATIC_PAGES[^{]*\{([\s\S]*?)\n\}/.exec(workerSrc)?.[1] ?? ""
  const served = [...block.matchAll(/"([^"]+)":\s*"([^"]+)"/g)].map(([, path, asset]) => ({ path, asset }))

  it("parses the worker's route table", () => {
    expect(served.length).toBeGreaterThan(0)
  })

  it("prerenders every statically-served page", () => {
    for (const { asset } of served) {
      expect(MARKETING_PAGES.map((p) => `/${p.entry}.html`)).toContain(asset)
    }
  })

  it("agrees with the worker on which URL serves each page", () => {
    for (const { path, asset } of served) {
      const page = MARKETING_PAGES.find((p) => `/${p.entry}.html` === asset)!
      expect([page.path, ...(page.aliases ?? [])]).toContain(path)
    }
  })

  it("serves the homepage at its canonical / route", () => {
    // `/` is not in STATIC_PAGES — the worker branches on the aq_hint cookie.
    expect(workerSrc).toContain('"/homepage.html"')
    expect(homepage.path).toBe("/")
  })
})
