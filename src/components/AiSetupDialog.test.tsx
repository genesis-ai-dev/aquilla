import { describe, expect, it, vi, beforeEach } from "vitest"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { I18nProvider } from "@/lib/i18n/I18nProvider"
import type { ProjectRecord } from "@/lib/parsers/types"

const saveSettings = vi.hoisted(() => vi.fn(async () => undefined))
const patchSettings = vi.hoisted(() => vi.fn(async () => ({ kind: "ok" as const })))
const clearUserProviderOverride = vi.hoisted(() => vi.fn())
const overrideState = vi.hoisted(() => ({ current: null as { endpoint: string; apiKey?: string } | null }))

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({
    session: { jwt: "jwt", username: "dev", createdAt: "2026-01-01T00:00:00Z" },
    loading: false,
  }),
}))

vi.mock("@/hooks/useCompletionSettings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/useCompletionSettings")>()
  return {
    ...actual,
    useSaveCompletionSettings: () => saveSettings,
  }
})

vi.mock("@/lib/store/user-provider-override", () => ({
  useUserProviderOverride: () => overrideState.current,
  clearUserProviderOverride: () => clearUserProviderOverride(),
  getUserProviderOverride: () => overrideState.current,
}))

vi.mock("@/lib/store/user-api-keys", () => ({
  getUserApiKey: () => undefined,
  setUserApiKey: vi.fn(),
  resolveApiKey: (_purpose: string, projectValue?: string) => projectValue,
}))

import { AiSetupDialog } from "./AiSetupDialog"

function makeProject(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id: "dev-project",
    name: "Dev Project",
    sourceLanguage: "en",
    targetLanguage: "fr",
    createdAt: "2026-01-01T00:00:00Z",
    files: [],
    members: [],
    ...overrides,
  }
}

function renderDialog(project: ProjectRecord = makeProject(), canEditShared = true) {
  const onOpenChange = vi.fn()
  const onUpdated = vi.fn()
  render(
    <I18nProvider>
      <MemoryRouter initialEntries={["/project/dev-project"]}>
        <Routes>
          <Route
            path="/project/:id"
            element={
              <AiSetupDialog
                open
                onOpenChange={onOpenChange}
                project={project}
                onUpdated={onUpdated}
                patchSettings={patchSettings}
                canEditShared={canEditShared}
              />
            }
          />
        </Routes>
      </MemoryRouter>
    </I18nProvider>,
  )
  return { onOpenChange, onUpdated }
}

function projectKeyOption() {
  return screen.getByRole("button", { name: /^This project's API key/ })
}

beforeEach(() => {
  saveSettings.mockClear()
  patchSettings.mockClear()
  clearUserProviderOverride.mockClear()
  overrideState.current = null
})

describe("AiSetupDialog", () => {
  it("offers Frontier, a project API key, and Continue", () => {
    renderDialog()
    expect(screen.getByRole("button", { name: /Aquilla AI/i })).toBeInTheDocument()
    expect(projectKeyOption()).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Personal override/i })).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Continue" })).toBeInTheDocument()
  })

  it("marks the project chosen on Continue, leaving a project already on Frontier as it is", async () => {
    const { onOpenChange } = renderDialog()
    fireEvent.click(screen.getByRole("button", { name: "Continue" }))
    await waitFor(() => expect(saveSettings).toHaveBeenCalled())
    expect(saveSettings).toHaveBeenCalledWith({}, expect.objectContaining({ aiProviderChosen: true }))
    expect(patchSettings).not.toHaveBeenCalled()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  // AQU-2259: the provider is the team's setting now.
  it("moves the whole project back to Aquilla through the shared settings", async () => {
    renderDialog(makeProject({
      completionSettings: {
        provider: "custom", endpoint: "https://openrouter.ai/api/v1", model: "x/y", maxTokens: 16384, temperature: 0.3,
      } as ProjectRecord["completionSettings"],
    }))
    fireEvent.click(screen.getByRole("button", { name: /Aquilla AI/i }))
    fireEvent.click(screen.getByRole("button", { name: "Continue" }))
    await waitFor(() => expect(patchSettings).toHaveBeenCalled())
    expect(patchSettings).toHaveBeenCalledWith({
      draftingSettings: expect.objectContaining({ provider: "frontier", model: "" }),
    })
  })

  it("shows a personal override option when Preferences already has one", () => {
    overrideState.current = { endpoint: "https://openrouter.ai/api/v1", apiKey: "sk-or-test" }
    renderDialog()
    expect(screen.getByRole("button", { name: /Personal override/i })).toBeInTheDocument()
    expect(screen.getByText(/openrouter\.ai/i)).toBeInTheDocument()
  })

  it("selects the personal override by default when one is already saved", () => {
    overrideState.current = { endpoint: "https://openrouter.ai/api/v1", apiKey: "sk-or-test" }
    renderDialog()
    expect(screen.getByRole("button", { name: /Personal override/i })).toHaveAttribute("aria-pressed", "true")
    expect(screen.getByRole("button", { name: /Aquilla AI/i })).toHaveAttribute("aria-pressed", "false")
  })

  it("requires an API key when choosing this project's API key for OpenRouter", async () => {
    renderDialog()
    fireEvent.click(projectKeyOption())
    fireEvent.click(screen.getByRole("button", { name: "Continue" }))
    expect(await screen.findByText("API key is required for this endpoint")).toBeInTheDocument()
    expect(saveSettings).not.toHaveBeenCalled()
  })

  it("saves the team's OpenRouter choice to the project and the key to this device", async () => {
    const { onOpenChange } = renderDialog()
    fireEvent.click(projectKeyOption())
    fireEvent.change(screen.getByLabelText(/API key/i), { target: { value: "sk-or-user" } })
    fireEvent.click(screen.getByRole("button", { name: "Continue" }))
    await waitFor(() => expect(saveSettings).toHaveBeenCalled())
    expect(patchSettings).toHaveBeenCalledWith({
      draftingSettings: expect.objectContaining({ provider: "custom", endpoint: "https://openrouter.ai/api/v1" }),
    })
    expect(JSON.stringify(patchSettings.mock.calls)).not.toContain("sk-or-user")
    expect(saveSettings).toHaveBeenCalledWith(
      { apiKey: "sk-or-user" },
      expect.objectContaining({ aiProviderChosen: true }),
    )
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("says who can change the project's provider when this person can't", async () => {
    const { onOpenChange } = renderDialog(makeProject(), false)
    fireEvent.click(projectKeyOption())
    fireEvent.change(screen.getByLabelText(/API key/i), { target: { value: "sk-or-user" } })
    fireEvent.click(screen.getByRole("button", { name: "Continue" }))
    expect(await screen.findByText(/set for the whole project/i)).toBeInTheDocument()
    expect(patchSettings).not.toHaveBeenCalled()
    expect(saveSettings).not.toHaveBeenCalled()
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
  })

  it("lets someone who can't change it add their key when the project already uses that provider", async () => {
    const { onOpenChange } = renderDialog(makeProject({
      completionSettings: {
        provider: "custom", endpoint: "https://openrouter.ai/api/v1", model: "", maxTokens: 16384, temperature: 0.3,
      } as ProjectRecord["completionSettings"],
    }), false)
    fireEvent.click(projectKeyOption())
    fireEvent.change(screen.getByLabelText(/API key/i), { target: { value: "sk-mine" } })
    fireEvent.click(screen.getByRole("button", { name: "Continue" }))
    await waitFor(() => expect(saveSettings).toHaveBeenCalled())
    expect(patchSettings).not.toHaveBeenCalled()
    expect(saveSettings).toHaveBeenCalledWith({ apiKey: "sk-mine" }, expect.objectContaining({ aiProviderChosen: true }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("keeps a personal override when Continue saves this project's API key", async () => {
    overrideState.current = { endpoint: "https://openrouter.ai/api/v1", apiKey: "sk-or-prefs" }
    renderDialog()
    fireEvent.click(projectKeyOption())
    fireEvent.change(screen.getByLabelText(/API key/i), { target: { value: "sk-or-project" } })
    fireEvent.click(screen.getByRole("button", { name: "Continue" }))
    await waitFor(() => expect(saveSettings).toHaveBeenCalled())
    expect(saveSettings).toHaveBeenCalledWith(
      { apiKey: "sk-or-project" },
      expect.objectContaining({ aiProviderChosen: true }),
    )
    expect(clearUserProviderOverride).not.toHaveBeenCalled()
  })

  it("uses the personal override without changing the team's provider", async () => {
    overrideState.current = { endpoint: "https://openrouter.ai/api/v1", apiKey: "sk-or-prefs" }
    renderDialog(makeProject({
      completionSettings: {
        provider: "custom",
        endpoint: "https://openrouter.ai/api/v1",
        apiKey: "sk-or-old-project",
        model: "",
        maxTokens: 4096,
        temperature: 0.3,
      } as ProjectRecord["completionSettings"],
    }))
    fireEvent.click(screen.getByRole("button", { name: /Personal override/i }))
    fireEvent.click(screen.getByRole("button", { name: "Continue" }))
    await waitFor(() => expect(saveSettings).toHaveBeenCalled())
    expect(patchSettings).not.toHaveBeenCalled()
    expect(saveSettings).toHaveBeenCalledWith({}, expect.objectContaining({ aiProviderChosen: true }))
    expect(clearUserProviderOverride).not.toHaveBeenCalled()
  })
})
