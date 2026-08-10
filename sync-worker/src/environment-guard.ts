export type DeploymentEnvironment = "production" | "development"

interface DeploymentBindings {
  ENVIRONMENT?: string
  AUTH_WORKER_URL?: string
  DEPLOYMENT_WORKER_NAME?: string
  CF_VERSION_METADATA?: {
    tag?: string
  }
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
