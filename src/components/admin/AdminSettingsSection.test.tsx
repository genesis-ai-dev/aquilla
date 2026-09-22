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
    // Nothing is STORED for the tiers, so `effective` reports the fallback —
    // the same frontier model everything else runs on.
    contextualFastModel: "anthropic/claude-sonnet-4.5",
    contextualDeepModel: "anthropic/claude-sonnet-4.5",
    allowedModels: ["anthropic/claude-sonnet-4.5", "anthropic/claude-haiku-4-5"],
  },
}

beforeEach(() => vi.clearAllMocks())
afterEach(() => vi.restoreAllMocks())

async function pickSelectOption(triggerLabel: string, optionName: RegExp) {
  fireEvent.click(screen.getByLabelText(triggerLabel))
  const option = await screen.findByRole("option", { name: optionName })
  fireEvent.pointerMove(option)
  fireEvent.mouseMove(option)
  fireEvent.keyDown(option, { key: "Enter" })
}

describe("AdminSettingsSection", () => {
  it("hydrates the optional tiers from the STORED value, not the effective one", async () => {
    // Seeding from `effective` would render an unset tier as pinned, and the
    // next save would silently write a value the admin never chose.
    mockGet.mockResolvedValue(RESPONSE)
    mockUpdate.mockResolvedValue({ settings: {}, version: 4 })
    render(<AdminSettingsSection jwt="jwt" />)
    await screen.findAllByText("anthropic/claude-sonnet-4.5")

    fireEvent.click(screen.getByRole("button", { name: /save/i }))
    await waitFor(() => expect(mockUpdate).toHaveBeenCalled())
    expect(mockUpdate.mock.calls[0][1]).toMatchObject({
      contextualFastModel: "",
      contextualDeepModel: "",
    })
  })

  it("sends a chosen fast tier and can clear it again", async () => {
    mockGet.mockResolvedValue({
      ...RESPONSE,
      settings: { contextualFastModel: "anthropic/claude-haiku-4-5" },
    })
    mockUpdate.mockResolvedValue({ settings: {}, version: 4 })
    render(<AdminSettingsSection jwt="jwt" />)
    await screen.findAllByText("anthropic/claude-haiku-4-5")

    fireEvent.click(screen.getByRole("button", { name: /save/i }))
    await waitFor(() => expect(mockUpdate).toHaveBeenCalled())
    expect(mockUpdate.mock.calls[0][1]).toMatchObject({
      contextualFastModel: "anthropic/claude-haiku-4-5",
    })
  })

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
    await pickSelectOption("Challenger model", /anthropic\/claude-haiku-4-5/)
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

describe("AdminSettingsSection — AQU-942: the form survives the post-save refetch", () => {
  it("keeps the form mounted while the post-save refetch is in flight", async () => {
    // WHY: `save` re-fetches to pick up the new version, flipping `loading`
    // back on — which replaced the entire settings form with skeletons on
    // every save.
    mockGet.mockResolvedValue(RESPONSE)
    mockUpdate.mockResolvedValue({ settings: {}, version: 4 })
    render(<AdminSettingsSection jwt="jwt" />)
    const save = await screen.findByRole("button", { name: /save settings/i })

    let release: (settings: PlatformSettingsResponse) => void = () => {}
    mockGet.mockImplementationOnce(
      () => new Promise<PlatformSettingsResponse>((resolve) => { release = resolve }),
    )
    fireEvent.click(save)
    await waitFor(() => expect(mockUpdate).toHaveBeenCalled())

    // The button reads "Saving…" while busy, so anchor on the form itself.
    expect(screen.getByText(/Global AI configuration for the whole platform/)).toBeInTheDocument()
    expect(
      screen.queryByRole("status", { name: "Loading platform settings" }),
    ).not.toBeInTheDocument()

    release({ ...RESPONSE, version: 4 })
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /save settings/i })).toBeInTheDocument(),
    )
  })

  it("shows a first-load placeholder before the first resolve", async () => {
    let release: (settings: PlatformSettingsResponse) => void = () => {}
    mockGet.mockImplementationOnce(
      () => new Promise<PlatformSettingsResponse>((resolve) => { release = resolve }),
    )
    render(<AdminSettingsSection jwt="jwt" />)

    expect(screen.getByRole("status", { name: "Loading platform settings" })).toHaveAttribute(
      "aria-busy",
      "true",
    )

    release(RESPONSE)
    expect(await screen.findByRole("button", { name: /save settings/i })).toBeInTheDocument()
  })
})
