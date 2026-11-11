/**
 * feedback.ts — in-app feedback capture (AQU-1028).
 *
 * Three jobs, all deliberately free of React so they can be unit-tested and
 * reused from any surface:
 *
 *  1. `captureScreenFrame()` — one full-resolution frame of the surface the user
 *     picks. AQU-2467: the dialog hides itself first, then shows the frame in a
 *     crop view; `cropImage()` turns the kept part into the downscaled JPEG.
 *  2. `validateAttachedImage()` — the type and size check for a file the user
 *     attaches from their device (sent as-is, never re-encoded).
 *  3. `submitFeedback()` — POST the answers (+ the image) to the identity
 *     worker's `/api/v2/feedback`, which posts them to the team's private Discord
 *     channel and the admin-defined email routes.
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

/** Resolve after `count` animation frames, so a just-hidden dialog has painted. */
function nextFrames(count: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const step = (left: number) => {
      if (left <= 0 || typeof requestAnimationFrame !== "function") resolve()
      else requestAnimationFrame(() => step(left - 1))
    }
    step(count)
  })
}

/** How long after the stream starts before the frame is grabbed. The picker
 *  closing and the page repainting without the dialog are not instant, and a
 *  frame taken too early shows the dialog the user just hid. */
export const SCREENSHOT_SETTLE_MS = 300

/**
 * Grab one full-resolution frame of the surface the user picks (defaulting to
 * the current tab where Chromium supports `preferCurrentTab`) as a PNG.
 *
 * The caller hides its own dialog BEFORE calling this, so the click that
 * started the capture still counts as the user gesture `getDisplayMedia` needs.
 * AQU-2467: no downscale here; `cropImage()` does that after the user has
 * chosen the part that matters.
 *
 * Throws `ScreenshotCancelled` when the user dismisses the picker; any other
 * failure throws a plain Error the caller reports as "couldn't capture".
 */
export async function captureScreenFrame(
  opts: { settleMs?: number } = {},
): Promise<Blob> {
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
    await new Promise<void>((resolve) => setTimeout(resolve, opts.settleMs ?? SCREENSHOT_SETTLE_MS))
    await nextFrames(2)

    const canvas = document.createElement("canvas")
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    const ctx = canvas.getContext("2d")
    if (!ctx) throw new Error("screen capture could not be rendered")
    ctx.drawImage(video, 0, 0)

    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"))
    if (!blob) throw new Error("screen capture could not be encoded")
    return blob
  } finally {
    // Always release the capture, including on the throw paths above — a live
    // track leaves the browser's "sharing your screen" indicator up for the
    // rest of the session.
    for (const track of stream.getTracks()) track.stop()
  }
}

function loadImage(blob: Blob): Promise<{ image: HTMLImageElement; revoke: () => void }> {
  const url = URL.createObjectURL(blob)
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve({ image, revoke: () => URL.revokeObjectURL(url) })
    image.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error("image could not be read"))
    }
    image.src = url
  })
}

/**
 * Cut `rect` (natural pixels; null keeps the whole image) out of a captured
 * frame, downscale it to `SCREENSHOT_MAX_EDGE_PX` on the long edge and encode
 * it as a JPEG.
 */
export async function cropImage(
  source: Blob,
  rect: { x: number; y: number; width: number; height: number } | null,
): Promise<Blob> {
  const { image, revoke } = await loadImage(source)
  try {
    const area = rect ?? { x: 0, y: 0, width: image.naturalWidth, height: image.naturalHeight }
    const { width, height } = scaleToFit(area.width, area.height)
    const canvas = document.createElement("canvas")
    canvas.width = Math.max(width, 1)
    canvas.height = Math.max(height, 1)
    const ctx = canvas.getContext("2d")
    if (!ctx) throw new Error("screenshot could not be rendered")
    ctx.drawImage(image, area.x, area.y, area.width, area.height, 0, 0, canvas.width, canvas.height)
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", SCREENSHOT_JPEG_QUALITY),
    )
    if (!blob) throw new Error("screenshot could not be encoded")
    return blob
  } finally {
    revoke()
  }
}

/** Image types the server accepts (and stores under a matching extension). */
export const ATTACHABLE_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"] as const

/** Check an image the user chose from their device before anything is sent.
 *  The file goes up as-is, so the 8 MB limit applies to it directly. */
export function validateAttachedImage(file: Blob): "ok" | "wrongType" | "tooLarge" {
  if (!(ATTACHABLE_IMAGE_TYPES as readonly string[]).includes(file.type)) return "wrongType"
  if (file.size > MAX_FEEDBACK_SCREENSHOT_BYTES) return "tooLarge"
  return "ok"
}

const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
}

export interface FeedbackSubmission {
  /** "What happened?" (required). */
  whatHappened: string
  /** "What were you trying to do?" */
  tryingTo?: string
  /** "What did you expect to happen?" */
  expected?: string
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
  const whatHappened = submission.whatHappened.trim()
  const tryingTo = submission.tryingTo?.trim() ?? ""
  const expected = submission.expected?.trim() ?? ""
  if (!whatHappened) {
    throw new FeedbackSubmitError("what happened is required", 400)
  }
  if (
    [whatHappened, tryingTo, expected].some((text) => text.length > MAX_FEEDBACK_DESCRIPTION_CHARS)
  ) {
    throw new FeedbackSubmitError("an answer is too long to send", 400)
  }
  if (submission.screenshot && submission.screenshot.size > MAX_FEEDBACK_SCREENSHOT_BYTES) {
    throw new FeedbackSubmitError("screenshot is too large to send", 413)
  }

  const form = new FormData()
  form.set("whatHappened", whatHappened)
  if (tryingTo) form.set("tryingTo", tryingTo)
  if (expected) form.set("expected", expected)
  form.set("route", submission.route)
  if (submission.projectId) form.set("projectId", submission.projectId)
  if (submission.fileId) form.set("fileId", submission.fileId)
  if (submission.sessionReplayUrl) form.set("sessionReplayUrl", submission.sessionReplayUrl)
  if (submission.screenshot) {
    const name =
      submission.screenshot instanceof File
        ? submission.screenshot.name
        : `screenshot.${IMAGE_EXTENSIONS[submission.screenshot.type] ?? "jpg"}`
    form.set("screenshot", submission.screenshot, name)
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
