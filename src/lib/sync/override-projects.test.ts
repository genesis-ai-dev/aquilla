// AQU-1938: reading the projects behind the org settings counts off the
// server's responses.
import { describe, it, expect, vi, afterEach } from "vitest"
import { parseOverrideProjectList } from "./override-projects"
import { fetchVisibilityOverrideCounts } from "./org-settings"

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("parseOverrideProjectList", () => {
  it("reads the server's shape", () => {
    expect(parseOverrideProjectList({ total: 3, projects: [{ id: "p1", name: "Genesis" }] }))
      .toEqual({ total: 3, projects: [{ id: "p1", name: "Genesis" }] })
  })

  it("is null when there is no list or it is not a list, so the line keeps its bare count", () => {
    for (const raw of [undefined, null, 3, "x", {}, { total: 2 }, { projects: [] }, { total: "2", projects: [] }]) {
      expect(parseOverrideProjectList(raw), JSON.stringify(raw)).toBeNull()
    }
  })

  it("drops an entry without a string id and name rather than showing a blank link", () => {
    expect(parseOverrideProjectList({
      total: 3,
      projects: [{ id: "p1", name: "Genesis" }, { id: 2, name: "Exodus" }, null, { id: "p3" }],
    })).toEqual({ total: 3, projects: [{ id: "p1", name: "Genesis" }] })
  })
})

describe("fetchVisibilityOverrideCounts", () => {
  const respond = (body: unknown) =>
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })))

  it("carries the projects the server names beside the counts", async () => {
    // The body GET /orgs/:id/settings/visibility-overrides sends (see
    // auth-worker org-override-projects.test.ts).
    respond({
      rosterViewMinRole: 2,
      memberProgressViewMinRole: 1,
      overrideProjects: {
        rosterViewMinRole: { total: 2, projects: [{ id: "p-tom", name: "Charlie" }] },
        memberProgressViewMinRole: { total: 1, projects: [] },
      },
    })
    expect(await fetchVisibilityOverrideCounts("jwt", 1, "https://api.test")).toEqual({
      rosterViewMinRole: 2,
      memberProgressViewMinRole: 1,
      overrideProjects: {
        rosterViewMinRole: { total: 2, projects: [{ id: "p-tom", name: "Charlie" }] },
        memberProgressViewMinRole: { total: 1, projects: [] },
      },
    })
  })

  it("from an older server that sends only counts, the lists are null", async () => {
    respond({ rosterViewMinRole: 2, memberProgressViewMinRole: 0 })
    expect(await fetchVisibilityOverrideCounts("jwt", 1, "https://api.test")).toEqual({
      rosterViewMinRole: 2,
      memberProgressViewMinRole: 0,
      overrideProjects: { rosterViewMinRole: null, memberProgressViewMinRole: null },
    })
  })
})
