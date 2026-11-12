// Pure helpers for scripts/refresh-neon-branch.ts: how the Neon CLI is invoked
// and how its failures are explained. No I/O here so the explanations can be
// unit-tested against the exact stderr a failed GitHub run produced.

export const DEFAULT_NEON_CLI_VERSION = "2.30.0"

/** Set to "1" (or "true") to stop after the read-only credential preflight. */
export const PREFLIGHT_ONLY_ENV = "NEON_REFRESH_PREFLIGHT_ONLY"

export type NeonCliFailureKind = "auth" | "not-found" | "other"

/**
 * Build the `npx` argv for one Neon CLI invocation.
 *
 * The API key is deliberately NOT placed on argv: the CLI's `--api-key` option
 * defaults to `process.env.NEON_API_KEY`, so passing the key through the
 * environment keeps it out of `ps`, out of the "exited N" error line this
 * script prints, and out of a developer's terminal scrollback.
 */
export function neonCliArgs(args: readonly string[], version = DEFAULT_NEON_CLI_VERSION): string[] {
  return ["--yes", `neon@${version}`, ...args, "--no-analytics", "--color", "false"]
}

/**
 * On an HTTP 401 the Neon CLI (2.30.0) deletes its stored credentials and
 * retries by re-parsing argv on the same yargs instance; the second parse loses
 * a positional, so the run ends with this yargs validation line instead of the
 * real cause. It is noise, never the error.
 */
const RETRY_ARTIFACT = /^ERROR: Not enough non-option arguments: got \d+, need at least \d+$/

const AUTH_PATTERNS = [
  /Authentication failed/i,
  /supplied credentials do not pass authentication/i,
  /\b401\b/,
]
const NOT_FOUND_PATTERNS = [/\b404\b/, /not found/i]

export function classifyNeonCliFailure(stderr: string): NeonCliFailureKind {
  if (AUTH_PATTERNS.some((pattern) => pattern.test(stderr))) return "auth"
  if (NOT_FOUND_PATTERNS.some((pattern) => pattern.test(stderr))) return "not-found"
  return "other"
}

/** `npx` under pnpm complains about pnpm's own npm_config_* variables; unrelated to Neon. */
const NPM_NOISE = /^npm warn /i

/** Keep the CLI's real diagnostics; drop blank lines, npm's env warnings and the yargs retry artifact. */
export function relevantCliStderr(stderr: string): string {
  return stderr
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0 && !RETRY_ARTIFACT.test(line) && !NPM_NOISE.test(line))
    .join("\n")
}

export function isPreflightOnly(env: NodeJS.ProcessEnv): boolean {
  const value = env[PREFLIGHT_ONLY_ENV]?.trim().toLowerCase()
  return value === "1" || value === "true"
}

export interface PreflightFailureInput {
  kind: NeonCliFailureKind
  /** Branch the read-only `branches get` was asked for. */
  branch: string
  projectId: string
  /** Neon organization that owns the project, for the rotation hint. */
  orgLabel: string
  /** true when NEON_API_KEY was in the environment; false for a local `neon auth` login. */
  usingApiKey: boolean
  stderr: string
  cliVersion: string
}

/**
 * Explain a failed credential preflight in terms of what to fix. The restore
 * never ran, so the message can say so.
 */
export function preflightFailureMessage(input: PreflightFailureInput): string {
  const { kind, branch, projectId, orgLabel, usingApiKey, stderr, cliVersion } = input
  const lines: string[] = []

  if (kind === "auth" && usingApiKey) {
    lines.push(
      `NEON_API_KEY was rejected by the Neon API (HTTP 401 "supplied credentials do not pass authentication") while reading branch '${branch}' of project ${projectId}.`,
      "Nothing was restored: the credential preflight runs before the restore.",
      "Neon answers 401 only for a token it cannot authenticate: a revoked key, or a secret whose value is not the key's token",
      "(truncated paste, surrounding quotes/whitespace, the key's name or id instead of the token, or a short-lived OAuth access token",
      "copied from ~/.config/neonctl/credentials.json). A valid key that merely lacks access to the project answers 404, not 401.",
      `Fix: in Neon, open organization ${orgLabel} → Settings → API keys, create a new organization API key (scoping it to project ${projectId} is enough),`,
      'copy the full token (it starts with "napi_") and store it as the GitHub repository secret NEON_API_KEY.',
    )
  } else if (kind === "auth") {
    lines.push(
      `The local Neon CLI login was rejected (HTTP 401) while reading branch '${branch}' of project ${projectId}.`,
      `Run \`npx --yes neon@${cliVersion} auth\` to sign in again, or export NEON_API_KEY.`,
    )
  } else if (kind === "not-found") {
    lines.push(
      `The Neon credentials authenticated, but branch '${branch}' of project ${projectId} is not visible to them (HTTP 404).`,
      usingApiKey
        ? `NEON_API_KEY is scoped to another project, or was created in a Neon account/organization that is not ${orgLabel}. Use an organization API key from ${orgLabel} with access to project ${projectId}.`
        : `Your Neon login does not have access to project ${projectId} in ${orgLabel}.`,
    )
  } else {
    lines.push(`Could not read branch '${branch}' of project ${projectId} with the Neon CLI.`)
  }

  lines.push(
    `Verify without restoring anything: ${PREFLIGHT_ONLY_ENV}=1 pnpm neon:refresh:dev`,
    '(or in GitHub: Actions → "Refresh Dev Neon Branch" → Run workflow with "preflight_only" checked).',
  )
  if (stderr) lines.push(`Neon CLI (${cliVersion}) said:`, stderr)
  return lines.join("\n")
}

interface BranchSummary {
  id: string
  name: string
  lastResetAt: string | null
}

/**
 * Pick the fields the preflight reports from `neon branches get --output json`.
 * Accepts the bare branch object and a `{ branch: {...} }` envelope.
 */
export function summarizeBranchJson(stdout: string): BranchSummary {
  const parsed: unknown = JSON.parse(stdout)
  const record =
    parsed && typeof parsed === "object" && "branch" in parsed && typeof parsed.branch === "object"
      ? parsed.branch
      : parsed
  if (!record || typeof record !== "object") {
    throw new Error("Neon CLI returned no branch object")
  }
  const branch = record as Record<string, unknown>
  const id = typeof branch.id === "string" ? branch.id : null
  const name = typeof branch.name === "string" ? branch.name : null
  if (!id || !name) throw new Error("Neon CLI branch object is missing id or name")
  const lastResetAt = typeof branch.last_reset_at === "string" ? branch.last_reset_at : null
  return { id, name, lastResetAt }
}
