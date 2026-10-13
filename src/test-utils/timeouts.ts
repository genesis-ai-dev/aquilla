/**
 * Stall watchdog for every wait in the root Vitest suite (AGENTS.md testing
 * rule 15: machine speed must not decide correctness).
 *
 * A wait ends as soon as its condition holds, so this budget costs nothing on
 * a passing run. It only decides how long a stalled wait runs before it fails.
 * On a loaded machine, a two-hop async chain that takes 30 ms when idle has
 * taken more than a second (AQU-1728), so the old 1 s default failed correct
 * tests.
 *
 * `src/test-setup.ts` makes this Testing Library's `asyncUtilTimeout`, which
 * covers every `findBy*` / `waitFor`. Vitest 5 hard-codes a 1 s default for
 * `vi.waitFor` and has no config option for it, so pass
 * `{ timeout: STALL_WATCHDOG_MS }` to each call. The per-test and per-hook
 * ceilings (60 s, in `vite.config.ts`) stay above the sum of a test's waits.
 */
export const STALL_WATCHDOG_MS = 10_000
