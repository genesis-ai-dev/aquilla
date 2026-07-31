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

describe("the prerendered page is identity-independent", () => {
  // The Worker serves one copy of this page to every visitor and lets the edge
  // cache it, so the prerendered markup must not encode who is asking.
  // AppEntryBanner does that in the browser after mount instead.
  const html = renderToStaticMarkup(marketingPageElement("homepage"))

  it("points 'open app' at the workspace entry, not at / or /login", () => {
    expect(html).toContain('href="/app"')
    // `/` is this very page — linking there would bounce the user in a circle.
    expect(html).not.toMatch(/href="\/"[^>]*>[^<]*open app/i)
  })

  it("carries no signed-in banner", () => {
    expect(html).not.toContain("aq-appentry")
    expect(html).not.toMatch(/welcome back/i)
  })

  it("reads no browser identity state while rendering", () => {
    // There is no document, cookie, or IndexedDB in Node. A page that needed
    // any of them to render would throw here rather than at deploy time.
    expect(html.length).toBeGreaterThan(5000)
  })
})
