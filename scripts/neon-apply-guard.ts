// The snapshot gate in front of a production migration apply (AQU-1877), as a
// pure function so it can be tested without spawning the Neon CLI.
//
// Applying migrations to Neon production used to need nothing but the
// command: no snapshot, no prompt, no undo. A Neon branch off production is
// instant and copy-on-write, so there is no reason not to hold one while DDL
// lands. `pnpm neon:apply:prod` therefore now refuses unless the operator
// chose: `--snapshot` (this script takes it) or `--no-snapshot` (they already
// did, or accept the risk). The refusal prints the exact command, so nobody
// has to go and look it up.
//
// `dev` and `local` are unaffected — they are refreshable by design
// (scripts/refresh-neon-branch.ts).

export const SNAPSHOT_FLAG = "--snapshot"
export const NO_SNAPSHOT_FLAG = "--no-snapshot"
/** Migration commands take no other flags; a typo must not be swallowed. */
export const MIGRATION_COMMANDS = ["status", "apply", "baseline", "prepare-comments-key"] as const

export type ApplyGuardDecision =
  | { kind: "proceed"; note?: string }
  | { kind: "snapshot"; branchName: string; args: string[]; note: string }
  | { kind: "refuse"; message: string }

/** A sortable, human-readable branch name: `premigrate-2026-10-11-14-32-05`. */
export function snapshotBranchName(now: Date): string {
  return `premigrate-${now.toISOString().slice(0, 19).replace(/[:T]/g, "-")}`
}

export function snapshotArgs(projectId: string, parentBranch: string, branchName: string): string[] {
  return ["branches", "create", "--project-id", projectId, "--name", branchName, "--parent", parentBranch]
}

function printableCommand(projectId: string, parentBranch: string, branchName: string, cliVersion: string): string {
  return `npx --yes neon@${cliVersion} ${snapshotArgs(projectId, parentBranch, branchName).join(" ")}`
}

export function decideApplyGuard(input: {
  target: "production" | "dev" | "local"
  command: string
  flags: readonly string[]
  projectId: string
  parentBranch: string
  cliVersion: string
  now: Date
}): ApplyGuardDecision {
  const { target, command, flags, projectId, parentBranch, cliVersion, now } = input
  const wantsSnapshot = flags.includes(SNAPSHOT_FLAG)
  const skipsSnapshot = flags.includes(NO_SNAPSHOT_FLAG)
  const unknown = flags.filter((f) => f !== SNAPSHOT_FLAG && f !== NO_SNAPSHOT_FLAG)

  if (unknown.length) {
    return {
      kind: "refuse",
      message:
        `✗ unknown flag(s) for ${command}: ${unknown.join(" ")}\n` +
        `  Migration commands accept only ${SNAPSHOT_FLAG} / ${NO_SNAPSHOT_FLAG} (production apply).`,
    }
  }

  const gated = target === "production" && command === "apply"
  if (!gated) {
    if (wantsSnapshot || skipsSnapshot) {
      return {
        kind: "refuse",
        message: `✗ ${SNAPSHOT_FLAG}/${NO_SNAPSHOT_FLAG} only apply to \`production apply\`, not \`${target} ${command}\`.`,
      }
    }
    return { kind: "proceed" }
  }

  if (wantsSnapshot && skipsSnapshot) {
    return { kind: "refuse", message: `✗ pass either ${SNAPSHOT_FLAG} or ${NO_SNAPSHOT_FLAG}, not both.` }
  }
  const branchName = snapshotBranchName(now)
  if (wantsSnapshot) {
    return {
      kind: "snapshot",
      branchName,
      args: snapshotArgs(projectId, parentBranch, branchName),
      note: `taking a Neon snapshot branch '${branchName}' off '${parentBranch}' before applying…`,
    }
  }
  if (skipsSnapshot) {
    return {
      kind: "proceed",
      note: `⚠ applying to Neon production with ${NO_SNAPSHOT_FLAG}: no snapshot was taken by this run.`,
    }
  }
  return {
    kind: "refuse",
    message:
      `✗ Refusing to apply migrations to Neon production without a snapshot.\n` +
      `  A Neon branch off '${parentBranch}' is instant and copy-on-write — take one:\n\n` +
      `      ${printableCommand(projectId, parentBranch, branchName, cliVersion)}\n\n` +
      `  Then re-run. Or let this script take it for you:\n\n` +
      `      pnpm neon:apply:prod ${SNAPSHOT_FLAG}\n\n` +
      `  If a snapshot already exists (or you accept the risk), re-run with ${NO_SNAPSHOT_FLAG}.`,
  }
}

/**
 * The same gate for `scripts/neon-migrate.ts`, the entry point that holds raw
 * `NEON_PG_*` credentials and so cannot tell which Neon branch it is pointed
 * at. Returns the refusal text, or null when the apply may proceed: a local
 * database, an explicit flag, or a decision already made by `neon-target.ts`.
 */
export function directApplyRefusal(argv: readonly string[], env: NodeJS.ProcessEnv): string | null {
  if (env.AQUILLA_LOCAL_PG_URL) return null
  if (argv.includes(NO_SNAPSHOT_FLAG) || argv.includes(SNAPSHOT_FLAG)) return null
  if (env.AQUILLA_MIGRATION_SNAPSHOT_DECISION?.trim()) return null
  return (
    `✗ Refusing to apply migrations to a remote Neon branch without a snapshot decision.\n` +
    `  This entry point cannot tell which branch NEON_PG_HOST points at. Use the\n` +
    `  target-aware commands, which gate production and can cut the snapshot:\n\n` +
    `      pnpm neon:apply:prod ${SNAPSHOT_FLAG}   # or ${NO_SNAPSHOT_FLAG} if one exists\n` +
    `      pnpm neon:apply:dev\n\n` +
    `  Or re-run with ${NO_SNAPSHOT_FLAG} to assert this branch is snapshotted or disposable.`
  )
}
