// AQU-1518 — the Create New Project dialog's "Upstream project" picker is
// searchable. These are the integration-level guards: the picker swap must not
// change which projects are linkable (archived ones stay out, by scroll AND by
// search), a project found by typing must link exactly as one found by
// scrolling did, and dismissing the picker's list must not take the dialog —
// and everything already typed into it — down with it.
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ProjectCreateDialog } from "./ProjectCreateDialog"
import { openCombobox, pickComboboxOption } from "@/test-utils/combobox"

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({
    session: { jwt: "tok", username: "wendi" },
    loading: false,
  }),
}))

const role = { level: 700, name: "owner", source: "creator" } as const

// Enough projects that the old dropdown had to be scrolled, two sharing a
// word, plus an archived one the picker must never offer.
vi.mock("@/hooks/useAccessibleProjects", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/useAccessibleProjects")>()
  return {
    ...actual,
    useProjectsForNavigation: () => ({
      projects: [
        { id: "p-1", name: "English Source", gitlabProjectId: null, role },
        { id: "p-2", name: "French Episode 1", gitlabProjectId: null, role },
        { id: "p-3", name: "French Episode 2", gitlabProjectId: null, role },
        { id: "p-4", name: "Swahili Pilot", gitlabProjectId: null, role },
        {
          id: "p-archived",
          name: "Retired Mandarin Draft",
          gitlabProjectId: null,
          role,
          archivedAt: "2026-01-01T00:00:00.000Z",
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
  PROJECT_SETTINGS_VERSION_INITIAL: 0,
  fetchProjectSettings: vi.fn(),
  patchProjectSettings: vi.fn().mockResolvedValue({
    kind: "ok",
    value: {
      version: 1,
      updatedAt: "2026-07-13T00:00:00.000Z",
      updatedBy: { id: 1, username: "wendi" },
      settings: {},
    },
  }),
}))
vi.mock("@/lib/sync/archive", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sync/archive")>()
  return {
    ...actual,
    linkProjectSource: vi.fn().mockResolvedValue({
      projectId: "new-proj", sourceProjectId: "p-4", mode: "live", consumes: "target",
      gate: "validated", previousSourceProjectId: null, seeded: true,
    }),
    triggerLinkSync: vi.fn().mockResolvedValue(true),
  }
})
vi.mock("@/lib/store/project-index", () => ({
  createProject: vi.fn().mockResolvedValue(undefined),
}))
vi.mock("@/lib/posthog", () => ({ default: { capture: vi.fn() } }))

import { linkProjectSource } from "@/lib/sync/archive"

const mockLinkProjectSource = vi.mocked(linkProjectSource)

const UPSTREAM = /Upstream project/i
const SEARCH = "Search projects"

/** Open the dialog on the linked-target shape, where the picker lives. */
function openLinkedShape() {
  render(<ProjectCreateDialog onCreated={vi.fn()} />)
  fireEvent.click(screen.getByRole("button", { name: /new project/i }))
  fireEvent.click(screen.getByText("Advanced: project shape"))
  fireEvent.click(screen.getByText(/Linked target/i))
}

describe("ProjectCreateDialog — searchable upstream picker (AQU-1518)", () => {
  beforeEach(() => {
    mockLinkProjectSource.mockClear()
  })

  it("offers every linkable project while browsing, and no archived one", async () => {
    openLinkedShape()
    await openCombobox(UPSTREAM, SEARCH)

    for (const name of ["English Source", "French Episode 1", "French Episode 2", "Swahili Pilot"]) {
      expect(await screen.findByRole("option", { name })).toBeInTheDocument()
    }
    expect(screen.queryByRole("option", { name: /Retired Mandarin Draft/ })).not.toBeInTheDocument()
  })

  it("narrows the list to the projects whose name contains the typed text", async () => {
    const user = userEvent.setup()
    openLinkedShape()
    const search = await openCombobox(UPSTREAM, SEARCH)

    await user.type(search, "episode")
    expect(await screen.findByRole("option", { name: "French Episode 1" })).toBeInTheDocument()
    expect(screen.getByRole("option", { name: "French Episode 2" })).toBeInTheDocument()
    expect(screen.queryByRole("option", { name: "English Source" })).not.toBeInTheDocument()

    await user.type(search, " 2")
    expect(await screen.findByRole("option", { name: "French Episode 2" })).toBeInTheDocument()
    expect(screen.queryByRole("option", { name: "French Episode 1" })).not.toBeInTheDocument()
  })

  it("does not surface an archived project even by its exact name", async () => {
    const user = userEvent.setup()
    openLinkedShape()
    const search = await openCombobox(UPSTREAM, SEARCH)

    await user.type(search, "Retired Mandarin Draft")
    expect(await screen.findByText("No projects match.")).toBeInTheDocument()
    expect(screen.queryByRole("option")).not.toBeInTheDocument()
  })

  it("links to the project found by typing, not to whatever the list happened to show first", async () => {
    openLinkedShape()

    fireEvent.change(screen.getByPlaceholderText("My Translation Project"), {
      target: { value: "Swahili Episode 1" },
    })
    fireEvent.change(screen.getByPlaceholderText(/English, Grade 7 English/i), {
      target: { value: "English" },
    })
    fireEvent.change(screen.getByPlaceholderText(/French, conversational Swahili/i), {
      target: { value: "Swahili" },
    })

    await pickComboboxOption(UPSTREAM, "Swahili Pilot", { search: "Pilot", searchName: SEARCH })

    // Picking an upstream still reveals the corpus follow-up question.
    const corpus = await screen.findByText(/Which corpus should become this project's source\?/i)
    expect(corpus).toBeInTheDocument()
    fireEvent.click(screen.getByText(/One of its Targets/i))

    fireEvent.click(screen.getByRole("button", { name: /Create & Link/i }))
    await waitFor(() => expect(mockLinkProjectSource).toHaveBeenCalledTimes(1))
    const [, , linkInput] = mockLinkProjectSource.mock.calls[0]!
    expect(linkInput).toMatchObject({
      sourceProjectId: "p-4",
      mode: "live",
      consumes: "target",
    })
  })

  it("Escape dismisses the picker's list only — the dialog keeps what was typed", async () => {
    const user = userEvent.setup()
    openLinkedShape()

    fireEvent.change(screen.getByPlaceholderText("My Translation Project"), {
      target: { value: "Swahili Episode 1" },
    })
    const search = await openCombobox(UPSTREAM, SEARCH)
    await user.type(search, "Pilot")
    expect(await screen.findByRole("option", { name: "Swahili Pilot" })).toBeInTheDocument()

    await user.keyboard("{Escape}")

    await waitFor(() => expect(screen.queryByRole("option")).not.toBeInTheDocument())
    expect(screen.getByRole("heading", { name: "Create New Project" })).toBeInTheDocument()
    expect(screen.getByPlaceholderText("My Translation Project")).toHaveValue("Swahili Episode 1")
  })

  it("clearing the upstream on a self-contained project drops the corpus question again", async () => {
    const user = userEvent.setup()
    render(<ProjectCreateDialog onCreated={vi.fn()} />)
    fireEvent.click(screen.getByRole("button", { name: /new project/i }))
    fireEvent.click(screen.getByText("Advanced: project shape"))

    // Self-contained + an upstream = the one-time clone path, which asks the
    // same corpus question.
    await pickComboboxOption(UPSTREAM, "English Source", { searchName: SEARCH })
    expect(
      await screen.findByText(/Which corpus should become this project's source\?/i),
    ).toBeInTheDocument()

    await user.click(screen.getByRole("combobox", { name: UPSTREAM }))
    await user.click(await screen.findByTestId("project-option-none"))

    await waitFor(() =>
      expect(
        screen.queryByText(/Which corpus should become this project's source\?/i),
      ).not.toBeInTheDocument(),
    )
  })
})
