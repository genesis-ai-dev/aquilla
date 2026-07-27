// AQU-334: Project Setup sidebar must render write-level rows (instructions,
// invite, voice & transcription) read-only-with-tooltip for callers below
// the action's role floor, rather than editable — per
// aquilla-specs/05-user-stories/customize-ai-settings.md Persona section.
// This test drives the real drawer (no mocked child steps) so the
// roleLevel prop -> RoleGatedStep wiring is covered end-to-end, not just
// RoleGatedStep in isolation (see RoleGatedStep.test.tsx for the unit
// coverage of the gating logic itself).
//
// AQU-334 (live-UI QA regression): the drawer used to derive its gate from
// `project.syncRole?.level` — a stale-tolerant cache stamped by unrelated
// /sync-token round-trips (see useProject.ts). A real contributor's checklist
// rendered with that cache unset (roleLevel == null -> fail-open) showed
// EVERY step as editable. `roleLevel` is now a dedicated prop sourced from
// useProject's fresh per-load resolve, independent of `project.syncRole` —
// see the "stale syncRole cache" test below, which fails on the old
// `project.syncRole?.level` derivation.

import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { SetupChecklistDrawer } from "./SetupChecklistDrawer"
import type { ChecklistState } from "@/hooks/useSetupChecklist"
import type { ProjectRecord } from "@/lib/parsers/types"
import { ROLE } from "@/lib/frontier/roles"

// RoleGatedStep's AppTooltip renders the full Base UI tooltip on hover/focus
// (see tooltip.tsx's TooltipDelegationBoundary comment) — its async open
// isn't reliably driveable in happy-dom. Only RoleGatedStep consumes this
// module in the drawer's tree, so mocking it here still exercises every real
// child step (AiInstructionsStep, InviteStep, VoiceStep, …) end-to-end; it
// only replaces the tooltip's open/close mechanics with an always-rendered
// content node so the role-naming string can be asserted directly.
vi.mock("@/components/ui/tooltip", () => ({
  AppTooltip: ({ children, content }: { children: React.ReactNode; content: React.ReactNode }) => (
    <>
      {children}
      <div data-testid="tooltip-content">{content}</div>
    </>
  ),
}))

// useFrontierSession (via InviteStep/AiInstructionsStep) reaches useAccounts,
// which needs a QueryClientProvider — same wrapper as useSetupChecklist's
// own hook tests.
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
)

const EMPTY_STATE: ChecklistState = {
  importFiles: false,
  aiInstructions: false,
  collaborators: false,
  aiModels: false,
  completedCount: 0,
  totalCount: 4,
}

/** Bare project record — no `syncRole` cache. Callers pass `roleLevel`
 *  separately (mirrors the real useProject -> ProjectWorkspace wiring). */
function makeProject(): ProjectRecord {
  return {
    id: "proj-1",
    name: "Test project",
    sourceLanguage: "en",
    targetLanguage: "fr",
    createdAt: new Date().toISOString(),
    files: [],
    members: [],
  } as ProjectRecord
}

function renderDrawer(roleLevel: number | null, project: ProjectRecord = makeProject()) {
  return render(
    <SetupChecklistDrawer
      open
      onOpenChange={() => {}}
      project={project}
      roleLevel={roleLevel}
      state={EMPTY_STATE}
      onProjectUpdated={() => {}}
      onSharesChanged={() => {}}
      onDismiss={() => {}}
    />,
    { wrapper },
  )
}

function expandStep(title: string) {
  fireEvent.click(screen.getByRole("button", { name: new RegExp(title, "i") }))
}

describe("SetupChecklistDrawer — AQU-334 role-aware read-only rows", () => {
  it("contributor (400): instructions, invite, and voice rows are all gated read-only", () => {
    renderDrawer(ROLE.CONTRIBUTOR)

    expandStep("Set translation instructions")
    expandStep("Invite collaborators")
    expandStep("Configure voice")

    // Three gated step bodies -> three aria-disabled wrappers.
    const gated = document.querySelectorAll("[data-testid='role-gated-step']")
    expect(gated.length).toBe(3)

    // Tooltips exist and name a required role for at least the invite row
    // (project_lead) and the instructions/voice rows (maintainer).
    const tooltips = Array.from(document.querySelectorAll("[data-testid='tooltip-content']")).map(
      (el) => el.textContent ?? "",
    )
    // Role labels render underscore-free and title-cased ("Project Lead").
    expect(tooltips.some((t) => /project lead/i.test(t))).toBe(true)
    expect(tooltips.some((t) => /maintainer/i.test(t))).toBe(true)
  })

  it("project_lead (500): invite row is enabled, instructions/voice rows stay gated (maintainer floor)", () => {
    renderDrawer(ROLE.PROJECT_LEAD)

    expandStep("Set translation instructions")
    expandStep("Invite collaborators")
    expandStep("Configure voice")

    const gated = document.querySelectorAll("[data-testid='role-gated-step']")
    // Only instructions + voice remain gated; invite is now unlocked.
    expect(gated.length).toBe(2)
  })

  it("maintainer (600): all three rows are enabled, no gating", () => {
    renderDrawer(ROLE.MAINTAINER)

    expandStep("Set translation instructions")
    expandStep("Invite collaborators")
    expandStep("Configure voice")

    expect(document.querySelectorAll("[data-testid='role-gated-step']").length).toBe(0)
  })

  it("owner (700): all three rows are enabled", () => {
    renderDrawer(ROLE.OWNER)

    expandStep("Set translation instructions")
    expandStep("Invite collaborators")
    expandStep("Configure voice")

    expect(document.querySelectorAll("[data-testid='role-gated-step']").length).toBe(0)
  })

  it("unsynced project (no syncRole): rows stay enabled — no server floor to gate against", () => {
    renderDrawer(null)

    expandStep("Set translation instructions")
    expandStep("Invite collaborators")
    expandStep("Configure voice")

    expect(document.querySelectorAll("[data-testid='role-gated-step']").length).toBe(0)
  })

  it("AQU-334 regression: a synced contributor whose project.syncRole cache is unset still gates — mirrors live QA (bob, role.level=400, zero gated steps)", () => {
    // The project record deliberately carries NO syncRole (the exact shape
    // QA observed for a real contributor whose /sync-token round-trip hadn't
    // fired this session) — only the `roleLevel` prop carries the server's
    // resolved role. If the drawer regressed to reading `project.syncRole`
    // instead of this prop, roleLevel would read as null (fail-open) and
    // this assertion would fail exactly like the live bug.
    renderDrawer(ROLE.CONTRIBUTOR, makeProject())

    expandStep("Set translation instructions")
    expandStep("Invite collaborators")
    expandStep("Configure voice")

    expect(document.querySelectorAll("[data-testid='role-gated-step']").length).toBe(3)
  })

  it("never hides a gated row — the step title and description stay visible for a contributor", () => {
    renderDrawer(ROLE.CONTRIBUTOR)

    expect(screen.getByText("Set translation instructions")).toBeInTheDocument()
    expect(screen.getByText("Invite collaborators")).toBeInTheDocument()
    expect(screen.getByText(/Configure voice/)).toBeInTheDocument()
  })

  it("AQU-693: launching import from step 1 fires onOpenImport but does NOT signal a dismissal via onOpenChange", () => {
    // Regression guard: the step-1 button used to call onOpenChange(false)
    // before onOpenImport(). In ProjectWorkspace that close handler persists
    // the `setupChecklistDismissed` flag, so using step 1 as intended silently
    // ended the whole setup flow. The drawer must launch the import without
    // ever routing through the dismissal path — the parent owns hiding and
    // reopening the drawer around the import dialog.
    const onOpenChange = vi.fn()
    const onOpenImport = vi.fn()
    render(
      <SetupChecklistDrawer
        open
        onOpenChange={onOpenChange}
        project={makeProject()}
        roleLevel={ROLE.OWNER}
        state={EMPTY_STATE}
        onProjectUpdated={() => {}}
        onSharesChanged={() => {}}
        onDismiss={() => {}}
        onOpenImport={onOpenImport}
      />,
      { wrapper },
    )

    // Expand the step (only the accordion header matches while collapsed), then
    // click the inner action button (exact "Import files", no extra description).
    expandStep("Import files")
    fireEvent.click(screen.getByRole("button", { name: /^import files$/i }))

    expect(onOpenImport).toHaveBeenCalledTimes(1)
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it("Coming Soon rows remain inactive teasers regardless of role (unaffected by this change)", () => {
    renderDrawer(ROLE.CONTRIBUTOR)
    expect(screen.getByText("Upload project standards")).toBeInTheDocument()
    expect(screen.getByText("Import glossary / translation memory")).toBeInTheDocument()
    expect(screen.getAllByText("Coming soon").length).toBe(2)
  })
})
