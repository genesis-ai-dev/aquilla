import { afterEach, describe, expect, it, vi } from "vitest"
import type { MonitorConfig } from "../src/config"
import { buildMessage, formatDuration, sendDiscord } from "../src/discord"
import type { AlertEvent } from "../src/state"

const ROLE = "123456789012345678"
const USER = "223456789012345678"
const config: MonitorConfig = {
  environment: "production",
  targets: [{ id: "sync", name: "Sync API", url: "https://api.aquilla.app/sync/health" }],
  failureThreshold: 3,
  recoveryThreshold: 2,
  reminderMinutes: 60,
  mentionRoleIds: [ROLE],
  mentionUserIds: [USER],
}
const at = Date.UTC(2026, 9, 27, 12, 0)
const down: AlertEvent = { kind: "down", targetId: "sync", at, downSince: at - 2 * 60_000, error: "HTTP 503 (expected 200)", httpStatus: 503, latencyMs: 80 }
const recovered: AlertEvent = { kind: "recovered", targetId: "sync", at, downSince: at - 75 * 60_000, httpStatus: 200, latencyMs: 40 }

describe("buildMessage", () => {
  it("returns nothing when there are no events", () => {
    expect(buildMessage([], config)).toBeNull()
  })

  it("mentions the configured role and users on a down alert, and allows only them", () => {
    const message = buildMessage([down], config)!
    expect(message.content).toBe(`<@&${ROLE}> <@${USER}> **production**: 1 service down`)
    expect(message.allowed_mentions).toEqual({ parse: [], roles: [ROLE], users: [USER] })
    expect(message.embeds[0]).toMatchObject({ title: "🔴 Sync API is DOWN", url: "https://api.aquilla.app/sync/health" })
    expect(message.embeds[0].fields).toContainEqual({ name: "Error", value: "`HTTP 503 (expected 200)`" })
  })

  it("pings no one on a recovery", () => {
    const message = buildMessage([recovered], config)!
    expect(message.content).toBe("**production**: 1 recovered")
    expect(message.allowed_mentions).toEqual({ parse: [], roles: [], users: [] })
    expect(message.embeds[0].title).toBe("🟢 Sync API has recovered")
    expect(message.embeds[0].fields).toContainEqual({ name: "Down for", value: "1 h 15 min", inline: true })
  })

  it("pings when a mixed batch contains any outage", () => {
    const message = buildMessage([down, { ...recovered, targetId: "web" }], config)!
    expect(message.content).toContain(`<@&${ROLE}>`)
    expect(message.content).toContain("1 service down, 1 recovered")
    expect(message.embeds).toHaveLength(2)
  })

  it("keeps @everyone in an error string from pinging", () => {
    const message = buildMessage([{ ...down, error: "@everyone `boom`" }], config)!
    expect(message.allowed_mentions.parse).toEqual([])
    expect(message.content).not.toContain("@everyone")
  })
})

describe("formatDuration", () => {
  it.each([
    [10_000, "less than 1 min"],
    [5 * 60_000, "5 min"],
    [60 * 60_000, "1 h"],
    [135 * 60_000, "2 h 15 min"],
  ])("%d ms → %s", (ms, text) => {
    expect(formatDuration(ms)).toBe(text)
  })
})

describe("sendDiscord", () => {
  afterEach(() => vi.useRealTimers())
  const message = buildMessage([down], config)!

  it("posts the message as JSON", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }))
    await sendDiscord("https://discord.test/hook", message, fetchImpl as unknown as typeof fetch)
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe("https://discord.test/hook")
    expect(JSON.parse(init.body as string)).toEqual(message)
  })

  it("retries once after a 429", async () => {
    vi.useFakeTimers()
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 429, headers: { "Retry-After": "1" } }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
    const sent = sendDiscord("https://discord.test/hook", message, fetchImpl as unknown as typeof fetch)
    await vi.advanceTimersByTimeAsync(1_000)
    await sent
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it("does not retry a 4xx such as a deleted webhook", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 404 }))
    await expect(sendDiscord("https://discord.test/hook", message, fetchImpl as unknown as typeof fetch)).rejects.toThrow("404")
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})
