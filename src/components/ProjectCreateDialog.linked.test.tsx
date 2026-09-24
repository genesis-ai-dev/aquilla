// AQU-478: linked-project creation flow tests.
//
// Verifies: picking the "Linked target" shape shows the upstream picker +
// clone/live + consumes choice, and submitting calls createCloudProject →
// linkProjectSource (in that order) with the chosen mode/consumes — the
// "create project → link-with-seed → land in it" flow the spec describes.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
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
        { id: "upstream-1", name: "English Source", gitlabProjectId: null, role: { level: 700, name: "owner", source: "creator" } },
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
import { linkProjectSource, triggerLinkSync } from "@/lib/sync/archive"
import { patchProjectSettings } from "@/lib/sync/project-settings"

const mockCreateCloudProject = vi.mocked(createCloudProject)
const mockLinkProjectSource = vi.mocked(linkProjectSource)
const mockTriggerLinkSync = vi.mocked(triggerLinkSync)
const mockPatchProjectSettings = vi.mocked(patchProjectSettings)

// Base UI Select renders a combobox trigger; options live in a portaled
// popup. Clicks on options don't reliably commit a selection under
// happy-dom, but hover-highlighting + Enter does (the keyboard path). The
// trigger's displayed label can lag a tick behind the committed value in
// this harness, so callers assert on the resulting application state
// (e.g. a mocked call's arguments) rather than the trigger's textContent.
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

describe("ProjectCreateDialog — linked-target creation flow", () => {
  beforeEach(() => {
    mockCreateCloudProject.mockClear()
    mockLinkProjectSource.mockClear()
    mockTriggerLinkSync.mockClear()
    mockPatchProjectSettings.mockClear()
    mockLinkProjectSource.mockResolvedValue({
      projectId: "new-proj", sourceProjectId: "upstream-1", mode: "live", consumes: "source",
      gate: "validated", previousSourceProjectId: null, seeded: true,
    })
  })

  it("shows the live intro + upstream picker + corpus choice for the linked-target shape", async () => {
    render(<ProjectCreateDialog onCreated={vi.fn()} />)
    fireEvent.click(screen.getByRole("button", { name: /new project/i }))
    // Self-contained Advanced shows the optional clone path, not the live one.
    fireEvent.click(screen.getByText("Advanced: project shape"))
    expect(screen.getByText(/import a/i)).toBeTruthy()
    expect(screen.queryByText(/creating a/i)).toBeNull()

    fireEvent.click(screen.getByText(/Linked target/i))

    expect(screen.getByText(/creating a/i)).toBeTruthy()
    expect(screen.getByRole("combobox", { name: /Upstream project/i })).toBeTruthy()
    expect(screen.queryByText(/Clone or live\?/i)).toBeNull()
    expect(screen.getByText(/Which corpus should become this project's source\?/i)).toBeTruthy()
  })

  it("shows the upstream project name on the trigger after selection, not its UUID", async () => {
    render(<ProjectCreateDialog onCreated={vi.fn()} />)
    fireEvent.click(screen.getByRole("button", { name: /new project/i }))
    fireEvent.click(screen.getByText("Advanced: project shape"))
    fireEvent.click(screen.getByText(/Linked target/i))

    await pickSelectOption(/Upstream project/i, /English Source/i)

    const trigger = screen.getByRole("combobox", { name: /Upstream project/i })
    await waitFor(() => {
      expect(trigger.textContent).toMatch(/English Source/)
      expect(trigger.textContent).not.toMatch(/upstream-1/)
    })
  })

  it("creates the project then links it to the chosen upstream with mode/consumes", async () => {
    render(<ProjectCreateDialog onCreated={vi.fn()} />)
    fireEvent.click(screen.getByRole("button", { name: /new project/i }))

    fireEvent.change(screen.getByPlaceholderText("My Translation Project"), { target: { value: "French Episode 1" } })
    fireEvent.change(screen.getByPlaceholderText(/English, Grade 7 English/i), { target: { value: "English" } })
    fireEvent.change(screen.getByPlaceholderText(/French, conversational Swahili/i), { target: { value: "French" } })

    fireEvent.click(screen.getByText("Advanced: project shape"))
    fireEvent.click(screen.getByText(/Linked target/i))

    await pickSelectOption(/Upstream project/i, /English Source/i)

    // Corpus choice is no longer prefilled — pick "Its Source" explicitly.
    fireEvent.click(screen.getByRole("radio", { name: /^Its Source/i }))
    fireEvent.click(screen.getByRole("button", { name: /Create & Link/i }))

    await waitFor(() => {
      expect(mockCreateCloudProject).toHaveBeenCalledTimes(1)
      expect(mockLinkProjectSource).toHaveBeenCalledTimes(1)
    })

    // Link call must follow creation (seeding IS the first mirror sync, per
    // the auth-worker route — creating without a server row first 403s).
    const createOrder = mockCreateCloudProject.mock.invocationCallOrder[0]!
    const linkOrder = mockLinkProjectSource.mock.invocationCallOrder[0]!
    expect(createOrder).toBeLessThan(linkOrder)

    const [, projectId, linkInput] = mockLinkProjectSource.mock.calls[0]!
    expect(projectId).toEqual(expect.any(String))
    expect(linkInput).toMatchObject({
      sourceProjectId: "upstream-1",
      mode: "live",
      consumes: "source",
    })

    // QA-BUG-1: the server reported seeding succeeded — no client-side
    // self-heal needed.
    expect(mockTriggerLinkSync).not.toHaveBeenCalled()
  })

  it("applies extra target lanes on the linked-target shape too", async () => {
    render(<ProjectCreateDialog onCreated={vi.fn()} />)
    fireEvent.click(screen.getByRole("button", { name: /new project/i }))

    fireEvent.change(screen.getByPlaceholderText("My Translation Project"), { target: { value: "Multilingual Linked" } })
    fireEvent.change(screen.getByPlaceholderText(/English, Grade 7 English/i), { target: { value: "English" } })
    fireEvent.change(screen.getByTestId("create-extra-lang-input"), { target: { value: "French" } })

    fireEvent.click(screen.getByTestId("create-add-target-lang"))
    fireEvent.change(screen.getByTestId("create-target-lang-input-1"), { target: { value: "es" } })

    fireEvent.click(screen.getByText("Advanced: project shape"))
    fireEvent.click(screen.getByText(/Linked target/i))
    await pickSelectOption(/Upstream project/i, /English Source/i)

    fireEvent.click(screen.getByRole("radio", { name: /^Its Source/i }))
    fireEvent.click(screen.getByRole("button", { name: /Create & Link/i }))

    await waitFor(() => {
      expect(mockLinkProjectSource).toHaveBeenCalledTimes(1)
    })

    // The lanes PATCH used to be gated on the self-contained shape; a linked
    // target is precisely the case that wants several of them.
    await waitFor(() => {
      expect(mockPatchProjectSettings).toHaveBeenCalledTimes(1)
      const [, , settings, version] = mockPatchProjectSettings.mock.calls[0]!
      expect(settings).toEqual({
        sourceLanguage: "English",
        targetLanguage: "French",
        targetLanes: ["French", "es"],
      })
      expect(version).toBe(0)
    })
  })

  it("QA-BUG-1: self-heals client-side when the server reports seeding did NOT run (mode=live)", async () => {
    mockLinkProjectSource.mockResolvedValueOnce({
      projectId: "new-proj", sourceProjectId: "upstream-1", mode: "live", consumes: "source",
      gate: "validated", previousSourceProjectId: null, seeded: false,
    })

    render(<ProjectCreateDialog onCreated={vi.fn()} />)
    fireEvent.click(screen.getByRole("button", { name: /new project/i }))

    fireEvent.change(screen.getByPlaceholderText("My Translation Project"), { target: { value: "French Episode 1" } })
    fireEvent.change(screen.getByPlaceholderText(/English, Grade 7 English/i), { target: { value: "English" } })
    fireEvent.change(screen.getByPlaceholderText(/French, conversational Swahili/i), { target: { value: "French" } })

    fireEvent.click(screen.getByText("Advanced: project shape"))
    fireEvent.click(screen.getByText(/Linked target/i))

    await pickSelectOption(/Upstream project/i, /English Source/i)
    fireEvent.click(screen.getByRole("radio", { name: /^Its Source/i }))
    fireEvent.click(screen.getByRole("button", { name: /Create & Link/i }))

    await waitFor(() => {
      expect(mockLinkProjectSource).toHaveBeenCalledTimes(1)
      expect(mockTriggerLinkSync).toHaveBeenCalledTimes(1)
    })
    const [, healedProjectId] = mockTriggerLinkSync.mock.calls[0]!
    expect(healedProjectId).toEqual(expect.any(String))

    // The self-heal call must follow the failed link call, not precede it.
    const linkOrder = mockLinkProjectSource.mock.invocationCallOrder[0]!
    const healOrder = mockTriggerLinkSync.mock.invocationCallOrder[0]!
    expect(linkOrder).toBeLessThan(healOrder)
  })

  it("shows validation when upstream project is missing for linked-target", async () => {
    render(<ProjectCreateDialog onCreated={vi.fn()} />)
    fireEvent.click(screen.getByRole("button", { name: /new project/i }))
    fireEvent.change(screen.getByPlaceholderText("My Translation Project"), { target: { value: "X" } })
    fireEvent.change(screen.getByPlaceholderText(/English, Grade 7 English/i), { target: { value: "English" } })
    fireEvent.change(screen.getByPlaceholderText(/French, conversational Swahili/i), { target: { value: "French" } })
    fireEvent.click(screen.getByText("Advanced: project shape"))
    fireEvent.click(screen.getByText(/Linked target/i))

    fireEvent.submit(document.getElementById("project-create-form")!)
    await waitFor(() => {
      expect(screen.getByText(/choose an upstream project/i)).toBeInTheDocument()
    })
  })

  it("shows validation when corpus choice is missing for linked-target", async () => {
    render(<ProjectCreateDialog onCreated={vi.fn()} />)
    fireEvent.click(screen.getByRole("button", { name: /new project/i }))
    fireEvent.change(screen.getByPlaceholderText("My Translation Project"), { target: { value: "X" } })
    fireEvent.change(screen.getByPlaceholderText(/English, Grade 7 English/i), { target: { value: "English" } })
    fireEvent.change(screen.getByPlaceholderText(/French, conversational Swahili/i), { target: { value: "French" } })
    fireEvent.click(screen.getByText("Advanced: project shape"))
    fireEvent.click(screen.getByText(/Linked target/i))
    await pickSelectOption(/Upstream project/i, /English Source/i)

    fireEvent.submit(document.getElementById("project-create-form")!)
    await waitFor(() => {
      expect(
        screen.getByText(/Choose which corpus should become this project's source/i),
      ).toBeInTheDocument()
    })
    expect(mockCreateCloudProject).not.toHaveBeenCalled()
  })
})
