/**
 * person-prefs-reset.ts — the seam `src/test-setup.ts` resets person-prefs
 * through between tests, without importing person-prefs itself.
 *
 * test-setup.ts runs before each test file, so everything it imports is
 * evaluated before that file's own `vi.mock()` calls take effect. person-prefs
 * reaches `@/lib/frontier/auth`, `orgs` and `elevation`; while test-setup
 * imported it directly, a test that mocks `@/lib/frontier/session-store`
 * (sync-token.test.ts, ProjectElevationBoundary.test.tsx) found elevation.ts
 * already bound to the real store, the step-up prompt never opened, and four
 * tests went red (PR #1713). This module imports nothing. person-prefs
 * registers its reset here as it loads, so a test file that never loads
 * person-prefs has nothing to reset and pays nothing to load it.
 */

const resets = new Set<() => void>()

/** Called by person-prefs as its module evaluates. Returns the unregister. */
export function registerPersonPrefsReset(reset: () => void): () => void {
  resets.add(reset)
  return () => {
    resets.delete(reset)
  }
}

/** Resets every person-prefs instance that has loaded; a no-op when none has. */
export function resetLoadedPersonPrefsForTests(): void {
  for (const reset of resets) reset()
}
