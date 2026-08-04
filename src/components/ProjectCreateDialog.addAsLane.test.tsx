// AQU-538 slice 3: "demote sibling linking" — the linked-target +
// consumes="source" shape (a new sibling language reading someone else's
// source) is the case the TMS lane model demotes in favor of adding a lane
// on the upstream project directly.
//
// Verifies: the "add as lane" recommendation renders exactly for
// (linked-target, consumes="source") with an upstream chosen, never for the
// chain case (consumes="target"); clicking "Add as lane" PATCHes the
// UPSTREAM project's settings.targetLanes (not the new project) and does
// NOT create a project; the classic linked-project ("Create & Link") path
// stays available alongside it.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react"
import { ProjectCreateDialog } from "./ProjectCreateDialog"

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({
    session: { jwt: "tok", username: "wendi" },
    loading: false,
  }),
}))

vi.mock("@/hooks/useAccessibleProjects", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/useAccessibleProjects")>()
  return {
    ...actual,
    useProjectsForNavigation: () => ({
      projects: [
        {
          id: "upstream-1",
          name: "English Source",
          gitlabProjectId: null,
          role: { level: 700, name: "owner", source: "creator" },
        },
        {
          id: "upstream-low-role",
          name: "Low Role Upstream",
          gitlabProjectId: null,
          role: { level: 400, name: "contributor", source: "invite" },
        },
      ],
      isLoading: false,
      refresh: vi.fn(),
    }),
  }
})

vi.mock("@/lib/sync/cloud-projects", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sync/cloud-projects")>()
  return { ...actual, createCloudProject: vi.fn().mockResolvedValue(undefined) }
})

vi.mock("@/lib/sync/project-settings", () => ({
  fetchProjectSettings: vi.fn(),
  patchProjectSettings: vi.fn(),
}))

vi.mock("@/lib/sync/archive", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sync/archive")>()
  return {
    ...actual,
    linkProjectSource: vi.fn().mockResolvedValue({
      projectId: "new-proj", sourceProjectId: "upstream-1", mode: "live", consumes: "source",
      gate: "validated", previousSourceProjectId: null, seeded: true,
    }),
    triggerLinkSync: vi.fn().mockResolvedValue(true),
  }
})

vi.mock("@/lib/store/project-index", () => ({
  createProject: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("@/lib/posthog", () => ({ default: { capture: vi.fn() } }))

import { createCloudProject } from "@/lib/sync/cloud-projects"
import { linkProjectSource } from "@/lib/sync/archive"
import { createProject } from "@/lib/store/project-index"
import { fetchProjectSettings, patchProjectSettings } from "@/lib/sync/project-settings"

const mockCreateCloudProject = vi.mocked(createCloudProject)
const mockLinkProjectSource = vi.mocked(linkProjectSource)
const mockCreateProject = vi.mocked(createProject)
const mockFetchProjectSettings = vi.mocked(fetchProjectSettings)
const mockPatchProjectSettings = vi.mocked(patchProjectSettings)

// Base UI Select renders a combobox trigger; options live in a portaled
// popup. Clicks on options don't reliably commit a selection under
// happy-dom, but hover-highlighting + Enter does (the keyboard path). See
// ProjectCreateDialog.linked.test.tsx for the original of this helper.
async function pickSelectOption(triggerName: RegExp, optionName: RegExp) {
  const trigger = screen.getByRole("combobox", { name: triggerName })
  fireEvent.click(trigger)
  const option = await screen.findByRole("option", { name: optionName })
  fireEvent.pointerMove(option)
  fireEvent.mouseMove(option)
  fireEvent.keyDown(document.activeElement ?? option, { key: "Enter" })
  await waitFor(() => {
    expect(screen.queryByRole("listbox")).toBeNull()
  })
}

async function openLinkedTargetWithUpstream(optionName: RegExp) {
  render(<ProjectCreateDialog onCreated={vi.fn()} />)
  fireEvent.click(screen.getByRole("button", { name: /new project/i }))

  fireEvent.change(screen.getByPlaceholderText("My Translation Project"), {
    target: { value: "French Episode 1" },
  })
  fireEvent.change(screen.getByPlaceholderText(/English, Grade 7 English/i), {
    target: { value: "English" },
  })
  fireEvent.change(screen.getByPlaceholderText(/French, conversational Swahili/i), {
    target: { value: "French" },
  })

  fireEvent.click(screen.getByText("Advanced: project shape"))
  fireEvent.click(screen.getByText(/Linked target/i))
  await pickSelectOption(/Upstream project/i, optionName)
}

describe("ProjectCreateDialog — add-as-lane recommendation (AQU-538 slice 3)", () => {
  beforeEach(() => {
    mockCreateCloudProject.mockClear()
    mockLinkProjectSource.mockClear()
    mockCreateProject.mockClear()
    mockFetchProjectSettings.mockReset()
    mockPatchProjectSettings.mockReset()
    mockFetchProjectSettings.mockResolvedValue({
      version: 3,
      updatedAt: "2026-07-13T00:00:00.000Z",
      updatedBy: null,
      settings: { targetLanguage: "English", targetLanes: ["es"] },
    })
    mockPatchProjectSettings.mockResolvedValue({
      kind: "ok",
      value: {
        version: 4,
        updatedAt: "2026-07-13T00:00:01.000Z",
        updatedBy: { id: 1, username: "wendi" },
        settings: { targetLanguage: "English", targetLanes: ["es", "French"] },
      },
    })
  })

  it("renders the recommendation for linked-target + consumes=source with an upstream chosen", async () => {
    await openLinkedTargetWithUpstream(/English Source/i)

    // Defaults to consumes="source" — no need to click the radio.
    const panel = screen.getByTestId("add-as-lane-panel")
    expect(panel).toBeTruthy()
    expect(screen.getByTestId("add-as-lane-btn")).toBeTruthy()
    expect(screen.getByText(/Add it as a target lane on/i)).toBeTruthy()
    // "English Source" appears both in the panel copy and the button label;
    // scope to the panel and accept either/both.
    expect(within(panel).getAllByText(/English Source/i).length).toBeGreaterThan(0)
  })

  it("never shows the recommendation for the chain case (consumes=target)", async () => {
    await openLinkedTargetWithUpstream(/English Source/i)

    fireEvent.click(screen.getByText(/Its translations/i))

    expect(screen.queryByTestId("add-as-lane-panel")).toBeNull()
    expect(screen.queryByTestId("add-as-lane-btn")).toBeNull()
    // The classic linked path stays fully available alongside the steer.
    expect(screen.getByRole("button", { name: /Create & Link/i })).toBeTruthy()
  })

  it("does not render when no upstream project is chosen yet", () => {
    render(<ProjectCreateDialog onCreated={vi.fn()} />)
    fireEvent.click(screen.getByRole("button", { name: /new project/i }))
    fireEvent.click(screen.getByText("Advanced: project shape"))
    fireEvent.click(screen.getByText(/Linked target/i))

    expect(screen.queryByTestId("add-as-lane-btn")).toBeNull()
  })

  it("clicking 'Add as lane' PATCHes the UPSTREAM project's targetLanes and does NOT create a project", async () => {
    await openLinkedTargetWithUpstream(/English Source/i)

    fireEvent.click(screen.getByTestId("add-as-lane-btn"))

    await waitFor(() => {
      expect(mockPatchProjectSettings).toHaveBeenCalledTimes(1)
    })

    expect(mockFetchProjectSettings).toHaveBeenCalledWith("tok", "upstream-1")
    expect(mockPatchProjectSettings).toHaveBeenCalledWith(
      "tok",
      "upstream-1",
      { targetLanes: ["es", "French"] },
      3,
    )

    // Success hint, and no project was ever created.
    await waitFor(() => {
      expect(screen.getByText(/Open that project to start translating/i)).toBeTruthy()
    })
    expect(mockCreateCloudProject).not.toHaveBeenCalled()
    expect(mockCreateProject).not.toHaveBeenCalled()
    expect(mockLinkProjectSource).not.toHaveBeenCalled()

    // Dialog closes shortly after the success hint (deferred so the hint is
    // actually perceivable — see AddAsLaneRecommendation's closeTimerRef).
    await waitFor(
      () => {
        expect(screen.queryByText("Create New Project")).toBeNull()
      },
      { timeout: 2000 },
    )
  })

  it("shows a friendly message on a 403 from the upstream settings PATCH", async () => {
    mockPatchProjectSettings.mockResolvedValueOnce({ kind: "forbidden", required: 600, role: 400 })

    await openLinkedTargetWithUpstream(/English Source/i)
    fireEvent.click(screen.getByTestId("add-as-lane-btn"))

    await waitFor(() => {
      expect(screen.getByText(/need maintainer access/i)).toBeTruthy()
    })
    expect(mockCreateCloudProject).not.toHaveBeenCalled()
  })

  it("rejects a duplicate/case-insensitive lane before PATCHing", async () => {
    mockFetchProjectSettings.mockResolvedValueOnce({
      version: 3,
      updatedAt: "2026-07-13T00:00:00.000Z",
      updatedBy: null,
      settings: { targetLanguage: "English", targetLanes: ["french"] },
    })

    await openLinkedTargetWithUpstream(/English Source/i)
    fireEvent.click(screen.getByTestId("add-as-lane-btn"))

    await waitFor(() => {
      expect(screen.getByText(/already a lane on English Source/i)).toBeTruthy()
    })
    expect(mockPatchProjectSettings).not.toHaveBeenCalled()
  })

  it("disables the button below maintainer when the upstream's role is known", async () => {
    await openLinkedTargetWithUpstream(/Low Role Upstream/i)

    const btn = screen.getByTestId("add-as-lane-btn") as HTMLButtonElement
    expect(btn.disabled).toBe(true)
  })
})
