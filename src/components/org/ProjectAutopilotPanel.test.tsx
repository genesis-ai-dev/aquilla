// Project-level autopilot panel. WHY: this is the only autopilot surface a
// project manager ever sees — every other one lives inside an open file. The
// tests pin what a PM has to be able to trust:
//
//   - the review backlog is reported across the WHOLE project, not per file
//   - the panel disappears cleanly where the backend isn't deployed, rather
//     than sitting dead on an otherwise-working page
//   - starting is gated to the same role floor the server enforces, so the
//     button never promises something the API will refuse

import { describe, it, expect, beforeEach, vi } from "vitest"
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react"
import { ProjectAutopilotPanel } from "./ProjectAutopilotPanel"
import type { ContextualOverview } from "@/lib/contextual/transport"

const fetchMock = vi.fn<(projectId: string) => Promise<ContextualOverview>>()
const startMock = vi.fn<(projectId: string) => Promise<unknown>>()

vi.mock("@/lib/contextual/transport", () => ({
  fetchContextualOverview: (projectId: string) => fetchMock(projectId),
  startProjectContextualRun: (projectId: string) => startMock(projectId),
}))

function overview(patch: Partial<ContextualOverview> = {}): ContextualOverview {
  return {
    available: true,
    files: [],
    activeRuns: 0,
    doneSpans: 0,
    totalSpans: 0,
    failedSpans: 0,
    unitsSpent: 0,
    proposedDrafts: 0,
    appliedDrafts: 0,
    ...patch,
  }
}

function fileRow(patch: Partial<ContextualOverview["files"][number]> = {}) {
  return {
    fileId: "f1",
    runId: "r1",
    status: "running",
    doneSpans: 3,
    totalSpans: 10,
    failedSpans: 0,
    unitsSpent: 51,
    proposedDrafts: 7,
    appliedDrafts: 2,
    updatedAt: "2026-08-02T00:00:00.000Z",
    lastError: null,
    ...patch,
  }
}

const names = new Map([["f1", "MRK.usfm"], ["f2", "LUK.usfm"]])

function renderPanel(canStart = true) {
  render(<ProjectAutopilotPanel projectId="p1" fileNames={names} canStart={canStart} />)
}

beforeEach(() => {
  cleanup()
  fetchMock.mockReset()
  startMock.mockReset()
  startMock.mockResolvedValue({ scopeGroup: "g1", started: [{ runId: "r9", fileId: "f2" }], skipped: [] })
})

describe("ProjectAutopilotPanel", () => {
  it("renders nothing when the backend isn't deployed for this environment", async () => {
    fetchMock.mockResolvedValue(overview({ available: false }))
    renderPanel()
    await waitFor(() => expect(screen.queryByText("Loading autopilot…")).toBeNull())
    expect(screen.queryByTestId("project-autopilot-panel")).toBeNull()
  })

  it("reports the review backlog across the whole project", async () => {
    fetchMock.mockResolvedValue(
      overview({
        files: [fileRow(), fileRow({ fileId: "f2", proposedDrafts: 5 })],
        proposedDrafts: 12,
        appliedDrafts: 4,
      }),
    )
    renderPanel()
    await screen.findByTestId("project-autopilot-panel")

    expect(screen.getByText("Waiting for review")).toBeTruthy()
    expect(screen.getByText("12")).toBeTruthy()
  })

  it("names each file rather than showing raw ids", async () => {
    fetchMock.mockResolvedValue(overview({ files: [fileRow()] }))
    renderPanel()
    await screen.findByTestId("project-autopilot-panel")
    expect(screen.getByText("MRK.usfm")).toBeTruthy()
  })

  it("falls back to the file id when the name isn't loaded", async () => {
    fetchMock.mockResolvedValue(overview({ files: [fileRow({ fileId: "unknown-file" })] }))
    renderPanel()
    await screen.findByTestId("project-autopilot-panel")
    expect(screen.getByText("unknown-file")).toBeTruthy()
  })

  it("shows how many files are drafting right now", async () => {
    fetchMock.mockResolvedValue(
      overview({ files: [fileRow(), fileRow({ fileId: "f2" })], activeRuns: 2 }),
    )
    renderPanel()
    await screen.findByTestId("autopilot-active")
    expect(screen.getByTestId("autopilot-active").textContent).toContain("2 files drafting")
  })

  it("explains itself when autopilot has never run here", async () => {
    fetchMock.mockResolvedValue(overview())
    renderPanel()
    await screen.findByTestId("project-autopilot-panel")
    expect(screen.getByText(/hasn't run on this project yet/i)).toBeTruthy()
  })

  it("starts a project-wide run and refreshes", async () => {
    fetchMock.mockResolvedValue(overview())
    renderPanel()
    await screen.findByTestId("project-autopilot-panel")
    fetchMock.mockClear()

    fireEvent.click(screen.getByRole("button", { name: /draft the whole project/i }))
    await waitFor(() => expect(startMock).toHaveBeenCalledWith("p1"))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
  })

  it("hides the start button below the contributor floor the server enforces", async () => {
    fetchMock.mockResolvedValue(overview({ files: [fileRow()] }))
    renderPanel(false)
    await screen.findByTestId("project-autopilot-panel")
    expect(screen.queryByRole("button", { name: /draft the whole project/i })).toBeNull()
  })

  it("says so plainly when every file is already running", async () => {
    fetchMock.mockResolvedValue(overview({ files: [fileRow()] }))
    startMock.mockResolvedValue({
      scopeGroup: "g1",
      started: [],
      skipped: [{ fileId: "f1", reason: "already running" }],
    })
    renderPanel()
    await screen.findByTestId("project-autopilot-panel")

    fireEvent.click(screen.getByRole("button", { name: /draft the whole project/i }))
    expect(await screen.findByText(/already running on every file/i)).toBeTruthy()
  })

  it("surfaces a failed start instead of failing silently", async () => {
    fetchMock.mockResolvedValue(overview())
    startMock.mockRejectedValue(new Error("Agent credit cap reached."))
    renderPanel()
    await screen.findByTestId("project-autopilot-panel")

    fireEvent.click(screen.getByRole("button", { name: /draft the whole project/i }))
    expect(await screen.findByText(/agent credit cap reached/i)).toBeTruthy()
  })
})

describe("context readiness", () => {
  function withReadiness(patch: Partial<NonNullable<ContextualOverview["readiness"]>> = {}) {
    return overview({
      files: [fileRow()],
      readiness: {
        blockingGaps: 2,
        ready: false,
        items: [
          {
            id: "terminology",
            label: "Key terms",
            level: "missing",
            detail: "No key terms have an approved rendering yet.",
            href: "settings/terminology",
          },
          {
            id: "brief",
            label: "Translation brief",
            level: "missing",
            detail: "No brief. Autopilot has to guess your audience.",
            href: "settings/brief",
          },
          {
            id: "languages",
            label: "Languages",
            level: "ready",
            detail: "Translating English → Spanish.",
          },
        ],
        ...patch,
      },
    })
  }

  it("opens itself when something important is missing", async () => {
    // A gap nobody sees is a gap nobody fixes, and the run still reports
    // "staged" either way.
    fetchMock.mockResolvedValue(withReadiness())
    renderPanel()
    await screen.findByTestId("autopilot-readiness")
    expect(screen.getByText("Key terms")).toBeTruthy()
    expect(screen.getByText(/No key terms have an approved rendering/)).toBeTruthy()
  })

  it("counts the gaps in the header", async () => {
    fetchMock.mockResolvedValue(withReadiness())
    renderPanel()
    const section = await screen.findByTestId("autopilot-readiness")
    expect(section.textContent).toContain("2 gaps")
  })

  it("stays collapsed when the project is fully set up", async () => {
    fetchMock.mockResolvedValue(
      withReadiness({
        blockingGaps: 0,
        ready: true,
        items: [{ id: "languages", label: "Languages", level: "ready", detail: "English → Spanish." }],
      }),
    )
    renderPanel()
    const section = await screen.findByTestId("autopilot-readiness")
    expect(section.querySelector('[aria-expanded="false"]')).toBeTruthy()
    expect(screen.queryByText("English → Spanish.")).toBeNull()
  })

  it("links each unmet item to the place that fixes it", async () => {
    fetchMock.mockResolvedValue(withReadiness())
    renderPanel()
    await screen.findByTestId("autopilot-readiness")
    const links = screen.getAllByRole("link", { name: /set up/i })
    expect(links.map((l) => l.getAttribute("href"))).toEqual([
      "/project/p1/settings/terminology",
      "/project/p1/settings/brief",
    ])
  })

  it("renders nothing extra when the server sends no readiness", async () => {
    fetchMock.mockResolvedValue(overview({ files: [fileRow()] }))
    renderPanel()
    await screen.findByTestId("project-autopilot-panel")
    expect(screen.queryByTestId("autopilot-readiness")).toBeNull()
  })
})
