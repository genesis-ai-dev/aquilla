/**
 * AdminSettingsSection — global platform settings form. Verifies it loads the
 * current settings, renders the model dropdown from the allowed list, and PATCHes
 * with the optimistic version on save.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { AdminSettingsSection } from "./AdminSettingsSection"
import type { PlatformSettingsResponse } from "@/lib/frontier/admin"

vi.mock("@/lib/frontier/admin", () => ({
  getPlatformSettings: vi.fn(),
  updatePlatformSettings: vi.fn(),
}))
import { getPlatformSettings, updatePlatformSettings } from "@/lib/frontier/admin"
const mockGet = vi.mocked(getPlatformSettings)
const mockUpdate = vi.mocked(updatePlatformSettings)

const RESPONSE: PlatformSettingsResponse = {
  settings: {},
  version: 3,
  updatedAt: null,
  updatedBy: null,
  effective: {
    defaultLlmModel: "anthropic/claude-sonnet-4.5",
    agentModel: "anthropic/claude-haiku-4-5",
    allowedModels: ["anthropic/claude-sonnet-4.5", "anthropic/claude-haiku-4-5"],
  },
}

beforeEach(() => vi.clearAllMocks())
afterEach(() => vi.restoreAllMocks())

describe("AdminSettingsSection", () => {
  it("loads settings and shows the effective model in the dropdown", async () => {
    mockGet.mockResolvedValue(RESPONSE)
    render(<AdminSettingsSection jwt="jwt" />)

    const select = (await screen.findByLabelText("Default chat model")) as HTMLSelectElement
    expect(select.value).toBe("anthropic/claude-sonnet-4.5")
    expect(mockGet).toHaveBeenCalledWith("jwt")
  })

  it("saves the chosen model with the current version (optimistic concurrency)", async () => {
    mockGet.mockResolvedValue(RESPONSE)
    mockUpdate.mockResolvedValue({ settings: {}, version: 4 })
    render(<AdminSettingsSection jwt="jwt" />)

    const select = (await screen.findByLabelText("Default chat model")) as HTMLSelectElement
    fireEvent.change(select, { target: { value: "anthropic/claude-haiku-4-5" } })
    fireEvent.click(screen.getByRole("button", { name: /save settings/i }))

    await waitFor(() => expect(mockUpdate).toHaveBeenCalled())
    const [, patch] = mockUpdate.mock.calls[0]
    expect(patch).toMatchObject({
      defaultLlmModel: "anthropic/claude-haiku-4-5",
      ifMatchVersion: 3,
    })
  })

  it("surfaces a save error", async () => {
    mockGet.mockResolvedValue(RESPONSE)
    mockUpdate.mockRejectedValue(new Error("model_not_allowed"))
    render(<AdminSettingsSection jwt="jwt" />)

    await screen.findByLabelText("Default chat model")
    fireEvent.click(screen.getByRole("button", { name: /save settings/i }))

    expect(await screen.findByText(/model_not_allowed/i)).toBeInTheDocument()
  })
})
