// OrgDataEgress page behavior. Pinned rules:
// - the page is maintainer-gated: viewers get an EmptyState, and the data hook
//   is never invoked for them (no org-wide inventory fetch below the floor);
// - all files are selected by default once data loads (the easy path is open
//   page → Export) and the Export button's label reflects the live count;
// - Export hands the engine the selection grouped per project and downloads
//   the resulting blob under the engine's filename.

import { describe, it, expect, beforeEach, vi } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { OrgDataEgress } from "./OrgDataEgress"
import type { OrgEgressData, EgressFileRow } from "@/hooks/useOrgEgressData"
import type { EgressManifest, RunOrgEgressArgs, RunOrgEgressResult } from "@/lib/egress/types"
import {
  DEFAULT_EGRESS_OPTIONS,
  getEgressPrefs,
  setEgressPrefs,
  _resetEgressPrefsForTests,
} from "@/lib/store/egress-prefs"

vi.mock("@/components/org/OrgSidebar", () => ({ OrgSidebar: () => null }))
vi.mock("@/components/org/OrgBreadcrumb", () => ({ OrgBreadcrumb: () => null }))
vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "jwt", username: "wendi", createdAt: "x" }, loading: false }),
}))

const useActiveOrg = vi.fn()
vi.mock("@/context/OrgContext", () => ({
  useActiveOrg: () => useActiveOrg(),
}))

// AQU-253 export policy — the page must consult the same gate ExportDialog
// does. Default: no floor configured (canExport true).
const useOrgSettings = vi.fn()
vi.mock("@/hooks/useOrgSettings", () => ({
  useOrgSettings: (...a: unknown[]) => useOrgSettings(...a),
}))

const useOrgEgressData = vi.fn()
vi.mock("@/hooks/useOrgEgressData", () => ({
  useOrgEgressData: (...a: unknown[]) => useOrgEgressData(...a),
}))

const runOrgEgress = vi.fn()
vi.mock("@/lib/egress/org-egress", () => ({
  runOrgEgress: (...a: unknown[]) => runOrgEgress(...a),
}))

const downloadBlob = vi.fn()
vi.mock("@/lib/export/export-service", () => ({
  downloadBlob: (...a: unknown[]) => downloadBlob(...a),
}))

function orgContext(overrides: Record<string, unknown> = {}) {
  return {
    activeOrg: { id: 1, name: "Acme", role: { level: 600, name: "maintainer" } },
    activeOrgId: 1,
    isAllOrgs: false,
    ...overrides,
  }
}

function fileRow(overrides: Partial<EgressFileRow> & { fileId: string }): EgressFileRow {
  return {
    fileName: `${overrides.fileId}.usfm`,
    fileType: "usfm",
    projectId: "p1",
    projectName: "Genesis",
    cellCount: 10,
    sourceLanguage: "en",
    targetLanguage: "sw",
    lanes: [{ lane: "", totalCells: 10, filledCells: 5, validatedCells: 2, lastEditAt: null }],
    hasAudio: false,
    lastEditAt: null,
    ...overrides,
  }
}

function egressData(rows: EgressFileRow[]): OrgEgressData {
  const projectMeta = new Map(
    rows.map((r) => [
      r.projectId,
      {
        projectId: r.projectId,
        projectName: r.projectName,
        sourceLanguage: r.sourceLanguage,
        targetLanguage: r.targetLanguage,
        recordedMs: 0,
      },
    ]),
  )
  return {
    rows,
    laneOptions: [{ lane: "", label: "sw" }],
    projectMeta,
    portfolioUnavailable: false,
    loading: false,
    error: null,
    retry: vi.fn(),
  }
}

const ROWS = [
  fileRow({ fileId: "a", fileName: "a.usfm" }),
  fileRow({ fileId: "b", fileName: "b.usfm", projectId: "p2", projectName: "Handbook" }),
]

function okResult(): RunOrgEgressResult {
  const manifest: EgressManifest = {
    generatedAt: "2026-08-13T00:00:00Z",
    org: { id: 1, name: "Acme" },
    options: { ...DEFAULT_EGRESS_OPTIONS },
    projects: [],
  }
  return { blob: new Blob(["zip"]), manifest, filename: "acme-egress.zip" }
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/orgs/1/egress"]}>
      <OrgDataEgress />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  localStorage.clear()
  _resetEgressPrefsForTests()
  useActiveOrg.mockReset()
  useOrgEgressData.mockReset()
  runOrgEgress.mockReset()
  downloadBlob.mockReset()
  useOrgSettings.mockReset()
  useOrgEgressData.mockReturnValue(egressData(ROWS))
  useOrgSettings.mockReturnValue({ canExport: true })
})

describe("OrgDataEgress role gate", () => {
  it("shows the maintainer-floor EmptyState to a viewer and never fetches the inventory", () => {
    useActiveOrg.mockReturnValue(
      orgContext({ activeOrg: { id: 1, name: "Acme", role: { level: 100, name: "viewer" } } }),
    )

    renderPage()

    expect(
      screen.getByText("Data egress is available to organization owners and maintainers."),
    ).toBeInTheDocument()
    expect(screen.queryByTestId("egress-export-button")).not.toBeInTheDocument()
    expect(useOrgEgressData).not.toHaveBeenCalled()
  })

  it("asks to pick a single org on the all-orgs view (egress is per-org)", () => {
    useActiveOrg.mockReturnValue(orgContext({ activeOrg: null, activeOrgId: null, isAllOrgs: true }))

    renderPage()

    expect(screen.getByText("Select an organization")).toBeInTheDocument()
    expect(useOrgEgressData).not.toHaveBeenCalled()
  })
})

describe("OrgDataEgress selection + export", () => {
  it("selects every file by default and labels the Export button with the count", async () => {
    useActiveOrg.mockReturnValue(orgContext())

    renderPage()

    // Default-all-selected: open page → Export, no clicking required.
    expect(await screen.findByRole("button", { name: "Export 2 files" })).toBeEnabled()
  })

  it("reflects deselection in the Export button label (singular form)", async () => {
    useActiveOrg.mockReturnValue(orgContext())

    renderPage()

    await screen.findByRole("button", { name: "Export 2 files" })
    fireEvent.click(screen.getByRole("checkbox", { name: "Select a.usfm" }))
    expect(screen.getByRole("button", { name: "Export 1 file" })).toBeEnabled()
  })

  it("disables Export when nothing is selected", async () => {
    useActiveOrg.mockReturnValue(orgContext())

    renderPage()

    await screen.findByRole("button", { name: "Export 2 files" })
    fireEvent.click(screen.getByRole("button", { name: "Clear selection" }))
    expect(screen.getByRole("button", { name: "Export 0 files" })).toBeDisabled()
  })

  it("runs the engine with per-project selections and downloads under the engine's filename", async () => {
    useActiveOrg.mockReturnValue(orgContext())
    const manifest: EgressManifest = {
      generatedAt: "2026-08-13T00:00:00Z",
      org: { id: 1, name: "Acme" },
      options: {
        textMode: "original",
        convertFormat: "txt",
        lanes: [""],
        includeSourceDocs: false,
        audioMode: "none",
        useCache: true,
      },
      projects: [],
    }
    const blob = new Blob(["zip"])
    runOrgEgress.mockResolvedValue({ blob, manifest, filename: "acme-egress.zip" })

    renderPage()

    fireEvent.click(await screen.findByRole("button", { name: "Export 2 files" }))

    await waitFor(() => expect(downloadBlob).toHaveBeenCalledWith(blob, "acme-egress.zip"))
    const args = runOrgEgress.mock.calls[0][0] as RunOrgEgressArgs
    expect(args.org).toEqual({ id: 1, name: "Acme" })
    // One selection per project, each carrying its own files.
    expect(args.selections.map((s) => s.projectId).sort()).toEqual(["p1", "p2"])
    expect(args.selections.find((s) => s.projectId === "p1")?.files).toEqual([
      { id: "a", name: "a.usfm", type: "usfm" },
    ])
  })

  it("threads the session username into the engine args (cache user-partitioning)", async () => {
    useActiveOrg.mockReturnValue(orgContext())
    runOrgEgress.mockResolvedValue(okResult())

    renderPage()

    fireEvent.click(await screen.findByRole("button", { name: "Export 2 files" }))

    await waitFor(() => expect(runOrgEgress).toHaveBeenCalled())
    const args = runOrgEgress.mock.calls[0][0] as RunOrgEgressArgs
    expect(args.username).toBe("wendi")
  })

  it("does not download or claim success when cancel raced the engine finishing", async () => {
    useActiveOrg.mockReturnValue(orgContext())
    let resolveRun!: (v: RunOrgEgressResult) => void
    runOrgEgress.mockImplementation(
      () => new Promise<RunOrgEgressResult>((res) => { resolveRun = res }),
    )

    renderPage()

    fireEvent.click(await screen.findByRole("button", { name: "Export 2 files" }))
    // Cancel while running — the engine still resolves (packaging had already
    // finished before it observed the abort).
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }))
    resolveRun(okResult())

    // Quiet return to idle: the run panel disappears, nothing downloads.
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument(),
    )
    expect(screen.queryByText(/Export complete/)).not.toBeInTheDocument()
    expect(downloadBlob).not.toHaveBeenCalled()
  })

  it("surfaces an engine failure without crashing the page", async () => {
    useActiveOrg.mockReturnValue(orgContext())
    runOrgEgress.mockRejectedValue(new Error("not implemented — egress engine lands with this branch"))

    renderPage()

    fireEvent.click(await screen.findByRole("button", { name: "Export 2 files" }))

    expect(
      await screen.findByText(/Export failed: not implemented/),
    ).toBeInTheDocument()
    expect(downloadBlob).not.toHaveBeenCalled()
  })
})

describe("OrgDataEgress export policy gate (AQU-253)", () => {
  it("disables Export and shows the amber policy note when canExport is false", async () => {
    useActiveOrg.mockReturnValue(orgContext())
    useOrgSettings.mockReturnValue({ canExport: false })

    renderPage()

    expect(await screen.findByRole("button", { name: "Export 2 files" })).toBeDisabled()
    const note = screen.getByTestId("egress-policy-gate")
    expect(note).toHaveTextContent("Export restricted by org policy")
    expect(note.querySelector("a")).toHaveAttribute(
      "href",
      "https://help.aquilla.app/permissions",
    )
  })
})

describe("OrgDataEgress empty-output options", () => {
  it("disables Export and hints when the options would produce nothing", async () => {
    useActiveOrg.mockReturnValue(orgContext())

    renderPage()

    // Defaults produce text; turning text off leaves audio "none" and no
    // source docs — nothing would land in the zip.
    await screen.findByRole("button", { name: "Export 2 files" })
    fireEvent.click(screen.getByRole("radio", { name: /Text off/ }))

    expect(screen.getByRole("button", { name: "Export 2 files" })).toBeDisabled()
    expect(screen.getByTestId("egress-nothing-hint")).toHaveTextContent(
      "These options would export nothing",
    )
  })
})

describe("OrgDataEgress stale persisted lanes", () => {
  it("prunes persisted lanes missing from the org's lane list and persists the result", async () => {
    useActiveOrg.mockReturnValue(orgContext())
    setEgressPrefs(1, { ...DEFAULT_EGRESS_OPTIONS, lanes: ["", "deleted-lane"] })

    renderPage()

    await waitFor(() => expect(getEgressPrefs(1)?.lanes).toEqual([""]))
  })

  it("does NOT prune when the portfolio is unavailable (degraded lane list)", async () => {
    useActiveOrg.mockReturnValue(orgContext())
    useOrgEgressData.mockReturnValue({ ...egressData(ROWS), portfolioUnavailable: true })
    setEgressPrefs(1, { ...DEFAULT_EGRESS_OPTIONS, lanes: ["", "maybe-legit-lane"] })

    renderPage()

    await screen.findByRole("button", { name: "Export 2 files" })
    expect(getEgressPrefs(1)?.lanes).toEqual(["", "maybe-legit-lane"])
  })
})
