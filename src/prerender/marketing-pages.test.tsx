import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { MARKETING_PAGE_IDS, marketingPageElement } from "./marketing-pages"

/**
 * The prerendered fallback is what crawlers, AI answer engines, and link
 * unfurlers see, so "it renders without JS" is the contract — not an
 * optimisation. A page that throws or degrades to a stub here would still
 * build; these assertions are what makes that a test failure.
 *
 * The build-time step (scripts/prerender-marketing.ts) renders these same
 * elements in Node, where there is no DOM at all.
 */
describe.each(MARKETING_PAGE_IDS)("%s renders without a browser", (id) => {
  const html = renderToStaticMarkup(marketingPageElement(id))

  it("emits the page, not a placeholder", () => {
    expect(html.length).toBeGreaterThan(5000)
    expect(html).toContain('class="aq-root"')
  })

  it("puts a single h1 in the markup", () => {
    expect(html.match(/<h1[\s>]/g) ?? []).toHaveLength(1)
  })

  it("ships body copy a crawler can read", () => {
    const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
    expect(text.length).toBeGreaterThan(1500)
  })

  it("links onward instead of dead-ending", () => {
    expect(html).toMatch(/<a [^>]*href="\/(onboarding|login|beta|homepage)/)
  })
})

describe("signed-out fallback", () => {
  it("renders the homepage's signed-out call to action", () => {
    // hasAuthHintCookie() has no cookie to read at build time; the prerendered
    // page must therefore be the signed-out variant, never a stale "open app"
    // link pointing signed-out visitors into the workspace.
    const html = renderToStaticMarkup(marketingPageElement("homepage"))
    expect(html).toContain('href="/login"')
  })
})
