// Builds and sends the Discord webhook message for one tick's alerts.
//
// The transport is a channel webhook, as in auth-worker/src/services/
// discord-feedback.ts. The URL is a secret (DISCORD_WEBHOOK_URL): anyone who
// holds it can post to the channel, so it is never logged.
//
// Mentions: Discord pings only for mentions in `content` (never in embeds), and
// only for ids listed in `allowed_mentions`. "down" and "reminder" alerts put
// the configured roles/users in `content`; a "recovered" alert pings no one.
// `parse: []` stops any `@everyone` text in an error string from pinging.

import type { MonitorConfig, Target } from "./config"
import type { AlertEvent } from "./state"

export interface DiscordEmbed {
  title: string
  description?: string
  color: number
  url?: string
  fields: { name: string; value: string; inline?: boolean }[]
  timestamp: string
}

export interface DiscordMessage {
  username: string
  content: string
  allowed_mentions: { parse: never[]; roles: string[]; users: string[] }
  embeds: DiscordEmbed[]
}

const RED = 0xe5484d
const ORANGE = 0xf76b15
const GREEN = 0x30a46c
/** Discord's limit per message. */
const MAX_EMBEDS = 10

export function formatDuration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000))
  if (minutes < 1) return "less than 1 min"
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`
}

/** Discord renders `<t:unix:R>` as "5 minutes ago" in each reader's own zone. */
const discordTime = (ms: number) => `<t:${Math.floor(ms / 1000)}:R>`

/** Keep error text inert: no mentions, no markdown that breaks the field. */
function quote(text: string): string {
  return "`" + text.replace(/`/g, "'").slice(0, 300) + "`"
}

function embedFor(event: AlertEvent, target: Target | undefined): DiscordEmbed {
  const name = target?.name ?? event.targetId
  const fields: DiscordEmbed["fields"] = []
  if (event.kind === "recovered") {
    fields.push({ name: "Down for", value: formatDuration(event.at - event.downSince), inline: true })
    fields.push({ name: "Response", value: `${event.httpStatus ?? "?"} in ${event.latencyMs} ms`, inline: true })
  } else {
    fields.push({ name: "Failing since", value: discordTime(event.downSince), inline: true })
    if (event.httpStatus !== undefined) fields.push({ name: "HTTP status", value: String(event.httpStatus), inline: true })
    if (event.error) fields.push({ name: "Error", value: quote(event.error) })
  }
  if (target) fields.push({ name: "Check", value: target.url })

  const title = {
    down: `🔴 ${name} is DOWN`,
    reminder: `🟠 ${name} is still DOWN (${formatDuration(event.at - event.downSince)})`,
    recovered: `🟢 ${name} has recovered`,
  }[event.kind]
  const color = { down: RED, reminder: ORANGE, recovered: GREEN }[event.kind]
  return { title, color, url: target?.url, fields, timestamp: new Date(event.at).toISOString() }
}

export function buildMessage(events: AlertEvent[], config: MonitorConfig): DiscordMessage | null {
  if (events.length === 0) return null
  const targets = new Map(config.targets.map((t) => [t.id, t]))
  const paging = events.some((e) => e.kind !== "recovered")
  const mentions = paging
    ? [...config.mentionRoleIds.map((id) => `<@&${id}>`), ...config.mentionUserIds.map((id) => `<@${id}>`)]
    : []

  const down = events.filter((e) => e.kind !== "recovered").length
  const up = events.length - down
  const summary = [
    down > 0 ? `${down} service${down === 1 ? "" : "s"} down` : "",
    up > 0 ? `${up} recovered` : "",
  ].filter(Boolean).join(", ")

  return {
    username: `Aquilla Monitor (${config.environment})`,
    content: [...mentions, `**${config.environment}**: ${summary}`].join(" "),
    allowed_mentions: {
      parse: [],
      roles: paging ? config.mentionRoleIds : [],
      users: paging ? config.mentionUserIds : [],
    },
    embeds: events.slice(0, MAX_EMBEDS).map((e) => embedFor(e, targets.get(e.targetId))),
  }
}

export async function sendDiscord(
  webhookUrl: string,
  message: DiscordMessage,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  // One retry covers a single dropped request or a 429. A second failure is
  // logged by the caller; the next state change will try again.
  for (let attempt = 1; attempt <= 2; attempt++) {
    const response = await fetchImpl(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(10_000),
    })
    if (response.ok) return
    const retryAfter = Number(response.headers.get("Retry-After") ?? "1")
    const detail = `Discord webhook answered ${response.status}`
    if (attempt === 2 || (response.status < 500 && response.status !== 429)) throw new Error(detail)
    await new Promise((resolve) => setTimeout(resolve, Math.min(Math.max(retryAfter, 1), 5) * 1000))
  }
}
