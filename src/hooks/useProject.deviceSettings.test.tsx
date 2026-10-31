// AQU-2331: on a cloud project, the settings this browser keeps for itself
// (Audio loading, Git auto-sync, Health) read back after a reload, in Project
// settings and in the editor. A cloud project's record comes from the server,
// which never has them, and useProject laid only some of this browser's
// settings over it, so these showed their default again after a reload, and
// Audio loading never reached the editor at all.
//
// The REAL read hook and the REAL store (fake-indexeddb); only the network,
// the session and the settings request are mocked.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { act, render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import type { DecaySettings, ProjectRecord, ProjectSyncSettings } from "@/lib/parsers/types"
import { TooltipProvider } from "@/components/ui/tooltip"

// AQU-1357: partial mock — see src/lib/sync/cloud-projects-mock-guard.test.ts.
vi.mock("@/lib/sync/cloud-projects", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/sync/cloud-projects")>()),
  resolveCloudProjectResult: vi.fn(),
  // The server's copy: no device settings, ever.
  minimalProjectRecord: vi.fn((project: { id: string; name: string; role: { level: number; name: string; source: string } }) => ({
    id: project.id,
    name: project.name,
    sourceLanguage: "en",
    targetLanguage: "fr",
    createdAt: "2026-10-30T00:00:00.000Z",
    files: [],
    members: [],
    syncRole: { level: project.role.level, name: project.role.name, source: project.role.source, fetchedAt: "2026-10-30T00:00:00.000Z" },
  })),
}))

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "test-jwt", username: "alice", email: "a@example.com" }, loading: false }),
}))

vi.mock("@/hooks/useProjectSettings", () => {
  // One constant object, so a new `project` is only ever a device-local change.
  const settings = {}
  const lanes = [
    { id: "source-lane", role: "source", language: "en", name: null, langCode: null, legacyTag: null, position: 0, archivedAt: null },
    { id: "target-lane", role: "target", language: "fr", name: null, langCode: null, legacyTag: "", position: 1, archivedAt: null },
  ]
  return {
    useProjectSettings: () => ({
      canEdit: true,
      reasonCannotEdit: null,
      canEditLanguages: true,
      reasonCannotEditLanguages: null,
      patch: vi.fn().mockResolvedValue({ kind: "ok" }),
      lanes,
      renameLane: vi.fn().mockResolvedValue("ok"),
      createLane: vi.fn().mockResolvedValue({ kind: "ok" }),
      setLaneArchived: vi.fn().mockResolvedValue({ kind: "ok" }),
      version: 1,
      updatedAt: null,
      updatedBy: null,
      conflict: false,
      dismissConflict: vi.fn(),
      settings,
      hasFetched: true,
      isOnline: true,
      refresh: vi.fn(),
    }),
  }
})

// What Project settings needs around it, as in the page's other tests.
vi.mock("@/hooks/useProjectMembers", () => ({
  useProjectMembers: () => ({
    members: [], isLoading: false, error: null, rosterHidden: false,
    refresh: async () => {}, add: async () => null, addMany: async () => [],
    remove: async () => {}, changeRole: async () => null,
  }),
}))
vi.mock("@/hooks/useOrg", () => ({ useOrg: () => ({ org: null }) }))
vi.mock("@/components/org/OrgSidebar", () => ({ OrgSidebar: () => <div data-testid="org-sidebar" /> }))
vi.mock("@/components/org/OrgBreadcrumb", () => ({ OrgBreadcrumb: () => <div data-testid="org-breadcrumb" /> }))
vi.mock("@/hooks/useAccounts", () => ({
  useAccounts: () => ({ active: null, sessions: [], loading: false, add: vi.fn(), activate: vi.fn(), remove: vi.fn() }),
}))
vi.mock("@/components/AccountSwitcher", () => ({ AccountSwitcher: () => <div data-testid="account-switcher" /> }))
vi.mock("@/lib/completion/completion-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/completion/completion-service")>()),
  fetchModels: vi.fn().mockResolvedValue([]),
}))
vi.mock("@/lib/store/user-api-keys", () => ({ setUserApiKey: vi.fn(), useUserApiKey: vi.fn(() => null) }))
vi.mock("@/lib/metrics/use-post-edit-metrics", () => ({
  usePostEditMetrics: () => ({ metrics: null, isLoading: false, isError: false, revalidate: vi.fn() }),
}))

import { useProject } from "./useProject"
import { ProjectSettings } from "@/components/ProjectSettings"
import { resolveCloudProjectResult } from "@/lib/sync/cloud-projects"
import { createProject, patchProject, _resetDbForTesting } from "@/lib/store/project-index"

const SYNC: ProjectSyncSettings = { autoSync: { enabled: true, intervalMinutes: 15 } }
const DECAY: DecaySettings = { maxHops: 4, perHopDecay: 0.2 }

function localRecord(id: string, overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id,
    name: `Project ${id}`,
    sourceLanguage: "en",
    targetLanguage: "fr",
    createdAt: "2026-10-30T00:00:00.000Z",
    files: [],
    members: [],
    // A cloud project: this browser's copy of one the server holds.
    syncRole: { level: 700, name: "owner", source: "creator", fetchedAt: "2026-10-30T00:00:00.000Z" },
    ...overrides,
  } as ProjectRecord
}

/** The editor's read of the project: the same hook, with the settings overlay. */
function EditorReader({ projectId, seen }: { projectId: string; seen?: ProjectRecord[] }) {
  const { project, status } = useProject(projectId)
  if (project) seen?.push(project)
  return (
    <>
      <output data-testid="editor-status">{status}</output>
      <output data-testid="editor-audio">{project ? (project.audioMediaStrategy ?? "lazy") : ""}</output>
      <output data-testid="editor-device">{JSON.stringify({ sync: project?.syncSettings ?? null, decay: project?.decaySettings ?? null })}</output>
    </>
  )
}

beforeEach(async () => {
  await _resetDbForTesting()
  for (const db of await indexedDB.databases()) if (db.name) indexedDB.deleteDatabase(db.name)
  vi.mocked(resolveCloudProjectResult).mockImplementation(async (id: string) => ({
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
  }) as never)
})

describe("useProject — the settings kept only on this device read back on a cloud project (AQU-2331)", () => {
  it("Eager survives a reload: Project settings show it, and the editor sees it", async () => {
    // Chosen on this device in an earlier visit: it lives in this browser's
    // copy of the project, and the server's copy has none of it.
    await createProject(localRecord("p-reload", { audioMediaStrategy: "eager", syncSettings: SYNC, decaySettings: DECAY }))
    // The reload: a cold mount of the settings page, and the editor's read.
    render(
      <TooltipProvider delay={0}>
        <MemoryRouter initialEntries={["/project/p-reload/settings/audio-media"]}>
          <Routes>
            <Route path="/project/:id/settings/:section" element={<ProjectSettings />} />
          </Routes>
        </MemoryRouter>
        <EditorReader projectId="p-reload" />
      </TooltipProvider>,
    )
    const eager = await screen.findByRole("button", { name: /^Eager/ }, { timeout: 4000 })
    await waitFor(() => expect(eager).toHaveAttribute("aria-pressed", "true"))
    expect(screen.getByRole("button", { name: /^Lazy/ })).toHaveAttribute("aria-pressed", "false")
    await waitFor(() => expect(screen.getByTestId("editor-audio")).toHaveTextContent("eager"))
    // Git auto-sync and Health come back the same way.
    expect(JSON.parse(screen.getByTestId("editor-device").textContent ?? "{}")).toEqual({ sync: SYNC, decay: DECAY })
  })

  it("a reader already open follows a device setting as it changes, and as it goes back to its default", async () => {
    await createProject(localRecord("p-live", { audioMediaStrategy: "eager" }))
    const seen: ProjectRecord[] = []
    render(<EditorReader projectId="p-live" seen={seen} />)
    await waitFor(() => expect(screen.getByTestId("editor-audio")).toHaveTextContent("eager"))
    expect(vi.mocked(resolveCloudProjectResult)).toHaveBeenCalledTimes(1)

    await act(async () => {
      await patchProject("p-live", (p) => ({ ...p, audioMediaStrategy: "stream" }))
    })
    await waitFor(() => expect(screen.getByTestId("editor-audio")).toHaveTextContent("stream"))

    // Put back to its default: this browser's copy no longer has it, so the
    // reader must not keep the value it read before.
    await act(async () => {
      await patchProject("p-live", (p) => {
        const next = { ...p }
        delete next.audioMediaStrategy
        return next
      })
    })
    await waitFor(() => expect(screen.getByTestId("editor-audio")).toHaveTextContent("lazy"))
    expect(vi.mocked(resolveCloudProjectResult)).toHaveBeenCalledTimes(1) // no reload

    // A write that changes no device setting hands the reader nothing new.
    const before = new Set(seen).size
    await act(async () => {
      await patchProject("p-live", (p) => ({ ...p, name: "Renamed in the local copy only" }))
    })
    await act(async () => {
      await patchProject("p-live", (p) => ({ ...p, decaySettings: DECAY }))
    })
    await waitFor(() => expect(JSON.parse(screen.getByTestId("editor-device").textContent ?? "{}").decay).toEqual(DECAY))
    expect(new Set(seen).size).toBe(before + 1)
  })
})
