import { describe, expect, it } from "vitest"
import { readConfig } from "../src/config"

const targets = JSON.stringify([{ id: "sync", name: "Sync", url: "https://api.aquilla.app/sync/health" }])

describe("readConfig", () => {
  it("applies defaults", () => {
    const config = readConfig({ MONITOR_TARGETS: targets })
    expect(config).toMatchObject({
      environment: "local",
      failureThreshold: 3,
      recoveryThreshold: 2,
      reminderMinutes: 60,
      mentionRoleIds: [],
      mentionUserIds: [],
    })
    expect(config.targets).toHaveLength(1)
  })

  it("parses comma-separated Discord ids", () => {
    const config = readConfig({
      MONITOR_TARGETS: targets,
      DISCORD_MENTION_ROLE_IDS: "123456789012345678, 223456789012345678",
      DISCORD_MENTION_USER_IDS: "323456789012345678",
    })
    expect(config.mentionRoleIds).toEqual(["123456789012345678", "223456789012345678"])
    expect(config.mentionUserIds).toEqual(["323456789012345678"])
  })

  it("rejects an id that is not a Discord snowflake, so no text can reach the mention", () => {
    expect(() => readConfig({ MONITOR_TARGETS: targets, DISCORD_MENTION_ROLE_IDS: "everyone" })).toThrow(/not a Discord id/)
  })

  it.each([
    [undefined, /not set/],
    ["[]", /non-empty/],
    ['[{"id":"a","name":"A","url":"ftp://x"}]', /http\(s\)/],
    ['[{"id":"a","name":"A","url":"https://x"},{"id":"a","name":"B","url":"https://y"}]', /two targets/],
    ['[{"name":"A","url":"https://x"}]', /id is missing/],
  ])("rejects MONITOR_TARGETS=%s", (raw, message) => {
    expect(() => readConfig({ MONITOR_TARGETS: raw })).toThrow(message)
  })

  it("rejects a threshold below 1", () => {
    expect(() => readConfig({ MONITOR_TARGETS: targets, FAILURE_THRESHOLD: "0" })).toThrow(/>= 1/)
  })
})
