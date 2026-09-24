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

export type NeonTargetCommand = "status" | "apply" | "baseline" | "prepare-comments-key" | "backfill-progress" | "backfill-activity" | "backfill-lanes"

export function scriptFor(command: NeonTargetCommand): string {
  return command === "backfill-progress"
    ? "scripts/neon-backfill-progress.ts"
    : command === "backfill-activity"
      ? "scripts/neon-backfill-activity.ts"
      : command === "backfill-lanes"
        ? "scripts/neon-backfill-lanes.ts"
        : "scripts/neon-migrate.ts"
}

/**
 * The child's argv, after the runtime. `passthrough` is whatever followed the
 * command on our own command line — `--missing-books`, `--missing-only` — and
 * is meaningful only to the backfill scripts, which read `process.argv`
 * themselves.
 */
export function childArgs(command: NeonTargetCommand, passthrough: readonly string[]): string[] {
  const script = scriptFor(command)
  return command.startsWith("backfill-") ? [script, ...passthrough] : [script, command]
}
