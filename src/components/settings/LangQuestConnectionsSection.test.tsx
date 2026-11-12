// Preferences → Connected organizations (AQU-2105 follow-up): each LangQuest
// org the account holds a token for, its health, "Check now", Reconnect when
// the token stopped working, and Disconnect. Tokens never reach this page.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { LangQuestConnectionsSection } from "./LangQuestConnectionsSection"
import type { LangQuestConnection } from "@/lib/langquest/types"

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "tok", username: "anna" }, loading: false }),
}))
vi.mock("@/lib/langquest/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/langquest/api")>()
  return {
    ...actual,
    fetchLangQuestConnections: vi.fn(),
    checkLangQuestConnection: vi.fn(),
    connectLangQuest: vi.fn(),
    disconnectLangQuest: vi.fn().mockResolvedValue({ ok: true, revoked: true }),
  }
})

import { checkLangQuestConnection, connectLangQuest, disconnectLangQuest, fetchLangQuestConnections } from "@/lib/langquest/api"

const conn = (over: Partial<LangQuestConnection> = {}): LangQuestConnection => ({
  id: "conn-1",
  apiBase: "https://next.langquest.org/api/v1",
  org: { id: "org-1", name: "Kalam Team" },
  token: { id: "t1", name: "Aquilla", scopes: ["read", "release"], expiresAt: null, allLanguages: true },
  health: "ok",
  lastCheckedAt: "2026-11-01T10:00:00Z",
  lastError: null,
  linkedProjects: 2,
  connectedAt: "2026-10-01T00:00:00Z",
  updatedAt: null,
  ...over,
})

describe("LangQuestConnectionsSection", () => {
  beforeEach(() => vi.clearAllMocks())

  it("lists each connected org with its health, linked-project count and scopes", async () => {
    vi.mocked(fetchLangQuestConnections).mockResolvedValue([conn()])
    render(<LangQuestConnectionsSection />)
    expect((await screen.findByTestId("langquest-connection-org")).textContent).toBe("Kalam Team")
    expect(screen.getByTestId("langquest-health")).toHaveAttribute("data-health", "ok")
    expect(screen.getByText(/2 linked projects/)).toBeInTheDocument()
    expect(screen.getByText(/Scopes: read, release/)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Check now" })).toBeInTheDocument()
  })

  it("Check now asks LangQuest and shows the verdict", async () => {
    vi.mocked(fetchLangQuestConnections).mockResolvedValue([conn()])
    vi.mocked(checkLangQuestConnection).mockResolvedValue({ connection: conn({ health: "needs_reauth", lastError: "That token is not valid." }) })
    render(<LangQuestConnectionsSection />)
    fireEvent.click(await screen.findByRole("button", { name: "Check now" }))
    await waitFor(() => expect(screen.getByTestId("langquest-health")).toHaveAttribute("data-health", "needs_reauth"))
    expect(checkLangQuestConnection).toHaveBeenCalledWith("tok", "conn-1")
    expect(screen.getByText("That token is not valid.")).toBeInTheDocument()
  })

  it("a broken connection offers Reconnect, which opens LangQuest Connect and a token form; a new token repairs the row", async () => {
    vi.mocked(fetchLangQuestConnections).mockResolvedValue([conn({ health: "expired" })])
    vi.mocked(connectLangQuest).mockResolvedValue({ connection: conn({ health: "ok" }), languages: [] })
    render(<LangQuestConnectionsSection />)
    fireEvent.click(await screen.findByTestId("langquest-reconnect"))
    const form = await screen.findByTestId("langquest-settings-token-form")
    expect(form.querySelector("a[target=_blank]")).toHaveAttribute("href", "https://next.langquest.org/connect")
    fireEvent.change(screen.getByLabelText("LangQuest access token"), { target: { value: "lqp_abcdefghijklmnop1234" } })
    fireEvent.click(screen.getByRole("button", { name: "Connect" }))
    await waitFor(() => expect(screen.getByTestId("langquest-health")).toHaveAttribute("data-health", "ok"))
    expect(screen.getAllByTestId("langquest-connection-org")).toHaveLength(1)
  })

  it("Disconnect asks first, then forgets and revokes", async () => {
    vi.mocked(fetchLangQuestConnections).mockResolvedValue([conn()])
    render(<LangQuestConnectionsSection />)
    fireEvent.click(await screen.findByRole("button", { name: "Disconnect" }))
    expect(await screen.findByText("Disconnect Kalam Team?")).toBeInTheDocument()
    // The confirm dialog's checkbox gates the destructive button; click its
    // label (happy-dom double-toggles a click on the control itself).
    fireEvent.click(screen.getByText("I understand this action."))
    const confirms = screen.getAllByRole("button", { name: "Disconnect" })
    await waitFor(() => expect(confirms[confirms.length - 1]!).toBeEnabled())
    fireEvent.click(confirms[confirms.length - 1]!)
    await waitFor(() => expect(disconnectLangQuest).toHaveBeenCalledWith("tok", "conn-1", { revoke: true }))
    await waitFor(() => expect(screen.queryByTestId("langquest-connection-org")).toBeNull())
    expect(screen.getByText("No LangQuest organization is connected yet.")).toBeInTheDocument()
  })
})
