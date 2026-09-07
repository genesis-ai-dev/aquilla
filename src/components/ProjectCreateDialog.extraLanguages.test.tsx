// AQU-538 "creation fix" (spec §5 / QA-AQU538-LANES.md "UX gaps" #1): the
// self-contained shape's target field is one text box per lane, stacked, with
// a plus button that appends another. Box 0 is targetLanguage, the rest become
// settings.targetLanes via a follow-up PATCH. The linked-target shape stays
// single-field — see ProjectCreateDialog.linked.test.tsx /
// ProjectCreateDialog.addAsLane.test.tsx.

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
      projects: [],
      isLoading: false,
      refresh: vi.fn(),
    }),
  }
})

vi.mock("@/lib/sync/cloud-projects", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sync/cloud-projects")>()
  return { ...actual, createCloudProject: vi.fn().mockResolvedValue(undefined) }
})

vi.mock("@/lib/sync/project-settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sync/project-settings")>()
  return {
    ...actual,
    fetchProjectSettings: vi.fn(),
    patchProjectSettings: vi.fn(),
  }
})

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
import { createProject } from "@/lib/store/project-index"
import { fetchProjectSettings, patchProjectSettings } from "@/lib/sync/project-settings"

const mockCreateCloudProject = vi.mocked(createCloudProject)
const mockCreateProject = vi.mocked(createProject)
const mockFetchProjectSettings = vi.mocked(fetchProjectSettings)
const mockPatchProjectSettings = vi.mocked(patchProjectSettings)

function targetLangInput(index = 0) {
  return index === 0
    ? screen.getByTestId("create-extra-lang-input")
    : screen.getByTestId(`create-target-lang-input-${index}`)
}

function addLaneButton() {
  return screen.getByTestId("create-add-target-lang")
}

function openDialogWithBasics(opts?: { name?: string; source?: string; target?: string }) {
  render(<ProjectCreateDialog onCreated={vi.fn()} />)
  fireEvent.click(screen.getByRole("button", { name: /new project/i }))

  fireEvent.change(screen.getByPlaceholderText("My Translation Project"), {
    target: { value: opts?.name ?? "Multilingual Episode 1" },
  })
  fireEvent.change(screen.getByPlaceholderText(/English, Grade 7 English/i), {
    target: { value: opts?.source ?? "English" },
  })
  fireEvent.change(targetLangInput(), { target: { value: opts?.target ?? "French" } })
}

/** Append one box and fill it. Assumes every earlier box is already filled,
 *  since the plus button stays disabled while the last one is blank. */
function addExtraLanguage(tag: string) {
  fireEvent.click(addLaneButton())
  const extras = screen.getAllByTestId(/^create-target-lang-input-\d+$/)
  fireEvent.change(extras[extras.length - 1]!, { target: { value: tag } })
}

describe("ProjectCreateDialog — self-contained target language chips (AQU-538)", () => {
  beforeEach(() => {
    mockCreateCloudProject.mockClear()
    mockCreateProject.mockClear()
    mockFetchProjectSettings.mockReset()
    mockPatchProjectSettings.mockReset()
    mockPatchProjectSettings.mockResolvedValue({
      kind: "ok",
      value: {
        version: 1,
        updatedAt: "2026-07-13T00:00:00.000Z",
        updatedBy: { id: 1, username: "wendi" },
        settings: {},
      },
    })
    mockFetchProjectSettings.mockResolvedValue({
      version: 2,
      updatedAt: "2026-07-13T00:00:00.000Z",
      updatedBy: { id: 1, username: "wendi" },
      settings: { sourceLanguage: "English", targetLanguage: "French" },
    })
  })

  it("relabels the field 'Target language(s)' on the default self-contained shape", () => {
    openDialogWithBasics()
    expect(screen.getByText("Target language(s)")).toBeTruthy()
    expect(targetLangInput()).toBeTruthy()
    expect(screen.getByTestId("create-target-lang-inputs")).toBeTruthy()
  })

  it("appends one box per language via the plus button", () => {
    openDialogWithBasics()
    expect(screen.queryAllByTestId(/^create-target-lang-input-\d+$/)).toHaveLength(0)

    addExtraLanguage("es")
    expect(targetLangInput(1)).toHaveProperty("value", "es")

    addExtraLanguage("pt-BR")
    expect(targetLangInput(2)).toHaveProperty("value", "pt-BR")
    expect(targetLangInput()).toHaveProperty("value", "French")
  })

  it("flags a case-insensitive duplicate of an earlier box", () => {
    openDialogWithBasics()
    addExtraLanguage("es")
    addExtraLanguage("ES")

    expect(screen.getByText("Already added.")).toBeTruthy()
  })

  it("flags a duplicate of the primary target language (case-insensitive)", () => {
    openDialogWithBasics({ target: "French" })
    addExtraLanguage("french")

    expect(screen.getByText("Already added.")).toBeTruthy()
  })

  it("keeps the plus button disabled until the last box has a value", () => {
    openDialogWithBasics()
    expect(addLaneButton()).toHaveProperty("disabled", false)

    fireEvent.click(addLaneButton())
    // The box just added is blank, so there is nothing to add another for.
    expect(addLaneButton()).toHaveProperty("disabled", true)

    fireEvent.change(targetLangInput(1), { target: { value: "es" } })
    expect(addLaneButton()).toHaveProperty("disabled", false)
  })

  it("removes a box via its × button", () => {
    openDialogWithBasics()
    addExtraLanguage("es")

    fireEvent.click(screen.getByTestId("create-target-lang-remove-1"))
    expect(screen.queryAllByTestId(/^create-target-lang-input-\d+$/)).toHaveLength(0)
  })

  it("submit with 2 extras: creates the project, then PATCHes settings with both lanes using the fetched version", async () => {
    openDialogWithBasics({ name: "Multilingual Episode 1", source: "English", target: "French" })
    addExtraLanguage("es")
    addExtraLanguage("pt-BR")

    fireEvent.click(screen.getByRole("button", { name: /Create Project/i }))

    await waitFor(() => {
      expect(mockCreateCloudProject).toHaveBeenCalledTimes(1)
      expect(mockFetchProjectSettings).toHaveBeenCalledTimes(1)
    })

    // create → fetch(for version) → PATCH targetLanes, in that order.
    const createOrder = mockCreateCloudProject.mock.invocationCallOrder[0]!
    const fetchOrder = mockFetchProjectSettings.mock.invocationCallOrder[0]!
    expect(createOrder).toBeLessThan(fetchOrder)

    const [, projectId] = mockFetchProjectSettings.mock.calls[0]!
    expect(projectId).toEqual(expect.any(String))

    // Two PATCH calls: the existing sourceLanguage/targetLanguage seed write
    // (version 0, untouched by this slice), then the targetLanes write using
    // the version returned by fetchProjectSettings (2, from the mock above).
    await waitFor(() => {
      expect(mockPatchProjectSettings).toHaveBeenCalledTimes(2)
    })
    const lanesCall = mockPatchProjectSettings.mock.calls.find(
      (call) => (call[2] as { targetLanes?: string[] }).targetLanes,
    )
    expect(lanesCall).toBeTruthy()
    const [, lanesProjectId, lanesSettings, lanesVersion] = lanesCall!
    expect(lanesProjectId).toEqual(projectId)
    expect(lanesSettings).toEqual({ targetLanes: ["es", "pt-BR"] })
    expect(lanesVersion).toBe(2)

    expect(mockCreateProject).toHaveBeenCalledTimes(1)
  })

  it("submits with no extras and issues no targetLanes PATCH", async () => {
    openDialogWithBasics()
    fireEvent.click(screen.getByRole("button", { name: /Create Project/i }))

    await waitFor(() => {
      expect(mockCreateCloudProject).toHaveBeenCalledTimes(1)
    })
    expect(mockFetchProjectSettings).not.toHaveBeenCalled()
    // Only the pre-existing sourceLanguage/targetLanguage seed write.
    await waitFor(() => {
      expect(mockPatchProjectSettings).toHaveBeenCalledTimes(1)
    })
    expect(mockPatchProjectSettings.mock.calls[0]![2]).not.toHaveProperty("targetLanes")
  })

  it("creates with only the primary box filled and no lanes added", async () => {
    render(<ProjectCreateDialog onCreated={vi.fn()} />)
    fireEvent.click(screen.getByRole("button", { name: /new project/i }))
    fireEvent.change(screen.getByPlaceholderText("My Translation Project"), {
      target: { value: "Draft Primary" },
    })
    fireEvent.change(screen.getByPlaceholderText(/English, Grade 7 English/i), {
      target: { value: "English" },
    })
    fireEvent.change(targetLangInput(), { target: { value: "Swahili" } })
    fireEvent.click(screen.getByRole("button", { name: /Create Project/i }))

    await waitFor(() => {
      expect(mockCreateCloudProject).toHaveBeenCalledTimes(1)
    })
    await waitFor(() => {
      expect(mockPatchProjectSettings).toHaveBeenCalledTimes(1)
    })
    expect(mockPatchProjectSettings.mock.calls[0]![2]).toMatchObject({
      targetLanguage: "Swahili",
    })
    expect(mockFetchProjectSettings).not.toHaveBeenCalled()
  })

  it("PATCH failure for targetLanes still resolves with the created project, and surfaces a non-fatal warning", async () => {
    // First PATCH (seed sourceLanguage/targetLanguage) succeeds; second
    // (targetLanes) fails.
    mockPatchProjectSettings
      .mockResolvedValueOnce({
        kind: "ok",
        value: {
          version: 1,
          updatedAt: "2026-07-13T00:00:00.000Z",
          updatedBy: { id: 1, username: "wendi" },
          settings: {},
        },
      })
      .mockResolvedValueOnce({ kind: "error", status: 500, message: "boom" })

    openDialogWithBasics()
    addExtraLanguage("es")

    fireEvent.click(screen.getByRole("button", { name: /Create Project/i }))

    await waitFor(() => {
      expect(mockCreateProject).toHaveBeenCalledTimes(1)
    })

    expect(
      screen.getByText(
        "Project created; adding extra languages failed — add them in Settings → Languages.",
      ),
    ).toBeTruthy()

    // Non-fatal: the project was still created (not rolled back), and the
    // dialog is left open (not the hard-failure "submitError" path).
    expect(screen.getByText("Create New Project")).toBeTruthy()
  })

  it("no longer offers the retired source-only shape", () => {
    render(<ProjectCreateDialog onCreated={vi.fn()} />)
    fireEvent.click(screen.getByRole("button", { name: /new project/i }))
    fireEvent.click(screen.getByText("Advanced: project shape"))

    expect(screen.queryByText(/Source-only/i)).toBeNull()
  })

  it("offers the same multi-lane boxes on the linked-target shape", () => {
    render(<ProjectCreateDialog onCreated={vi.fn()} />)
    fireEvent.click(screen.getByRole("button", { name: /new project/i }))
    fireEvent.click(screen.getByText("Advanced: project shape"))
    fireEvent.click(screen.getByText(/Linked target/i))

    // A linked target is the Biblica case — one upstream source, several
    // languages — so it needs lanes at creation just as much as a
    // self-contained project does.
    expect(screen.getByText("Target language(s)")).toBeTruthy()
    expect(screen.getByTestId("create-extra-lang-input")).toBeTruthy()
    expect(screen.getByTestId("create-add-target-lang")).toBeTruthy()
  })

  it("toggles between the two shapes from the linked-target checkbox", () => {
    render(<ProjectCreateDialog onCreated={vi.fn()} />)
    fireEvent.click(screen.getByRole("button", { name: /new project/i }))
    fireEvent.click(screen.getByText("Advanced: project shape"))

    const toggle = () => screen.getByTestId("create-shape-linked-target")
    expect(toggle().getAttribute("aria-checked")).toBe("false")
    expect(screen.queryByText("Upstream project")).toBeNull()

    // Checking reveals the upstream picker and leaves the lane boxes alone.
    fireEvent.click(screen.getByText(/Linked target/i))
    expect(toggle().getAttribute("aria-checked")).toBe("true")
    expect(screen.getByText("Upstream project")).toBeTruthy()
    expect(screen.getByTestId("create-extra-lang-input")).toBeTruthy()

    // Unchecking must return to self-contained rather than stranding the form
    // in a shape that still demands an upstream.
    fireEvent.click(screen.getByText(/Linked target/i))
    expect(toggle().getAttribute("aria-checked")).toBe("false")
    expect(screen.queryByText("Upstream project")).toBeNull()
    expect(screen.getByTestId("create-extra-lang-input")).toBeTruthy()
  })
})
