import deploymentManifest from "../../config/cloudflare-deployments.json"

export type DeploymentEnvironment = "production" | "development"

interface DeploymentBindings {
  ENVIRONMENT?: string
  BASE_URL?: string
  SYNC_WORKER_URL?: string
  DEPLOYMENT_WORKER_NAME?: string
  CF_VERSION_METADATA?: {
    tag?: string
  }
  WRANGLER_LOCAL?: string
}

interface ExpectedDeployment {
  environment: DeploymentEnvironment
  worker: string
  apiHost: string
  plainText: Record<string, string>
}

const identityEnvironments = deploymentManifest.surfaces.identity.environments
const EXPECTED_DEPLOYMENTS = Object.fromEntries(
  Object.entries(identityEnvironments).map(([environment, config]) => [
    config.apiHost,
    {
      environment: environment as DeploymentEnvironment,
      worker: config.worker,
      apiHost: config.apiHost,
      plainText: config.plainText,
    },
  ]),
) as Record<string, ExpectedDeployment>

const EXPECTED_BY_ENVIRONMENT = Object.fromEntries(
  Object.values(EXPECTED_DEPLOYMENTS).map((config) => [config.environment, config]),
) as Record<DeploymentEnvironment, ExpectedDeployment>

function normalizedUrl(value: string): string | null {
  try {
    const url = new URL(value)
    if (url.username || url.password || url.search || url.hash) return null
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`
  } catch {
    return null
  }
}

function expectedBindingError(
  expected: ExpectedDeployment,
  bindings: DeploymentBindings,
): string | null {
  for (const [name, expectedValue] of Object.entries(expected.plainText)) {
    const received = bindings[name as keyof DeploymentBindings]
    if (typeof received !== "string" || !received) {
      return `${expected.apiHost} expected ${name}=${expectedValue}, received unset`
    }
    const receivedValue = name.endsWith("_URL") || name === "BASE_URL"
      ? normalizedUrl(received)
      : received
    if (!receivedValue) return `${expected.apiHost} received an invalid ${name}`
    if (receivedValue !== expectedValue) {
      return `${expected.apiHost} expected ${name}=${expectedValue}, received ${receivedValue}`
    }
  }

  const versionTag = bindings.CF_VERSION_METADATA?.tag
  const expectedTagPrefix = `${expected.worker}-${expected.environment}-`
  if (!versionTag?.startsWith(expectedTagPrefix)) {
    return `${expected.apiHost} expected a version tag beginning ${expectedTagPrefix}, received ${versionTag ?? "unset"}`
  }
  return null
}

/**
 * Fail closed before Postgres is opened when a first-party API hostname is
 * served with another environment's identity bindings. Preview workers,
 * workers.dev, and local development deliberately remain outside this guard.
 */
export function deploymentEnvironmentError(
  requestUrl: string,
  bindings: DeploymentBindings,
): string | null {
  const requestHostname = new URL(requestUrl).hostname
  const expected = EXPECTED_DEPLOYMENTS[requestHostname]
  if (!expected) return null
  return expectedBindingError(expected, bindings)
}

/**
 * Scheduled events do not carry a request hostname. The version tag records
 * the actual Worker namespace selected by the deployer, while the runtime vars
 * record the logical environment. Both must agree before the cron opens Neon.
 */
export function scheduledDeploymentEnvironmentError(
  bindings: DeploymentBindings,
): string | null {
  if (bindings.WRANGLER_LOCAL === "1") return null
  const environment = bindings.ENVIRONMENT as DeploymentEnvironment | undefined
  const expected = environment && EXPECTED_BY_ENVIRONMENT[environment]
  if (!expected) return `scheduled identity event received ENVIRONMENT=${environment ?? "unset"}`
  return expectedBindingError(expected, bindings)
}
