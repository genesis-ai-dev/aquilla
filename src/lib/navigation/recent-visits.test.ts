import { describe, it, expect } from "vitest"
import {
  MAX_RECENT_VISITS,
  parseRecentEntity,
  recentTitleFromNavTitle,
  renameRecentVisit,
  upsertRecentVisit,
  type RecentEntity,
} from "./recent-visits"

describe("parseRecentEntity", () => {
  it("tracks project overview and non-file workspace as the same project", () => {
    expect(parseRecentEntity("/projects/abc")).toEqual({
      kind: "project",
      id: "abc",
      homePath: "/projects/abc",
    })
    expect(parseRecentEntity("/project/abc/editor")).toEqual({
      kind: "project",
      id: "abc",
      homePath: "/projects/abc",
    })
    expect(parseRecentEntity("/project/abc/comments")).toEqual({
      kind: "project",
      id: "abc",
      homePath: "/projects/abc",
    })
  })

  it("tracks each editor file as its own recent entry", () => {
    expect(parseRecentEntity("/project/abc/editor/file/7")).toEqual({
      kind: "file",
      id: "abc:7",
      homePath: "/project/abc/editor/file/7",
    })
    expect(parseRecentEntity("/project/abc/editor/file/luke")).toEqual({
      kind: "file",
      id: "abc:luke",
      homePath: "/project/abc/editor/file/luke",
    })
  })

  it("tracks a specific team, not the teams list", () => {
    expect(parseRecentEntity("/orgs/7/teams")).toBeNull()
    expect(parseRecentEntity("/orgs/7/teams/42")).toEqual({
      kind: "team",
      id: "7:42",
      homePath: "/orgs/7/teams/42",
    })
    expect(parseRecentEntity("/orgs/7/teams/42/settings")).toEqual({
      kind: "team",
      id: "7:42",
      homePath: "/orgs/7/teams/42",
    })
  })

  it("ignores org-shell list and admin pages", () => {
    expect(parseRecentEntity("/orgs/7")).toBeNull()
    expect(parseRecentEntity("/orgs/7/assigned")).toBeNull()
    expect(parseRecentEntity("/orgs/7/members")).toBeNull()
    expect(parseRecentEntity("/orgs/7/settings")).toBeNull()
    expect(parseRecentEntity("/admin")).toBeNull()
    expect(parseRecentEntity("/shared")).toBeNull()
    expect(parseRecentEntity("/preferences")).toBeNull()
  })
})

describe("recentTitleFromNavTitle", () => {
  it("keeps the project name before the separator", () => {
    expect(recentTitleFromNavTitle("project", "Genesis · Editor")).toBe("Genesis")
    expect(recentTitleFromNavTitle("project", "Genesis")).toBe("Genesis")
  })

  it("keeps the file name after the separator", () => {
    expect(recentTitleFromNavTitle("file", "Genesis · Luke")).toBe("Luke")
    expect(recentTitleFromNavTitle("file", "Genesis · Matt · notes")).toBe("Matt · notes")
    expect(recentTitleFromNavTitle("file", "OrphanFile")).toBe("OrphanFile")
  })
})

describe("upsertRecentVisit", () => {
  it("moves a revisited entity to the front and caps at 15", () => {
    let recent: RecentEntity[] = []
    for (let i = 0; i < 20; i++) {
      recent = upsertRecentVisit(recent, {
        kind: "project",
        id: `p${i}`,
        pathname: `/projects/p${i}`,
        search: "",
        title: `Project ${i}`,
      })
    }
    expect(recent).toHaveLength(MAX_RECENT_VISITS)
    expect(recent[0]?.id).toBe("p19")

    recent = upsertRecentVisit(recent, {
      kind: "project",
      id: "p5",
      pathname: "/projects/p5",
      search: "",
      title: "Project 5 renamed",
    })
    expect(recent[0]?.id).toBe("p5")
    expect(recent[0]?.title).toBe("Project 5 renamed")
    expect(recent.filter((e) => e.id === "p5")).toHaveLength(1)
  })
})

describe("renameRecentVisit", () => {
  it("updates only the matching entity title", () => {
    const recent: RecentEntity[] = [
      {
        kind: "team",
        id: "7:1",
        pathname: "/orgs/7/teams/1",
        search: "",
        title: "Team",
        timestamp: 1,
      },
    ]
    const next = renameRecentVisit(recent, "team", "7:1", "Alpha")
    expect(next[0]?.title).toBe("Alpha")
  })
})
