// AQU-1103: the Autopilot surfaces are gated on a DEVICE-LOCAL flag that
// lives on the IDB project record. Project settings — the flag's only writer
// — opens as a route-modal over a still-mounted overview/workspace, so the
// flag must reach an already-resolved useProject without a page reload.
//
// These tests drive the REAL writer (ExperimentalFlagsSection → patchProject /
// updateProject) through the REAL store (fake-indexeddb) into the REAL read
// hook, with only the network and session mocked — the composition that the
// overview and the workspace rely on.
//
// AQU-1246 moved the Autopilot gate itself off this path: it is now the
// project-wide `autopilotEnabled` setting, and `contextualTranslation` survives
// only as a `legacy` grandfather that is read but never rendered as a switch.
// That switch following live is covered in useProject.autopilotOptInLive.test.tsx.
// The device-local writer is unchanged and is what the next registry flag will
// use, so the writer tests below register a stand-in flag (STAND_IN_FLAG).

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
import { FLAGS, isAutopilotVisible, isFlagEnabled, type FeatureFlagDefinition } from "@/lib/features/flags"
import { ExperimentalFlagsSection } from "@/components/ProjectSettings/ExperimentalFlagsSection"
import { resolveCloudProjectResult } from "@/lib/sync/cloud-projects"
import { createProject, patchProject, _resetDbForTesting } from "@/lib/store/project-index"

const mockResolve = vi.mocked(resolveCloudProjectResult)

/**
 * A registry flag that IS offered as a switch — the shape `contextualTranslation`
 * had until AQU-1246 marked it `legacy`. Registered per test under a key no
 * product code reads, so the real writer has a switch to render.
 */
const STAND_IN_FLAG = "deviceLocalLiveStandIn"
const STAND_IN_DEFINITION: FeatureFlagDefinition = {
  labelKey: "autopilot.settings.controlsLabel",
  descriptionKey: "autopilot.settings.controlsDescription",
  default: false,
}
const STAND_IN_SWITCH = { name: "Show Autopilot controls" } as const

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
 * ProjectAutopilotPanel (`isAutopilotVisible` — a stored legacy flag still
 * counts), with the settings modal's writer mounted alongside it (the modal
 * renders over the overview, both stay mounted). The stand-in surface is gated
 * the way any registry flag is read.
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
      {project && isAutopilotVisible(project) && (
        <section data-testid="project-autopilot-panel">Autopilot</section>
      )}
      {project && isFlagEnabled(project, STAND_IN_FLAG) && (
        <section data-testid="stand-in-flag-surface">Stand-in</section>
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
  FLAGS[STAND_IN_FLAG] = STAND_IN_DEFINITION
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
  delete FLAGS[STAND_IN_FLAG]
  vi.clearAllMocks()
})

describe("useProject — device-local flags follow the settings toggle live (AQU-1103)", () => {
  it("shows and hides a flag's surface as its toggle flips, without remounting the reader", async () => {
    // Cached on this device, no stored flag: the production shape after any
    // earlier visit. The surface is absent (default OFF) until the toggle flips.
    await createProject(localRecord("p-1"))
    render(<OverviewWithSettingsModal projectId="p-1" />)
    await waitForReady()
    expect(screen.queryByTestId("stand-in-flag-surface")).toBeNull()

    const toggle = screen.getByRole("switch", STAND_IN_SWITCH)
    expect(toggle).not.toBeChecked()

    fireEvent.click(toggle)
    expect(await screen.findByTestId("stand-in-flag-surface")).toBeInTheDocument()
    expect(mockResolve).toHaveBeenCalledTimes(1) // no refetch, no remount

    fireEvent.click(toggle)
    await waitFor(() => expect(screen.queryByTestId("stand-in-flag-surface")).toBeNull())
    expect(mockResolve).toHaveBeenCalledTimes(1)
    // A registry flag is not the Autopilot gate (AQU-1246): flipping one must
    // never reveal Autopilot.
    expect(screen.queryByTestId("project-autopilot-panel")).toBeNull()
  })

  it("follows the toggle on a device that never cached the project (the upsert path)", async () => {
    // First visit on this device: no IDB record, so the writer seeds one from
    // the server record (updateProject) instead of patching — that path must
    // announce itself too.
    render(<OverviewWithSettingsModal projectId="p-fresh" />)
    await waitForReady()
    expect(screen.queryByTestId("stand-in-flag-surface")).toBeNull()

    fireEvent.click(screen.getByRole("switch", STAND_IN_SWITCH))
    expect(await screen.findByTestId("stand-in-flag-surface")).toBeInTheDocument()
  })

  it("keeps a grandfathered device's Autopilot panel, with no switch left to flip it (AQU-1246)", async () => {
    // The registry exactly as shipped. A device that stored the legacy flag
    // before the gate moved keeps its Autopilot: the stored `true` still
    // reaches the reader through the device-local overlay, and the settings
    // writer offers no switch for it.
    delete FLAGS[STAND_IN_FLAG]
    await createProject(localRecord("p-1", { experimentalFlags: { contextualTranslation: true } }))
    render(<OverviewWithSettingsModal projectId="p-1" />)
    await waitForReady()

    expect(screen.getByTestId("project-autopilot-panel")).toBeInTheDocument()
    expect(screen.queryByRole("switch", STAND_IN_SWITCH)).toBeNull()
  })

  it("hands the reader a new project object only when a device-local field actually changed", async () => {
    await createProject(localRecord("p-1"))
    await createProject(localRecord("p-2"))
    const seen: Array<ProjectRecord | null> = []
    render(<OverviewWithSettingsModal projectId="p-1" seen={seen} />)
    await waitForReady()
    // A cold mount: nothing until the resolve, so `ready` is the one object
    // the resolve produced. (A warm mount is the next test.)
    expect(seen[0]).toBeNull()
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

    // The same rule once the record DOES carry device-local fields — the usual
    // production shape (a saved AI provider). Every stamp now recomputes an
    // overlay equal to what the reader already holds, and that must still read
    // as nothing new. Switching the flag back off is the next marker.
    await act(async () => {
      await patchProject("p-1", (p) => ({ ...p, name: "Stamped again in the local cache" }))
    })
    await act(async () => {
      await patchProject("p-1", (p) => ({
        ...p,
        experimentalFlags: { contextualTranslation: false },
      }))
    })
    await waitFor(() => expect(screen.queryByTestId("project-autopilot-panel")).toBeNull())

    const distinct = [...new Set(seen.filter((p): p is ProjectRecord => p !== null))]
    expect(distinct).toEqual([
      ready,
      expect.objectContaining({
        id: "p-1",
        name: "Project p-1", // the server name — the local rename never overlays
        experimentalFlags: { contextualTranslation: true },
      }),
      expect.objectContaining({
        id: "p-1",
        name: "Project p-1",
        experimentalFlags: { contextualTranslation: false },
      }),
    ])
  })

  it("adds only the revalidated record on a warm mount, and still nothing for a no-op write (AQU-1325)", async () => {
    // Overview → editor: the second mount of a project starts from the record
    // the first resolve produced and revalidates behind it. The revalidated
    // record is the one extra object a warm reader is owed — the authoritative
    // answer, exactly as on the `initialProject` path. The rule above must hold
    // on top of it.
    await createProject(localRecord("p-1"))
    const first = render(<OverviewWithSettingsModal projectId="p-1" />)
    await waitForReady()
    first.unmount()

    const seen: Array<ProjectRecord | null> = []
    render(<OverviewWithSettingsModal projectId="p-1" seen={seen} />)
    const seed = seen[0]
    expect(seed?.id).toBe("p-1") // ready at once, no skeleton frame
    const distinctSeen = () => [...new Set(seen.filter((p): p is ProjectRecord => p !== null))]
    await waitFor(() => expect(distinctSeen()).toHaveLength(2))
    expect(mockResolve).toHaveBeenCalledTimes(2)
    const revalidated = distinctSeen()[1]

    await act(async () => {
      await patchProject("p-1", (p) => ({ ...p, name: "Renamed in the local cache only" }))
    })
    await act(async () => {
      await patchProject("p-1", (p) => ({
        ...p,
        experimentalFlags: { contextualTranslation: true },
      }))
    })
    await screen.findByTestId("project-autopilot-panel")

    expect(distinctSeen()).toEqual([
      seed,
      revalidated,
      expect.objectContaining({
        id: "p-1",
        name: "Project p-1",
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
