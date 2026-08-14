import { describe, expect, it } from "vitest"
import { selectAffectedE2E } from "./lib/e2e-impact"

const specs = [
  "e2e/specs/auth/login-account-setup-status.smoke.spec.ts",
  "e2e/specs/collab/concurrent-edit.smoke.spec.ts",
  "e2e/specs/editor/import-and-edit.smoke.spec.ts",
  "e2e/specs/editor/search-keyboard-shortcut.smoke.spec.ts",
  "e2e/specs/editor/workspace-actions-dropdown.smoke.spec.ts",
  "e2e/specs/projects/project-settings-validation.smoke.spec.ts",
  "e2e/specs/projects/route-health.smoke.spec.ts",
  "e2e/specs/rules/violation.smoke.spec.ts",
]

describe("changed-file E2E impact selection", () => {
  it("runs a changed smoke spec directly", () => {
    expect(selectAffectedE2E([specs[3]], specs).specs).toEqual([specs[3]])
  })

  it("maps domain code to a sentinel and close filename matches", () => {
    expect(selectAffectedE2E([
      "src/components/ProjectSettings/ProjectSettingsValidation.tsx",
    ], specs).specs).toEqual([
      "e2e/specs/projects/project-settings-validation.smoke.spec.ts",
      "e2e/specs/projects/route-health.smoke.spec.ts",
    ])
  })

  it("maps sync-worker changes to the collaboration boundary", () => {
    expect(selectAffectedE2E(["sync-worker/src/events/commit.ts"], specs).specs).toContain(
      "e2e/specs/collab/concurrent-edit.smoke.spec.ts",
    )
  })

  it("uses core sentinels for unclassified runtime code", () => {
    expect(selectAffectedE2E(["src/context/AppContext.tsx"], specs).specs).toEqual([
      "e2e/specs/editor/workspace-actions-dropdown.smoke.spec.ts",
      "e2e/specs/projects/route-health.smoke.spec.ts",
    ])
  })

  it("does not boot a browser for docs and unit-test-only changes", () => {
    expect(selectAffectedE2E([
      "docs/E2E.md",
      "src/lib/search/search.test.ts",
    ], specs).specs).toEqual([])
  })

  it("runs core sentinels for harness changes instead of the whole suite", () => {
    expect(selectAffectedE2E(["scripts/e2e-up.ts"], specs).specs).toEqual([
      "e2e/specs/editor/workspace-actions-dropdown.smoke.spec.ts",
      "e2e/specs/projects/route-health.smoke.spec.ts",
    ])
  })
})

