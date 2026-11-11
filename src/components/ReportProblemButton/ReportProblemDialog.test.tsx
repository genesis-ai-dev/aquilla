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
 *
 * AQU-2467: three answers instead of one, a crop step after "Take a screenshot",
 * and "Attach an image" from the device with its refusals before any send.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { ScreenshotCancelled } from "@/lib/feedback"
import { ReportProblemDialog } from "./ReportProblemDialog"

const submitFeedback = vi.hoisted(() => vi.fn())
const captureScreenFrame = vi.hoisted(() => vi.fn())
const cropImage = vi.hoisted(() => vi.fn())
const isScreenshotCaptureSupported = vi.hoisted(() => vi.fn(() => true))
const captureReportProblem = vi.hoisted(() => vi.fn())
const analyticsEnabled = vi.hoisted(() => ({ value: true }))

vi.mock("@/lib/feedback", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/feedback")>()
  return { ...actual, submitFeedback, captureScreenFrame, cropImage, isScreenshotCaptureSupported }
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
  fireEvent.change(screen.getByLabelText(/what happened\?/i), { target: { value: text } })
}

/** Take a screenshot and keep the whole frame, as the common path does. */
async function takeAndKeepScreenshot() {
  fireEvent.click(screen.getByRole("button", { name: /take a screenshot/i }))
  fireEvent.click(await screen.findByRole("button", { name: /keep whole image/i }))
  await waitFor(() =>
    expect(screen.getByAltText(/screenshot attached to this report/i)).toBeInTheDocument(),
  )
}

function chooseFile(file: File) {
  fireEvent.change(screen.getByTestId("report-image-input"), { target: { files: [file] } })
}

beforeEach(() => {
  analyticsEnabled.value = true
  isScreenshotCaptureSupported.mockReturnValue(true)
  submitFeedback.mockResolvedValue({ feedbackId: "f1", delivered: true, screenshotKey: null })
  captureScreenFrame.mockResolvedValue(new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }))
  cropImage.mockResolvedValue(new Blob([new Uint8Array([4, 5])], { type: "image/jpeg" }))
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
        whatHappened: "the editor eats my first keystroke",
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
      expect.objectContaining({ whatHappened: "something broke", hasScreenshot: false }),
    )
  })

  it("sends all three answers, leaving the optional ones empty when unanswered", async () => {
    renderDialog()
    typeDescription("it froze")
    fireEvent.change(screen.getByLabelText(/what were you trying to do/i), { target: { value: "save" } })
    fireEvent.click(screen.getByRole("button", { name: /send report/i }))

    await waitFor(() => expect(submitFeedback).toHaveBeenCalledTimes(1))
    expect(submitFeedback.mock.calls[0][1]).toMatchObject({
      whatHappened: "it froze",
      tryingTo: "save",
      expected: "",
    })
  })

  it("refuses to send an empty description", async () => {
    renderDialog()
    fireEvent.click(screen.getByRole("button", { name: /send report/i }))

    await waitFor(() => expect(screen.getByText(/say what happened before sending/i)).toBeInTheDocument())
    expect(submitFeedback).not.toHaveBeenCalled()
  })

  it("keeps the form and explains the failure when the send fails", async () => {
    submitFeedback.mockRejectedValue(new Error("offline"))
    renderDialog()

    typeDescription("cannot reach the server")
    fireEvent.click(screen.getByRole("button", { name: /send report/i }))

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/couldn't send/i))
    // The typed text is still there, and the copy fallback can rescue it.
    expect(screen.getByLabelText(/what happened\?/i)).toHaveValue("cannot reach the server")
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

describe("ReportProblemDialog screenshot (AQU-1028, AQU-2467)", () => {
  it("shows the captured frame for cropping, then attaches the cropped image", async () => {
    renderDialog()
    typeDescription("look at this layout")

    await takeAndKeepScreenshot()
    expect(captureScreenFrame).toHaveBeenCalledTimes(1)
    // Keeping the whole image crops with no rectangle.
    expect(cropImage).toHaveBeenCalledWith(expect.any(Blob), null)
    // The typed answer survived the hide-and-restore round trip.
    expect(screen.getByLabelText(/what happened\?/i)).toHaveValue("look at this layout")

    fireEvent.click(screen.getByRole("button", { name: /send report/i }))
    await waitFor(() => expect(submitFeedback).toHaveBeenCalledTimes(1))
    expect(submitFeedback.mock.calls[0][1].screenshot).toBeInstanceOf(Blob)
    expect(captureReportProblem).toHaveBeenCalledWith(
      expect.objectContaining({ hasScreenshot: true }),
    )
  })

  it("keeps the crop button off until a box is drawn, and discards without attaching", async () => {
    renderDialog()
    fireEvent.click(screen.getByRole("button", { name: /take a screenshot/i }))
    expect(await screen.findByRole("button", { name: /use selected area/i })).toBeDisabled()

    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }))
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /keep whole image/i })).not.toBeInTheDocument(),
    )
    expect(screen.queryByAltText(/screenshot attached/i)).not.toBeInTheDocument()
  })

  it("stays quiet when the user dismisses the share-picker", async () => {
    captureScreenFrame.mockRejectedValue(new ScreenshotCancelled())
    renderDialog()

    fireEvent.click(screen.getByRole("button", { name: /take a screenshot/i }))

    await waitFor(() => expect(captureScreenFrame).toHaveBeenCalled())
    expect(screen.queryByText(/couldn't capture/i)).not.toBeInTheDocument()
    expect(screen.queryByAltText(/screenshot attached/i)).not.toBeInTheDocument()
  })

  it("explains a real capture failure without blocking the report", async () => {
    captureScreenFrame.mockRejectedValue(new Error("no screens"))
    renderDialog()

    fireEvent.click(screen.getByRole("button", { name: /take a screenshot/i }))
    await waitFor(() => expect(screen.getByText(/couldn't capture a screenshot/i)).toBeInTheDocument())

    typeDescription("sending without a picture")
    fireEvent.click(screen.getByRole("button", { name: /send report/i }))
    await waitFor(() => expect(submitFeedback).toHaveBeenCalledTimes(1))
    expect(submitFeedback.mock.calls[0][1].screenshot).toBeNull()
  })

  it("detaches the screenshot when removed", async () => {
    renderDialog()
    await takeAndKeepScreenshot()

    fireEvent.click(screen.getByRole("button", { name: /remove screenshot/i }))
    await waitFor(() =>
      expect(screen.queryByAltText(/screenshot attached/i)).not.toBeInTheDocument(),
    )

    typeDescription("no picture after all")
    fireEvent.click(screen.getByRole("button", { name: /send report/i }))
    await waitFor(() => expect(submitFeedback).toHaveBeenCalledTimes(1))
    expect(submitFeedback.mock.calls[0][1].screenshot).toBeNull()
  })

  it("hides Take a screenshot where capture is unavailable but still offers Attach an image", () => {
    isScreenshotCaptureSupported.mockReturnValue(false)
    renderDialog()
    expect(screen.queryByRole("button", { name: /take a screenshot/i })).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: /attach an image/i })).toBeInTheDocument()
  })
})

describe("ReportProblemDialog attach an image (AQU-2467)", () => {
  it("sends a chosen PNG as-is", async () => {
    renderDialog()
    typeDescription("see the picture")
    const file = new File([new Uint8Array([1, 2, 3])], "bug.png", { type: "image/png" })
    chooseFile(file)
    await waitFor(() => expect(screen.getByAltText(/screenshot attached/i)).toBeInTheDocument())

    fireEvent.click(screen.getByRole("button", { name: /send report/i }))
    await waitFor(() => expect(submitFeedback).toHaveBeenCalledTimes(1))
    expect(submitFeedback.mock.calls[0][1].screenshot).toBe(file)
    expect(cropImage).not.toHaveBeenCalled()
  })

  it("refuses an image over 8 MB with a plain message before sending", async () => {
    renderDialog()
    typeDescription("big one")
    chooseFile(new File([new Uint8Array(9 * 1024 * 1024)], "huge.png", { type: "image/png" }))

    expect(await screen.findByRole("alert")).toHaveTextContent(/larger than 8 MB/i)
    expect(screen.queryByAltText(/screenshot attached/i)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: /send report/i }))
    await waitFor(() => expect(submitFeedback).toHaveBeenCalledTimes(1))
    expect(submitFeedback.mock.calls[0][1].screenshot).toBeNull()
  })

  it("refuses a file of the wrong type", async () => {
    renderDialog()
    chooseFile(new File([new Uint8Array([1])], "anim.gif", { type: "image/gif" }))

    expect(await screen.findByRole("alert")).toHaveTextContent(/PNG, JPEG, or WebP/i)
    expect(screen.queryByAltText(/screenshot attached/i)).not.toBeInTheDocument()
    expect(submitFeedback).not.toHaveBeenCalled()
  })
})
