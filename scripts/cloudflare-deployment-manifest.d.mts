export type WorkerSurface = "web" | "identity" | "sync"
export type DeploymentEnvironment = "production" | "staging" | "development"

export interface DeploymentExpectation {
  surface: WorkerSurface
  environment: DeploymentEnvironment
  worker: string
  directory: string
  apiHost?: string
  routes: string[]
  plainText: Record<string, string>
  hyperdrives: Record<string, string>
  r2Buckets: Record<string, string>
  requiredSecrets: string[]
  requiredBindings: Record<string, string>
}

export const REPO_ROOT: string
export const DEPLOYMENT_MANIFEST: {
  schemaVersion: number
  surfaces: Record<string, unknown>
}
export const WORKER_SURFACES: readonly WorkerSurface[]
export const DEPLOYMENT_ENVIRONMENTS: readonly DeploymentEnvironment[]

export function deploymentExpectation(
  surface: WorkerSurface,
  environment: DeploymentEnvironment,
): DeploymentExpectation
