import { describe, expect, it } from "vitest"
import { extractMentions } from "./comment-helpers"
import { applyMention, mentionTokenAt, rankMentionSuggestions } from "./mention-suggest"

describe("mentionTokenAt", () => {
  it("opens on an @ at a mention boundary", () => {
    expect(mentionTokenAt("Hey @ali", 8)).toEqual({ start: 4, query: "ali" })
    expect(mentionTokenAt("@", 1)).toEqual({ start: 0, query: "" })
  })

  it("does not open on an @ inside an email or a word", () => {
    expect(mentionTokenAt("me@example.com", 3)).toBeNull()
    expect(mentionTokenAt("me@example.com", 12)).toBeNull()
    expect(mentionTokenAt("foo@bar", 7)).toBeNull()
  })

  it("keeps filtering through the hyphens, dots and digits of a real username", () => {
    expect(mentionTokenAt("Hey @qa-bot-", 12)).toEqual({ start: 4, query: "qa-bot-" })
    expect(mentionTokenAt("@john.doe", 9)).toEqual({ start: 0, query: "john.doe" })
  })

  it("closes once the token is finished or can never be a username", () => {
    expect(mentionTokenAt("Hey @alice ", 11)).toBeNull()
    expect(mentionTokenAt("price @10", 9)).toBeNull()
    expect(mentionTokenAt("@123", 4)).toBeNull()
  })
})

describe("rankMentionSuggestions", () => {
  const roster = [
    { username: "carol" },
    { username: "bob" },
    { username: "bobby" },
    { username: "alice" },
    { username: "alice" },
  ]

  it("puts prefix matches ahead of substring matches, alphabetically within each", () => {
    expect(rankMentionSuggestions(roster, "bo").map((m) => m.username)).toEqual(["bob", "bobby"])
    expect(rankMentionSuggestions(roster, "ob").map((m) => m.username)).toEqual(["bob", "bobby"])
  })

  it("matches a typed hyphen literally", () => {
    const bots = [{ username: "qa_bot_mention" }, { username: "qa-bot-2" }, { username: "qa-bot" }]
    expect(rankMentionSuggestions(bots, "qa-").map((m) => m.username)).toEqual(["qa-bot", "qa-bot-2"])
  })

  it("lists the whole roster except the signed-in user when the query is empty", () => {
    expect(rankMentionSuggestions(roster, "", "alice").map((m) => m.username)).toEqual([
      "bob",
      "bobby",
      "carol",
    ])
  })
})

describe("applyMention", () => {
  it("replaces the active token with @username and a trailing space", () => {
    const next = applyMention("Hey @bo please", { start: 4, query: "bo" }, "bob")
    expect(next).toEqual({ value: "Hey @[bob] please", caret: 11 })
    expect(extractMentions(next.value)).toEqual(["bob"])
  })

  it("stores a hyphenated username so the inbox can read it back", () => {
    const next = applyMention("@qa-b", { start: 0, query: "qa-b" }, "qa-bot-2")
    expect(next).toEqual({ value: "@[qa-bot-2] ", caret: 12 })
    expect(extractMentions(next.value)).toEqual(["qa-bot-2"])
  })
})
