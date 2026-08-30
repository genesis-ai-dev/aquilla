import { describe, expect, it } from "vitest"
import { selectAffectedE2E } from "./lib/e2e-impact"
import {
  affectedRunMode,
  FAST_AFFECTED_SPEC_LIMIT,
  shouldWriteTestEnvFile,
} from "./lib/e2e-run-mode"

const specs = [
  "e2e/specs/ai/completion.smoke.spec.ts",
  "e2e/specs/auth/login-account-setup-status.smoke.spec.ts",
  "e2e/specs/auth/session-expired-banner.smoke.spec.ts",
  "e2e/specs/collab/concurrent-edit.smoke.spec.ts",
  "e2e/specs/editor/import-and-edit.smoke.spec.ts",
  "e2e/specs/editor/search.smoke.spec.ts",
  "e2e/specs/editor/workspace-actions-dropdown.smoke.spec.ts",
  "e2e/specs/projects/project-settings.smoke.spec.ts",
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
      "e2e/specs/projects/project-settings.smoke.spec.ts",
      "e2e/specs/projects/route-health.smoke.spec.ts",
    ])
  })

  it("maps sync-worker changes to the collaboration boundary", () => {
    expect(selectAffectedE2E(["sync-worker/src/events/commit.ts"], specs).specs).toContain(
      "e2e/specs/collab/concurrent-edit.smoke.spec.ts",
    )
  })

  it("maps auth/session changes to both login and expiry journeys", () => {
    for (const file of [
      "src/pages/Login.tsx",
      "src/components/ExpiredSessionGate.tsx",
      "src/components/SessionExpiredBanner.tsx",
      "src/lib/frontier/session-expiry.ts",
      "src/lib/errors/session-expired-signal.ts",
      "src/context/OutboxContext.tsx",
    ]) {
      expect(selectAffectedE2E([file], specs).specs, file).toEqual([
        "e2e/specs/auth/login-account-setup-status.smoke.spec.ts",
        "e2e/specs/auth/session-expired-banner.smoke.spec.ts",
      ])
    }
  })

  it("maps branching-search retrieval to the AI completion journey", () => {
    for (const file of [
      "sync-worker/src/lib/branching-search/corpus.ts",
      "sync-worker/src/events/branching-search-route.ts",
      "src/lib/sync/branching-search-read.ts",
      "src/lib/sync/branching-search-passages-read.ts",
    ]) {
      expect(selectAffectedE2E([file], specs).specs, file).toContain(
        "e2e/specs/ai/completion.smoke.spec.ts",
      )
    }
  })

  it("maps Knowledge Base clients and routes to the project-settings persistence journey", () => {
    expect(selectAffectedE2E([
      "src/components/knowledge/KnowledgeBaseSurface.tsx",
      "auth-worker/src/routes/knowledge.ts",
    ], specs).specs).toContain("e2e/specs/projects/project-settings.smoke.spec.ts")
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

describe("affected E2E run mode", () => {
  it("uses one dev-mode stack only for genuinely small suites", () => {
    expect(affectedRunMode(FAST_AFFECTED_SPEC_LIMIT)).toEqual({ viteMode: "dev", shards: 1 })
  })

  it("caps a 115-spec selection at two preview stacks to avoid local worker OOM", () => {
    expect(affectedRunMode(115)).toEqual({ viteMode: "preview", shards: 2 })
  })

  it("never writes Vite's watched env file in dev mode", () => {
    expect(shouldWriteTestEnvFile(false, "dev")).toBe(false)
    expect(shouldWriteTestEnvFile(false, "preview")).toBe(true)
    expect(shouldWriteTestEnvFile(true, "preview")).toBe(false)
  })
})
