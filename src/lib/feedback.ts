/**
 * feedback.ts — in-app feedback capture (AQU-1028).
 *
 * Two jobs, both deliberately free of React so they can be unit-tested and
 * reused from any surface:
 *
 *  1. `captureViewportScreenshot()` — one frame of what the user is looking at,
 *     as a downscaled JPEG.
 *  2. `submitFeedback()` — POST the message (+ that frame) to the identity
 *     worker's `/api/v2/feedback`, which forwards it to the team inbox.
 *
 * WHY `getDisplayMedia` and not a DOM-rasteriser (html2canvas & co.): the bugs
 * people report are the ones a rasteriser reproduces worst — a mis-painted
 * TipTap selection, a clipped popover, a stuck audio waveform on a <canvas>, a
 * layout that only breaks at their zoom level. Screen capture returns the
 * actual composited pixels, costs no dependency, and asks the user for explicit
 * per-capture consent (the browser's own picker), which is the right default for
 * an image that leaves the device carrying whatever is on screen.
 *
 * The trade is that it is gesture-gated and cancellable — hence
 * `ScreenshotCancelled`, which callers treat as "no screenshot", not an error.
 */

import { AUTH_BASE } from "@/lib/frontier/auth"
import { fetchWithTimeout } from "@/lib/frontier/orgs"

/** Long-edge ceiling for the captured frame. A 4K grab downscales to this
 *  before encoding: still legible for reading UI text in a bug report, roughly
 *  an order of magnitude smaller to store and mail around. */
export const SCREENSHOT_MAX_EDGE_PX = 1600

/** JPEG quality for the capture. 0.85 keeps UI text crisp without the PNG
 *  size penalty of a full-colour screenshot. */
const SCREENSHOT_JPEG_QUALITY = 0.85

/** Mirrors MAX_FEEDBACK_SCREENSHOT_BYTES in auth-worker/src/routes/feedback.ts
 *  so an oversize frame is caught before the upload round-trip. */
export const MAX_FEEDBACK_SCREENSHOT_BYTES = 8 * 1024 * 1024

/** Mirrors MAX_FEEDBACK_DESCRIPTION_CHARS on the server. */
export const MAX_FEEDBACK_DESCRIPTION_CHARS = 5000

/** Upload can carry a multi-hundred-KB image; the 15s API default is tight. */
const SUBMIT_TIMEOUT_MS = 45_000

/** The user dismissed the browser's screen-picker. Not a failure — the dialog
 *  silently returns to "no screenshot attached" rather than showing an error. */
export class ScreenshotCancelled extends Error {
  constructor() {
    super("screenshot capture cancelled by the user")
    this.name = "ScreenshotCancelled"
  }
}

export class FeedbackSubmitError extends Error {
  public status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
    this.name = "FeedbackSubmitError"
  }
}

/**
 * Whether this browser can capture the screen at all. False in the Tauri
 * webview on some platforms, in insecure contexts, and in happy-dom under
 * Vitest — every caller must be able to render without the affordance.
 */
export function isScreenshotCaptureSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getDisplayMedia === "function" &&
    typeof HTMLCanvasElement !== "undefined"
  )
}

/** Fit (w, h) inside a `max`-pixel long edge, never scaling up. */
export function scaleToFit(
  width: number,
  height: number,
  max: number = SCREENSHOT_MAX_EDGE_PX,
): { width: number; height: number } {
  const longEdge = Math.max(width, height)
  if (longEdge <= max || longEdge === 0) {
    return { width: Math.round(width), height: Math.round(height) }
  }
  const ratio = max / longEdge
  return { width: Math.round(width * ratio), height: Math.round(height * ratio) }
}

/** Resolve once the video element has real dimensions to draw from. */
function waitForFrame(video: HTMLVideoElement): Promise<void> {
  if (video.readyState >= 2 && video.videoWidth > 0) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    video.onloadeddata = () => resolve()
    video.onerror = () => reject(new Error("screen capture stream failed to start"))
  })
}

/**
 * Grab one frame of the surface the user picks (defaulting to the current tab
 * where Chromium supports `preferCurrentTab`) as a downscaled JPEG.
 *
 * Throws `ScreenshotCancelled` when the user dismisses the picker; any other
 * failure throws a plain Error the caller reports as "couldn't capture".
 */
export async function captureViewportScreenshot(): Promise<Blob> {
  if (!isScreenshotCaptureSupported()) {
    throw new Error("screen capture is not available in this browser")
  }

  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      // `preferCurrentTab` is Chromium-only and ignored elsewhere; it puts the
      // user's own tab at the top of the picker so the common case is one click.
      video: true,
      audio: false,
      preferCurrentTab: true,
    } as DisplayMediaStreamOptions)
  } catch (err) {
    // Every browser reports a dismissed picker as NotAllowedError, which is
    // also what a policy block looks like — both mean "no image", so both are
    // a cancellation rather than something to show a red error for.
    if (err instanceof DOMException && (err.name === "NotAllowedError" || err.name === "AbortError")) {
      throw new ScreenshotCancelled()
    }
    throw err instanceof Error ? err : new Error(String(err))
  }

  try {
    const video = document.createElement("video")
    video.srcObject = stream
    video.muted = true
    await video.play().catch(() => {
      /* autoplay rejection still leaves a decodable frame; waitForFrame decides */
    })
    await waitForFrame(video)

    const { width, height } = scaleToFit(video.videoWidth, video.videoHeight)
    const canvas = document.createElement("canvas")
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext("2d")
    if (!ctx) throw new Error("screen capture could not be rendered")
    ctx.drawImage(video, 0, 0, width, height)

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", SCREENSHOT_JPEG_QUALITY),
    )
    if (!blob) throw new Error("screen capture could not be encoded")
    return blob
  } finally {
    // Always release the capture, including on the throw paths above — a live
    // track leaves the browser's "sharing your screen" indicator up for the
    // rest of the session.
    for (const track of stream.getTracks()) track.stop()
  }
}

export interface FeedbackSubmission {
  description: string
  route: string
  projectId?: string
  fileId?: string
  sessionReplayUrl?: string | null
  screenshot?: Blob | null
}

export interface FeedbackResult {
  feedbackId: string
  /** False when the worker has no EMAIL binding (local/e2e): the message was
   *  accepted but no mail left the building. The dialog says so rather than
   *  claiming the team has it. */
  delivered: boolean
  screenshotKey: string | null
}

/**
 * POST the feedback to the identity worker. Throws `FeedbackSubmitError` on an
 * oversize screenshot (client-side) or a non-OK response.
 */
export async function submitFeedback(
  jwt: string,
  submission: FeedbackSubmission,
): Promise<FeedbackResult> {
  const description = submission.description.trim()
  if (!description) {
    throw new FeedbackSubmitError("description is required", 400)
  }
  if (submission.screenshot && submission.screenshot.size > MAX_FEEDBACK_SCREENSHOT_BYTES) {
    throw new FeedbackSubmitError("screenshot is too large to send", 413)
  }

  const form = new FormData()
  form.set("description", description)
  form.set("route", submission.route)
  if (submission.projectId) form.set("projectId", submission.projectId)
  if (submission.fileId) form.set("fileId", submission.fileId)
  if (submission.sessionReplayUrl) form.set("sessionReplayUrl", submission.sessionReplayUrl)
  if (submission.screenshot) {
    form.set("screenshot", submission.screenshot, "screenshot.jpg")
  }

  const res = await fetchWithTimeout(
    `${AUTH_BASE}/api/v2/feedback`,
    {
      method: "POST",
      // No Content-Type header: the browser must set the multipart boundary.
      headers: { Authorization: `Bearer ${jwt}` },
      body: form,
    },
    SUBMIT_TIMEOUT_MS,
  )

  if (!res.ok) {
    let detail = ""
    try {
      const body = (await res.json()) as { error?: string }
      detail = typeof body.error === "string" ? body.error : ""
    } catch {
      /* non-JSON error body — nothing to preserve */
    }
    const err = new FeedbackSubmitError(detail || `feedback failed (HTTP ${res.status})`, res.status)
    throw err
  }

  const out = (await res.json()) as Partial<FeedbackResult>
  return {
    feedbackId: out.feedbackId ?? "",
    delivered: out.delivered === true,
    screenshotKey: out.screenshotKey ?? null,
  }
}
