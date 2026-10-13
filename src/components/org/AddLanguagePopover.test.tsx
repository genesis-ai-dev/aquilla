// AQU-538 §3.2 — "+ Language" quick action: loads the project's lanes, validates
// like LanguagesSection (dedupe vs the default lane and existing lanes), and
// creates a target lane. AQU-1594: it no longer writes settings.targetLanes.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { AddLanguagePopover } from "./AddLanguagePopover"
import type { CreateLaneResult, ProjectSettingsResponse } from "@/lib/sync/project-settings"

const fetchProjectSettings = vi.fn<() => Promise<ProjectSettingsResponse | null>>()
const createProjectLane = vi.fn<() => Promise<CreateLaneResult>>()

vi.mock("@/lib/sync/project-settings", () => ({
  fetchProjectSettings: () => fetchProjectSettings(),
  createProjectLane: (..._args: unknown[]) => createProjectLane(),
}))

function settings(
  overrides: Partial<ProjectSettingsResponse["settings"]>,
  version = 3,
  lanes: ProjectSettingsResponse["lanes"] = [],
): ProjectSettingsResponse {
  return {
    version,
    updatedAt: "2026-07-14T00:00:00Z",
    updatedBy: null,
    settings: { targetLanguage: "en", targetLanes: [], ...overrides },
    lanes,
  }
}

beforeEach(() => {
  fetchProjectSettings.mockReset()
  createProjectLane.mockReset()
})

async function openPopover() {
  render(<AddLanguagePopover projectId="p1" jwt="jwt" />)
  fireEvent.click(screen.getByTestId("org-add-lang-p1"))
  return waitFor(() => screen.getByLabelText("New target language"))
}

describe("AddLanguagePopover (AQU-538 §3.2)", () => {
  it("creates a target lane for the language the user typed", async () => {
    fetchProjectSettings.mockResolvedValue(
      settings({ targetLanes: [] }, 5, [
        {
          id: "es-lane",
          role: "target",
          language: "es",
          name: null,
          langCode: "es",
          legacyTag: "es",
          position: 1,
          archivedAt: null,
        },
      ]),
    )
    createProjectLane.mockResolvedValue({ kind: "ok", lane: { id: "fr-lane" } } as never)

    const input = await openPopover()
    fireEvent.change(input, { target: { value: "fr" } })
    fireEvent.click(screen.getByRole("button", { name: /^add$/i }))

    await waitFor(() => expect(createProjectLane).toHaveBeenCalledTimes(1))
  })

  it("rejects a duplicate of an existing lane without creating another", async () => {
    fetchProjectSettings.mockResolvedValue(
      settings({}, 3, [
        {
          id: "es-lane",
          role: "target",
          language: "es",
          name: null,
          langCode: "es",
          legacyTag: "es",
          position: 1,
          archivedAt: null,
        },
      ]),
    )

    const input = await openPopover()
    fireEvent.change(input, { target: { value: "ES" } })
    fireEvent.click(screen.getByRole("button", { name: /^add$/i }))

    expect(await screen.findByText(/this lane already exists/i)).toBeInTheDocument()
    expect(createProjectLane).not.toHaveBeenCalled()
  })

  it("rejects a lane equal to the default target language without creating one", async () => {
    fetchProjectSettings.mockResolvedValue(
      settings({ targetLanguage: "en", targetLanes: [] }, 3, [
        {
          id: "default-lane",
          role: "target",
          language: "en",
          name: null,
          langCode: "en",
          legacyTag: "",
          position: 0,
          archivedAt: null,
        },
      ]),
    )

    const input = await openPopover()
    fireEvent.change(input, { target: { value: "EN" } })
    fireEvent.click(screen.getByRole("button", { name: /^add$/i }))

    expect(await screen.findByText(/already the default target language/i)).toBeInTheDocument()
    expect(createProjectLane).not.toHaveBeenCalled()
  })

  it("surfaces a 403 forbidden result inline instead of throwing", async () => {
    fetchProjectSettings.mockResolvedValue(settings({ targetLanes: [] }))
    createProjectLane.mockResolvedValue({ kind: "error", message: "create failed (403)" })

    const input = await openPopover()
    fireEvent.change(input, { target: { value: "fr" } })
    fireEvent.click(screen.getByRole("button", { name: /^add$/i }))

    expect(await screen.findByText(/don't have permission/i)).toBeInTheDocument()
  })
})
