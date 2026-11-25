import { describe, expect, it } from "vitest"

import { formatDenialScope, formatScopePath, scopePathKey, viaTeamName } from "./scope-path"
import type { ScopePath } from "./types"

const path: ScopePath = [
  { type: "org", id: "o1", name: "Biblica ETT" },
  { type: "team", id: "t1", name: "biblica/pattani-malay" },
  { type: "project", id: "p1", name: "Pattani Malay Bible" },
  { type: "lane", id: "l1", name: "French" },
]

describe("formatScopePath (AQU-2361)", () => {
  it("spells Organization › Project › Lane and leaves the team off the crumb", () => {
    expect(formatScopePath(path)).toBe("Biblica ETT › Pattani Malay Bible › French")
    expect(viaTeamName(path)).toBe("biblica/pattani-malay")
  })

  it("keeps a team name when the path is only a team", () => {
    expect(formatScopePath([{ type: "team", id: "t1", name: "Blue" }])).toBe("Blue")
    expect(formatScopePath([path[0], path[1]])).toBe("Biblica ETT")
  })

  it("is byte-identical for equal paths — title, dialog header and grant chip must match", () => {
    const copy: ScopePath = path.map((s) => ({ ...s }))
    const a = formatScopePath(path)
    const b = formatScopePath(copy)
    expect(Buffer.from(a, "utf8").equals(Buffer.from(b, "utf8"))).toBe(true)
  })

  it("collapses hidden ancestors into one ellipsis and never names a sibling lane", () => {
    const hidden: ScopePath = [
      { type: "org", id: "o1", name: "Secret Org", hidden: true },
      { type: "team", id: "t1", name: "Hidden Team", hidden: true },
      path[2],
      { type: "lane", id: "fr", name: "French" },
      { type: "lane", id: "es", name: "Spanish", hidden: true },
    ]
    expect(formatScopePath(hidden)).toBe("… › Pattani Malay Bible › French")
    expect(formatScopePath(hidden)).not.toContain("Secret Org")
    expect(formatScopePath(hidden)).not.toContain("Spanish")
    expect(formatScopePath(hidden)).not.toContain("Hidden Team")
    expect(viaTeamName(hidden)).toBeNull()
    expect(formatScopePath([])).toBe("")
  })

  it("formats a denial scope the same way, from strings or structured crumbs", () => {
    expect(formatDenialScope(["", "Alpha", "French"])).toBe("… › Alpha › French")
    expect(formatDenialScope([
      { type: "org", id: "o", name: "Secret Org", hidden: true },
      { type: "project", id: "p", name: "Alpha" },
      { type: "lane", id: "fr", name: "French" },
      { type: "lane", id: "es", name: "Spanish", hidden: true },
    ])).toBe("… › Alpha › French")
  })

  it("keys by id so a renamed scope keeps its identity", () => {
    const renamed = path.map((s) => (s.type === "org" ? { ...s, name: "Biblica" } : s))
    expect(scopePathKey(renamed)).toBe(scopePathKey(path))
    expect(scopePathKey(path)).toBe("org:o1/team:t1/project:p1/lane:l1")
  })
})
