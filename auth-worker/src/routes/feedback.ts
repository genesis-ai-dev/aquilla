// In-app feedback surface (AQU-1028) — mounted at /api/v2/feedback in src/index.ts.
//
//   POST /api/v2/feedback   session JWT required
//     Body = multipart/form-data
//       whatHappened     (required, ≤ 5000 chars) — "What happened?"
//       tryingTo         (optional, ≤ 5000 chars) — "What were you trying to do?"
//       expected         (optional, ≤ 5000 chars) — "What did you expect to happen?"
//       description      (legacy) — older clients' single box; read as whatHappened
//                        when whatHappened is absent (AQU-2467)
//       route            (optional) — SPA pathname they were on
//       projectId        (optional)
//       fileId           (optional) — the server looks up its name for the report
//       sessionReplayUrl (optional) — posthog replay link, when analytics are on
//       screenshot       (optional) — image/png|jpeg|webp, ≤ MAX_FEEDBACK_SCREENSHOT_BYTES
//     → 201 { ok, feedbackId, delivered, screenshotKey, emailedRoutes }
//       (`delivered` is Discord only; `emailedRoutes` counts addresses mailed by
//       the admin-defined feedback routes, services/feedback-routes.ts)
//     → 502 { error } when Discord or a route email is refused, so the SPA shows
//       its send-failed message and keeps the typed text (AQU-2467). "No routes
//       matched" and "no EMAIL binding" (local/e2e) are not failures.
//
// WHY the server and not just PostHog: AQU-307 shipped "Report a problem" as a
// PostHog capture, which means feedback only reaches the team when the user has
// analytics consent ON — exactly the stuck, frustrated user least likely to have
// opted in. Routing through the identity worker makes the message land in the
// team's private Discord channel regardless of consent, and gives the
// screenshot somewhere to live: a PostHog event property cannot carry an image.
//
// The screenshot goes to the same `aquilla-snapshots` R2 bucket the agent
// artifacts use (SNAPSHOTS binding), under `{prefix}feedback/{userId}/{id}.{ext}`
// — a separate prefix from `artifacts/` so a retention sweep can treat support
// attachments differently from project data. That copy is the archive; the
// Discord post carries the image as an attachment (so it renders inline) plus
// the key in its footer.
//
// The card names the org, project and user id. The browser only sends the
// project id, and a client-sent org name could be anything, so the server looks
// the project and org up itself, and only when the reporter can read that
// project: otherwise a user could probe org names by guessing project ids. The
// file name comes from the same lookup, under the same rule (AQU-2466).
//
// Storage and Discord both degrade rather than fail. A missing SNAPSHOTS binding
// drops the archive copy and says so on the card; a missing webhook secret
// (local/e2e) returns `delivered: false` with a 200. A mail service that refuses
// a route email is different: that is a 502, never a success (AQU-2467). The
// user's message is never lost to a misconfigured side channel — the SPA shows
// what actually happened.

import { Hono } from "hono"
import { authMiddleware, type AuthHonoEnv } from "../middleware/auth"
import { sendFeedbackToDiscord, type FeedbackAttachment } from "../services/discord-feedback"
import type { FeedbackAnswers } from "../services/feedback-answers"
import { emailFeedbackRoutes } from "../services/feedback-routes"
import { getOrgMemberRole } from "../services/org-permissions"
import { resolveProjectRole } from "../services/project-permissions"
import type { AuthUser, Env } from "../types"
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

interface ProjectContext {
  orgId: number | null
  orgName: string | null
  projectName: string | null
  /** Display name of the reported file, when it belongs to that project. */
  fileName: string | null
}

/** Project and org names for the card. Best effort: a failed lookup, an
 *  unknown project or org, or one the reporter cannot read yields nulls and
 *  the report still goes out (the user and route are always shown). */
async function lookupProjectContext(
  env: Env,
  user: AuthUser,
  projectId: string | null,
  fileId: string | null,
  route: string,
): Promise<ProjectContext> {
  const none: ProjectContext = { orgId: null, orgName: null, projectName: null, fileName: null }
  try {
    if (!projectId) {
      // No project: the user may be on an org page (/orgs/:orgId, e.g. stuck
      // adding a member or creating a project). Name that org if they belong.
      const orgId = Number(/^\/orgs\/(\d+)(?:\/|$)/.exec(route)?.[1])
      if (!Number.isSafeInteger(orgId)) return none
      if ((await getOrgMemberRole(env, orgId, user.id)) === null) return none
      const org = await env.AQUILLA_PG.prepare("SELECT name FROM organizations WHERE id = ?")
        .bind(orgId)
        .first<{ name: string | null }>()
      return { orgId, orgName: org?.name ?? null, projectName: null, fileName: null }
    }
    const role = await resolveProjectRole(env, user, projectId)
    if (!role) return none
    const row = await env.AQUILLA_PG.prepare(
      `SELECT p.name AS project_name, p.org_id, o.name AS org_name
         FROM projects p LEFT JOIN organizations o ON o.id = p.org_id
        WHERE p.id = ?`,
    )
      .bind(projectId)
      .first<{ project_name: string | null; org_id: number | null; org_name: string | null }>()
    if (!row) return none
    // Scoped to the project the reporter can read, so a guessed file id from
    // another project names nothing.
    const file = fileId
      ? await env.AQUILLA_PG.prepare("SELECT name FROM files WHERE id = ? AND project_id = ?")
          .bind(fileId, projectId)
          .first<{ name: string | null }>()
      : null
    return {
      orgId: row.org_id,
      orgName: row.org_name,
      projectName: row.project_name,
      fileName: file?.name?.trim() || null,
    }
  } catch (err) {
    console.warn("[feedback] project/org lookup failed:", err)
    return none
  }
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

  // `description` is what clients before AQU-2467 send; it becomes whatHappened.
  const whatHappened = field(body, "whatHappened") ?? field(body, "description")
  if (!whatHappened) {
    return c.json({ error: "Say what happened." }, 400)
  }
  const answers: FeedbackAnswers = {
    whatHappened,
    tryingTo: field(body, "tryingTo"),
    expected: field(body, "expected"),
  }
  for (const [name, value] of Object.entries(answers)) {
    if (value && value.length > MAX_FEEDBACK_DESCRIPTION_CHARS) {
      return c.json(
        { error: `${name} exceeds the ${MAX_FEEDBACK_DESCRIPTION_CHARS}-character limit.` },
        400,
      )
    }
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

  const projectId = field(body, "projectId")
  const fileId = field(body, "fileId")
  const route = field(body, "route") ?? ""
  const context = await lookupProjectContext(c.env, user, projectId, fileId, route)
  const attachment: FeedbackAttachment | null =
    screenshotBytes && screenshotExt
      ? {
          bytes: screenshotBytes,
          ext: screenshotExt,
          contentType: `image/${screenshotExt === "jpg" ? "jpeg" : screenshotExt}`,
        }
      : null

  const sessionReplayUrl = field(body, "sessionReplayUrl")
  const screenshotDropped = screenshotBytes !== null && screenshotKey === null

  // Discord and the admin-defined email routes go out together. The email
  // helper never throws; it reports `failed`, and that becomes a 502 below once
  // Discord has also been tried, so one refusal never hides the other send.
  const emailed = emailFeedbackRoutes(
    c.env,
    { orgId: context.orgId, projectId: context.orgId !== null ? projectId : null, userId: user.id },
    {
      answers,
      username: user.username,
      userEmail: user.email,
      orgName: context.orgName,
      projectName: context.projectName,
      route,
      fileId,
      fileName: context.fileName,
      sessionReplayUrl,
      screenshotKey,
      screenshotDropped,
      sentAt: new Date().toISOString(),
    },
    attachment,
  )

  let delivered: boolean
  try {
    const result = await sendFeedbackToDiscord(
      c.env,
      {
        answers,
        userId: user.id,
        username: user.username,
        email: user.email,
        route,
        ...context,
        projectId,
        fileId,
        sessionReplayUrl,
        screenshotKey,
        screenshotDropped,
      },
      attachment,
    )
    delivered = result.delivered
  } catch (err) {
    // A configured-but-failing post is a real delivery failure: tell the SPA so
    // it can offer the copy-to-clipboard fallback instead of claiming success.
    console.error("[feedback] discord post failed:", err)
    await emailed
    return c.json({ error: "Feedback could not be delivered — please try again." }, 502)
  }
  const emailResult = await emailed
  if (emailResult.status === "failed") {
    console.error("[feedback] route email refused:", feedbackId)
    return c.json({ error: "Feedback could not be delivered — please try again." }, 502)
  }
  const emailedRoutes = emailResult.count

  return c.json({ ok: true, feedbackId, delivered, screenshotKey, emailedRoutes }, 201)
})

export default feedback
