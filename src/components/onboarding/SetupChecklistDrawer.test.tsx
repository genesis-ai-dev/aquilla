// FRO-334: Project Setup sidebar must render write-level rows (instructions,
// invite, voice & transcription) read-only-with-tooltip for callers below
// the action's role floor, rather than editable — per
// aquilla-specs/05-user-stories/customize-ai-settings.md Persona section.
// This test drives the real drawer (no mocked child steps) so the
// project.syncRole.level -> RoleGatedStep wiring is covered end-to-end, not
// just RoleGatedStep in isolation (see RoleGatedStep.test.tsx for the unit
// coverage of the gating logic itself).

import { describe, it, expect } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { SetupChecklistDrawer } from "./SetupChecklistDrawer"
import type { ChecklistState } from "@/hooks/useSetupChecklist"
import type { ProjectRecord } from "@/lib/parsers/types"
import { ROLE } from "@/lib/frontier/roles"

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

function makeProject(roleLevel: number | null): ProjectRecord {
  return {
    id: "proj-1",
    name: "Test project",
    sourceLanguage: "en",
    targetLanguage: "fr",
    createdAt: new Date().toISOString(),
    files: [],
    members: [],
    ...(roleLevel != null
      ? { syncRole: { level: roleLevel, name: "role", source: "test", fetchedAt: new Date().toISOString() } }
      : {}),
  } as ProjectRecord
}

function renderDrawer(project: ProjectRecord) {
  return render(
    <SetupChecklistDrawer
      open
      onOpenChange={() => {}}
      project={project}
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

describe("SetupChecklistDrawer — FRO-334 role-aware read-only rows", () => {
  it("contributor (400): instructions, invite, and voice rows are all gated read-only", () => {
    renderDrawer(makeProject(ROLE.CONTRIBUTOR))

    expandStep("Set translation instructions")
    expandStep("Invite collaborators")
    expandStep("Configure voice")

    // Three gated step bodies -> three aria-disabled wrappers.
    const gated = document.querySelectorAll("[data-testid='role-gated-step']")
    expect(gated.length).toBe(3)

    // Tooltips exist and name a required role for at least the invite row
    // (project_lead) and the instructions/voice rows (maintainer).
    const tooltips = Array.from(document.querySelectorAll("[data-tooltip]")).map((el) =>
      el.getAttribute("data-tooltip") ?? "",
    )
    expect(tooltips.some((t) => /project_lead/i.test(t))).toBe(true)
    expect(tooltips.some((t) => /maintainer/i.test(t))).toBe(true)
  })

  it("project_lead (500): invite row is enabled, instructions/voice rows stay gated (maintainer floor)", () => {
    renderDrawer(makeProject(ROLE.PROJECT_LEAD))

    expandStep("Set translation instructions")
    expandStep("Invite collaborators")
    expandStep("Configure voice")

    const gated = document.querySelectorAll("[data-testid='role-gated-step']")
    // Only instructions + voice remain gated; invite is now unlocked.
    expect(gated.length).toBe(2)
  })

  it("maintainer (600): all three rows are enabled, no gating", () => {
    renderDrawer(makeProject(ROLE.MAINTAINER))

    expandStep("Set translation instructions")
    expandStep("Invite collaborators")
    expandStep("Configure voice")

    expect(document.querySelectorAll("[data-testid='role-gated-step']").length).toBe(0)
  })

  it("owner (700): all three rows are enabled", () => {
    renderDrawer(makeProject(ROLE.OWNER))

    expandStep("Set translation instructions")
    expandStep("Invite collaborators")
    expandStep("Configure voice")

    expect(document.querySelectorAll("[data-testid='role-gated-step']").length).toBe(0)
  })

  it("unsynced project (no syncRole): rows stay enabled — no server floor to gate against", () => {
    renderDrawer(makeProject(null))

    expandStep("Set translation instructions")
    expandStep("Invite collaborators")
    expandStep("Configure voice")

    expect(document.querySelectorAll("[data-testid='role-gated-step']").length).toBe(0)
  })

  it("never hides a gated row — the step title and description stay visible for a contributor", () => {
    renderDrawer(makeProject(ROLE.CONTRIBUTOR))

    expect(screen.getByText("Set translation instructions")).toBeInTheDocument()
    expect(screen.getByText("Invite collaborators")).toBeInTheDocument()
    expect(screen.getByText(/Configure voice/)).toBeInTheDocument()
  })

  it("Coming Soon rows remain inactive teasers regardless of role (unaffected by this change)", () => {
    renderDrawer(makeProject(ROLE.CONTRIBUTOR))
    expect(screen.getByText("Upload project standards")).toBeInTheDocument()
    expect(screen.getByText("Import glossary / translation memory")).toBeInTheDocument()
    expect(screen.getAllByText("Coming soon").length).toBe(2)
  })
})
