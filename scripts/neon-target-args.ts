// What `neon-target.ts` hands to the script it spawns, as a pure function so
// it can be tested without spawning anything.
//
// AQU-1278: THE BACKFILL FLAGS MUST REACH THE BACKFILL. `neon-target` used to
// build the child's arguments as just the script path, so
// `pnpm neon:backfill:progress:prod --missing-books` silently ran the
// UNSCOPED reprojection of every file in production — the one thing the flag
// exists to avoid — and there was no way through the package scripts to run
// the scoped one at all. Everything after the command now passes through to
// a backfill script untouched. The migration commands keep their fixed shape:
// `neon-migrate` takes the command word and nothing else.

export type NeonTargetCommand =
  | "status"
  | "apply"
  | "baseline"
  | "prepare-comments-key"
  | "backfill-progress"
  | "backfill-activity"
  | "backfill-lanes"
  | "verify-lanes"

export function scriptFor(command: NeonTargetCommand): string {
  if (command === "backfill-progress") return "scripts/neon-backfill-progress.ts"
  if (command === "backfill-activity") return "scripts/neon-backfill-activity.ts"
  if (command === "backfill-lanes") return "scripts/neon-backfill-lanes.ts"
  if (command === "verify-lanes") return "scripts/neon-verify-lanes.ts"
  return "scripts/neon-migrate.ts"
}

/**
 * The child's argv, after the runtime. `passthrough` is whatever followed the
 * command on our own command line — `--missing-books`, `--apply`,
 * `--require-complete` — and is meaningful only to the backfill and
 * verify-lanes scripts, which read `process.argv` themselves.
 */
export function childArgs(command: NeonTargetCommand, passthrough: readonly string[]): string[] {
  const script = scriptFor(command)
  const forwardsFlags = command.startsWith("backfill-") || command === "verify-lanes"
  return forwardsFlags ? [script, ...passthrough] : [script, command]
}
