// AQU-767 — the clone-voice button must reveal the Voices tab.
//
// Root cause this test guards: LeftDock renders ONLY the active tab's panel
// (`activeTab && panels[activeTab]`). The per-cell "Clone a voice from this
// take" modal lives inside the Voices panel. So when the dock sits on Files
// (or is collapsed → activeTab === null), opening the clone modal did nothing
// visible — its host panel was never mounted. The fix (in ProjectWorkspace's
// `onMakeCharacterFromCell`) switches the dock to the Voices tab so the modal
// actually renders.
//
// These tests pin the structural fact the fix depends on: a panel that is not
// the active tab is NOT in the DOM. If someone ever makes LeftDock render all
// panels at once, this test breaks and the tab-switch requirement can be
// revisited deliberately rather than by accident.

import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { LeftDock } from "./LeftDock"

// The dock footer pulls in auth/version/report chrome irrelevant to panel
// mounting — stub them so the test stays focused on the tab→panel contract.
vi.mock("@/components/AccountSwitcher", () => ({ AccountSwitcher: () => null }))
vi.mock("@/components/VersionBadge", () => ({ VersionTag: () => null }))
vi.mock("@/components/ReportProblemButton/ReportProblemButton", () => ({
  ReportProblemButton: () => null,
}))

const CLONE_HOST = "clone-modal-host"

function renderDock(activeTab: "files" | "voices" | null) {
  return render(
    <LeftDock
      storageKey="aqu767"
      activeTab={activeTab}
      filesPanel={<div data-testid="files-host">files</div>}
      agentPanel={<div data-testid="agent-host">agent</div>}
      searchPanel={<div data-testid="search-host">search</div>}
      // The Voices panel is where the Clone-voice modal actually renders.
      voicesPanel={<div data-testid={CLONE_HOST}>clone modal</div>}
    />,
  )
}

describe("AQU-767: clone modal only renders when the Voices tab is active", () => {
  it("does NOT mount the Voices panel (clone modal host) while the dock is on Files", () => {
    renderDock("files")
    expect(screen.getByTestId("files-host")).toBeTruthy()
    // The regression: the clone modal's host panel is absent, so opening the
    // modal without switching tabs shows nothing.
    expect(screen.queryByTestId(CLONE_HOST)).toBeNull()
  })

  it("does NOT mount the Voices panel while the dock is collapsed (activeTab === null)", () => {
    renderDock(null)
    expect(screen.queryByTestId(CLONE_HOST)).toBeNull()
    expect(screen.queryByTestId("files-host")).toBeNull()
  })

  it("mounts the Voices panel (clone modal host) once the Voices tab is active", () => {
    renderDock("voices")
    expect(screen.getByTestId(CLONE_HOST)).toBeTruthy()
    // And the previously-active Files panel is gone — one panel at a time.
    expect(screen.queryByTestId("files-host")).toBeNull()
  })
})
