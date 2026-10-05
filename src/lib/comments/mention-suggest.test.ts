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
})
