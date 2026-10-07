/**
 * Thin-client projects are server-loaded and often have no IDB row.
 * Continue used to close Set up AI after a silent no-op, so sparkle asked
 * again and Project Settings stayed on Frontier.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { I18nProvider } from "@/lib/i18n/I18nProvider"
import { AiSetupDialog } from "./AiSetupDialog"
import {
  getProject,
  _resetDbForTesting,
} from "@/lib/store/project-index"
import { shouldPromptAiSetup } from "@/lib/completion/completion-service"
import type { ProjectRecord } from "@/lib/parsers/types"

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({
    session: { jwt: "jwt", username: "dev", createdAt: "2026-01-01T00:00:00Z" },
    loading: false,
  }),
}))

function makeProject(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id: "srv-no-idb",
    name: "Server Project",
    sourceLanguage: "en",
    targetLanguage: "fr",
    createdAt: "2026-01-01T00:00:00Z",
    files: [],
    members: [],
    ...overrides,
  }
}

function renderDialog(project: ProjectRecord) {
  const onOpenChange = vi.fn()
  const onUpdated = vi.fn()
  render(
    <I18nProvider>
      <MemoryRouter initialEntries={["/project/srv-no-idb"]}>
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

beforeEach(async () => {
  await _resetDbForTesting()
})

describe("AiSetupDialog persist (thin client, no IDB row)", () => {
  it("seeds a project OpenRouter key and does not ask Set up AI again", async () => {
    const project = makeProject()
    expect(await getProject(project.id)).toBeUndefined()
    const { onOpenChange, onUpdated } = renderDialog(project)

    fireEvent.click(screen.getByRole("button", { name: /^This project's API key/ }))
    fireEvent.change(screen.getByLabelText(/API key/i), { target: { value: "sk-or-user" } })
    fireEvent.click(screen.getByRole("button", { name: "Continue" }))

    await waitFor(() => expect(onUpdated).toHaveBeenCalled())
    const row = await getProject(project.id)
    expect(row?.completionSettings?.provider).toBe("custom")
    expect(row?.completionSettings?.endpoint).toBe("https://openrouter.ai/api/v1")
    expect(row?.completionSettings?.apiKey).toBe("sk-or-user")
    expect(row?.aiProviderChosen).toBe(true)
    expect(shouldPromptAiSetup(row?.aiProviderChosen)).toBe(false)
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("seeds Frontier as chosen when there is no IDB row yet", async () => {
    const project = makeProject()
    const { onUpdated } = renderDialog(project)
    fireEvent.click(screen.getByRole("button", { name: "Continue" }))
    await waitFor(() => expect(onUpdated).toHaveBeenCalled())
    const row = await getProject(project.id)
    expect(row?.completionSettings?.provider).toBe("frontier")
    expect(row?.aiProviderChosen).toBe(true)
    expect(shouldPromptAiSetup(row?.aiProviderChosen)).toBe(false)
  })
})
