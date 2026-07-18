// AQU-538 §3.2 — "+ Language" quick action: fetches settings for the version
// pin, validates like LanguagesSection (dedupe vs default + existing), and
// PATCHes targetLanes.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { AddLanguagePopover } from "./AddLanguagePopover"
import type {
  ProjectSettingsResponse,
  PatchResult,
} from "@/lib/sync/project-settings"

const fetchProjectSettings = vi.fn<() => Promise<ProjectSettingsResponse | null>>()
const patchProjectSettings = vi.fn<() => Promise<PatchResult>>()

vi.mock("@/lib/sync/project-settings", () => ({
  fetchProjectSettings: () => fetchProjectSettings(),
  patchProjectSettings: (
    ..._args: unknown[]
  ) => patchProjectSettings(),
}))

function settings(overrides: Partial<ProjectSettingsResponse["settings"]>, version = 3): ProjectSettingsResponse {
  return {
    version,
    updatedAt: "2026-07-14T00:00:00Z",
    updatedBy: null,
    settings: { targetLanguage: "en", targetLanes: [], ...overrides },
  }
}

beforeEach(() => {
  fetchProjectSettings.mockReset()
  patchProjectSettings.mockReset()
})

async function openPopover() {
  render(<AddLanguagePopover projectId="p1" jwt="jwt" />)
  fireEvent.click(screen.getByTestId("org-add-lang-p1"))
  // Wait for settings load to resolve (the input becomes available).
  return waitFor(() => screen.getByLabelText("New target language tag"))
}

describe("AddLanguagePopover (AQU-538 §3.2)", () => {
  it("PATCHes targetLanes with the added lane appended to the existing registry", async () => {
    fetchProjectSettings.mockResolvedValue(settings({ targetLanes: ["es"] }, 5))
    patchProjectSettings.mockResolvedValue({ kind: "ok", value: settings({ targetLanes: ["es", "fr"] }, 6) })

    const input = await openPopover()
    fireEvent.change(input, { target: { value: "fr" } })
    fireEvent.click(screen.getByRole("button", { name: /^add$/i }))

    await waitFor(() => expect(patchProjectSettings).toHaveBeenCalledTimes(1))
  })

  it("rejects a duplicate of an existing lane (case-insensitive) without PATCHing", async () => {
    fetchProjectSettings.mockResolvedValue(settings({ targetLanes: ["es"] }))

    const input = await openPopover()
    fireEvent.change(input, { target: { value: "ES" } })
    fireEvent.click(screen.getByRole("button", { name: /^add$/i }))

    expect(await screen.findByText(/this lane already exists/i)).toBeInTheDocument()
    expect(patchProjectSettings).not.toHaveBeenCalled()
  })

  it("rejects a lane equal to the default target language without PATCHing", async () => {
    fetchProjectSettings.mockResolvedValue(settings({ targetLanguage: "en", targetLanes: [] }))

    const input = await openPopover()
    fireEvent.change(input, { target: { value: "EN" } })
    fireEvent.click(screen.getByRole("button", { name: /^add$/i }))

    expect(await screen.findByText(/already the default target language/i)).toBeInTheDocument()
    expect(patchProjectSettings).not.toHaveBeenCalled()
  })

  it("surfaces a 403 forbidden result inline instead of throwing", async () => {
    fetchProjectSettings.mockResolvedValue(settings({ targetLanes: [] }))
    patchProjectSettings.mockResolvedValue({ kind: "forbidden", required: 600, role: 400 })

    const input = await openPopover()
    fireEvent.change(input, { target: { value: "fr" } })
    fireEvent.click(screen.getByRole("button", { name: /^add$/i }))

    expect(await screen.findByText(/don't have permission/i)).toBeInTheDocument()
  })
})
