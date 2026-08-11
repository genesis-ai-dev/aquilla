export type WorkerSurface = "web" | "identity" | "sync"
export type DeploymentEnvironment = "production" | "development"

export interface DeploymentPlan {
  mode: "preview"
  environment: DeploymentEnvironment
  promote: false
}

export function deploymentPlan(branch?: string): DeploymentPlan

export function runDeployment(options?: {
  surface?: WorkerSurface
  env?: NodeJS.ProcessEnv
  deployVersion?: (options: {
    surface: WorkerSurface
    environment: DeploymentEnvironment
    promote: false
    expectedWorker: string
    sourceId: string
    sourceLabel: string
  }) => Promise<unknown>
}): Promise<unknown>
