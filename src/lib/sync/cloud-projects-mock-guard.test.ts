// AQU-1357 guard — every test that stubs `@/lib/sync/cloud-projects` must do it
// as a PARTIAL mock (`async (importActual) => ({ ...(await importActual()), … })`).
//
// Why this exists. `cloud-projects` is a wide module reached indirectly: a test
// renders OrgProjectsPage, which renders OrgProjectsDataTable, which pulls
// `lib/offline/download`, which reads `resolveCloudProjectResult` at module
// scope. A hand-written `vi.mock` factory listing only the two or three exports
// the test cares about therefore breaks the moment anyone adds an export that
// some transitive import touches — and it breaks at COLLECTION, so the file
// reports "no tests run" rather than a failed assertion.
//
// That is exactly what happened: `resolveCloudProjectResult` landed, and four
// OrgProjectsPage suites stopped running on `dev` while still looking like a
// green-ish "0 tests" line. Eight more org suites carried the same stale factory
// and were one import away from the same fate. AQU-1339 was the same defect on a
// different module.
//
// Spreading the real module removes the whole class: a new export is present by
// default, and the test still overrides precisely what it wants to control. It
// is safe here because `cloud-projects.ts` is side-effect free at module scope —
// it only declares types and functions.
//
// If this guard fails, do NOT add the missing export to the factory by hand.
// Convert the factory instead:
//
//   vi.mock("@/lib/sync/cloud-projects", async (importActual) => ({
//     ...(await importActual<typeof import("@/lib/sync/cloud-projects")>()),
//     fetchAccessibleProjectsResult: vi.fn(...),
//   }))

import { describe, it, expect } from "vitest"
import * as fs from "node:fs"
import * as path from "node:path"

const SRC = path.resolve(__dirname, "../..")
const MODULE_SPECIFIER = "@/lib/sync/cloud-projects"

/** `vi.mock("@/lib/sync/cloud-projects"` with either quote style. */
const MOCK_CALL = new RegExp(
  String.raw`vi\.mock\(\s*["']` + MODULE_SPECIFIER.replace(/\//g, "\\/") + String.raw`["']`,
  "g",
)

/**
 * The partial-mock signature, checked against the text right after the module
 * specifier. `importOriginal` is vitest's other name for the same helper.
 */
const PARTIAL_FACTORY = /^\s*,\s*async\s*\(\s*(importActual|importOriginal)\s*\)/

/** This file quotes the pattern it looks for, so it must not scan itself. */
const SELF = path.resolve(__filename)

function collectTestFiles(dir: string, results: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) collectTestFiles(full, results)
    else if (entry.isFile() && /\.test\.tsx?$/.test(entry.name) && full !== SELF) {
      results.push(full)
    }
  }
  return results
}

describe("cloud-projects mock guard (AQU-1357)", () => {
  it("every vi.mock of @/lib/sync/cloud-projects is a partial mock", () => {
    const offenders: string[] = []

    for (const file of collectTestFiles(SRC)) {
      const source = fs.readFileSync(file, "utf8")
      for (const match of source.matchAll(MOCK_CALL)) {
        const after = source.slice(match.index + match[0].length, match.index + match[0].length + 120)
        if (PARTIAL_FACTORY.test(after)) continue
        const line = source.slice(0, match.index).split("\n").length
        offenders.push(`${path.relative(SRC, file)}:${line}`)
      }
    }

    expect(offenders, [
      `These tests stub ${MODULE_SPECIFIER} with a hand-written factory that will`,
      "stop collecting the next time the module gains an export. Spread the real",
      "module instead — see the comment at the top of this file.",
    ].join(" ")).toEqual([])
  })

  it("finds the mocks it is guarding (the scan itself still works)", () => {
    // A rename or a moved directory could silently reduce this guard to a no-op.
    const matches = collectTestFiles(SRC).filter((f) =>
      fs.readFileSync(f, "utf8").includes(`vi.mock("${MODULE_SPECIFIER}"`),
    )
    expect(matches.length).toBeGreaterThan(20)
  })
})
