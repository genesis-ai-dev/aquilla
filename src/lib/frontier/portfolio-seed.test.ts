// These seeds decide what a page paints before its own read answers. The
// rules that matter: they never cross accounts, and an org's full answer
// retires rows it no longer lists (an archived project must not keep painting
// last hour's progress on its overview).

import { beforeEach, describe, expect, it } from "vitest"
import type { PortfolioProject } from "./portfolio"
import {
  clearPortfolioSeeds,
  readDirectoryPageSeed,
  readOrgPortfolioSeed,
  readPortfolioRowSeed,
  forgetPortfolioProject,
  rememberDirectoryPage,
  rememberOrgPortfolio,
  rememberPortfolioRows,
} from "./portfolio-seed"

const row = (id: string, name = id) => ({ id, name }) as PortfolioProject

beforeEach(() => clearPortfolioSeeds())

describe("portfolio seeds", () => {
  it("hands a project's overview the row its list was showing", () => {
    rememberOrgPortfolio("jwt-a", 1, { projects: [row("p1", "Luke")], activeLanguageCount: 2 })
    expect(readPortfolioRowSeed("jwt-a", "p1")?.name).toBe("Luke")
    expect(readOrgPortfolioSeed("jwt-a", 1)?.activeLanguageCount).toBe(2)
  })

  it("never paints one account's portfolio for another", () => {
    rememberOrgPortfolio("jwt-a", 1, { projects: [row("p1")], activeLanguageCount: 1 })
    rememberDirectoryPage("jwt-a", "1", { projects: [row("p1")], nextCursor: null })
    expect(readPortfolioRowSeed("jwt-b", "p1")).toBeNull()
    expect(readOrgPortfolioSeed("jwt-b", 1)).toBeNull()
    expect(readDirectoryPageSeed("jwt-b", "1")).toBeNull()
    // The other account's first answer drops everything the first one left.
    rememberPortfolioRows("jwt-b", [row("p9")])
    expect(readPortfolioRowSeed("jwt-a", "p1")).toBeNull()
    expect(readOrgPortfolioSeed("jwt-a", 1)).toBeNull()
  })

  it("retires a row the org's next full answer no longer lists", () => {
    rememberOrgPortfolio("jwt-a", 1, { projects: [row("p1"), row("p2")], activeLanguageCount: 1 })
    rememberOrgPortfolio("jwt-a", 1, { projects: [row("p2")], activeLanguageCount: 1 })
    expect(readPortfolioRowSeed("jwt-a", "p1")).toBeNull()
    expect(readPortfolioRowSeed("jwt-a", "p2")).not.toBeNull()
  })

  it("keeps another org's rows when one org answers", () => {
    rememberOrgPortfolio("jwt-a", 1, { projects: [row("p1")], activeLanguageCount: 1 })
    rememberOrgPortfolio("jwt-a", 2, { projects: [row("p2")], activeLanguageCount: 1 })
    rememberOrgPortfolio("jwt-a", 1, { projects: [], activeLanguageCount: 0 })
    expect(readPortfolioRowSeed("jwt-a", "p2")).not.toBeNull()
  })

  it("drops one refused project from the list paint, the org summary, and the row", () => {
    const alpha = row("alpha", "PMR Alpha")
    const beta = row("beta", "Beta Notes")
    rememberDirectoryPage("jwt-a", "7", { projects: [alpha, beta], nextCursor: "c1" })
    rememberOrgPortfolio("jwt-a", 7, { projects: [alpha, beta], activeLanguageCount: 2 })
    rememberDirectoryPage("jwt-a", "7,8", { projects: [alpha], nextCursor: null })

    forgetPortfolioProject("jwt-a", "alpha")

    expect(readDirectoryPageSeed("jwt-a", "7")).toEqual({ projects: [beta], nextCursor: "c1" })
    expect(readDirectoryPageSeed("jwt-a", "7,8")).toEqual({ projects: [], nextCursor: null })
    expect(readOrgPortfolioSeed("jwt-a", 7)?.projects).toEqual([beta])
    expect(readPortfolioRowSeed("jwt-a", "alpha")).toBeNull()
    expect(readPortfolioRowSeed("jwt-a", "beta")).not.toBeNull()
  })

  it("remembers the directory's first page with its cursor", () => {
    rememberDirectoryPage("jwt-a", "1,2", { projects: [row("p1")], nextCursor: "c1" })
    expect(readDirectoryPageSeed("jwt-a", "1,2")).toEqual({ projects: [row("p1")], nextCursor: "c1" })
    expect(readDirectoryPageSeed("jwt-a", "1")).toBeNull()
  })
})
