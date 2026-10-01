// In-app feedback surface (AQU-1028) — mounted at /api/v2/feedback in src/index.ts.
//
//   POST /api/v2/feedback   session JWT required
//     Body = multipart/form-data
//       description      (required, ≤ 5000 chars) — what the user typed
//       route            (optional) — SPA pathname they were on
//       projectId        (optional)
//       fileId           (optional)
//       sessionReplayUrl (optional) — posthog replay link, when analytics are on
//       screenshot       (optional) — image/png|jpeg|webp, ≤ MAX_FEEDBACK_SCREENSHOT_BYTES
//     → { ok, feedbackId, delivered, screenshotKey }
//
// WHY the server and not just PostHog: AQU-307 shipped "Report a problem" as a
// PostHog capture, which means feedback only reaches the team when the user has
// analytics consent ON — exactly the stuck, frustrated user least likely to have
// opted in. Routing through the identity worker makes the message land in the
// team inbox regardless of consent, and gives the screenshot somewhere to live:
// a PostHog event property cannot carry an image.
//
// The screenshot goes to the same `aquilla-snapshots` R2 bucket the agent
// artifacts use (SNAPSHOTS binding), under `{prefix}feedback/{userId}/{id}.{ext}`
// — a separate prefix from `artifacts/` so a retention sweep can treat support
// attachments differently from project data. The email carries the KEY, not the
// bytes: the Cloudflare Email Service binding takes html/text only, and an
// inlined data URI would be stripped by most clients anyway.
//
// Storage and mail both degrade rather than fail. A missing SNAPSHOTS binding
// drops the image and says so in the email; a missing EMAIL binding (local/e2e)
// returns `delivered: false` with a 200. The user's message is never lost to a
// misconfigured side channel — the SPA shows what actually happened.

import { Hono } from "hono"
import { authMiddleware, type AuthHonoEnv } from "../middleware/auth"
import { sendFeedbackEmail } from "../services/email"
import {
  FEEDBACK_MAX_PER_USER,
  countRecentEvents,
  recordAuthEvent,
  userIdentifier,
} from "../utils/rate-limit"

const feedback = new Hono<AuthHonoEnv>()

/** Max screenshot size — 8 MB. A downscaled viewport JPEG is ~100–300 KB, so
 *  this is headroom for a 5K display at PNG quality, not a target. */
export const MAX_FEEDBACK_SCREENSHOT_BYTES = 8 * 1024 * 1024

/** Max description length, mirroring the marketing contact form's message cap. */
export const MAX_FEEDBACK_DESCRIPTION_CHARS = 5000

/** Image types we accept and the extension each is stored under. Anything else
 *  is rejected rather than stored with a guessed extension — the key is the only
 *  handle the team has on the object. */
const SCREENSHOT_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
}

/** `{prefix}feedback/{userId}/{feedbackId}.{ext}`. Prefix is empty in every
 *  current env; mirrors artifactR2Key's handling so the two agree. */
function screenshotR2Key(
  env: AuthHonoEnv["Bindings"],
  userId: number,
  feedbackId: string,
  ext: string,
): string {
  const p = env.R2_KEY_PREFIX?.trim().replace(/^\/+|\/+$/g, "") ?? ""
  const prefix = p ? `${p}/` : ""
  return `${prefix}feedback/${userId}/${feedbackId}.${ext}`
}

/** Read a form field as a trimmed string, or null when absent/blank/a file. */
function field(body: Record<string, unknown>, name: string): string | null {
  const value = body[name]
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed === "" ? null : trimmed
}

feedback.post("/", authMiddleware, async (c) => {
  const user = c.get("user")

  const identifier = userIdentifier(user.id)
  const recent = await countRecentEvents(c.env.AQUILLA_PG, "feedback", identifier, {
    onlyFailures: false,
  })
  if (recent >= FEEDBACK_MAX_PER_USER) {
    return c.json({ error: "Too many feedback submissions — please try again later." }, 429)
  }

  let body: Record<string, unknown>
  try {
    body = await c.req.parseBody()
  } catch {
    return c.json({ error: "Expected a multipart/form-data body." }, 400)
  }

  const description = field(body, "description")
  if (!description) {
    return c.json({ error: "Description is required." }, 400)
  }
  if (description.length > MAX_FEEDBACK_DESCRIPTION_CHARS) {
    return c.json(
      { error: `Description exceeds the ${MAX_FEEDBACK_DESCRIPTION_CHARS}-character limit.` },
      400,
    )
  }

  const feedbackId = crypto.randomUUID()

  // Validate the screenshot BEFORE recording the rate-limit event or sending,
  // so a rejected upload is a clean 400 the user can correct and retry.
  const screenshot = body["screenshot"]
  let screenshotBytes: Uint8Array | null = null
  let screenshotExt: string | null = null
  if (screenshot instanceof File && screenshot.size > 0) {
    const ext = SCREENSHOT_EXTENSIONS[screenshot.type]
    if (!ext) {
      return c.json(
        { error: "Screenshot must be a PNG, JPEG, or WebP image." },
        400,
      )
    }
    if (screenshot.size > MAX_FEEDBACK_SCREENSHOT_BYTES) {
      return c.json(
        { error: `Screenshot exceeds the ${MAX_FEEDBACK_SCREENSHOT_BYTES}-byte limit.` },
        400,
      )
    }
    screenshotBytes = new Uint8Array(await screenshot.arrayBuffer())
    screenshotExt = ext
  }

  await recordAuthEvent(c.env.AQUILLA_PG, "feedback", identifier, true)

  const bucket = c.env.SNAPSHOTS
  let screenshotKey: string | null = null
  if (screenshotBytes && screenshotExt) {
    if (bucket) {
      screenshotKey = screenshotR2Key(c.env, user.id, feedbackId, screenshotExt)
      try {
        await bucket.put(screenshotKey, screenshotBytes, {
          httpMetadata: { contentType: `image/${screenshotExt === "jpg" ? "jpeg" : screenshotExt}` },
        })
      } catch (err) {
        // Losing the image must not lose the message — fall through to the mail
        // with `screenshotDropped` set rather than 500-ing the whole report.
        console.error("[feedback] screenshot upload failed:", err)
        screenshotKey = null
      }
    } else {
      console.warn("[feedback] SNAPSHOTS binding absent — screenshot dropped")
    }
  }

  let delivered: boolean
  try {
    const result = await sendFeedbackEmail(c.env, {
      description,
      username: user.username,
      email: user.email,
      route: field(body, "route") ?? "",
      projectId: field(body, "projectId"),
      fileId: field(body, "fileId"),
      sessionReplayUrl: field(body, "sessionReplayUrl"),
      screenshotKey,
      screenshotDropped: screenshotBytes !== null && screenshotKey === null,
    })
    delivered = result.delivered
  } catch (err) {
    // A configured-but-failing send is a real delivery failure: tell the SPA so
    // it can offer the copy-to-clipboard fallback instead of claiming success.
    console.error("[feedback] email send failed:", err)
    return c.json({ error: "Feedback could not be delivered — please try again." }, 502)
  }

  return c.json({ ok: true, feedbackId, delivered, screenshotKey }, 201)
})

export default feedback
