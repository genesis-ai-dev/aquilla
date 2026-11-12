// The one decision behind scripts/neon-scrub-integrations.ts, kept apart from
// the script because the script imports scripts/pg.ts (a `#!` file vitest's
// node-polyfill plugin cannot transform) and this must stay unit-testable.

const PROTECTED_TARGETS = new Set(["production", "prod", "main"])

/**
 * Null when the integration scrub may run against `target`
 * (AQUILLA_NEON_TARGET, as neon-target.ts and the dev refresh set it), else
 * why not. Production under any alias is refused, and so is no target at all:
 * a bare run with NEON_PG_* pointed somewhere unknown is exactly the mistake
 * the guard exists to catch.
 */
export function scrubRefusal(target: string | undefined): string | null {
  const normalized = target?.trim().toLowerCase()
  if (!normalized) {
    return "AQUILLA_NEON_TARGET is unset — run this through neon-target (pnpm neon:scrub:dev) or the dev refresh, never bare"
  }
  if (PROTECTED_TARGETS.has(normalized)) {
    return `refusing to scrub integration connections on ${normalized}`
  }
  return null
}
