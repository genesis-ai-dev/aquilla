import { describe, expect, it, vi, beforeEach } from "vitest"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { I18nProvider } from "@/lib/i18n/I18nProvider"
import type { ProjectRecord } from "@/lib/parsers/types"

const saveSettings = vi.hoisted(() => vi.fn(async () => undefined))
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

function renderDialog(project: ProjectRecord = makeProject()) {
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
  clearUserProviderOverride.mockClear()
  overrideState.current = null
})

describe("AiSetupDialog", () => {
  it("offers Frontier, a project API key, and Continue", () => {
    renderDialog()
    expect(screen.getByRole("button", { name: /Frontier AI/i })).toBeInTheDocument()
    expect(projectKeyOption()).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Personal override/i })).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Continue" })).toBeInTheDocument()
  })

  it("marks the project chosen and saves Frontier on Continue", async () => {
    const { onOpenChange } = renderDialog()
    fireEvent.click(screen.getByRole("button", { name: "Continue" }))
    await waitFor(() => expect(saveSettings).toHaveBeenCalled())
    expect(saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "frontier" }),
      expect.objectContaining({ aiProviderChosen: true }),
    )
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("shows a personal override option when Preferences already has one", () => {
    overrideState.current = { endpoint: "https://openrouter.ai/api/v1", apiKey: "sk-or-test" }
    renderDialog()
    expect(screen.getByRole("button", { name: /Personal override/i })).toBeInTheDocument()
    expect(screen.getByText(/openrouter\.ai/i)).toBeInTheDocument()
  })

  it("requires an API key when choosing this project's API key for OpenRouter", async () => {
    renderDialog()
    fireEvent.click(projectKeyOption())
    fireEvent.click(screen.getByRole("button", { name: "Continue" }))
    expect(await screen.findByText("API key is required for this endpoint")).toBeInTheDocument()
    expect(saveSettings).not.toHaveBeenCalled()
  })

  it("saves a project OpenRouter key and closes on Continue", async () => {
    const { onOpenChange } = renderDialog()
    fireEvent.click(projectKeyOption())
    fireEvent.change(screen.getByLabelText(/API key/i), { target: { value: "sk-or-user" } })
    fireEvent.click(screen.getByRole("button", { name: "Continue" }))
    await waitFor(() => expect(saveSettings).toHaveBeenCalled())
    expect(saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "custom",
        endpoint: "https://openrouter.ai/api/v1",
        apiKey: "sk-or-user",
      }),
      expect.objectContaining({ aiProviderChosen: true }),
    )
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
      expect.objectContaining({
        provider: "custom",
        apiKey: "sk-or-project",
      }),
      expect.objectContaining({ aiProviderChosen: true }),
    )
    expect(clearUserProviderOverride).not.toHaveBeenCalled()
  })

  it("clears a leftover project key when Continue uses the personal override", async () => {
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
    expect(saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "frontier" }),
      expect.objectContaining({ aiProviderChosen: true }),
    )
    expect(clearUserProviderOverride).not.toHaveBeenCalled()
  })
})
