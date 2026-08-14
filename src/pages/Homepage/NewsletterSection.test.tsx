/**
 * The homepage partner-letter section is a REQUEST form (curated list), not a
 * subscription: it POSTs to the auth-worker newsletter endpoint and shows a
 * clear "request received" state — no auto-join, no booking-tab side effect.
 * The payload shape here is the producer side of auth-worker
 * routes/contact.ts's newsletterSchema — field names must stay in sync, and
 * organization is required.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { NewsletterSection } from "./NewsletterSection"

const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal("fetch", fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function fillAndSubmit() {
  fireEvent.change(screen.getByLabelText(/name/i), { target: { value: "Mariette du Toit" } })
  fireEvent.change(screen.getByLabelText(/email/i), { target: { value: "mariette@example.com" } })
  fireEvent.change(screen.getByLabelText(/organization/i), { target: { value: "Biblica" } })
  fireEvent.change(screen.getByLabelText(/how do you work with aquilla/i), {
    target: { value: "Global Publishing translation projects" },
  })
  fireEvent.click(screen.getByRole("button", { name: /request the newsletter/i }))
}

describe("NewsletterSection", () => {
  it("renders the heading and frames the list as curated", () => {
    render(<NewsletterSection />)
    expect(
      screen.getByRole("heading", { name: /the frontier r&d partner newsletter/i }),
    ).toBeInTheDocument()
    expect(screen.getByText(/the list is curated/i)).toBeInTheDocument()
    // Organization is required — the backend rejects requests without it.
    expect(screen.getByLabelText(/organization/i)).toBeRequired()
  })

  it("POSTs the request to the newsletter endpoint and shows the received state", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ ok: true, delivered: true }), { status: 200 }),
    )
    render(<NewsletterSection />)
    fillAndSubmit()

    await waitFor(() => expect(screen.getByRole("status")).toBeInTheDocument())
    expect(screen.getByText(/request received/i)).toBeInTheDocument()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toMatch(/\/api\/v2\/contact\/newsletter$/)
    expect(init.method).toBe("POST")
    expect(JSON.parse(String(init.body))).toEqual({
      name: "Mariette du Toit",
      email: "mariette@example.com",
      organization: "Biblica",
      message: "Global Publishing translation projects",
      website: "",
    })
  })

  it("surfaces the server's error message and keeps the form for a retry", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "Too many requests — please try again later." }), {
        status: 429,
      }),
    )
    render(<NewsletterSection />)
    fillAndSubmit()

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument())
    expect(screen.getByRole("alert")).toHaveTextContent(/too many requests/i)
    expect(screen.getByRole("button", { name: /request the newsletter/i })).toBeInTheDocument()
  })

  it("shows a generic failure when the network call throws", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"))
    render(<NewsletterSection />)
    fillAndSubmit()

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument())
    expect(screen.getByRole("button", { name: /request the newsletter/i })).toBeInTheDocument()
  })
})
