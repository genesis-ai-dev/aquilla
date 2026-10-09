import { describe, expect, it } from "vitest"
import type { CommentRecord } from "@/lib/sync/comments-read-types"
import { mentionNoticesFor } from "./mention-inbox"

function comment(overrides: Partial<CommentRecord>): CommentRecord {
  return {
    commentId: "c1",
    projectId: "p1",
    scopeKind: "cell",
    fileId: "f1",
    cellId: "cell-1",
    parentCommentId: null,
    body: "Please check @[alice]",
    resolved: false,
    authorId: "bob",
    authorLabel: "Bob",
    createdAt: 2_000,
    updatedAt: 2_000,
    deletedAt: null,
    cellRef: "GEN 1:1",
    ...overrides,
  }
}

describe("mentionNoticesFor", () => {
  it("lists comments that mention the reader, newest first, and never their own", () => {
    const notices = mentionNoticesFor(
      [
        comment({ commentId: "older", createdAt: 1, body: "@[alice] first" }),
        comment({ commentId: "own", authorId: "alice", body: "@[alice] I wrote this" }),
        comment({ commentId: "newer", createdAt: 5, body: "Hey @[Alice]" }),
        comment({ commentId: "other", body: "@[carol] only" }),
        comment({ commentId: "email", body: "write me@alice.com" }),
      ],
      "alice",
    )
    expect(notices.map((n) => n.commentId)).toEqual(["newer", "older"])
    expect(notices[0]).toMatchObject({ authorLabel: "Bob", cellRef: "GEN 1:1" })
  })

  // AQU-761 bot walk: the picker offered `@qa-bot-2`, but the bell stayed on
  // "No mentions yet" because the token class rejected the hyphen.
  it("lists a mention of a hyphenated username and shows it as @name", () => {
    const notices = mentionNoticesFor(
      [comment({ commentId: "hyphen", authorId: "qa-bot", body: "Please check @[qa-bot-2]" })],
      "qa-bot-2",
    )
    expect(notices.map((n) => n.commentId)).toEqual(["hyphen"])
    expect(notices[0]?.excerpt).toBe("Please check @qa-bot-2")
  })

  it("keeps the verse ref and a text fallback for a cell that has neither", () => {
    const notices = mentionNoticesFor(
      [
        comment({ commentId: "verse", cellRef: "GEN 1:1", createdForTranslated: "In the beginning" }),
        comment({
          commentId: "heading",
          cellId: "heading-1",
          cellRef: null,
          createdForTranslated: "The Creation",
          body: "@[alice] here",
        }),
        comment({
          commentId: "reply",
          parentCommentId: "heading",
          cellId: "heading-1",
          cellRef: null,
          createdForTranslated: null,
          body: "@[alice] reply",
        }),
      ],
      "alice",
    )
    expect(notices.find((n) => n.commentId === "verse")).toMatchObject({
      cellRef: "GEN 1:1",
      cellText: "In the beginning",
    })
    expect(notices.find((n) => n.commentId === "heading")?.cellText).toBe("The Creation")
    expect(notices.find((n) => n.commentId === "reply")?.cellText).toBe("The Creation")
  })

  it("drops a deleted comment so the inbox cannot point at it", () => {
    expect(
      mentionNoticesFor([comment({ deletedAt: 9, body: "@[alice] gone" })], "alice"),
    ).toEqual([])
  })
})
