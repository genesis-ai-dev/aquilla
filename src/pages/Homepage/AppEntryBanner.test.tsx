import { render, screen, waitFor } from "@testing-library/react"
import { renderToStaticMarkup } from "react-dom/server"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mockLoadActiveSession = vi.fn()
vi.mock("@/lib/frontier/session-store", () => ({
  loadActiveSession: () => mockLoadActiveSession(),
}))

const { AppEntryBanner } = await import("./AppEntryBanner")

beforeEach(() => {
  vi.clearAllMocks()
  sessionStorage.clear()
})

describe("AppEntryBanner", () => {
  it("renders nothing for a visitor with no session", async () => {
    mockLoadActiveSession.mockResolvedValue(null)
    const { container } = render(<AppEntryBanner />)
    await waitFor(() => expect(mockLoadActiveSession).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })

  it("offers a signed-in visitor the way into the workspace", async () => {
    mockLoadActiveSession.mockResolvedValue({ username: "noeline" })
    render(<AppEntryBanner />)

    const link = await screen.findByRole("link", { name: /noeline/i })
    expect(link).toHaveAttribute("href", "/app")
  })

  it("shows for a stored session even when the token may be expired", async () => {
    // We can't validate a token without a request, and hiding the way back into
    // the app from someone who is signed in is the worse failure. /app re-checks.
    mockLoadActiveSession.mockResolvedValue({ username: "mark", token: "expired" })
    render(<AppEntryBanner />)
    expect(await screen.findByRole("link", { name: /mark/i })).toBeInTheDocument()
  })

  it("survives storage being unavailable", async () => {
    mockLoadActiveSession.mockRejectedValue(new Error("IndexedDB blocked"))
    const { container } = render(<AppEntryBanner />)
    await waitFor(() => expect(mockLoadActiveSession).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })

  it("stays dismissed for the rest of the session", async () => {
    sessionStorage.setItem("aq-appentry-dismissed", "1")
    mockLoadActiveSession.mockResolvedValue({ username: "wendi" })
    const { container } = render(<AppEntryBanner />)
    await waitFor(() => expect(mockLoadActiveSession).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })

  it("is absent from the prerendered markup, so the cached page is identical for everyone", () => {
    // The effect never runs during server rendering. This is what lets the
    // homepage be edge-cached while still steering signed-in visitors.
    mockLoadActiveSession.mockResolvedValue({ username: "noeline" })
    expect(renderToStaticMarkup(<AppEntryBanner />)).toBe("")
    expect(mockLoadActiveSession).not.toHaveBeenCalled()
  })
})
