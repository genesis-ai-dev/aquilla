// AQU-1103: the Autopilot surfaces are gated on a DEVICE-LOCAL flag that
// lives on the IDB project record. Project settings — the flag's only writer
// — opens as a route-modal over a still-mounted overview/workspace, so the
// flag must reach an already-resolved useProject without a page reload.
//
// These tests drive the REAL writer (ExperimentalFlagsSection → patchProject /
// updateProject) through the REAL store (fake-indexeddb) into the REAL read
// hook, with only the network and session mocked — the composition that the
// overview and the workspace rely on.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, fireEvent, waitFor, cleanup, act } from "@testing-library/react"
import type { ProjectRecord } from "@/lib/parsers/types"

vi.mock("@/lib/sync/cloud-projects", () => ({
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

vi.mock("@/hooks/useProjectSettings", () => {
  // One constant object: overlaySettings hands back its input by reference
  // when nothing is assigned, which is what lets the identity test below
  // attribute every new `project` object to a device-local change.
  const settings = {}
  return {
    useProjectSettings: () => ({ settings, patch: vi.fn(), hasFetched: true }),
  }
})

import { useProject } from "./useProject"
import { isFlagEnabled } from "@/lib/features/flags"
import { ExperimentalFlagsSection } from "@/components/ProjectSettings/ExperimentalFlagsSection"
import { resolveCloudProjectResult } from "@/lib/sync/cloud-projects"
import { createProject, patchProject, _resetDbForTesting } from "@/lib/store/project-index"

const mockResolve = vi.mocked(resolveCloudProjectResult)

function localRecord(id: string, overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id,
    name: `Project ${id}`,
    sourceLanguage: "en",
    targetLanguage: "fr",
    createdAt: "2026-09-10T00:00:00.000Z",
    files: [],
    members: [],
    ...overrides,
  }
}

/**
 * The overview's shape: a reader gated exactly the way ProjectOverview gates
 * ProjectAutopilotPanel, with the settings modal's writer mounted alongside
 * it (the modal renders over the overview, both stay mounted).
 */
function OverviewWithSettingsModal({
  projectId,
  seen,
}: {
  projectId: string
  /** Every `project` object handed to the reader, in render order. */
  seen?: Array<ProjectRecord | null>
}) {
  const { project, status } = useProject(projectId)
  seen?.push(project)
  return (
    <>
      <output data-testid="status">{status}</output>
      {project && isFlagEnabled(project, "contextualTranslation") && (
        <section data-testid="project-autopilot-panel">Autopilot</section>
      )}
      <ExperimentalFlagsSection projectId={projectId} serverProject={project ?? undefined} />
    </>
  )
}

async function waitForReady() {
  await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("ready"))
}

beforeEach(async () => {
  cleanup()
  await _resetDbForTesting()
  const dbs = await indexedDB.databases()
  for (const db of dbs) {
    if (db.name) indexedDB.deleteDatabase(db.name)
  }
  mockResolve.mockImplementation(async (id: string) => ({
    ok: true,
    project: {
      id,
      name: `Project ${id}`,
      gitlabProjectId: null,
      archivedAt: null,
      archivedBy: null,
      role: { level: 700, name: "owner", source: "creator" },
      files: [],
    },
  }))
})

afterEach(() => {
  vi.clearAllMocks()
})

describe("useProject — device-local flags follow the settings toggle live (AQU-1103)", () => {
  it("shows and hides the Autopilot panel as the toggle flips, without remounting the reader", async () => {
    // Cached on this device, no stored flag: the production shape after any
    // earlier visit. The panel is absent (default OFF) until the toggle flips.
    await createProject(localRecord("p-1"))
    render(<OverviewWithSettingsModal projectId="p-1" />)
    await waitForReady()
    expect(screen.queryByTestId("project-autopilot-panel")).toBeNull()

    const toggle = screen.getByRole("switch", { name: "Show Autopilot controls" })
    expect(toggle).not.toBeChecked()

    fireEvent.click(toggle)
    expect(await screen.findByTestId("project-autopilot-panel")).toBeInTheDocument()
    expect(mockResolve).toHaveBeenCalledTimes(1) // no refetch, no remount

    fireEvent.click(toggle)
    await waitFor(() => expect(screen.queryByTestId("project-autopilot-panel")).toBeNull())
    expect(mockResolve).toHaveBeenCalledTimes(1)
  })

  it("follows the toggle on a device that never cached the project (the upsert path)", async () => {
    // First visit on this device: no IDB record, so the writer seeds one from
    // the server record (updateProject) instead of patching — that path must
    // announce itself too.
    render(<OverviewWithSettingsModal projectId="p-fresh" />)
    await waitForReady()
    expect(screen.queryByTestId("project-autopilot-panel")).toBeNull()

    fireEvent.click(screen.getByRole("switch", { name: "Show Autopilot controls" }))
    expect(await screen.findByTestId("project-autopilot-panel")).toBeInTheDocument()
  })

  it("hands the reader a new project object only when a device-local field actually changed", async () => {
    await createProject(localRecord("p-1"))
    await createProject(localRecord("p-2"))
    const seen: Array<ProjectRecord | null> = []
    render(<OverviewWithSettingsModal projectId="p-1" seen={seen} />)
    await waitForReady()
    const ready = seen[seen.length - 1]
    expect(ready?.id).toBe("p-1")

    // The workspace stamps this record on every sync-token round-trip, and
    // other projects' records move on their own. Neither carries a
    // device-local change for p-1, so neither may produce a new `project`
    // object — that would re-render every consumer for nothing.
    await act(async () => {
      await patchProject("p-1", (p) => ({ ...p, name: "Renamed in the local cache only" }))
      await patchProject("p-2", (p) => ({
        ...p,
        experimentalFlags: { contextualTranslation: true },
      }))
    })
    // A real device-local change for p-1 is the marker that the reader has
    // processed everything issued before it (last-issued read wins).
    await act(async () => {
      await patchProject("p-1", (p) => ({
        ...p,
        experimentalFlags: { contextualTranslation: true },
      }))
    })
    await screen.findByTestId("project-autopilot-panel")

    const distinct = [...new Set(seen.filter((p): p is ProjectRecord => p !== null))]
    expect(distinct).toEqual([
      ready,
      expect.objectContaining({
        id: "p-1",
        name: "Project p-1", // the server name — the local rename never overlays
        experimentalFlags: { contextualTranslation: true },
      }),
    ])
  })

  it("stops listening once the reader unmounts", async () => {
    await createProject(localRecord("p-1"))
    const seen: Array<ProjectRecord | null> = []
    const { unmount } = render(<OverviewWithSettingsModal projectId="p-1" seen={seen} />)
    await waitForReady()
    const renders = seen.length
    unmount()

    await act(async () => {
      await patchProject("p-1", (p) => ({
        ...p,
        experimentalFlags: { contextualTranslation: true },
      }))
    })
    expect(seen).toHaveLength(renders)
  })

  it("overlays a saved aiProviderChosen flag without remounting the reader (AQU-1158)", async () => {
    await createProject(localRecord("p-chosen"))
    function Reader({ projectId }: { projectId: string }) {
      const { project, status } = useProject(projectId)
      return (
        <>
          <output data-testid="status">{status}</output>
          <output data-testid="chosen">{String(project?.aiProviderChosen ?? "unset")}</output>
        </>
      )
    }
    render(<Reader projectId="p-chosen" />)
    await waitForReady()
    expect(screen.getByTestId("chosen")).toHaveTextContent("unset")

    await act(async () => {
      await patchProject("p-chosen", (p) => ({ ...p, aiProviderChosen: true }))
    })
    await waitFor(() => expect(screen.getByTestId("chosen")).toHaveTextContent("true"))
    expect(mockResolve).toHaveBeenCalledTimes(1)
  })
})
