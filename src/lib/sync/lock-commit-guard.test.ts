// RACE-5: Tests for the commit-time lock guard.
//
// The core RACE-5 client gap: `lockHolderLabel` in EditorRow is derived from
// React state (cellLockHolders), which is updated asynchronously via setState.
// A commit queued in the debounce window (1.2 s) may fire after the WS frame
// arrives but before React re-renders with the new state. The fix:
//   • `cellLockHoldersRef` in ProjectWorkspace is updated synchronously inside
//     the WS `onMessage` handler (before any setState).
//   • `checkLockHolder` reads from the ref — always returns the latest value.
//   • handleEditorCommit uses `checkLockHolder?.(cell.id) ?? lockHolderLabel`.
//
// This file tests the logical contract of that guard rather than the component
// internals (which would require a 50+-prop harness).

import { describe, it, expect } from "vitest"
import {
  applyPresenceFrame,
  applyLockClaimed,
  applyLockReleased,
} from "./cell-lock-state"

// ── Helpers mirroring the production implementation ──────────────────────────

/**
 * Simulates the ref-backed lock-check function created in ProjectWorkspace:
 *   const checkLockHolder = useCallback((cellId) =>
 *     cellLockHoldersRef.current.get(cellId) ?? null, [])
 *
 * Returns a factory that wraps a mutable map (the "ref") so tests can drive
 * synchronous updates independently of React state.
 */
function makeLiveLockCheck(): {
  lockMap: Map<string, string>
  checkLockHolder: (cellId: string) => string | null
} {
  const lockMap = new Map<string, string>()
  const checkLockHolder = (cellId: string) => lockMap.get(cellId) ?? null
  return { lockMap, checkLockHolder }
}

/**
 * The effective-holder computation from handleEditorCommit.
 * Returns the holder label if the commit should abort, or null if it may proceed.
 */
function getEffectiveHolder(
  cellId: string,
  lockHolderLabel: string | null,
  checkLockHolder?: (cellId: string) => string | null,
): string | null {
  return checkLockHolder?.(cellId) ?? lockHolderLabel
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("RACE-5 commit-time lock guard", () => {
  describe("getEffectiveHolder (the guard used in handleEditorCommit)", () => {
    it("returns null when neither the prop nor the live check report a holder", () => {
      const { checkLockHolder } = makeLiveLockCheck()
      expect(getEffectiveHolder("cell-1", null, checkLockHolder)).toBeNull()
    })

    it("returns the prop holder when checkLockHolder is not wired (offline / no-WS)", () => {
      // Advisory design: when the socket is absent, fall back to the last known
      // prop value — offline users must still be able to edit.
      expect(getEffectiveHolder("cell-1", "alice", undefined)).toBe("alice")
    })

    it("returns the prop holder when checkLockHolder reports no holder but the prop says someone holds it", () => {
      // e.g. lock.released arrived but prop wasn't cleared yet (opposite stale case).
      const { checkLockHolder } = makeLiveLockCheck()
      // lockMap is empty, but the prop still says alice (lagging release)
      expect(getEffectiveHolder("cell-1", "alice", checkLockHolder)).toBe("alice")
    })

    it("returns the live holder when the prop is null but the ref was just updated (the RACE-5 gap)", () => {
      // This is the key regression test.
      // Scenario:
      //   1. lockHolderLabel = null (React state from last render, stale)
      //   2. lock.claimed(cell-1, alice) arrives synchronously → ref updated
      //   3. React hasn't re-rendered yet → prop still null
      //   4. handleEditorCommit fires → should abort because alice holds the lock
      const { lockMap, checkLockHolder } = makeLiveLockCheck()

      // Step 1: render just happened, lockHolderLabel is null
      const staleLabel: string | null = null

      // Step 2: WS frame arrives — ref is updated synchronously
      lockMap.set("cell-1", "alice")

      // Step 4: commit check runs — must see alice even though the prop is null
      expect(getEffectiveHolder("cell-1", staleLabel, checkLockHolder)).toBe("alice")
    })

    it("returns null when the ref holder was released and the prop is also null", () => {
      const { lockMap, checkLockHolder } = makeLiveLockCheck()
      lockMap.set("cell-1", "alice")
      lockMap.delete("cell-1")
      expect(getEffectiveHolder("cell-1", null, checkLockHolder)).toBeNull()
    })

    it("is cell-specific: a holder on a different cell does not block commits on this cell", () => {
      const { lockMap, checkLockHolder } = makeLiveLockCheck()
      lockMap.set("cell-2", "bob")
      // cell-1 is free even though cell-2 is held by bob
      expect(getEffectiveHolder("cell-1", null, checkLockHolder)).toBeNull()
    })
  })

  describe("ref synchrony invariant", () => {
    it("checkLockHolder always reads from the mutable ref, not a captured snapshot", () => {
      // The ref-backed function must read the CURRENT map state at call time,
      // not a snapshot captured when the function was created.
      const { lockMap, checkLockHolder } = makeLiveLockCheck()

      // Function created before the lock is set
      const savedCheck = checkLockHolder

      // Lock arrives (simulates the WS onMessage handler running)
      lockMap.set("cell-X", "carol")

      // The saved reference must still return the live value
      expect(savedCheck("cell-X")).toBe("carol")
    })

    it("reflects deletions immediately, same frame", () => {
      const { lockMap, checkLockHolder } = makeLiveLockCheck()
      lockMap.set("cell-Y", "dave")
      expect(checkLockHolder("cell-Y")).toBe("dave")

      lockMap.delete("cell-Y")
      expect(checkLockHolder("cell-Y")).toBeNull()
    })
  })
})

// ── B4: object-identity invariant for setState bail-out ───────────────────────
//
// React's functional-updater (and direct setState) bails — skips re-render —
// when the new value is reference-equal to the current state.  The original
// ProjectWorkspace handlers for lock.claimed and lock.released mutated the
// shared Map in place *before* calling setState, so the bail check always
// fired and the UI never updated for lone lock frames.
//
// The helpers in cell-lock-state.ts always return a NEW Map.  These tests pin
// that contract so a future regression is caught immediately.

describe("B4 — cell-lock-state helpers never alias input (bail-out invariant)", () => {
  describe("applyPresenceFrame", () => {
    it("returns a new Map (never the same reference)", () => {
      const users = [{ userId: "alice", focusedCell: "GEN 1:1" }]
      const result = applyPresenceFrame(users, "bob")
      // The helper builds from scratch — there is no prior map to alias
      expect(result).toBeInstanceOf(Map)
      expect(result.get("GEN 1:1")).toBe("alice")
    })

    it("excludes the current user's focusedCell", () => {
      const users = [
        { userId: "alice", focusedCell: "GEN 1:1" },
        { userId: "me", focusedCell: "GEN 1:2" },
      ]
      const result = applyPresenceFrame(users, "me")
      expect(result.has("GEN 1:2")).toBe(false)
      expect(result.get("GEN 1:1")).toBe("alice")
    })

    it("excludes users with no focusedCell", () => {
      const users = [{ userId: "alice" }]
      const result = applyPresenceFrame(users, "bob")
      expect(result.size).toBe(0)
    })
  })

  describe("applyLockClaimed", () => {
    it("returns a Map with a different identity from the input", () => {
      const current = new Map<string, string>([["GEN 1:1", "alice"]])
      const result = applyLockClaimed(current, "GEN 1:2", "bob")
      expect(result).not.toBe(current)
    })

    it("includes the new claim in the returned Map", () => {
      const current = new Map<string, string>()
      const result = applyLockClaimed(current, "GEN 1:1", "alice")
      expect(result.get("GEN 1:1")).toBe("alice")
    })

    it("preserves existing entries", () => {
      const current = new Map<string, string>([["GEN 1:1", "alice"]])
      const result = applyLockClaimed(current, "GEN 1:2", "bob")
      expect(result.get("GEN 1:1")).toBe("alice")
      expect(result.get("GEN 1:2")).toBe("bob")
    })

    it("does NOT mutate the input Map (critical: prevents React bail-out)", () => {
      const current = new Map<string, string>()
      applyLockClaimed(current, "GEN 1:1", "alice")
      // The original map must remain unchanged — if it were mutated the
      // React functional updater would see the new value already in `cur`
      // and bail out, skipping the re-render.
      expect(current.size).toBe(0)
    })
  })

  describe("applyLockReleased", () => {
    it("returns a Map with a different identity from the input", () => {
      const current = new Map<string, string>([["GEN 1:1", "alice"]])
      const result = applyLockReleased(current, "GEN 1:1")
      expect(result).not.toBe(current)
    })

    it("removes the released cell from the returned Map", () => {
      const current = new Map<string, string>([["GEN 1:1", "alice"]])
      const result = applyLockReleased(current, "GEN 1:1")
      expect(result.has("GEN 1:1")).toBe(false)
    })

    it("does NOT mutate the input Map (critical: prevents React bail-out)", () => {
      const current = new Map<string, string>([["GEN 1:1", "alice"]])
      applyLockReleased(current, "GEN 1:1")
      // The original map must still contain the entry — if it were deleted
      // in-place the updater's `!cur.has(cellId)` check would bail, skipping
      // the re-render and leaving the cell visually locked forever.
      expect(current.get("GEN 1:1")).toBe("alice")
    })

    it("returns an empty Map when removing the only entry", () => {
      const current = new Map<string, string>([["GEN 1:1", "alice"]])
      const result = applyLockReleased(current, "GEN 1:1")
      expect(result.size).toBe(0)
    })

    it("returns a map without the entry even if it was absent (idempotent)", () => {
      const current = new Map<string, string>()
      const result = applyLockReleased(current, "GEN 1:1")
      expect(result.has("GEN 1:1")).toBe(false)
      expect(result).not.toBe(current)
    })
  })

  describe("frame sequence: presence -> lock.claimed -> lone lock.released", () => {
    // This is the exact sequence from the B4 bug report.
    // The sweep-expired-leases path broadcasts lock.released with NO trailing
    // presence frame.  If lock.released mutated the shared Map in place, the
    // React bail-out would fire and the cell would stay visually locked.

    it("produces distinct Map objects on every step (no object aliasing)", () => {
      // Simulate the ref + setState calls using the helpers.
      // In production code:
      //   cellLockHoldersRef.current = newMap
      //   setCellLockHolders(newMap)   ← same object
      //
      // Each step captures what the ref / state would hold after the frame.

      // Step 1: presence frame
      const afterPresence = applyPresenceFrame(
        [{ userId: "alice", focusedCell: "GEN 1:1" }],
        "me",
      )
      expect(afterPresence.get("GEN 1:1")).toBe("alice")

      // Step 2: lock.claimed (alice explicitly claims GEN 1:1)
      const afterClaimed = applyLockClaimed(afterPresence, "GEN 1:1", "alice")
      expect(afterClaimed).not.toBe(afterPresence) // new identity → re-render fires
      expect(afterClaimed.get("GEN 1:1")).toBe("alice")

      // Step 3: lone lock.released (lease sweep — no trailing presence frame)
      const afterReleased = applyLockReleased(afterClaimed, "GEN 1:1")
      expect(afterReleased).not.toBe(afterClaimed) // new identity → re-render fires
      expect(afterReleased.has("GEN 1:1")).toBe(false)

      // Critically: the intermediate maps are unchanged
      expect(afterPresence.get("GEN 1:1")).toBe("alice") // step-1 map untouched
      expect(afterClaimed.get("GEN 1:1")).toBe("alice")  // step-2 map untouched
    })

    it("ref reflects release immediately (RACE-5 synchrony preserved)", () => {
      // Simulate the ref pointer — always updated synchronously with the new Map.
      let refCurrent: Map<string, string> = new Map()

      // presence frame
      refCurrent = applyPresenceFrame(
        [{ userId: "alice", focusedCell: "GEN 1:1" }],
        "me",
      )

      // lock.claimed
      refCurrent = applyLockClaimed(refCurrent, "GEN 1:1", "alice")
      expect(refCurrent.get("GEN 1:1")).toBe("alice")

      // lone lock.released
      refCurrent = applyLockReleased(refCurrent, "GEN 1:1")

      // The ref must immediately reflect the release — checkLockHolder must
      // return null so a commit is not wrongly blocked.
      const checkLockHolder = (cellId: string) => refCurrent.get(cellId) ?? null
      expect(checkLockHolder("GEN 1:1")).toBeNull()
    })
  })
})
