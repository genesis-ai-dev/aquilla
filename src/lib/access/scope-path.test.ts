import { describe, expect, it } from "vitest"

import { formatScopePath, scopePathKey } from "./scope-path"
import type { ScopePath } from "./types"

const path: ScopePath = [
  { type: "org", id: "o1", name: "Biblica ETT" },
  { type: "team", id: "t1", name: "biblica/pattani-malay" },
  { type: "project", id: "p1", name: "Pattani Malay Bible" },
  { type: "lane", id: "l1", name: "French" },
]

describe("formatScopePath (AQU-1352 §3.9)", () => {
  it("spells the full path with the U+203A separator", () => {
    expect(formatScopePath(path)).toBe(
      "Biblica ETT › biblica/pattani-malay › Pattani Malay Bible › French",
    )
  })

  it("is byte-identical for equal paths — title, dialog header and grant chip must match (QA #9)", () => {
    const copy: ScopePath = path.map((s) => ({ ...s }))
    const a = formatScopePath(path)
    const b = formatScopePath(copy)
    expect(Buffer.from(a, "utf8").equals(Buffer.from(b, "utf8"))).toBe(true)
  })

  it("collapses ancestors a guest cannot see into one ellipsis crumb (rule 4)", () => {
    expect(formatScopePath(path.slice(0, 3), { truncateBefore: 2 })).toBe("… › Pattani Malay Bible")
  })

  it("ignores out-of-range truncation instead of throwing", () => {
    expect(formatScopePath(path, { truncateBefore: -1 })).toBe(formatScopePath(path))
    expect(formatScopePath([], { truncateBefore: 3 })).toBe("")
  })

  it("keys by id so a renamed scope keeps its identity", () => {
    const renamed = path.map((s) => (s.type === "org" ? { ...s, name: "Biblica" } : s))
    expect(scopePathKey(renamed)).toBe(scopePathKey(path))
    expect(scopePathKey(path)).toBe("org:o1/team:t1/project:p1/lane:l1")
  })
})
