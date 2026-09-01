// AQU-1042 — option derivation and exact-match narrowing for the Projects
// toolbar's viewer-role filter.

import { describe, it, expect } from "vitest"
import {
  ROLE_FILTER_ALL,
  filterByRole,
  resolveRoleFilter,
  roleFilterFor,
  roleFilterNames,
} from "./project-role-filter"

type Row = { id: string }

const row = (id: string): Row => ({ id })

/** Role lookup as the page holds it: project id → the viewer's role there. */
function lookup(entries: Record<string, string | null>) {
  return new Map(
    Object.entries(entries).map(([id, name]) => [id, name ? { name } : null] as const),
  )
}

describe("roleFilterNames", () => {
  it("lists exactly the roles present, deduped and in ladder order", () => {
    const roles = lookup({
      a: "owner",
      b: "viewer",
      c: "project_lead",
      d: "viewer",
      e: null,
    })
    expect(roleFilterNames([row("a"), row("b"), row("c"), row("d"), row("e")], roles)).toEqual([
      "viewer",
      "project_lead",
      "owner",
    ])
  })

  it("offers a non-canonical role too, after the ladder — the column shows it", () => {
    const roles = lookup({ a: "owner", b: "mystery_role", c: "viewer" })
    expect(roleFilterNames([row("a"), row("b"), row("c")], roles)).toEqual([
      "viewer",
      "owner",
      "mystery_role",
    ])
  })

  it("returns nothing to offer when no loaded row has a role", () => {
    expect(roleFilterNames([row("a"), row("b")], lookup({ a: null }))).toEqual([])
    expect(roleFilterNames([row("a")], undefined)).toEqual([])
  })
})

describe("filterByRole", () => {
  const roles = lookup({
    gospels: "owner",
    ruth: "contributor",
    acts: null,
    psalms: "owner",
  })
  const rows = [row("gospels"), row("ruth"), row("acts"), row("psalms")]

  it("passes every row through on the 'all' default — roleless rows included", () => {
    expect(filterByRole(rows, roles, ROLE_FILTER_ALL).map((r) => r.id)).toEqual([
      "gospels",
      "ruth",
      "acts",
      "psalms",
    ])
  })

  it("keeps only rows where the viewer holds the selected role", () => {
    expect(filterByRole(rows, roles, roleFilterFor("owner")).map((r) => r.id)).toEqual([
      "gospels",
      "psalms",
    ])
  })

  it("excludes roleless ('—') rows from every specific role, without throwing", () => {
    expect(filterByRole(rows, roles, roleFilterFor("contributor")).map((r) => r.id)).toEqual([
      "ruth",
    ])
    expect(filterByRole([row("unknown-id")], roles, roleFilterFor("owner"))).toEqual([])
  })

  it("yields an empty list (not a throw) when nothing matches", () => {
    expect(filterByRole(rows, roles, roleFilterFor("maintainer"))).toEqual([])
    expect(filterByRole(rows, undefined, roleFilterFor("owner"))).toEqual([])
  })

  it("composes with pre-applied status/PM narrowing — it only ever narrows", () => {
    const alreadyNarrowed = [rows[0], rows[2]]
    expect(filterByRole(alreadyNarrowed, roles, roleFilterFor("owner")).map((r) => r.id)).toEqual([
      "gospels",
    ])
  })

  it("cannot confuse a role literally named 'all' with the sentinel", () => {
    const odd = lookup({ x: "all", y: null })
    expect(filterByRole([row("x"), row("y")], odd, roleFilterFor("all")).map((r) => r.id)).toEqual([
      "x",
    ])
  })
})

describe("resolveRoleFilter", () => {
  it("keeps a selection that is still offered", () => {
    expect(resolveRoleFilter(roleFilterFor("owner"), ["viewer", "owner"])).toBe("role:owner")
  })

  it("falls back to 'all' once the role leaves the loaded rows", () => {
    expect(resolveRoleFilter(roleFilterFor("owner"), ["viewer"])).toBe(ROLE_FILTER_ALL)
    expect(resolveRoleFilter(roleFilterFor("owner"), [])).toBe(ROLE_FILTER_ALL)
  })

  it("leaves the 'all' default alone", () => {
    expect(resolveRoleFilter(ROLE_FILTER_ALL, [])).toBe(ROLE_FILTER_ALL)
  })
})
