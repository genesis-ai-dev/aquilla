import { describe, expect, it } from "vitest"
import { selectAffectedE2E } from "./lib/e2e-impact"
import {
  affectedRunMode,
  FAST_AFFECTED_SPEC_LIMIT,
  shouldWriteTestEnvFile,
} from "./lib/e2e-run-mode"

const specs = [
  "e2e/specs/agent/agent-connection.smoke.spec.ts",
  "e2e/specs/orgs/org-settings-billing.smoke.spec.ts",
  "e2e/specs/ai/completion.smoke.spec.ts",
  "e2e/specs/auth/login-account-setup-status.smoke.spec.ts",
  "e2e/specs/auth/session-expired-banner.smoke.spec.ts",
  "e2e/specs/collab/concurrent-edit.smoke.spec.ts",
  "e2e/specs/editor/import-and-edit.smoke.spec.ts",
  "e2e/specs/editor/import-media-captions.smoke.spec.ts",
  "e2e/specs/editor/comments.smoke.spec.ts",
  "e2e/specs/editor/search.smoke.spec.ts",
  "e2e/specs/editor/workspace-actions-dropdown.smoke.spec.ts",
  "e2e/specs/orgs/account-switcher.smoke.spec.ts",
  "e2e/specs/orgs/preferences-persist-reload.smoke.spec.ts",
  "e2e/specs/projects/project-settings.smoke.spec.ts",
  "e2e/specs/projects/route-health.smoke.spec.ts",
  "e2e/specs/rules/violation.smoke.spec.ts",
]

describe("changed-file E2E impact selection", () => {
  it("selects media publication coverage for media import contracts", () => {
    for (const file of [
      "src/lib/import.ts", "src/lib/import/media-cues.ts",
      "src/components/import/MediaImportPreviewDialog.tsx",
      "src/lib/sync/bulk-import.ts", "sync-worker/src/events/import-route.ts",
      "src/lib/import/timeline-text.ts", "shared/timeline-import.ts",
      "sync-worker/src/events/import-track-publication.ts",
      "sync-worker/src/events/import-caption-promotion.ts",
      "src/hooks/useTimelineTextCells.ts", "src/components/timeline/TimelineEditor.tsx",
      "src/lib/audio/script-alignment.ts",
      "src/lib/audio/align-source-script.ts", "src/lib/audio/source-alignment.ts",
      "src/lib/parsers/embedded-subtitles.ts", "sync-worker/src/audio.ts",
    ]) {
      expect(selectAffectedE2E([file], specs).specs, file).toContain(
        "e2e/specs/editor/import-media-captions.smoke.spec.ts",
      )
    }
  })
  it("selects billing for catalog, client, and shared-contract changes", () => {
    for (const file of ["config/pricing/stripe-sandbox.json", "db/shared/billing-offers.ts", "db/shared/billing-workspace.ts", "src/pages/Login.tsx", "src/components/onboarding/OnboardingWizard.tsx",
      "auth-worker/src/services/org-permissions.ts", "db/postgres/migrations/0092_workspace_billing.sql", "db/postgres/migrations/0093_workspace_checkout_attempts.sql",
      "db/postgres/migrations/0095_workspace_subscription_state.sql",
      "db/postgres/migrations/0096_workspace_plan_change_reviews.sql", "db/postgres/migrations/0097_workspace_usage_requests.sql", "db/postgres/migrations/0098_workspace_usage_provider_ref.sql", "db/shared/billing-cost.ts", "auth-worker/src/routes/chat.ts", "auth-worker/src/routes/import-classify.ts", "auth-worker/src/routes/transcription.ts", "auth-worker/src/routes/agent.ts", "auth-worker/src/routes/contextual.ts", "db/shared/workspace-access.ts",
      "src/components/org/BillingOffers.tsx", "auth-worker/src/lib/billing/catalog.ts"]) {
      expect(selectAffectedE2E([file], specs).specs).toContain(
        "e2e/specs/orgs/org-settings-billing.smoke.spec.ts")
    }
  })

  it("maps smart-testing infrastructure to the edit durability boundary", () => {
    expect(selectAffectedE2E(["smart-tests/driver.ts"], specs).specs).toContain(
      "e2e/specs/editor/import-and-edit.smoke.spec.ts",
    )
  })
  it("maps imported video producers and picture resolution to the import journey", () => {
    for (const file of ["src/hooks/useMediaPictureUrl.ts", "src/lib/sync/bulk-import.ts",
      "sync-worker/src/events/import-route.ts",
      "sync-worker/src/events/import-caption-promotion.ts"]) {
      expect(selectAffectedE2E([file], specs).specs, file).toContain(
        "e2e/specs/editor/import-and-edit.smoke.spec.ts",
      )
    }
  })
  it("maps flexible YouTube sources and empty-picture readiness to import coverage", () => {
    for (const file of ["src/lib/import/youtube-captions.ts",
      "src/lib/import/youtube-caption-commit.ts",
      "src/components/import/YouTubeImportPanel.tsx", "src/lib/editor/cell-area-state.ts"]) {
      expect(selectAffectedE2E([file], specs).specs, file)
        .toContain("e2e/specs/editor/import-and-edit.smoke.spec.ts")
    }
  })
  it("keeps comment coverage when its no-hover entry point changes", () => {
    expect(selectAffectedE2E(["src/components/CellActionRail.tsx"], specs).specs).toContain(
      "e2e/specs/editor/comments.smoke.spec.ts",
    )
  })
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

  it("selects browser authorization for plugin package, credential and OAuth changes", () => {
    for (const file of ["plugins/aquilla/.codex-plugin/plugin.json", "sync-worker/src/external/mcp-chatgpt.ts",
      "db/shared/api-credentials.ts", "db/postgres/migrations/0130_mcp_oauth_resource.sql"]) {
      expect(selectAffectedE2E([file], specs).specs).toContain("e2e/specs/agent/agent-connection.smoke.spec.ts")
    }
  })

  it("maps sync-worker changes to the collaboration boundary", () => {
    expect(selectAffectedE2E(["sync-worker/src/events/commit.ts"], specs).specs).toContain(
      "e2e/specs/collab/concurrent-edit.smoke.spec.ts",
    )
  })

  it("maps auth/session changes to login, expiry, and multi-account isolation journeys", () => {
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
        "e2e/specs/orgs/account-switcher.smoke.spec.ts",
        ...(file === "src/pages/Login.tsx" ? ["e2e/specs/orgs/org-settings-billing.smoke.spec.ts"] : []),
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

  it("maps the document-understanding tag layer to the AI completion journey", () => {
    // AQU-657: tags reach a user through retrieval and few-shot selection, so a
    // change to them must not fall through to the generic shared-runtime sentinel.
    for (const file of [
      "src/lib/understanding/passage-tags.ts",
      "src/lib/understanding/passage-tag-store.ts",
      "auth-worker/src/routes/ai-passage-tags.ts",
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

  it("maps the share / invite surfaces to the share-invite journey (AQU-1153)", () => {
    // PR #882 restyled UsernameTypeahead's mode switch as tabs and merged with a
    // stale button locator in share-invite.smoke: none of these files carried a
    // domain keyword, so the push gate ran only the core sentinels.
    const available = [...specs, "e2e/specs/projects/share-invite.smoke.spec.ts"]
    for (const file of [
      "src/components/UsernameTypeahead.tsx",
      "src/components/MemberMultiAddRow.tsx",
      "src/components/MultiProjectInviteDialog.tsx",
      "src/components/ProjectMembersPage.tsx",
      "src/components/ProjectSettings/AddProjectMemberDialog.tsx",
      "src/components/SharePanel.tsx",
      "src/components/JoinPage.tsx",
      "src/hooks/useUserSearch.ts",
      "src/lib/sync/invites.ts",
      "auth-worker/src/routes/invites.ts",
      "auth-worker/src/services/invite-scopes.ts",
    ]) {
      expect(selectAffectedE2E([file], available).specs, file).toContain(
        "e2e/specs/projects/share-invite.smoke.spec.ts",
      )
    }
    // A matched domain rule replaces the core-sentinel fallback outright.
    expect(selectAffectedE2E(["src/components/UsernameTypeahead.tsx"], available).specs).toEqual([
      "e2e/specs/projects/share-invite.smoke.spec.ts",
    ])
  })

  it("maps app font-size preference and boot script to preferences persist-reload", () => {
    for (const file of [
      "src/branding/FontSize.tsx",
      "src/pages/Preferences.tsx",
      "src/lib/store/file-view-prefs.ts",
      "index.html",
    ]) {
      expect(selectAffectedE2E([file], specs).specs, file).toContain(
        "e2e/specs/orgs/preferences-persist-reload.smoke.spec.ts",
      )
    }
  })

  it("maps a format parser to the import journey rather than shared runtime", () => {
    for (const file of [
      "src/lib/parsers/usfm.ts",
      "src/partner-integrations/biblica/parsers/biblica-ebl.ts",
      "src/partner-integrations/biblica/ebl/notes.ts",
    ]) {
      expect(selectAffectedE2E([file], specs).specs, file).toContain(
        "e2e/specs/editor/import-and-edit.smoke.spec.ts",
      )
    }
  })

  it("uses core sentinels for unclassified runtime code", () => {
    expect(selectAffectedE2E(["src/context/AppContext.tsx"], specs).specs).toEqual([
      "e2e/specs/editor/workspace-actions-dropdown.smoke.spec.ts",
      "e2e/specs/projects/route-health.smoke.spec.ts",
    ])
  })

  it("maps original-source download to the export journey", () => {
    const available = [...specs, "e2e/specs/editor/export.smoke.spec.ts"]
    expect(selectAffectedE2E(["src/lib/sync/original-download.ts"], available).specs).toContain(
      "e2e/specs/editor/export.smoke.spec.ts",
    )
    expect(selectAffectedE2E(
      ["sync-worker/src/events/original-download-route.ts"],
      available,
    ).specs).toContain("e2e/specs/editor/export.smoke.spec.ts")
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
