// Target guard for the dev-DB seed loader (scripts/seed-load.ts).
//
// The loader is destructive by design: it DELETEs every row carried by the
// bundle's id-sets (projects, users, orgs, groups, assignments — and via the
// seed tables, their cells/files/events) and re-inserts the bundle verbatim.
// Pointed at production it silently replaces live project content with a
// day-old mirror, which is exactly how imported content "vanishes about a day
// after import" (AQU-750).
//
// The original guard was fail-OPEN:
//
//   if (process.env.NEON_PG_HOST && host === process.env.NEON_PG_HOST) throw …
//
// It only fired when the operator happened to have NEON_PG_HOST exported AND
// that value happened to be the production host. A fresh checkout, a shell
// without `.env` loaded, or a session where neon-target.ts / refresh-neon-
// branch.ts had already reassigned NEON_PG_HOST to a *non*-prod branch left
// the loader free to write to whatever `--target` named.
//
// The rule is now fail-CLOSED: loopback targets are always allowed, every
// remote target must be named a second time on the command line, and a host
// declared as production is refused outright and cannot be confirmed past.

/** Flag an operator must pass, echoing the exact hostname, for a remote target. */
export const CONFIRM_FLAG = "--confirm-remote-target"

// `new URL()` keeps IPv6 literals bracketed, so both spellings are listed.
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"])

export interface SeedTargetGuardInput {
  /** The Postgres connection string the loader is about to open. */
  url: string
  /** Process environment (injected so this is testable without mutating globals). */
  env: Record<string, string | undefined>
  /** Full argv, scanned for the confirmation flag. */
  argv: readonly string[]
}

function hostnameOf(url: string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`refusing to load: target is not a valid connection URL`)
  }
  const host = parsed.hostname.trim().toLowerCase()
  if (!host) throw new Error(`refusing to load: target connection URL has no host`)
  return host
}

/** Hosts the operator has declared to be production, from the environment. */
function productionHosts(env: Record<string, string | undefined>): Set<string> {
  const hosts = new Set<string>()
  for (const name of ["AQUILLA_PROD_PG_HOST", "NEON_PG_HOST"]) {
    const value = env[name]?.trim().toLowerCase()
    if (value) hosts.add(value)
  }
  return hosts
}

function confirmedHost(argv: readonly string[]): string | null {
  const i = argv.indexOf(CONFIRM_FLAG)
  if (i < 0) return null
  return argv[i + 1]?.trim().toLowerCase() || null
}

/**
 * Throw unless this target is safe for a destructive seed load.
 *
 * Order matters: the production deny runs first so `--confirm-remote-target`
 * can never unlock a host the operator has declared to be production.
 *
 * @returns the validated hostname, for logging by the caller.
 */
export function assertSeedTargetAllowed({ url, env, argv }: SeedTargetGuardInput): string {
  const host = hostnameOf(url)

  if (productionHosts(env).has(host)) {
    throw new Error(`refusing to load into prod host ${host}`)
  }

  if (LOOPBACK_HOSTS.has(host)) return host

  const confirmed = confirmedHost(argv)
  if (confirmed !== host) {
    throw new Error(
      `refusing to load into remote host ${host}: the seed loader DELETEs and replaces ` +
        `every row the bundle carries, so a remote target must be named twice.\n` +
        `  If ${host} is a disposable non-production branch, re-run with ` +
        `${CONFIRM_FLAG} ${host}\n` +
        `  Never point this at production (AQU-750).`,
    )
  }

  return host
}
