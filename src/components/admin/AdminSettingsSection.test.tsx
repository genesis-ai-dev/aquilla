/**
 * AdminSettingsSection — global platform settings form. Verifies it loads the
 * current settings into the managed model list (with the effective chat/agent
 * defaults marked), and PATCHes with the optimistic version on save.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { AdminSettingsSection } from "./AdminSettingsSection"
import type { PlatformSettingsResponse } from "@/lib/frontier/admin"

vi.mock("@/lib/frontier/admin", () => ({
  getPlatformSettings: vi.fn(),
  updatePlatformSettings: vi.fn(),
  getAbResults: vi.fn(async () => ({ days: 30, results: [] })),
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
  it("loads settings and lists the allowed models", async () => {
    mockGet.mockResolvedValue(RESPONSE)
    render(<AdminSettingsSection jwt="jwt" />)

    // Model IDs can also appear as challenger <option>s — assert presence, not uniqueness.
    expect((await screen.findAllByText("anthropic/claude-sonnet-4.5")).length).toBeGreaterThan(0)
    expect(screen.getAllByText("anthropic/claude-haiku-4-5").length).toBeGreaterThan(0)
    expect(mockGet).toHaveBeenCalledWith("jwt")
  })

  it("saves the models + defaults with the current version (optimistic concurrency)", async () => {
    mockGet.mockResolvedValue(RESPONSE)
    mockUpdate.mockResolvedValue({ settings: {}, version: 4 })
    render(<AdminSettingsSection jwt="jwt" />)

    await screen.findByText("anthropic/claude-sonnet-4.5")
    fireEvent.click(screen.getByRole("button", { name: /save settings/i }))

    await waitFor(() => expect(mockUpdate).toHaveBeenCalled())
    const [, patch] = mockUpdate.mock.calls[0]
    expect(patch).toMatchObject({
      defaultLlmModel: "anthropic/claude-sonnet-4.5",
      agentModel: "anthropic/claude-haiku-4-5",
      allowedModels: ["anthropic/claude-sonnet-4.5", "anthropic/claude-haiku-4-5"],
      ifMatchVersion: 3,
    })
  })

  it("adds a model and marks it as the chat default before saving", async () => {
    mockGet.mockResolvedValue(RESPONSE)
    mockUpdate.mockResolvedValue({ settings: {}, version: 4 })
    render(<AdminSettingsSection jwt="jwt" />)

    await screen.findByText("anthropic/claude-sonnet-4.5")
    fireEvent.change(screen.getByLabelText(/add a model id/i), { target: { value: "openai/gpt-5" } })
    fireEvent.click(screen.getByRole("button", { name: /^add$/i }))

    // The new model's row appears (it's also a challenger <option> — take the <li>).
    const newRow = screen
      .getAllByText("openai/gpt-5")
      .map((el) => el.closest("li"))
      .find((li): li is HTMLLIElement => li !== null)!
    fireEvent.click(newRow.querySelector('[aria-label^="Chat"]')!)
    fireEvent.click(screen.getByRole("button", { name: /save settings/i }))

    await waitFor(() => expect(mockUpdate).toHaveBeenCalled())
    const [, patch] = mockUpdate.mock.calls[0]
    expect(patch.allowedModels).toContain("openai/gpt-5")
    expect(patch.defaultLlmModel).toBe("openai/gpt-5")
  })

  it("configures the A/B experiment and includes it in the PATCH", async () => {
    mockGet.mockResolvedValue(RESPONSE)
    mockUpdate.mockResolvedValue({ settings: {}, version: 4 })
    render(<AdminSettingsSection jwt="jwt" />)
    await screen.findByText("anthropic/claude-sonnet-4.5")

    fireEvent.click(screen.getByRole("switch", { name: /enable a\/b experiment/i }))
    fireEvent.change(screen.getByLabelText("Challenger model"), {
      target: { value: "anthropic/claude-haiku-4-5" },
    })
    fireEvent.change(screen.getByLabelText("Challenger traffic %"), { target: { value: "25" } })
    fireEvent.click(screen.getByRole("button", { name: /save settings/i }))

    await waitFor(() => expect(mockUpdate).toHaveBeenCalled())
    const [, patch] = mockUpdate.mock.calls[0]
    expect(patch.abTest).toEqual({
      enabled: true,
      challengerModel: "anthropic/claude-haiku-4-5",
      trafficPct: 25,
    })
  })

  it("surfaces a save error", async () => {
    mockGet.mockResolvedValue(RESPONSE)
    mockUpdate.mockRejectedValue(new Error("model_not_allowed"))
    render(<AdminSettingsSection jwt="jwt" />)

    await screen.findByText("anthropic/claude-sonnet-4.5")
    fireEvent.click(screen.getByRole("button", { name: /save settings/i }))

    expect(await screen.findByText(/model_not_allowed/i)).toBeInTheDocument()
  })
})
