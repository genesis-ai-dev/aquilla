// AQU-1040 — option derivation and exact-match narrowing for the Projects
// toolbar's designated-PM filter.

import { describe, it, expect } from "vitest"
import {
  PM_FILTER_ALL,
  PM_FILTER_MINE,
  PM_FILTER_UNASSIGNED,
  filterByPm,
  hasUnassignedPm,
  isManagedBy,
  pmFilterFor,
  pmFilterUsernames,
  resolvePmFilter,
} from "./project-pm-filter"

type Row = { id: string; pm?: { id: number; username: string } | null }

const withPm = (id: string, username: string, userId = 1): Row => ({
  id,
  pm: { id: userId, username },
})
const withoutPm = (id: string): Row => ({ id, pm: null })

describe("pmFilterUsernames", () => {
  it("lists exactly the PMs present, deduped and case-insensitively ordered", () => {
    const rows = [
      withPm("a", "zoe", 3),
      withPm("b", "anna", 1),
      withPm("c", "Anna", 1),
      withoutPm("d"),
      withPm("e", "mark", 2),
    ]
    expect(pmFilterUsernames(rows)).toEqual(["anna", "mark", "zoe"])
  })

  it("returns nothing to offer when no loaded row has a PM", () => {
    expect(pmFilterUsernames([withoutPm("a"), { id: "b" }])).toEqual([])
  })

  // AQU-1027: the viewer is reachable through the pinned "Managed by me"
  // option, so listing them by name too would show the same person twice.
  it("drops the viewer from the named options, case-insensitively", () => {
    const rows = [withPm("a", "Anna", 1), withPm("b", "mark", 2), withPm("c", "zoe", 3)]
    expect(pmFilterUsernames(rows, "anna")).toEqual(["mark", "zoe"])
  })

  it("lists everyone when no viewer is given, or the viewer manages nothing", () => {
    const rows = [withPm("a", "anna", 1), withPm("b", "mark", 2)]
    expect(pmFilterUsernames(rows)).toEqual(["anna", "mark"])
    expect(pmFilterUsernames(rows, "  ")).toEqual(["anna", "mark"])
    expect(pmFilterUsernames(rows, "zoe")).toEqual(["anna", "mark"])
  })
})

describe("isManagedBy", () => {
  it("matches the designated PM case-insensitively", () => {
    expect(isManagedBy(withPm("a", "Anna"), "anna")).toBe(true)
    expect(isManagedBy(withPm("a", "anna"), "ANNA")).toBe(true)
    expect(isManagedBy(withPm("a", "anna"), " anna ")).toBe(true)
  })

  it("is false for another PM, and for a row with no PM at all", () => {
    const pmFieldAbsent: Row = { id: "c" }
    expect(isManagedBy(withPm("a", "mark", 2), "anna")).toBe(false)
    expect(isManagedBy(withoutPm("b"), "anna")).toBe(false)
    expect(isManagedBy(pmFieldAbsent, "anna")).toBe(false)
  })

  // Identity is a username compare because FrontierSession carries no user id;
  // a missing viewer must therefore match nothing, never everything.
  it("is false when there is no signed-in viewer", () => {
    expect(isManagedBy(withPm("a", "anna"), null)).toBe(false)
    expect(isManagedBy(withPm("a", "anna"), undefined)).toBe(false)
    expect(isManagedBy(withPm("a", "anna"), "")).toBe(false)
    expect(isManagedBy(withPm("a", "anna"), "   ")).toBe(false)
  })
})

describe("hasUnassignedPm", () => {
  it("is true when a row has no PM (null or absent) and false otherwise", () => {
    expect(hasUnassignedPm([withPm("a", "anna"), withoutPm("b")])).toBe(true)
    expect(hasUnassignedPm([withPm("a", "anna"), { id: "b" }])).toBe(true)
    expect(hasUnassignedPm([withPm("a", "anna"), withPm("b", "mark", 2)])).toBe(false)
  })
})

describe("filterByPm", () => {
  const rows = [
    withPm("a", "anna"),
    withPm("b", "annabel", 2),
    withoutPm("c"),
    withPm("d", "Anna", 1),
  ]

  it("passes every row through on the 'all' default", () => {
    expect(filterByPm(rows, PM_FILTER_ALL).map((r) => r.id)).toEqual(["a", "b", "c", "d"])
  })

  it("matches the PM exactly — 'anna' does not pull in 'annabel'", () => {
    expect(filterByPm(rows, pmFilterFor("anna")).map((r) => r.id)).toEqual(["a", "d"])
  })

  it("keeps only PM-less rows for Unassigned — the case search cannot express", () => {
    expect(filterByPm(rows, PM_FILTER_UNASSIGNED).map((r) => r.id)).toEqual(["c"])
  })

  it("yields an empty list (not a throw) when nothing matches", () => {
    expect(filterByPm(rows, pmFilterFor("nobody"))).toEqual([])
  })

  it("composes with a pre-applied status filter — it only ever narrows", () => {
    const stalled = [rows[0], rows[2]]
    expect(filterByPm(stalled, pmFilterFor("anna")).map((r) => r.id)).toEqual(["a"])
  })

  it("treats a PM literally named 'all' as a PM, not the sentinel", () => {
    const odd = [withPm("x", "all"), withoutPm("y")]
    expect(filterByPm(odd, pmFilterFor("all")).map((r) => r.id)).toEqual(["x"])
  })

  it("narrows to the viewer's own projects under 'mine'", () => {
    expect(filterByPm(rows, PM_FILTER_MINE, "anna").map((r) => r.id)).toEqual(["a", "d"])
  })

  it("matches nothing — not everything — when 'mine' has no signed-in viewer", () => {
    expect(filterByPm(rows, PM_FILTER_MINE, null)).toEqual([])
    expect(filterByPm(rows, PM_FILTER_MINE)).toEqual([])
  })

  it("treats a PM literally named 'mine' as a PM, not the sentinel", () => {
    const odd = [withPm("x", "mine"), withPm("y", "anna", 2)]
    expect(filterByPm(odd, pmFilterFor("mine"), "anna").map((r) => r.id)).toEqual(["x"])
  })
})

describe("resolvePmFilter", () => {
  it("keeps a selection that is still offered", () => {
    expect(resolvePmFilter(pmFilterFor("anna"), ["anna", "mark"], true)).toBe("pm:anna")
    expect(resolvePmFilter(PM_FILTER_UNASSIGNED, ["anna"], true)).toBe(PM_FILTER_UNASSIGNED)
  })

  it("falls back to 'all' once the PM leaves the loaded rows", () => {
    expect(resolvePmFilter(pmFilterFor("anna"), ["mark"], true)).toBe(PM_FILTER_ALL)
  })

  it("falls back to 'all' once every row has a PM", () => {
    expect(resolvePmFilter(PM_FILTER_UNASSIGNED, ["anna"], false)).toBe(PM_FILTER_ALL)
  })

  it("leaves the 'all' default alone", () => {
    expect(resolvePmFilter(PM_FILTER_ALL, [], false)).toBe(PM_FILTER_ALL)
  })

  // AQU-1027, the regression this branch exists to prevent: asking for "my
  // projects" and being shown all of them instead of an honest empty table.
  it("keeps 'mine' even when the viewer manages none of the loaded rows", () => {
    expect(resolvePmFilter(PM_FILTER_MINE, ["mark"], true, "anna")).toBe(PM_FILTER_MINE)
    expect(resolvePmFilter(PM_FILTER_MINE, [], false, "anna")).toBe(PM_FILTER_MINE)
  })

  it("clears 'mine' only when there is no signed-in viewer to resolve it to", () => {
    expect(resolvePmFilter(PM_FILTER_MINE, ["anna"], true, null)).toBe(PM_FILTER_ALL)
    expect(resolvePmFilter(PM_FILTER_MINE, ["anna"], true)).toBe(PM_FILTER_ALL)
  })

  // The viewer is excluded from the named options, so a stale pm:<viewer>
  // selection resolves to the identity option instead of snapping to "all".
  it("normalizes a stale 'pm:<viewer>' selection to 'mine'", () => {
    expect(resolvePmFilter(pmFilterFor("Anna"), ["mark"], true, "anna")).toBe(PM_FILTER_MINE)
  })
})
