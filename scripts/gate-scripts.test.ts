import { describe, expect, it } from "vitest"
import { engineProblems, lockedVersion, manifestProblems } from "./gate-deps.mjs"
import { planShape, shapeDiff } from "./gate-plan-diff.mjs"

const manifest = (over: Record<string, unknown> = {}) => ({
  name: "aquilla-sync-worker",
  scripts: { test: "vitest run" },
  dependencies: { hono: "^4.13.16", postgres: "3.4.9" },
  devDependencies: { vitest: "^5.1.0", "@electric-sql/pglite": "^0.5.15", typescript: "^5.9.2" },
  ...over,
})

// The gate lets a worker's dependency change ship with no person, so each
// row is a way a "version bump" could be something else.
describe("deps gate: manifestProblems", () => {
  it.each([
    ["a version bump", { dependencies: { hono: "^4.14.0", postgres: "3.4.9" } }],
    ["a new dependency", { dependencies: { hono: "^4.13.16", postgres: "3.4.9", zod: "~4.1.0" } }],
    ["a removed dependency", { dependencies: { hono: "^4.13.16" } }],
    ["a prerelease", { devDependencies: { vitest: "^5.1.0", "@electric-sql/pglite": "^0.5.15", typescript: "6.0.0-beta.1" } }],
  ])("passes %s", (_name, over) => {
    expect(manifestProblems(manifest(), manifest(over))).toEqual([])
  })

  it.each([
    ["a script", { scripts: { test: "true" } }, /`scripts` changed/],
    ["an override block", { pnpm: { overrides: { vitest: "npm:fake@1.0.0" } } }, /`pnpm` changed/],
    ["an alias", { dependencies: { hono: "npm:not-hono@4.13.16", postgres: "3.4.9" } }, /not a plain registry version/],
    ["a git source", { dependencies: { hono: "github:someone/hono", postgres: "3.4.9" } }, /not a plain registry version/],
    ["a file source", { dependencies: { hono: "file:../hono", postgres: "3.4.9" } }, /not a plain registry version/],
    ["the test runner", { devDependencies: { vitest: "^5.2.0", "@electric-sql/pglite": "^0.5.15", typescript: "^5.9.2" } }, /devDependencies\.vitest changed.*the gates run through it/],
    ["the test database", { devDependencies: { vitest: "^5.1.0", typescript: "^5.9.2" } }, /pglite changed \(\^0\.5\.15 → absent\)/],
  ])("holds %s", (_name, over, why) => {
    expect(manifestProblems(manifest(), manifest(over)).join("\n")).toMatch(why)
  })
})

describe("deps gate: the locked test engine", () => {
  const lock = (vitest: string, pglite = "0.5.15") => `lockfileVersion: '9.0'

importers:

  .:
    dependencies:
      hono:
        specifier: ^4.13.16
        version: 4.13.16
    devDependencies:
      '@electric-sql/pglite':
        specifier: ^0.5.15
        version: ${pglite}
      vitest:
        specifier: ^5.1.0
        version: ${vitest}

packages:

  vitest@9.9.9:
    resolution: {integrity: sha512-x}
`

  it("reads a direct dependency's resolved version, quoted name or not, and never a packages entry", () => {
    expect(lockedVersion(lock("5.1.0(@types/node@26.6.6)"), "vitest")).toBe("5.1.0(@types/node@26.6.6)")
    expect(lockedVersion(lock("5.1.0"), "@electric-sql/pglite")).toBe("0.5.15")
    expect(lockedVersion(lock("5.1.0"), "typescript")).toBeUndefined()
  })

  it("holds when a lockfile-only change moves the engine, or the version cannot be read", () => {
    expect(engineProblems(lock("5.1.0"), lock("5.1.0"))).toEqual([])
    expect(engineProblems(lock("5.1.0"), lock("5.1.1"))).toEqual(["vitest resolves to 5.1.1, the base to 5.1.0; the gates run through it"])
    expect(engineProblems(lock("5.1.0"), "lockfileVersion: '9.0'\n").join("\n")).toMatch(/cannot read the locked version of vitest/)
  })
})

// What the plan-diff gate compares, and how it says what moved.
describe("plan diff", () => {
  const plan = {
    openReleases: [],
    prCount: 3,
    cut: true,
    reason: "2 ready PR(s), 1 held, no release in flight",
    branch: "release/2026/11/19-01",
    base: "tagtip",
    prs: [
      { number: 1, sha: "a", mergedAt: "t", walk: "PASS", areas: [] },
      { number: 2, sha: "b", mergedAt: "t", walk: "unknown", areas: ["sync"] },
    ],
    held: [{ number: 3, sha: "c", mergedAt: "t", walk: "PASS", areas: ["infra"], why: "touches infra" }],
  }

  it("is silent when the same PRs are ready and held for the same reasons", () => {
    const sameDecision = { ...plan, prs: plan.prs.map((pr) => ({ ...pr, files: ["x"] })), walkPolicy: "fail-only" as const }
    expect(shapeDiff("plan", { ...planShape(plan) }, { ...planShape(sameDecision) })).toEqual([])
  })

  it("names each PR that moved between ready and held, and each changed reason", () => {
    const moved = { ...plan, reason: "1 ready PR(s), 2 held, no release in flight", prs: [plan.prs[0]], held: [...plan.held, { ...plan.prs[1], why: "walk unknown" }] }
    expect(shapeDiff("plan", { ...planShape(plan) }, { ...planShape(moved) })).toEqual([
      'plan.reason: base "2 ready PR(s), 1 held, no release in flight", PR "1 ready PR(s), 2 held, no release in flight"',
      "plan.ready: only the base has `#2 walk=unknown areas=sync`",
      "plan.held: only the PR has `#2 walk unknown`",
    ])
  })

  it("reports a reorder, which changes the picks' order on the branch", () => {
    expect(shapeDiff("cut", { picked: ["#1", "#2"] }, { picked: ["#2", "#1"] })).toEqual(["cut.picked: same entries, different order"])
  })
})
