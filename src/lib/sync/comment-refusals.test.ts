/**
 * AQU-1957: a comment the server permanently refused must be distinguishable
 * from one that simply hasn't flushed yet. `useComments` keeps every optimistic
 * comment that is "not yet in server rows", so without this predicate a refused
 * comment sits in the thread forever looking posted — the shape of the BGP
 * report that someone "can write comments but cannot submit them".
 */

import { describe, it, expect } from "vitest"
import { commentRefusalsIn, sameCommentRefusals } from "./comment-refusals"
import type { OutboxRecord } from "./outbox"
import type { CqrsRawEvent } from "./outbox-types"
import { CQRS_SCHEMA_VERSION } from "./outbox-types"

function makeRecord(
  id: string,
  overrides: {
    kind?: string
    projectId?: string
    commentId?: string | null
    status?: OutboxRecord["status"]
    lastError?: OutboxRecord["lastError"]
    acknowledgedAt?: number
  } = {},
): OutboxRecord {
  const payload: Record<string, unknown> =
    overrides.commentId === null ? {} : { commentId: overrides.commentId ?? "cmt-1" }
  const event = {
    id,
    schemaVersion: CQRS_SCHEMA_VERSION,
    kind: overrides.kind ?? "comment.create",
    projectId: overrides.projectId ?? "proj-a",
    fileId: "__project__",
    cellId: undefined,
    author: "kume",
    payload,
    clientTs: 1000,
  } as unknown as CqrsRawEvent
  return {
    id,
    enqueuedAt: 1000,
    event,
    attempts: 1,
    lastAttemptAt: 1000,
    lastError: overrides.lastError ?? { status: 403, reason: "role too low for comment.create" },
    status: overrides.status ?? "failed",
    ...(overrides.acknowledgedAt ? { acknowledgedAt: overrides.acknowledgedAt } : {}),
  }
}

describe("commentRefusalsIn", () => {
  it("reports a 403-quarantined comment.create with its comment id and reason", () => {
    const refusals = commentRefusalsIn([makeRecord("r1")], "proj-a")
    expect(refusals).toEqual([
      {
        id: "r1",
        commentId: "cmt-1",
        kind: "comment.create",
        status: 403,
        reason: "role too low for comment.create",
      },
    ])
  })

  it.each([
    [
      "a record still being retried",
      makeRecord("r1", { status: "pending", lastError: { status: 0, reason: "offline" } }),
    ],
    [
      // requeueTransientlyFailedOutboxEvents revives these on reconnect, so the
      // comment is still going to be sent and must stay in the thread.
      "a failed record whose last error was a network drop",
      makeRecord("r1", { lastError: { status: 0, reason: "offline" } }),
    ],
    [
      "a failed record whose last error was a 5xx",
      makeRecord("r1", { lastError: { status: 503, reason: "HTTP 503" } }),
    ],
    ["a refusal the user already acknowledged", makeRecord("r1", { acknowledgedAt: 2000 })],
    ["a refused event for another project", makeRecord("r1", { projectId: "proj-b" })],
    ["a refused event that is not a comment", makeRecord("r1", { kind: "target.cell.commit" })],
    ["a comment event carrying no commentId", makeRecord("r1", { commentId: null })],
  ])("does not report %s", (_label, record) => {
    expect(commentRefusalsIn([record], "proj-a")).toEqual([])
  })

  it("reports every refused comment kind, not just create", () => {
    const records = [
      makeRecord("r1", { kind: "comment.edit", commentId: "cmt-1" }),
      makeRecord("r2", { kind: "comment.resolve", commentId: "cmt-2" }),
      makeRecord("r3", { kind: "comment.delete", commentId: "cmt-3" }),
    ]
    expect(commentRefusalsIn(records, "proj-a").map((r) => r.kind)).toEqual([
      "comment.edit",
      "comment.resolve",
      "comment.delete",
    ])
  })

  it("treats a retry-exhausted deterministic 4xx as a refusal", () => {
    const record = makeRecord("r1", { lastError: { status: 400, reason: "HTTP 400" } })
    expect(commentRefusalsIn([record], "proj-a")).toHaveLength(1)
  })
})

describe("sameCommentRefusals", () => {
  it("is true for the same ids and reasons, false when either changes", () => {
    const a = commentRefusalsIn([makeRecord("r1")], "proj-a")
    expect(sameCommentRefusals(a, commentRefusalsIn([makeRecord("r1")], "proj-a"))).toBe(true)
    expect(sameCommentRefusals(a, commentRefusalsIn([makeRecord("r2")], "proj-a"))).toBe(false)
    expect(
      sameCommentRefusals(
        a,
        commentRefusalsIn([makeRecord("r1", { lastError: { status: 403, reason: "other" } })], "proj-a"),
      ),
    ).toBe(false)
    expect(sameCommentRefusals(a, [])).toBe(false)
  })
})
