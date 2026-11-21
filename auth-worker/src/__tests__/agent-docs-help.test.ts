// In-app help (AQU-2582): the docs tool's `help` topics. The help site is
// mocked at fetch. What matters: only index-listed pages are fetched, the
// changelog and the developer map never reach the model, an outage is text and
// not a throw, long pages are cut with a pointer, and other topics still come
// from the cookbooks.

import { describe, it, expect, afterEach, vi } from "vitest"
import { getHelpDocs, isHelpTopic, HELP_PAGE_MAX_CHARS } from "../lib/agent/help-docs"
import { getCookbook } from "../lib/agent/docs"

const SITE = "https://help.aquilla.app"
const INDEX_URL = `${SITE}/llms-index.json`

function entry(path: string, title: string, section: string, description = "") {
  const slug = path.replace(/^\/|\/$/g, "")
  return { path, title, description, section, url: `${SITE}${path}`, markdownUrl: `${SITE}/${slug}.md` }
}

const INDEX = {
  site: "Aquilla Help",
  pages: [
    entry("/export/", "Export a file", "Files", "Download a file."),
    entry("/roles/", "Roles", "Team", "What each role can do."),
    entry("/changelog/", "Changelog", "Updates", "Every release."),
    entry("/dev/map/", "Dev map", "Dev", "Internals."),
  ],
}

function mockSite(routes: Record<string, () => Response> = {}) {
  const all: Record<string, () => Response> = {
    [INDEX_URL]: () => Response.json(INDEX),
    [`${SITE}/export.md`]: () => new Response("# Export\n\nUse the file menu.", { status: 200 }),
    [`${SITE}/changelog.md`]: () => new Response("x".repeat(200_000), { status: 200 }),
    [`${SITE}/dev/map.md`]: () => new Response("# secret", { status: 200 }),
    ...routes,
  }
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const route = all[String(input)]
    return route ? route() : new Response("nope", { status: 404 })
  })
  vi.stubGlobal("fetch", fetchMock)
  return fetchMock
}
const urls = (m: ReturnType<typeof mockSite>) => m.mock.calls.map((c) => String(c[0]))

afterEach(() => vi.unstubAllGlobals())

describe("docs help topic", () => {
  it("lists pages by section, without the changelog or the developer map", async () => {
    mockSite()
    const r = await getHelpDocs({}, "help")
    expect(r.ok).toBe(true)
    expect(r.text).toContain("## Files\nhelp/export — Export a file: Download a file.")
    expect(r.text).toContain("## Team\nhelp/roles — Roles: What each role can do.")
    expect(r.text).toContain('docs({topic:"help/<path>"})')
    expect(r.text).not.toMatch(/changelog|dev\/map/i)
  })

  it("returns one page with its title and URL, and says to link it", async () => {
    const m = mockSite()
    const r = await getHelpDocs({}, "help/export")
    expect(r.ok).toBe(true)
    expect(r.text.startsWith(`# Export a file\n${SITE}/export/\n\n# Export\n\nUse the file menu.`)).toBe(true)
    expect(r.text).toContain(`give the user the page URL: ${SITE}/export/`)
    expect(urls(m)).toEqual([INDEX_URL, `${SITE}/export.md`])
  })

  it("names an unknown page and points back to the list", async () => {
    mockSite()
    const r = await getHelpDocs({}, "help/nope")
    expect(r.ok).toBe(false)
    expect(r.text).toContain('"nope"')
    expect(r.text).toContain('docs({topic:"help"})')
    expect(r.text).not.toContain("get_help")
  })

  it("returns text, not a throw, when the help site is down", async () => {
    mockSite({ [INDEX_URL]: () => new Response("down", { status: 503 }) })
    for (const topic of ["help", "help/export"]) {
      const r = await getHelpDocs({}, topic)
      expect(r.ok).toBe(false)
      expect(r.text).toContain("could not reach the help pages")
      expect(r.text).toContain(SITE)
    }
  })

  it("refuses the changelog before any fetch and gives its URL", async () => {
    const m = mockSite()
    for (const topic of ["help/changelog", "help/changelog/", `help/${SITE}/changelog/`]) {
      const r = await getHelpDocs({}, topic)
      expect(r.ok).toBe(false)
      expect(r.text).toContain(`${SITE}/changelog/`)
    }
    expect(m).not.toHaveBeenCalled()
  })

  it("never fetches a developer-map page", async () => {
    const m = mockSite()
    const r = await getHelpDocs({}, "help/dev/map")
    expect(r.ok).toBe(false)
    expect(urls(m)).not.toContain(`${SITE}/dev/map.md`)
  })

  it("cuts a long page at the cap and points to the full page", async () => {
    mockSite({ [`${SITE}/export.md`]: () => new Response("y".repeat(HELP_PAGE_MAX_CHARS + 500), { status: 200 }) })
    const r = await getHelpDocs({}, "help/export")
    expect(r.ok).toBe(true)
    expect(r.text).toContain("y".repeat(HELP_PAGE_MAX_CHARS))
    expect(r.text).not.toContain("y".repeat(HELP_PAGE_MAX_CHARS + 1))
    expect(r.text).toContain(`cut short. The rest is at ${SITE}/export/`)
  })

  it("routes only help topics here; cookbooks still answer the rest", () => {
    expect(isHelpTopic("help")).toBe(true)
    expect(isHelpTopic(" help/export ")).toBe(true)
    expect(isHelpTopic("helpful")).toBe(false)
    expect(isHelpTopic("checking")).toBe(false)
    expect(getCookbook("checking").ok).toBe(true)
    expect(getCookbook("nonsense").ok).toBe(false)
  })
})
