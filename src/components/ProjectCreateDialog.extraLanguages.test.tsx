// AQU-538 "creation fix" (spec §5 / QA-AQU538-LANES.md "UX gaps" #1): the
// self-contained shape's target field is a single Combobox chips input.
// Type → Enter → pill; first pill is targetLanguage, the rest become
// settings.targetLanes in the SAME create settings PATCH (AQU-1250 — the HTTP
// PATCH handler replaces the whole blob, so a second lanes-only write wiped the
// languages). Source-only and linked-target
// shapes stay single-field — see ProjectCreateDialog.linked.test.tsx /
// ProjectCreateDialog.addAsLane.test.tsx.

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

function targetLangInput() {
  return screen.getByTestId("create-extra-lang-input")
}

/** Commit one or more target-language pills via type → Enter. */
function commitTargetLanguages(...tags: string[]) {
  const input = targetLangInput()
  for (const tag of tags) {
    fireEvent.change(input, { target: { value: tag } })
    fireEvent.keyDown(input, { key: "Enter" })
  }
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
  // Commit the primary target as a pill so further Enter-adds become extras.
  commitTargetLanguages(opts?.target ?? "French")
}

function addExtraLanguage(tag: string) {
  commitTargetLanguages(tag)
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
    expect(screen.getByTestId("create-target-lang-chips")).toBeTruthy()
  })

  it("adds a chip on Enter for primary and extras", () => {
    openDialogWithBasics()
    expect(screen.getByTestId("create-extra-lang-chip-French")).toBeTruthy()

    addExtraLanguage("es")
    expect(screen.getByTestId("create-extra-lang-chip-es")).toBeTruthy()

    fireEvent.change(targetLangInput(), { target: { value: "pt-BR" } })
    fireEvent.keyDown(targetLangInput(), { key: "Enter" })
    expect(screen.getByTestId("create-extra-lang-chip-pt-BR")).toBeTruthy()
  })

  it("rejects a case-insensitive duplicate of an existing chip", () => {
    openDialogWithBasics()
    addExtraLanguage("es")

    addExtraLanguage("ES")
    expect(screen.getAllByTestId("create-extra-lang-chip-es")).toHaveLength(1)
    expect(screen.getByText("Already added.")).toBeTruthy()
  })

  it("rejects a duplicate of the primary target language (case-insensitive)", () => {
    openDialogWithBasics({ target: "French" })

    addExtraLanguage("french")
    expect(screen.queryByTestId("create-extra-lang-chip-french")).toBeNull()
    expect(screen.getByText("Already added.")).toBeTruthy()
  })

  it("rejects blank input on Enter", () => {
    openDialogWithBasics()
    fireEvent.keyDown(targetLangInput(), { key: "Enter" })
    expect(screen.getByText("Enter a language tag.")).toBeTruthy()
  })

  it("removes a chip via its × button", () => {
    openDialogWithBasics()
    addExtraLanguage("es")
    const chip = screen.getByTestId("create-extra-lang-chip-es")
    fireEvent.click(within(chip).getByRole("button", { name: /remove es/i }))
    expect(screen.queryByTestId("create-extra-lang-chip-es")).toBeNull()
  })

  it("submit with 2 extras: creates the project, then PATCHes languages AND both lanes in ONE version-0 write", async () => {
    openDialogWithBasics({ name: "Multilingual Episode 1", source: "English", target: "French" })
    addExtraLanguage("es")
    addExtraLanguage("pt-BR")

    fireEvent.click(screen.getByRole("button", { name: /Create Project/i }))

    await waitFor(() => {
      expect(mockCreateCloudProject).toHaveBeenCalledTimes(1)
    })

    // AQU-1250: exactly ONE settings PATCH. The old second, lanes-only PATCH
    // replaced the whole blob and silently wiped sourceLanguage/targetLanguage,
    // so there is no version re-fetch to make either.
    await waitFor(() => {
      expect(mockPatchProjectSettings).toHaveBeenCalledTimes(1)
    })
    expect(mockFetchProjectSettings).not.toHaveBeenCalled()

    const createOrder = mockCreateCloudProject.mock.invocationCallOrder[0]!
    const patchOrder = mockPatchProjectSettings.mock.invocationCallOrder[0]!
    expect(createOrder).toBeLessThan(patchOrder)

    const [, , settings, version] = mockPatchProjectSettings.mock.calls[0]!
    expect(settings).toEqual({
      sourceLanguage: "English",
      targetLanguage: "French",
      targetLanes: ["es", "pt-BR"],
    })
    expect(version).toBe(0)

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

  it("allows create with a typed primary that was never Enter-committed as a pill", async () => {
    render(<ProjectCreateDialog onCreated={vi.fn()} />)
    fireEvent.click(screen.getByRole("button", { name: /new project/i }))
    fireEvent.change(screen.getByPlaceholderText("My Translation Project"), {
      target: { value: "Draft Primary" },
    })
    fireEvent.change(screen.getByPlaceholderText(/English, Grade 7 English/i), {
      target: { value: "English" },
    })
    // Type only — no Enter — so targetLanguage is live-synced from the draft.
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

  it("a failed settings PATCH still resolves with the created project, and surfaces a non-fatal warning", async () => {
    // AQU-1250: the single languages+lanes PATCH fails.
    mockPatchProjectSettings.mockResolvedValueOnce({ kind: "error", status: 500, message: "boom" })

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

  it("does not offer the multi-language chips UI on the source-only shape", () => {
    render(<ProjectCreateDialog onCreated={vi.fn()} />)
    fireEvent.click(screen.getByRole("button", { name: /new project/i }))
    fireEvent.click(screen.getByText("Advanced: project shape"))
    fireEvent.click(screen.getByText(/Source-only/i))

    expect(screen.queryByTestId("create-extra-lang-input")).toBeNull()
    expect(screen.queryByText("Target language(s)")).toBeNull()
  })

  it("does not offer the multi-language chips UI on the linked-target shape", () => {
    render(<ProjectCreateDialog onCreated={vi.fn()} />)
    fireEvent.click(screen.getByRole("button", { name: /new project/i }))
    fireEvent.click(screen.getByText("Advanced: project shape"))
    fireEvent.click(screen.getByText(/Linked target/i))

    // The single "Target Language" field is still there (required by the
    // shared schema for this shape) — just without the multi-entry list.
    // AQU-832: this label now reuses projectSettings.info.targetLanguageLabel
    // (Title Case, shared with the Project Info card) instead of a separate
    // sentence-case duplicate, so the create dialog renders "Target Language".
    expect(screen.getByText("Target Language")).toBeTruthy()
    expect(screen.queryByText("Target language(s)")).toBeNull()
    expect(screen.queryByTestId("create-extra-lang-input")).toBeNull()
  })
})
