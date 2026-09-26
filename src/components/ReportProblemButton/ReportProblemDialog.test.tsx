/**
 * AQU-1028 — the feedback dialog's delivery contract.
 *
 * The regression this suite exists to prevent is the one AQU-1028 fixed: before
 * it, the dialog only submitted when the user had analytics consent ON, so the
 * stuck user least likely to have opted in was also the one whose report went
 * nowhere. Tying delivery back to consent — by re-branching the submit button,
 * or by dropping the server call in favour of the PostHog capture — would be
 * invisible in the UI and silent in production. The first test pins it.
 *
 * The rest pin the screenshot affordance's three outcomes (attached, dismissed,
 * failed), which differ only in what the user is told, and the two ways a send
 * can end short of "the team has it".
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { ScreenshotCancelled } from "@/lib/feedback"
import { ReportProblemDialog } from "./ReportProblemDialog"
import { FeedbackButton } from "./FeedbackButton"

const submitFeedback = vi.hoisted(() => vi.fn())
const captureViewportScreenshot = vi.hoisted(() => vi.fn())
const isScreenshotCaptureSupported = vi.hoisted(() => vi.fn(() => true))
const captureReportProblem = vi.hoisted(() => vi.fn())
const analyticsEnabled = vi.hoisted(() => ({ value: true }))

vi.mock("@/lib/feedback", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/feedback")>()
  return { ...actual, submitFeedback, captureViewportScreenshot, isScreenshotCaptureSupported }
})

vi.mock("@/lib/report-problem", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/report-problem")>()
  return { ...actual, captureReportProblem, getSessionReplayUrl: () => null }
})

vi.mock("@/lib/frontier/session-store", () => ({
  loadActiveSession: async () => ({ jwt: "test-jwt" }),
}))

vi.mock("@/hooks/useAnalyticsConsent", () => ({
  useAnalyticsConsent: () => ({ enabled: analyticsEnabled.value }),
}))

function renderDialog() {
  // A real matched route, not a bare MemoryRouter: the dialog reads :id/:fileId
  // off useParams to tell the team which project the report came from, and a
  // router without the pattern would silently hand it `undefined`.
  return render(
    <MemoryRouter initialEntries={["/project/p1"]}>
      <Routes>
        <Route path="/project/:id" element={<ReportProblemDialog open onOpenChange={() => {}} />} />
      </Routes>
    </MemoryRouter>,
  )
}

function typeDescription(text: string) {
  fireEvent.change(screen.getByPlaceholderText(/what went wrong/i), { target: { value: text } })
}

beforeEach(() => {
  analyticsEnabled.value = true
  isScreenshotCaptureSupported.mockReturnValue(true)
  submitFeedback.mockResolvedValue({ feedbackId: "f1", delivered: true, screenshotKey: null })
  captureViewportScreenshot.mockResolvedValue(
    new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" }),
  )
  vi.stubGlobal("URL", {
    ...globalThis.URL,
    createObjectURL: vi.fn(() => "blob:preview"),
    revokeObjectURL: vi.fn(),
  })
})

afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe("ReportProblemDialog delivery (AQU-1028)", () => {
  it("sends the report to the team even when analytics consent is off", async () => {
    analyticsEnabled.value = false
    renderDialog()

    typeDescription("the editor eats my first keystroke")
    fireEvent.click(screen.getByRole("button", { name: /send report/i }))

    await waitFor(() => expect(submitFeedback).toHaveBeenCalledTimes(1))
    expect(submitFeedback).toHaveBeenCalledWith(
      "test-jwt",
      expect.objectContaining({
        description: "the editor eats my first keystroke",
        route: "/project/p1",
        projectId: "p1",
      }),
    )
    await waitFor(() => expect(screen.getByText(/report received/i)).toBeInTheDocument())
  })

  it("still mirrors the report into analytics when consent is on", async () => {
    renderDialog()
    typeDescription("something broke")
    fireEvent.click(screen.getByRole("button", { name: /send report/i }))

    await waitFor(() => expect(captureReportProblem).toHaveBeenCalledTimes(1))
    expect(captureReportProblem).toHaveBeenCalledWith(
      expect.objectContaining({ description: "something broke", hasScreenshot: false }),
    )
  })

  it("refuses to send an empty description", async () => {
    renderDialog()
    fireEvent.click(screen.getByRole("button", { name: /send report/i }))

    await waitFor(() => expect(screen.getByText(/description is required/i)).toBeInTheDocument())
    expect(submitFeedback).not.toHaveBeenCalled()
  })

  it("keeps the form and explains the failure when the send fails", async () => {
    submitFeedback.mockRejectedValue(new Error("offline"))
    renderDialog()

    typeDescription("cannot reach the server")
    fireEvent.click(screen.getByRole("button", { name: /send report/i }))

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/couldn't send/i))
    // The copy fallback is still there to rescue the text.
    expect(screen.getByRole("button", { name: /copy report/i })).toBeInTheDocument()
    expect(screen.queryByText(/thanks/i)).not.toBeInTheDocument()
  })

  it("says so when the environment accepted the report but sent no mail", async () => {
    submitFeedback.mockResolvedValue({ feedbackId: "f1", delivered: false, screenshotKey: null })
    renderDialog()

    typeDescription("local dev report")
    fireEvent.click(screen.getByRole("button", { name: /send report/i }))

    await waitFor(() =>
      expect(screen.getByText(/no mail delivery configured/i)).toBeInTheDocument(),
    )
  })
})

describe("ReportProblemDialog screenshot (AQU-1028)", () => {
  it("attaches a captured screenshot to the submission", async () => {
    renderDialog()
    typeDescription("look at this layout")

    fireEvent.click(screen.getByRole("button", { name: /attach a screenshot/i }))
    await waitFor(() =>
      expect(screen.getByAltText(/screenshot attached to this report/i)).toBeInTheDocument(),
    )

    fireEvent.click(screen.getByRole("button", { name: /send report/i }))
    await waitFor(() => expect(submitFeedback).toHaveBeenCalledTimes(1))
    expect(submitFeedback.mock.calls[0][1].screenshot).toBeInstanceOf(Blob)
    expect(captureReportProblem).toHaveBeenCalledWith(
      expect.objectContaining({ hasScreenshot: true }),
    )
  })

  it("stays quiet when the user dismisses the share-picker", async () => {
    captureViewportScreenshot.mockRejectedValue(new ScreenshotCancelled())
    renderDialog()

    fireEvent.click(screen.getByRole("button", { name: /attach a screenshot/i }))

    await waitFor(() => expect(captureViewportScreenshot).toHaveBeenCalled())
    expect(screen.queryByText(/couldn't capture/i)).not.toBeInTheDocument()
    expect(screen.queryByAltText(/screenshot attached/i)).not.toBeInTheDocument()
  })

  it("explains a real capture failure without blocking the report", async () => {
    captureViewportScreenshot.mockRejectedValue(new Error("no screens"))
    renderDialog()

    fireEvent.click(screen.getByRole("button", { name: /attach a screenshot/i }))
    await waitFor(() => expect(screen.getByText(/couldn't capture a screenshot/i)).toBeInTheDocument())

    typeDescription("sending without a picture")
    fireEvent.click(screen.getByRole("button", { name: /send report/i }))
    await waitFor(() => expect(submitFeedback).toHaveBeenCalledTimes(1))
    expect(submitFeedback.mock.calls[0][1].screenshot).toBeNull()
  })

  it("detaches the screenshot when removed", async () => {
    renderDialog()
    fireEvent.click(screen.getByRole("button", { name: /attach a screenshot/i }))
    await waitFor(() => expect(screen.getByAltText(/screenshot attached/i)).toBeInTheDocument())

    fireEvent.click(screen.getByRole("button", { name: /remove screenshot/i }))
    await waitFor(() =>
      expect(screen.queryByAltText(/screenshot attached/i)).not.toBeInTheDocument(),
    )

    typeDescription("no picture after all")
    fireEvent.click(screen.getByRole("button", { name: /send report/i }))
    await waitFor(() => expect(submitFeedback).toHaveBeenCalledTimes(1))
    expect(submitFeedback.mock.calls[0][1].screenshot).toBeNull()
  })

  it("hides the affordance entirely where screen capture is unavailable", () => {
    isScreenshotCaptureSupported.mockReturnValue(false)
    renderDialog()
    expect(screen.queryByRole("button", { name: /attach a screenshot/i })).not.toBeInTheDocument()
  })
})

describe("FeedbackButton (AQU-1028)", () => {
  it("is a visible, labelled control — not an item hidden inside a dropdown", () => {
    render(
      <MemoryRouter>
        <FeedbackButton />
      </MemoryRouter>,
    )
    expect(screen.getByRole("button", { name: /feedback/i })).toBeVisible()
  })

  it("keeps an accessible name when collapsed to an icon", () => {
    render(
      <MemoryRouter>
        <FeedbackButton compact />
      </MemoryRouter>,
    )
    expect(screen.getByRole("button", { name: /send feedback to the aquilla team/i })).toBeVisible()
  })

  it("opens the feedback dialog", async () => {
    render(
      <MemoryRouter>
        <FeedbackButton />
      </MemoryRouter>,
    )
    fireEvent.click(screen.getByRole("button", { name: /feedback/i }))
    await waitFor(() =>
      expect(screen.getByPlaceholderText(/what went wrong/i)).toBeInTheDocument(),
    )
  })
})
