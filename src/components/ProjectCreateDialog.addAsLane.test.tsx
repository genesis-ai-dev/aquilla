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
import { pickComboboxOption } from "@/test-utils/combobox"
import { ProjectCreateDialog } from "./ProjectCreateDialog"

// AQU-1352: the destination picker fetches create-targets on open; submit waits
// for it, so resolve to Personal (the server always lists it).
// AQU-1561: the dialog reads the chosen upstream's file list so the lead can
// pick which files to bring in. These tests are about everything else in the
// create flow, so the list resolves to one file and stays all-checked — the
// whole-project default, which keeps `linkProjectSource` carrying no `fileIds`
// exactly as it did before that slice.
vi.mock("@/lib/sync/link-source-preview", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sync/link-source-preview")>()
  return {
    ...actual,
    loadUpstreamFileChoices: vi
      .fn()
      .mockResolvedValue([{ id: "up-file-1", name: "MAT", clashes: false }]),
  }
})

vi.mock("@/lib/sync/create-targets", () => ({
  fetchCreateTargets: vi.fn().mockResolvedValue([
    { kind: "personal", orgId: null, name: "Personal", path: ["Personal"], role: 700, teams: [] },
  ]),
}))
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
  createProjectLane: vi.fn().mockResolvedValue({ kind: "ok", lane: { id: "lane" } }),
  renameProjectLane: vi.fn().mockResolvedValue({ kind: "ok", lane: { id: "source-lane" } }),

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
import { createProjectLane, fetchProjectSettings } from "@/lib/sync/project-settings"

const mockCreateCloudProject = vi.mocked(createCloudProject)
const mockLinkProjectSource = vi.mocked(linkProjectSource)
const mockCreateProject = vi.mocked(createProject)
const mockFetchProjectSettings = vi.mocked(fetchProjectSettings)
const mockCreateProjectLane = vi.mocked(createProjectLane)

async function pickCorpusSource() {
  fireEvent.click(screen.getByRole("radio", { name: /^Its Source/i }))
}

async function pickCorpusTarget() {
  fireEvent.click(screen.getByRole("radio", { name: /^One of its Targets/i }))
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
  await pickComboboxOption(/Upstream project/i, optionName)
}

describe("ProjectCreateDialog — add-as-lane recommendation (AQU-538 slice 3)", () => {
  beforeEach(() => {
    mockCreateCloudProject.mockClear()
    mockLinkProjectSource.mockClear()
    mockCreateProject.mockClear()
    mockFetchProjectSettings.mockReset()
    mockCreateProjectLane.mockReset()
    mockFetchProjectSettings.mockResolvedValue({
      version: 3,
      updatedAt: "2026-07-13T00:00:00.000Z",
      updatedBy: null,
      settings: { targetLanguage: "English", targetLanes: ["es"] },
    })
    mockCreateProjectLane.mockResolvedValue({ kind: "ok", lane: { id: "lane" } } as never)
  })

  it("renders the recommendation for linked-target + consumes=source with an upstream chosen", async () => {
    await openLinkedTargetWithUpstream(/English Source/i)

    // Corpus choice is not prefilled — pick Its Source to reveal the panel.
    expect(screen.queryByTestId("add-as-lane-panel")).toBeNull()
    pickCorpusSource()

    const panel = screen.getByTestId("add-as-lane-panel")
    expect(panel).toBeTruthy()
    expect(screen.getByTestId("add-as-lane-btn")).toBeTruthy()
    expect(screen.getByText(/Add it as a target lane on/i)).toBeTruthy()
    // "English Source" appears both in the panel copy and the button label;
    // scope to the panel and accept either/both.
    expect(within(panel).getAllByText(/English Source/i).length).toBeGreaterThan(0)
  })

  it("scrolls the recommendation into view when it appears", async () => {
    const scrollIntoView = vi.fn()
    const previous = Element.prototype.scrollIntoView
    // happy-dom does not implement Element.scrollIntoView; stub it so we can
    // assert the mount-time nudge that keeps the panel from landing below
    // the DialogBody fold.
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
      writable: true,
    })

    try {
      await openLinkedTargetWithUpstream(/English Source/i)
      pickCorpusSource()
      expect(screen.getByTestId("add-as-lane-panel")).toBeTruthy()

      await waitFor(() => {
        expect(scrollIntoView).toHaveBeenCalled()
      })
    } finally {
      Object.defineProperty(Element.prototype, "scrollIntoView", {
        configurable: true,
        value: previous,
        writable: true,
      })
    }
  })

  it("never shows the recommendation for the chain case (consumes=target)", async () => {
    await openLinkedTargetWithUpstream(/English Source/i)

    pickCorpusTarget()

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

  it("does not show the recommendation on self-contained clone + Its Source", async () => {
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
    // Self Contained is already checked — pick an upstream to reveal corpus choice.
    await pickComboboxOption(/Upstream project/i, /English Source/i)
    pickCorpusSource()

    expect(screen.queryByTestId("add-as-lane-panel")).toBeNull()
  })

  it("clicking 'Add as lane' creates a lane on the UPSTREAM project and does NOT create a project", async () => {
    await openLinkedTargetWithUpstream(/English Source/i)
    pickCorpusSource()

    fireEvent.click(screen.getByTestId("add-as-lane-btn"))

    await waitFor(() => {
      expect(mockCreateProjectLane).toHaveBeenCalledTimes(1)
    })

    expect(mockFetchProjectSettings).toHaveBeenCalledWith("tok", "upstream-1")
    expect(mockCreateProjectLane).toHaveBeenCalledWith("tok", "upstream-1", {
      name: "",
      language: "French",
    })

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

  it("shows a friendly message on a 403 from the upstream lane create", async () => {
    mockCreateProjectLane.mockResolvedValueOnce({ kind: "error", message: "create failed (403)" })

    await openLinkedTargetWithUpstream(/English Source/i)
    pickCorpusSource()
    fireEvent.click(screen.getByTestId("add-as-lane-btn"))

    await waitFor(() => {
      expect(screen.getByText(/need maintainer access/i)).toBeTruthy()
    })
    expect(mockCreateCloudProject).not.toHaveBeenCalled()
  })

  it("allows adding the upstream's primary language when it is not yet a registered lane", async () => {
    mockFetchProjectSettings.mockResolvedValueOnce({
      version: 3,
      updatedAt: "2026-07-13T00:00:00.000Z",
      updatedBy: null,
      settings: { targetLanguage: "English", targetLanes: ["es"] },
    })

    render(<ProjectCreateDialog onCreated={vi.fn()} />)
    fireEvent.click(screen.getByRole("button", { name: /new project/i }))
    fireEvent.change(screen.getByPlaceholderText("My Translation Project"), {
      target: { value: "English Episode 1" },
    })
    fireEvent.change(screen.getByPlaceholderText(/English, Grade 7 English/i), {
      target: { value: "English" },
    })
    fireEvent.change(screen.getByPlaceholderText(/French, conversational Swahili/i), {
      target: { value: "English" },
    })
    fireEvent.click(screen.getByText("Advanced: project shape"))
    fireEvent.click(screen.getByText(/Linked target/i))
    await pickComboboxOption(/Upstream project/i, /English Source/i)
    pickCorpusSource()
    fireEvent.click(screen.getByTestId("add-as-lane-btn"))

    await waitFor(() => {
      expect(mockCreateProjectLane).toHaveBeenCalledWith("tok", "upstream-1", {
        name: "",
        language: "English",
      })
    })
    expect(screen.queryByText(/already .* default target language/i)).toBeNull()
  })

  it("rejects a duplicate/case-insensitive lane before PATCHing", async () => {
    mockFetchProjectSettings.mockResolvedValueOnce({
      version: 3,
      updatedAt: "2026-07-13T00:00:00.000Z",
      updatedBy: null,
      settings: { targetLanguage: "English", targetLanes: ["french"] },
    })

    await openLinkedTargetWithUpstream(/English Source/i)
    pickCorpusSource()
    fireEvent.click(screen.getByTestId("add-as-lane-btn"))

    await waitFor(() => {
      expect(screen.getByText(/already a lane on English Source/i)).toBeTruthy()
    })
    expect(mockCreateProjectLane).not.toHaveBeenCalled()
  })

  it("disables the button below maintainer when the upstream's role is known", async () => {
    await openLinkedTargetWithUpstream(/Low Role Upstream/i)
    pickCorpusSource()

    const btn = screen.getByTestId("add-as-lane-btn") as HTMLButtonElement
    expect(btn.disabled).toBe(true)
  })
})
