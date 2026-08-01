export type DeploymentEnvironment = "production" | "staging" | "development"

interface DeploymentBindings {
  ENVIRONMENT?: string
  AUTH_WORKER_URL?: string
}

interface ExpectedDeployment {
  environment: DeploymentEnvironment
  authHostname: string
}

const EXPECTED_DEPLOYMENTS: Record<string, ExpectedDeployment> = {
  "api.aquilla.app": {
    environment: "production",
    authHostname: "api.aquilla.app",
  },
  "api.staging.aquilla.app": {
    environment: "staging",
    authHostname: "api.staging.aquilla.app",
  },
  "api.dev.aquilla.app": {
    environment: "development",
    authHostname: "api.dev.aquilla.app",
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

  return null
}
