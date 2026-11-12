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

// AQU-1946: THE ONE LIST. `neon-target.ts` used to repeat the accepted
// commands as a hand-written `parseCommand` chain, so `repair-lane-grants`
// could sit in the union, in `scriptFor` and in the flag-passthrough list and
// still be rejected before any database work — both
// `pnpm neon:repair-lane-grants:dev|:prod` printed the usage and exited 1. The
// union is now derived from this array and `parseCommand` / `usage()` read it,
// so adding a command here wires all four places at once.
export const NEON_TARGET_COMMANDS = [
  "status",
  "apply",
  "baseline",
  "prepare-comments-key",
  "backfill-progress",
  "backfill-activity",
  "backfill-book-codes",
  "backfill-file-kinds",
  "backfill-lanes",
  "backfill-lane-batch",
  "repair-lane-grants",
  "prune-phantom-voices",
  "fold-cast-by-character",
  "verify-lanes",
  "seed-extract",
  "scrub-integrations",
  "copy-dev-audio",
  "copy-dev-audio-all",
] as const

export type NeonTargetCommand = (typeof NEON_TARGET_COMMANDS)[number]

/** The command word `neon-target.ts` was invoked with, or not one at all. */
export function isNeonTargetCommand(value: string | undefined): value is NeonTargetCommand {
  return value !== undefined && (NEON_TARGET_COMMANDS as readonly string[]).includes(value)
}

export function scriptFor(command: NeonTargetCommand): string {
  if (command === "backfill-progress") return "scripts/neon-backfill-progress.ts"
  if (command === "backfill-activity") return "scripts/neon-backfill-activity.ts"
  if (command === "backfill-book-codes") return "scripts/neon-backfill-book-codes.ts"
  // AQU-2211: give files the Codex migrator stamped `codex` the type they had in Codex.
  if (command === "backfill-file-kinds") return "scripts/neon-backfill-file-kinds.ts"
  if (command === "backfill-lanes") return "scripts/neon-backfill-lanes.ts"
  if (command === "backfill-lane-batch") return "scripts/neon-backfill-lane-batch.ts"
  if (command === "repair-lane-grants") return "scripts/neon-repair-lane-grants.ts"
  if (command === "prune-phantom-voices") return "scripts/neon-prune-phantom-voices.ts"
  // AQU-2125: fold line-by-line voice casting into one entry per character.
  if (command === "fold-cast-by-character") return "scripts/neon-fold-cast-by-character.ts"
  if (command === "verify-lanes") return "scripts/neon-verify-lanes.ts"
  // AQU-1953: the dev-DB seed extract runs under neon-target so the source
  // branch is explicit and recorded (AQUILLA_NEON_TARGET) in seed.meta.json.
  if (command === "seed-extract") return "scripts/seed-extract.ts"
  // AQU-1775: strip the integration tokens a production copy carries.
  if (command === "scrub-integrations") return "scripts/neon-scrub-integrations.ts"
  // AQU-2114: copy one project's prod audio into the dev bucket, so the rows
  // the dev refresh restored have bytes behind them.
  if (command === "copy-dev-audio") return "scripts/neon-copy-dev-audio.ts"
  // AQU-2115: copy EVERY project's prod audio into the dev bucket, so the rows
  // the nightly dev refresh restored have bytes behind them.
  if (command === "copy-dev-audio-all") return "scripts/neon-copy-dev-audio-all.ts"
  return "scripts/neon-migrate.ts"
}

/**
 * The child's argv, after the runtime. `passthrough` is whatever followed the
 * command on our own command line — `--missing-books`, `--apply`,
 * `--require-complete` — and is meaningful only to the backfill, verify-lanes,
 * and repair-lane-grants scripts, which read `process.argv` themselves.
 */
export function childArgs(command: NeonTargetCommand, passthrough: readonly string[]): string[] {
  const script = scriptFor(command)
  const forwardsFlags =
    command.startsWith("backfill-") ||
    command === "verify-lanes" ||
    command === "repair-lane-grants" ||
    command === "prune-phantom-voices" ||
    command === "fold-cast-by-character" ||
    command === "seed-extract" ||
    command === "scrub-integrations" ||
    command === "copy-dev-audio" ||
    command === "copy-dev-audio-all"
  return forwardsFlags ? [script, ...passthrough] : [script, command]
}
