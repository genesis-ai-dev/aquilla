/**
 * The homepage "book a call" section must offer both paths: the Google
 * Calendar booking link, and a form that POSTs to the auth-worker contact
 * endpoint and shows a clear sent/error state. The payload shape here is the
 * producer side of auth-worker routes/contact.ts's zod schema — field names
 * must stay in sync.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { BookCallSection, BOOKING_URL } from "./BookCallSection"

const fetchMock = vi.fn()
const openMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  openMock.mockReset()
  vi.stubGlobal("fetch", fetchMock)
  vi.stubGlobal("open", openMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function fillAndSubmit() {
  fireEvent.change(screen.getByLabelText(/name/i), { target: { value: "Ada Lovelace" } })
  fireEvent.change(screen.getByLabelText(/email/i), { target: { value: "ada@example.com" } })
  fireEvent.change(screen.getByLabelText(/organization/i), { target: { value: "Analytical Engines" } })
  fireEvent.change(screen.getByLabelText(/hoping to translate/i), { target: { value: "Docs into Spanish" } })
  fireEvent.click(screen.getByRole("button", { name: /send message/i }))
}

describe("BookCallSection", () => {
  it("renders the heading and the Google Calendar booking link", () => {
    render(<BookCallSection />)
    expect(
      screen.getByRole("heading", { name: /want to start\? book a call with us/i }),
    ).toBeInTheDocument()
    const link = screen.getByRole("link", { name: /book a call/i })
    expect(link).toHaveAttribute("href", BOOKING_URL)
    expect(link).toHaveAttribute("target", "_blank")
  })

  it("POSTs the form to the contact endpoint and shows the sent state", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ ok: true, delivered: true }), { status: 200 }),
    )
    render(<BookCallSection />)
    fillAndSubmit()

    await waitFor(() => expect(screen.getByRole("status")).toBeInTheDocument())
    expect(screen.getByText(/thanks — we'll be in touch/i)).toBeInTheDocument()

    // Successful leads are sent straight to the booking calendar in a new tab.
    expect(openMock).toHaveBeenCalledWith(BOOKING_URL, "_blank", "noopener,noreferrer")

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toMatch(/\/api\/v2\/contact\/book-call$/)
    expect(init.method).toBe("POST")
    expect(JSON.parse(String(init.body))).toEqual({
      name: "Ada Lovelace",
      email: "ada@example.com",
      organization: "Analytical Engines",
      message: "Docs into Spanish",
      website: "",
    })
  })

  it("surfaces the server's error message and keeps the form", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "Too many requests — please try again later." }), {
        status: 429,
      }),
    )
    render(<BookCallSection />)
    fillAndSubmit()

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument())
    expect(screen.getByRole("alert")).toHaveTextContent(/too many requests/i)
    // Form is still there for a retry, and no booking tab was opened.
    expect(screen.getByRole("button", { name: /send message/i })).toBeInTheDocument()
    expect(openMock).not.toHaveBeenCalled()
  })

  it("shows a generic failure when the network call throws", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"))
    render(<BookCallSection />)
    fillAndSubmit()

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument())
    expect(screen.getByRole("button", { name: /send message/i })).toBeInTheDocument()
  })
})
