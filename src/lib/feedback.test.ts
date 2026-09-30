/**
 * AQU-1028 — the two halves of in-app feedback that can fail silently.
 *
 * `submitFeedback` is the delivery path: if a field is dropped from the form or
 * the auth header goes missing, the report still "succeeds" in the UI and the
 * team simply never learns which project the user was in. So the assertions
 * read the FormData the client actually builds, not a summary of it.
 *
 * `captureViewportScreenshot` is gesture-gated and cancellable. Two behaviours
 * matter and neither is visible in the happy path: a dismissed share-picker must
 * surface as `ScreenshotCancelled` (the dialog stays quiet) rather than an
 * error, and every exit must stop the MediaStream tracks — a leaked track leaves
 * the browser's "sharing your screen" indicator up for the rest of the session.
 */

import { describe, it, expect, vi, afterEach } from "vitest"
import {
  FeedbackSubmitError,
  MAX_FEEDBACK_SCREENSHOT_BYTES,
  SCREENSHOT_MAX_EDGE_PX,
  ScreenshotCancelled,
  captureViewportScreenshot,
  isScreenshotCaptureSupported,
  scaleToFit,
  submitFeedback,
} from "./feedback"

function okResponse(body: unknown): Response {
  return {
    ok: true,
    status: 201,
    json: async () => body,
  } as unknown as Response
}

function errorResponse(status: number, body: unknown): Response {
  return {
    ok: false,
    status,
    json: async () => body,
  } as unknown as Response
}

/** Replace navigator.mediaDevices for one test. */
function stubDisplayMedia(impl: () => Promise<MediaStream>) {
  vi.stubGlobal("navigator", {
    ...globalThis.navigator,
    mediaDevices: { getDisplayMedia: impl },
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("scaleToFit", () => {
  it("never scales a small capture up", () => {
    expect(scaleToFit(800, 600)).toEqual({ width: 800, height: 600 })
  })

  it("fits the long edge to the ceiling, preserving aspect ratio", () => {
    const { width, height } = scaleToFit(3840, 2160)
    expect(width).toBe(SCREENSHOT_MAX_EDGE_PX)
    expect(height).toBe(Math.round(2160 * (SCREENSHOT_MAX_EDGE_PX / 3840)))
  })

  it("uses the long edge even when the capture is portrait", () => {
    expect(scaleToFit(1000, 4000).height).toBe(SCREENSHOT_MAX_EDGE_PX)
  })

  it("survives a zero-sized stream rather than dividing by zero", () => {
    expect(scaleToFit(0, 0)).toEqual({ width: 0, height: 0 })
  })
})

describe("isScreenshotCaptureSupported", () => {
  it("is false when the browser has no getDisplayMedia", () => {
    vi.stubGlobal("navigator", { ...globalThis.navigator, mediaDevices: {} })
    expect(isScreenshotCaptureSupported()).toBe(false)
  })

  it("is true when getDisplayMedia and canvas are both present", () => {
    stubDisplayMedia(async () => ({}) as MediaStream)
    expect(isScreenshotCaptureSupported()).toBe(true)
  })
})

describe("captureViewportScreenshot", () => {
  it("maps a dismissed share-picker to ScreenshotCancelled, not an error", async () => {
    stubDisplayMedia(async () => {
      throw new DOMException("denied", "NotAllowedError")
    })
    await expect(captureViewportScreenshot()).rejects.toBeInstanceOf(ScreenshotCancelled)
  })

  it("maps an aborted picker to ScreenshotCancelled too", async () => {
    stubDisplayMedia(async () => {
      throw new DOMException("aborted", "AbortError")
    })
    await expect(captureViewportScreenshot()).rejects.toBeInstanceOf(ScreenshotCancelled)
  })

  it("surfaces any other capture failure as a real error", async () => {
    stubDisplayMedia(async () => {
      throw new DOMException("no screens", "NotFoundError")
    })
    await expect(captureViewportScreenshot()).rejects.not.toBeInstanceOf(ScreenshotCancelled)
  })

  it("stops every track even when rendering the frame fails", async () => {
    const stop = vi.fn()
    stubDisplayMedia(async () => ({ getTracks: () => [{ stop }] }) as unknown as MediaStream)
    // happy-dom has no 2D canvas context, so the draw step throws — which is
    // exactly the path that must still release the capture.
    await expect(captureViewportScreenshot()).rejects.toBeTruthy()
    expect(stop).toHaveBeenCalledTimes(1)
  })
})

describe("submitFeedback", () => {
  it("posts every context field and the bearer token", async () => {
    const fetchMock = vi.fn(async () => okResponse({ feedbackId: "f1", delivered: true, screenshotKey: null }))
    vi.stubGlobal("fetch", fetchMock)

    const result = await submitFeedback("jwt-123", {
      description: "  editor drops keystrokes  ",
      route: "/project/p1/file/f1",
      projectId: "p1",
      fileId: "f1",
      sessionReplayUrl: "https://posthog.example/r/1",
    })

    expect(result).toEqual({ feedbackId: "f1", delivered: true, screenshotKey: null })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain("/api/v2/feedback")
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer jwt-123")
    // No hand-set Content-Type: the browser must own the multipart boundary.
    expect((init.headers as Record<string, string>)["Content-Type"]).toBeUndefined()

    const form = init.body as FormData
    expect(form.get("description")).toBe("editor drops keystrokes")
    expect(form.get("route")).toBe("/project/p1/file/f1")
    expect(form.get("projectId")).toBe("p1")
    expect(form.get("fileId")).toBe("f1")
    expect(form.get("sessionReplayUrl")).toBe("https://posthog.example/r/1")
    expect(form.get("screenshot")).toBeNull()
  })

  it("attaches the screenshot blob when one was captured", async () => {
    const fetchMock = vi.fn(async () => okResponse({ feedbackId: "f2", delivered: true, screenshotKey: "feedback/1/f2.jpg" }))
    vi.stubGlobal("fetch", fetchMock)

    const screenshot = new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" })
    const result = await submitFeedback("jwt", {
      description: "look",
      route: "/org",
      screenshot,
    })

    expect(result.screenshotKey).toBe("feedback/1/f2.jpg")
    const form = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as FormData
    expect(form.get("screenshot")).toBeInstanceOf(Blob)
  })

  it("refuses an empty description without a round trip", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    await expect(submitFeedback("jwt", { description: "   ", route: "/" })).rejects.toBeInstanceOf(
      FeedbackSubmitError,
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("refuses an oversize screenshot without a round trip", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    const huge = { size: MAX_FEEDBACK_SCREENSHOT_BYTES + 1, type: "image/jpeg" } as Blob
    await expect(
      submitFeedback("jwt", { description: "big", route: "/", screenshot: huge }),
    ).rejects.toMatchObject({ status: 413 })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("surfaces the server's error message and status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => errorResponse(429, { error: "Too many feedback submissions" })))
    await expect(submitFeedback("jwt", { description: "again", route: "/" })).rejects.toMatchObject({
      status: 429,
      message: "Too many feedback submissions",
    })
  })

  it("treats a missing delivered flag as not delivered rather than assuming success", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okResponse({ feedbackId: "f3" })))
    const result = await submitFeedback("jwt", { description: "x", route: "/" })
    expect(result.delivered).toBe(false)
    expect(result.screenshotKey).toBeNull()
  })
})
