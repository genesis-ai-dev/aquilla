// Posts in-app feedback (routes/feedback.ts) to a private Discord channel.
//
// Replaces the team email: the report lands in the channel the team already
// watches, with the org, project and user id on the card so nobody has to go
// looking for who sent it.
//
// The transport is a channel webhook, not a bot. A webhook is a secret URL that
// accepts a POST and shows the message in one channel, which is all this needs.
// The URL is a Worker secret (DISCORD_FEEDBACK_WEBHOOK_URL): anyone holding it
// can post to the channel, so it is never logged or echoed in an error.
//
// The screenshot travels as a file attachment so Discord renders it inline. The
// copy in R2 stays as the archive; its key is in the footer.

import type { Env } from "../types"

/** An in-app feedback submission. The sender is an authenticated user, so
 *  identity comes from the session, not the form — only `description` is typed. */
export interface FeedbackSubmission {
  /** Free text the user typed. */
  description: string
  /** Numeric account id (session-derived). */
  userId: number
  username: string
  email: string
  /** SPA route the user was on when they opened the dialog. */
  route: string
  /** Org that owns the project, when the report came from inside one. */
  orgId?: number | null
  orgName?: string | null
  projectId?: string | null
  projectName?: string | null
  fileId?: string | null
  /** posthog-js session replay URL, when analytics are on. */
  sessionReplayUrl?: string | null
  /** R2 key of the archived screenshot, when one was captured and stored. */
  screenshotKey?: string | null
  /** True when the user attached a screenshot but R2 was unavailable. */
  screenshotDropped?: boolean
}

export interface FeedbackAttachment {
  bytes: Uint8Array
  /** `image/png` | `image/jpeg` | `image/webp` */
  contentType: string
  ext: string
}

// Discord's embed limits: 4096 for the description, 1024 per field value.
const EMBED_DESCRIPTION_MAX = 4000
const FIELD_VALUE_MAX = 1000
const EMBED_COLOR = 0x2563eb

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}

function orgLine(s: FeedbackSubmission): string {
  if (s.orgId == null) return "none (not on an org or project page)"
  return s.orgName?.trim() ? `${s.orgName.trim()} (id ${s.orgId})` : `id ${s.orgId}`
}

function projectLine(s: FeedbackSubmission): string | null {
  const id = s.projectId?.trim()
  if (!id) return null
  const name = s.projectName?.trim()
  return name ? `${name} (${id})` : id
}

/**
 * Build the webhook JSON. Pure and exported so the card can be unit-tested
 * without a network. `allowed_mentions.parse = []` means a description that
 * says "@everyone" pings nobody.
 */
export function buildFeedbackDiscordPayload(
  s: FeedbackSubmission,
  opts: { hasAttachment: boolean; screenshotExt?: string; descriptionTruncated: boolean },
): Record<string, unknown> {
  const username = s.username.trim()
  const fields: { name: string; value: string; inline?: boolean }[] = [
    { name: "User", value: clip(`${username} (id ${s.userId})\n${s.email.trim()}`, FIELD_VALUE_MAX), inline: true },
    { name: "Org", value: clip(orgLine(s), FIELD_VALUE_MAX), inline: true },
  ]
  const project = projectLine(s)
  if (project) fields.push({ name: "Project", value: clip(project, FIELD_VALUE_MAX), inline: true })
  fields.push({ name: "Route", value: clip(s.route.trim() || "(unknown)", FIELD_VALUE_MAX) })
  const fileId = s.fileId?.trim()
  if (fileId) fields.push({ name: "File", value: clip(fileId, FIELD_VALUE_MAX), inline: true })
  const replay = s.sessionReplayUrl?.trim()
  if (replay) fields.push({ name: "Session replay", value: clip(replay, FIELD_VALUE_MAX) })
  if (s.screenshotDropped) {
    fields.push({ name: "Screenshot", value: "attached, but object storage was unavailable: not archived" })
  }

  const text = s.description.trim()
  const embed: Record<string, unknown> = {
    title: clip(`Feedback from ${username}`, 250),
    description: opts.descriptionTruncated
      ? `${text.slice(0, EMBED_DESCRIPTION_MAX - 1)}…\n\n*Full text attached as description.txt.*`
      : text,
    color: EMBED_COLOR,
    fields,
  }
  if (s.screenshotKey) embed.footer = { text: clip(`R2: ${s.screenshotKey}`, 2000) }
  if (opts.hasAttachment && opts.screenshotExt) {
    embed.image = { url: `attachment://screenshot.${opts.screenshotExt}` }
  }

  return { embeds: [embed], allowed_mentions: { parse: [] } }
}

/**
 * Post a feedback submission to the Discord channel. `{ delivered: false }`
 * without error when no webhook is configured (local/e2e) so the in-app flow
 * still succeeds in dev; throws when a configured post fails so the route can
 * tell the user it didn't land. The thrown message never contains the URL.
 */
export async function sendFeedbackToDiscord(
  env: Env,
  submission: FeedbackSubmission,
  screenshot: FeedbackAttachment | null,
): Promise<{ delivered: boolean }> {
  const url = env.DISCORD_FEEDBACK_WEBHOOK_URL?.trim()
  if (!url) return { delivered: false }

  const descriptionTruncated = submission.description.trim().length > EMBED_DESCRIPTION_MAX
  const payload = buildFeedbackDiscordPayload(submission, {
    hasAttachment: screenshot !== null,
    screenshotExt: screenshot?.ext,
    descriptionTruncated,
  })

  const form = new FormData()
  form.set("payload_json", JSON.stringify(payload))
  let fileIndex = 0
  if (screenshot) {
    form.set(
      `files[${fileIndex++}]`,
      new Blob([screenshot.bytes], { type: screenshot.contentType }),
      `screenshot.${screenshot.ext}`,
    )
  }
  if (descriptionTruncated) {
    form.set(
      `files[${fileIndex}]`,
      new Blob([submission.description.trim()], { type: "text/plain" }),
      "description.txt",
    )
  }

  let res: Response
  try {
    res = await fetch(url, { method: "POST", body: form })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`Failed to post feedback to Discord: ${message}`, { cause: err })
  }
  if (!res.ok) {
    throw new Error(`Failed to post feedback to Discord: HTTP ${res.status}`)
  }
  return { delivered: true }
}
