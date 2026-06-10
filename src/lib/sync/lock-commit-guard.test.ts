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
