export type DeploymentEnvironment = "production" | "development"

interface DeploymentBindings {
  ENVIRONMENT?: string
  AUTH_WORKER_URL?: string
  DEPLOYMENT_WORKER_NAME?: string
  CF_VERSION_METADATA?: {
    tag?: string
  }
}

/** Bindings consulted by the ALLOW_UNAUTHENTICATED guard. */
export interface AuthBypassBindings {
  ENVIRONMENT?: string
  ALLOW_UNAUTHENTICATED?: string
}

/**
 * ENVIRONMENT values that mean "this Worker is deployed on Cloudflare and
 * serving other people's data". `pnpm dev` leaves sync-worker on the
 * wrangler.toml top-level `ENVIRONMENT = "local"`, and `[env.e2e]` declares no
 * vars block at all (env blocks don't inherit `[vars]`), so neither is caught
 * here — only the two deployed profiles are.
 */
const DEPLOYED_ENVIRONMENTS: ReadonlySet<string> = new Set(["production", "development"])

/**
 * True when these bindings belong to a deployed sync-worker rather than a
 * laptop or an ephemeral E2E stack. Deliberately keyed on ENVIRONMENT rather
 * than the request hostname so a `*.workers.dev` or PR-preview deploy of the
 * production/development profile is still treated as deployed.
 */
export function isDeployedEnvironment(bindings: AuthBypassBindings): boolean {
  return DEPLOYED_ENVIRONMENTS.has(bindings.ENVIRONMENT ?? "")
}

/**
 * `ALLOW_UNAUTHENTICATED="true"` skips sync-token JWT verification entirely on
 * ProjectSync WebSocket connections (project-do.ts `/connect`) — a local-dev
 * escape hatch from before the client fetched /sync-token. On a deployed
 * worker it would let any unauthenticated client join any project's realtime
 * session, read presence, and take focus-lock leases, so it must never be set
 * there. wrangler.toml only documents that in a comment, and the flag is
 * settable after the fact via `wrangler secret put` — which no config review
 * would catch. Fail closed instead of trusting the comment.
 *
 * Returns an operator-facing message when the combination is unsafe, else null.
 */
export function unauthenticatedBypassError(bindings: AuthBypassBindings): string | null {
  if (bindings.ALLOW_UNAUTHENTICATED !== "true") return null
  if (!isDeployedEnvironment(bindings)) return null
  return `ALLOW_UNAUTHENTICATED=true with ENVIRONMENT=${bindings.ENVIRONMENT} — the sync auth bypass must never be enabled on a deployed worker`
}

interface ExpectedDeployment {
  environment: DeploymentEnvironment
  authHostname: string
  worker: string
}

const EXPECTED_DEPLOYMENTS: Record<string, ExpectedDeployment> = {
  "api.aquilla.app": {
    environment: "production",
    authHostname: "api.aquilla.app",
    worker: "aquilla-sync-worker",
  },
  "api.dev.aquilla.app": {
    environment: "development",
    authHostname: "api.dev.aquilla.app",
    worker: "aquilla-sync-worker-dev",
  },
}

/**
 * Fail closed when a first-party API hostname is served by another
 * environment's bindings. Preview workers and local development use other
 * hostnames, so they deliberately remain outside this production guard.
 */
export function deploymentEnvironmentError(
  requestUrl: string,
  bindings: DeploymentBindings,
): string | null {
  const requestHostname = new URL(requestUrl).hostname
  const expected = EXPECTED_DEPLOYMENTS[requestHostname]
  if (!expected) return null

  if (bindings.ENVIRONMENT !== expected.environment) {
    return `${requestHostname} expected ENVIRONMENT=${expected.environment}, received ${bindings.ENVIRONMENT ?? "unset"}`
  }

  if (!bindings.AUTH_WORKER_URL) {
    return `${requestHostname} expected AUTH_WORKER_URL host ${expected.authHostname}, received unset`
  }

  let authHostname: string
  try {
    authHostname = new URL(bindings.AUTH_WORKER_URL).hostname
  } catch {
    return `${requestHostname} received an invalid AUTH_WORKER_URL`
  }

  if (authHostname !== expected.authHostname) {
    return `${requestHostname} expected AUTH_WORKER_URL host ${expected.authHostname}, received ${authHostname}`
  }

  if (bindings.DEPLOYMENT_WORKER_NAME !== expected.worker) {
    return `${requestHostname} expected DEPLOYMENT_WORKER_NAME=${expected.worker}, received ${bindings.DEPLOYMENT_WORKER_NAME ?? "unset"}`
  }

  const versionTag = bindings.CF_VERSION_METADATA?.tag
  const expectedTagPrefix = `${expected.worker}-${expected.environment}-`
  if (!versionTag?.startsWith(expectedTagPrefix)) {
    return `${requestHostname} expected a version tag beginning ${expectedTagPrefix}, received ${versionTag ?? "unset"}`
  }

  return null
}

/**
 * The `scheduled` entrypoint's version of the guard above.
 *
 * `deploymentEnvironmentError` keys off the request hostname, which a cron has
 * none of — so a worker whose profile and bindings disagree would sail straight
 * past it. That matters for the AQU-1856 R2 sweep in particular: it DELETES
 * user media unattended, so a development-profile deploy pointed at the
 * production bucket must not run it.
 *
 * Returns an operator-facing message when the combination is unsafe, else null.
 * A non-deployed worker (`pnpm dev`, `[env.e2e]`) returns null — local stacks
 * own their own bucket and are allowed to sweep it.
 */
export function scheduledDeploymentEnvironmentError(
  bindings: AuthBypassBindings & { DEPLOYMENT_WORKER_NAME?: string },
): string | null {
  if (!isDeployedEnvironment(bindings)) return null
  const expected = Object.values(EXPECTED_DEPLOYMENTS).find(
    (d) => d.environment === bindings.ENVIRONMENT,
  )
  if (!expected) {
    return `ENVIRONMENT=${bindings.ENVIRONMENT} has no expected deployment profile`
  }
  if (bindings.DEPLOYMENT_WORKER_NAME !== expected.worker) {
    return `ENVIRONMENT=${expected.environment} expected DEPLOYMENT_WORKER_NAME=${expected.worker}, received ${bindings.DEPLOYMENT_WORKER_NAME ?? "unset"}`
  }
  return null
}
