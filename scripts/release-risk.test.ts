import { describe, expect, it } from "vitest"
import { APPROVED_LABEL, AREAS, AREA_GATES, GATE_SWITCHES, HOLDING_AREAS, classifyFiles, gateEnabled, holdingAreas, riskLabelsFor } from "./release-risk.mjs"

// A misclassified file in one of these areas would put a change that can
// corrupt the event log, drop an offline edit, or leak another org's data
// onto the automatic hourly line with no person in the loop. Each row is a
// file the risk map (docs/RELEASE-RISK-GATES.md) names as part of that
// forbidden outcome's path.
describe("classifyFiles: holding areas", () => {
  it.each([
    ["db/postgres/migrations/0123_add.sql", ["migration"]],
    ["db/postgres/schema.sql", ["migration", "events"]],
    ["wrangler.toml", ["infra"]],
    ["sync-worker/wrangler.toml", ["infra"]],
    ["config/cloudflare-deployments.json", ["infra"]],
    [".github/workflows/release-cut.yml", ["infra"]],
    ["scripts/tag-release.sh", ["infra"]],
    ["scripts/verify-live-environment.mjs", ["infra"]],
    ["scripts/cloudflare-version-deploy.mjs", ["infra"]],
    [".github/workflows/release-deploy.yml", ["infra"]],
    [".github/workflows/risk-label.yml", ["infra"]],
    [".github/workflows/ci.yml", ["infra"]],
    // A workflow nobody has placed yet holds until someone does.
    [".github/workflows/brand-new.yml", ["infra"]],
    ["scripts/release-risk.mjs", ["infra"]],
    ["scripts/release-risk-label.mjs", ["infra"]],
    ["scripts/release-plan.mjs", ["release-tooling"]],
    ["scripts/release-cut.mjs", ["release-tooling"]],
    ["scripts/release-deploy-check.mjs", ["release-tooling"]],
    ["scripts/release-stall.mjs", ["release-tooling"]],
    ["scripts/release-discord-notify.sh", ["release-tooling"]],
    ["sync-worker/package.json", ["deps"]],
    ["auth-worker/pnpm-lock.yaml", ["deps"]],
    ["sync-worker/src/events/route.ts", ["events", "sync"]],
    ["sync-worker/src/events/types.ts", ["events", "sync"]],
    ["sync-worker/src/events/event-projection.ts", ["events", "sync"]],
    ["sync-worker/src/events/rebuild.ts", ["events", "sync"]],
    ["sync-worker/src/events/handlers/cell-events.ts", ["events", "sync"]],
    ["sync-worker/src/events/import-route.ts", ["events", "sync"]],
    ["sync-worker/src/project-do.ts", ["events", "sync"]],
    ["sync-worker/src/checking/policy.ts", ["events", "sync"]],
    ["src/lib/sync/events-emit.ts", ["events", "sync"]],
    ["src/lib/sync/target-commit-parent.ts", ["events", "sync"]],
    ["src/lib/import.ts", ["events"]],
    ["src/lib/sync/outbox.ts", ["offline-sync", "sync"]],
    ["src/lib/sync/outbox-flush.ts", ["offline-sync", "sync"]],
    ["src/lib/sync/ws-reconciler.ts", ["offline-sync", "sync"]],
    ["src/lib/sync/flush-applied.ts", ["offline-sync", "sync"]],
    ["src/hooks/useOutboxFlusher.ts", ["offline-sync"]],
    ["auth-worker/src/index.ts", ["auth"]],
    ["auth-worker/src/middleware/auth.ts", ["auth"]],
    ["auth-worker/src/middleware/platform-admin.ts", ["auth"]],
    ["auth-worker/src/services/project-permissions.ts", ["auth"]],
    ["auth-worker/src/services/sync-token-mint.ts", ["auth"]],
    ["auth-worker/src/routes/project-members.ts", ["auth"]],
    ["auth-worker/src/routes/credentials.ts", ["auth"]],
    ["sync-worker/src/auth.ts", ["auth", "sync"]],
    ["sync-worker/src/index.ts", ["auth", "sync"]],
    ["sync-worker/src/events/authorize.ts", ["events", "auth", "sync"]],
    ["sync-worker/src/events/membership.ts", ["events", "auth", "sync"]],
    ["sync-worker/src/external/read-auth.ts", ["auth", "sync"]],
    ["sync-worker/src/external/token-bridge.ts", ["auth", "sync"]],
    ["sync-worker/src/lib/service-auth.ts", ["auth", "sync"]],
    ["db/shared/project-roles.ts", ["auth"]],
    ["db/shared/access-grants.ts", ["auth"]],
    ["db/shim/postgres.ts", ["auth"]],
  ])("%s → %j, holding", (file, areas) => {
    expect(classifyFiles([file])).toEqual({ areas, pathHolds: true })
  })
})

describe("classifyFiles: noted but not holding", () => {
  it.each([
    ["src/lib/export/exporters/docx.ts", ["export"]],
    ["packages/idml-roundtrip/src/build.ts", ["export"]],
    ["sync-worker/src/events/export-route.ts", ["events", "export", "sync"]],
    ["sync-worker/src/audio.ts", ["sync"]],
    ["sync-worker/src/comments.ts", ["sync"]],
    ["src/lib/sync/cells-read.ts", ["sync"]],
    ["auth-worker/src/routes/chat.ts", []],
    ["auth-worker/src/routes/feedback.ts", []],
    // Off the web release line and not a gate: GitHub runs these from dev
    // the moment they merge, so a hold on the slice protected nothing.
    [".github/workflows/tauri-release.yml", ["ci"]],
    [".github/workflows/desktop-release-cut.yml", ["ci"]],
    [".github/workflows/dependency-audit.yml", ["ci"]],
    [".github/workflows/adversarial-jev.yml", ["ci"]],
  ])("%s → %j", (file, areas) => {
    expect(classifyFiles([file])).toEqual({ areas, pathHolds: areas.some((a) => HOLDING_AREAS.has(a)) })
  })

  it("leaves UI and copy changes with no area and no hold", () => {
    expect(classifyFiles(["src/components/Editor.tsx", "src/locales/en.json", "docs/SEO.md"]))
      .toEqual({ areas: [], pathHolds: false })
  })

  it("ignores test files: adding a sync-worker test is not an events change", () => {
    expect(classifyFiles(["sync-worker/src/__tests__/events-route.test.ts", "src/lib/sync/outbox.test.ts", "e2e/specs/x.spec.ts"]))
      .toEqual({ areas: [], pathHolds: false })
  })

  it("reports a mixed PR's areas in AREAS order and holds on the worst one", () => {
    const { areas, pathHolds } = classifyFiles(["src/lib/export/x.ts", "auth-worker/src/middleware/auth.ts", "src/App.tsx"])
    expect(areas).toEqual(["auth", "export"])
    expect(pathHolds).toBe(true)
    expect(AREAS.indexOf("auth")).toBeLessThan(AREAS.indexOf("export"))
  })
})

describe("labels", () => {
  it("names one risk label per area and the approval label the planner reads", () => {
    expect(riskLabelsFor(["events", "auth"])).toEqual(["risk:events", "risk:auth"])
    expect(APPROVED_LABEL).toBe("release:approved")
  })
})

describe("holdingAreas", () => {
  it("lists only holding areas, minus those with a passed gate", () => {
    expect(holdingAreas(["events", "export", "migration"])).toEqual(["events", "migration"])
    expect(holdingAreas(["events", "export", "migration"], ["events"])).toEqual(["migration"])
    expect(holdingAreas(["sync"], ["events"])).toEqual([])
  })

  it("names each gate by the check name its workflow job carries", () => {
    expect(AREA_GATES).toEqual({
      events: "replay-gate",
      auth: "auth-matrix",
      "offline-sync": "offline-gate",
      migration: "migration-gate",
      "release-tooling": "plan-diff",
      deps: "deps-gate",
    })
  })

  // A green migration gate ships the PR, so the deploy has to apply the
  // migration itself: the gate counts only once that has been switched on.
  it("counts the migration gate only while AUTO_MIGRATE is on, and the others always", () => {
    expect(GATE_SWITCHES).toEqual({ migration: "AUTO_MIGRATE" })
    expect(gateEnabled("migration", {})).toBe(false)
    expect(gateEnabled("migration", { AUTO_MIGRATE: "on" })).toBe(true)
    expect(gateEnabled("events", {})).toBe(true)
  })

  it("names a check for every gated area, and gates only holding areas", () => {
    for (const [area, check] of Object.entries(AREA_GATES)) {
      expect(HOLDING_AREAS.has(area)).toBe(true)
      expect(check).toMatch(/^[a-z-]+$/)
    }
  })
})

// A PR that edits the gate's harness, corpus or golden could make its own
// gate pass. Those files are infra, which holds with no gate, and they hold
// even though most of them sit under __tests__ (which otherwise never holds).
describe("gate machinery holds as infra", () => {
  it.each([
    "sync-worker/replay-corpus/golden.json",
    "sync-worker/replay-corpus/manifest.json",
    "sync-worker/replay-corpus/synthetic/genesis-sample.json",
    "sync-worker/src/__tests__/replay-corpus.test.ts",
    "sync-worker/src/__tests__/helpers/replay-corpus.ts",
    "scripts/replay-corpus.mjs",
    ".github/workflows/risk-label.yml",
    // Everything the gate executes through, not only its own two files.
    "sync-worker/src/__tests__/helpers/pg-test-db.ts",
    "sync-worker/vitest.config.ts",
    // The auth matrix's own chain, on both workers.
    "auth-worker/permission-matrix/golden.json",
    "sync-worker/permission-matrix/golden.json",
    "auth-worker/src/__tests__/permission-matrix.test.ts",
    "sync-worker/src/__tests__/permission-matrix.test.ts",
    "auth-worker/src/__tests__/helpers/access-fixture.ts",
    "auth-worker/src/__tests__/helpers/pg-test-env.ts",
    "auth-worker/src/__tests__/setup-migrations.ts",
    "auth-worker/vitest.config.ts",
    "db/shared/test-lane-fill.ts",
    // The newer gates: the offline harness and golden, and the scripted gates.
    "src/lib/sync/offline-gate/offline-gate.test.ts",
    "src/lib/sync/offline-gate/golden.json",
    "scripts/gate-migration.ts",
    "scripts/gate-migration.test.ts",
    "scripts/gate-deps.mjs",
    "scripts/gate-plan-diff.mjs",
  ])("%s", (file) => {
    const { areas, pathHolds } = classifyFiles([file])
    expect(areas).toContain("infra")
    expect(pathHolds).toBe(true)
    expect(AREA_GATES).not.toHaveProperty("infra")
  })

  it("still ignores an ordinary sync-worker or auth-worker test", () => {
    expect(classifyFiles(["sync-worker/src/__tests__/rebuild.test.ts"]).areas).toEqual([])
    expect(classifyFiles(["auth-worker/src/__tests__/auth-routes.test.ts"]).areas).toEqual([])
  })
})
