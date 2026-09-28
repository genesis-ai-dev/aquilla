// AQU-1246 moved the Autopilot gate from a device-local flag to the
// project-wide `autopilotEnabled` setting, so the promise AQU-1103 made — flip
// the switch in Project settings and the overview underneath follows, with no
// page reload — now rides a different path: the modal's settings hook PATCHes,
// broadcasts (AQU-979), and the settings hook INSIDE the overview's useProject
// re-reads the row and overlays it onto `project`.
//
// These tests drive the REAL switch (ExperimentalFlagsSection, wired the way
// ProjectSettings wires it) through the REAL settings hooks into the REAL read
// hook, with only the network and session mocked. The device-local half of
// this story lives in useProject.deviceLocalLive.test.tsx.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react"
import type { ProjectWideSettings, ProjectSettingsResponse } from "@/lib/sync/project-settings"

// AQU-1357: partial mock — see src/lib/sync/cloud-projects-mock-guard.test.ts.
vi.mock("@/lib/sync/cloud-projects", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/sync/cloud-projects")>()),
  resolveCloudProjectResult: vi.fn(),
  minimalProjectRecord: vi.fn((project: { id: string; name: string; role: { level: number; name: string; source: string } }) => ({
    id: project.id,
    name: project.name,
    sourceLanguage: "en",
    targetLanguage: "fr",
    createdAt: "2026-09-10T00:00:00.000Z",
    files: [],
    members: [],
    syncRole: {
      level: project.role.level,
      name: project.role.name,
      source: project.role.source,
      fetchedAt: "2026-09-10T00:00:00.000Z",
    },
  })),
}))

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({
    session: { jwt: "test-jwt", username: "alice" },
    loading: false,
  }),
}))

import { useProject } from "./useProject"
import { useProjectSettings } from "./useProjectSettings"
import { isAutopilotVisible } from "@/lib/features/flags"
import { ROLE } from "@/lib/frontier/roles"
import { ExperimentalFlagsSection } from "@/components/ProjectSettings/ExperimentalFlagsSection"
import { resolveCloudProjectResult } from "@/lib/sync/cloud-projects"
import * as settingsClient from "@/lib/sync/project-settings"
import { _resetDbForTesting } from "@/lib/store/project-index"

const mockResolve = vi.mocked(resolveCloudProjectResult)
const AUTOPILOT_SWITCH = { name: "Try Autopilot" } as const

/** The settings row as auth-worker holds it: one version-checked blob. */
let serverRow: ProjectSettingsResponse

/** ProjectOverview's shape: the panel is gated on the read hook's record. */
function Overview({ projectId }: { projectId: string }) {
  const { project, status } = useProject(projectId)
  return (
    <>
      <output data-testid="overview-status">{status}</output>
      {project && isAutopilotVisible(project) && (
        <section data-testid="project-autopilot-panel">Autopilot</section>
      )}
    </>
  )
}

/**
 * ProjectSettings' shape: it owns its own editable settings hook (so its read
 * hook skips the overlay) and hands the switch that hook's blob and patch.
 */
function SettingsModal({ projectId }: { projectId: string }) {
  const { project, status } = useProject(projectId, { includeSettings: false })
  const roleLevel = project?.syncRole?.level ?? null
  const { settings, patch } = useProjectSettings(projectId, roleLevel)
  return (
    <>
      <output data-testid="modal-status">{status}</output>
      <ExperimentalFlagsSection
        projectId={projectId}
        serverProject={project ?? undefined}
        autopilotEnabled={settings.autopilotEnabled}
        roleLevel={roleLevel}
        onSetAutopilotEnabled={(enabled) => { void patch({ autopilotEnabled: enabled }) }}
      />
    </>
  )
}

function OverviewUnderSettingsModal({ projectId }: { projectId: string }) {
  return (
    <>
      <Overview projectId={projectId} />
      <SettingsModal projectId={projectId} />
    </>
  )
}

async function waitForBothReady() {
  await waitFor(() => {
    expect(screen.getByTestId("overview-status")).toHaveTextContent("ready")
    expect(screen.getByTestId("modal-status")).toHaveTextContent("ready")
  })
}

function resolveAs(level: number, name: string) {
  mockResolve.mockImplementation(async (id: string) => ({
    ok: true,
    project: {
      id,
      name: `Project ${id}`,
      gitlabProjectId: null,
      archivedAt: null,
      archivedBy: null,
      role: { level, name, source: "creator" },
      files: [],
    },
  }))
}

beforeEach(async () => {
  cleanup()
  await _resetDbForTesting()
  const dbs = await indexedDB.databases()
  for (const db of dbs) {
    if (db.name) indexedDB.deleteDatabase(db.name)
  }
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true })
  serverRow = { version: 3, updatedAt: "2026-09-10T00:00:00.000Z", updatedBy: null, settings: { targetLanguage: "fr" } }
  vi.spyOn(settingsClient, "fetchProjectSettingsResult").mockImplementation(
    async () => ({ ok: true, value: serverRow }),
  )
  vi.spyOn(settingsClient, "patchProjectSettings").mockImplementation(
    async (_jwt: string, _projectId: string, settings: ProjectWideSettings, ifMatchVersion: number) => {
      if (ifMatchVersion !== serverRow.version) return { kind: "conflict", latest: serverRow }
      serverRow = { ...serverRow, version: serverRow.version + 1, settings }
      return { kind: "ok", value: serverRow }
    },
  )
  resolveAs(ROLE.PROJECT_LEAD, "project_lead")
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("useProject — the Autopilot opt-in follows the settings switch live (AQU-1246)", () => {
  it("shows and hides the overview's Autopilot panel as a lead flips the switch, without refetching the project", async () => {
    render(<OverviewUnderSettingsModal projectId="p-1" />)
    await waitForBothReady()
    expect(screen.queryByTestId("project-autopilot-panel")).toBeNull()
    const resolvesAtReady = mockResolve.mock.calls.length

    const toggle = screen.getByRole("switch", AUTOPILOT_SWITCH)
    expect(toggle).not.toBeChecked()

    fireEvent.click(toggle)
    expect(await screen.findByTestId("project-autopilot-panel")).toBeInTheDocument()
    expect(serverRow.settings.autopilotEnabled).toBe(true) // project-wide, not device-local
    expect(serverRow.settings.targetLanguage).toBe("fr") // the single-key write kept the rest of the row
    await waitFor(() => expect(toggle).toBeChecked())

    fireEvent.click(toggle)
    await waitFor(() => expect(screen.queryByTestId("project-autopilot-panel")).toBeNull())
    expect(serverRow.settings.autopilotEnabled).toBe(false)

    // The overview converged through its settings overlay alone.
    expect(mockResolve).toHaveBeenCalledTimes(resolvesAtReady)
  })

  it("opens with the panel already showing for a project that opted in earlier", async () => {
    serverRow = { ...serverRow, settings: { ...serverRow.settings, autopilotEnabled: true } }
    render(<OverviewUnderSettingsModal projectId="p-1" />)
    await waitForBothReady()

    expect(await screen.findByTestId("project-autopilot-panel")).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole("switch", AUTOPILOT_SWITCH)).toBeChecked())
  })

  it("leaves a contributor's overview without Autopilot: the switch cannot be flipped and nothing is written", async () => {
    resolveAs(ROLE.CONTRIBUTOR, "contributor")
    render(<OverviewUnderSettingsModal projectId="p-1" />)
    await waitForBothReady()

    const toggle = screen.getByRole("switch", AUTOPILOT_SWITCH)
    await waitFor(() => expect(toggle).toHaveAttribute("aria-disabled", "true"))
    fireEvent.click(toggle)

    expect(settingsClient.patchProjectSettings).not.toHaveBeenCalled()
    expect(serverRow.settings.autopilotEnabled).toBeUndefined()
    expect(screen.queryByTestId("project-autopilot-panel")).toBeNull()
  })
})
