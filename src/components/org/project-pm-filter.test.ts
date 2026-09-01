// AQU-1040 — option derivation and exact-match narrowing for the Projects
// toolbar's designated-PM filter.

import { describe, it, expect } from "vitest"
import {
  PM_FILTER_ALL,
  PM_FILTER_UNASSIGNED,
  filterByPm,
  hasUnassignedPm,
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
})
