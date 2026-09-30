/**
 * buildConversationRows tests — the pure row builder behind the dock's
 * conversations list.
 *
 * The v3 assertion that matters is the REACTION marker. A run the team started
 * off the back of human edits is uninvited work: nobody clicked anything for
 * it. The react loop's whole anti-noise premise is that such a run is a thread
 * you can find rather than a notification that finds you — which only holds if
 * the row admits, at a glance, that it started itself. So the marker goes in
 * FRONT of the ordinary preview (both facts are needed), and the flag rides
 * alongside so the list can draw its glyph without re-deriving the reason.
 */

import { describe, it, expect } from "vitest"
import { t } from "@/lib/i18n/standalone"
import type { ContextualRunRecord } from "@/lib/contextual/transport"
import { buildConversationRows } from "./team-conversations"

function runRecord(overrides: Partial<ContextualRunRecord> = {}): ContextualRunRecord {
  return {
    runId: "run-1",
    fileId: "file-1",
    status: "running",
    phase: "drafting",
    spanLabel: "MRK 4:1–4:8",
    done: 1,
    total: 4,
    failed: 0,
    unitsSpent: 0,
    callsSpent: 0,
    lastError: null,
    createdAt: "2026-08-28T11:00:00Z",
    updatedAt: "2026-08-28T12:00:00Z",
    activeDirections: [],
    proposedDrafts: 0,
    targetLang: "",
    ...overrides,
  }
}

function rowsFor(runs: ContextualRunRecord[]) {
  return buildConversationRows({
    chatRuns: [],
    isStreaming: false,
    runs,
    openCount: 0,
    firstQuestionReason: null,
    runTitle: () => "Mark",
    runStatusLabel: () => "Working",
    t,
  })
}

describe("buildConversationRows — reaction conversations", () => {
  it("flags a reaction row and keeps the ordinary preview behind the marker", () => {
    const [, row] = rowsFor([runRecord({ initiatedBy: "reaction" })])
    expect(row.reaction).toBe(true)
    // "who started this" AND "where it is up to" — the marker adds, never replaces.
    expect(row.preview).toBe("Reacted to your changes — Working — MRK 4:1–4:8")
  })

  it("marks a reaction that already has drafts waiting, without losing the count", () => {
    const [, row] = rowsFor([runRecord({ initiatedBy: "reaction", proposedDrafts: 2 })])
    expect(row.preview).toBe("Reacted to your changes — 2 drafts ready for your review")
    expect(row.badge).toBe(2)
  })

  it("leaves a run a human asked for unmarked", () => {
    for (const initiatedBy of [undefined, null, "user", "cron"]) {
      const [, row] = rowsFor([runRecord({ initiatedBy })])
      expect(row.reaction).toBeUndefined()
      expect(row.preview).toBe("Working — MRK 4:1–4:8")
    }
  })

  it("drops an opaque span id out of the preview rather than printing a UUID", () => {
    const [, row] = rowsFor([
      runRecord({ spanLabel: "0b6f1f1e-4a1e-4c33-9f4a-8f2b0f5f1e77", initiatedBy: "reaction" }),
    ])
    expect(row.preview).toBe("Reacted to your changes — Working")
  })
})
