/**
 * Deleting a track is TWO writes with two different authorities, and until
 * 2026-08-27 they went in one batch: removing the takes is `cell.audio.remove`
 * at contributor level, while removing the row is `file.track.set` behind the
 * project's `allowTrackEditing` setting. The worker authorizes each event on
 * its own and answers with a mixed accepted/rejected list, so with that setting
 * off the server took the recordings and refused the row — and said nothing,
 * because the flusher quarantines a 403 BEFORE the `rejected` list that feeds
 * `onRejected`, so the handler written for exactly that 403 could never fire.
 * The user was left looking at a track they thought they had deleted, now
 * empty.
 *
 * The row goes first now, and this is the guard that decides whether its
 * recordings may follow. Tested directly rather than through a render — the
 * same extract-the-guard pattern as `shouldApplyCheckResult` next door, since
 * proving the rule needs none of the component.
 */
import { describe, it, expect } from "vitest"
import { trackDeleteGate } from "./project-workspace-helpers"

/** An outbox record as the gate sees it. */
const rec = (status: "pending" | "failed", reason?: string) => ({
  status,
  lastError: reason == null ? null : { reason },
})

describe("trackDeleteGate", () => {
  it("lets the recordings go once the row's deletion has landed", () => {
    // Nothing left in the outbox means the server took it.
    expect(trackDeleteGate([])).toEqual({ proceed: true, refused: false, reason: null })
  })

  it("keeps the recordings when the row was REFUSED, and carries the reason", () => {
    const gate = trackDeleteGate([rec("failed", "track editing is off for this project")])
    expect(gate.proceed).toBe(false)
    expect(gate.refused).toBe(true)
    expect(gate.reason).toBe("track editing is off for this project")
  })

  // THE HALF THAT IS EASY TO GET WRONG. "We never heard back" is not permission
  // to delete somebody's recordings — offline, or an unrelated batch flushed
  // ahead of ours, must leave the track exactly as it was.
  it("keeps the recordings when the answer never came", () => {
    const gate = trackDeleteGate([rec("pending")])
    expect(gate.proceed).toBe(false)
    expect(gate.refused).toBe(false)
    expect(gate.reason).toBeNull()
  })

  // Several rows deleted at once: one refusal is enough to stop all of it,
  // because the takes were gathered across every doomed track together.
  it("stops on a refusal even when the rest of the batch landed", () => {
    const gate = trackDeleteGate([rec("failed", "not permitted")])
    expect(gate.proceed).toBe(false)
    expect(gate.refused).toBe(true)
  })

  it("reports a refusal even when a pending record is seen first", () => {
    const gate = trackDeleteGate([rec("pending"), rec("failed", "not permitted")])
    expect(gate.refused).toBe(true)
    expect(gate.reason).toBe("not permitted")
  })

  it("survives a refusal the server gave no reason for", () => {
    expect(trackDeleteGate([rec("failed")])).toEqual({
      proceed: false,
      refused: true,
      reason: null,
    })
  })
})
