export type WorkerSurface = "web" | "identity" | "sync"
export type DeploymentEnvironment = "production" | "staging" | "development"

export interface DeploymentPlan {
  mode: "production" | "preview"
  environment: DeploymentEnvironment
  promote: boolean
}

export function deploymentPlan(branch?: string): DeploymentPlan

export function runDeployment(options?: {
  surface?: WorkerSurface
  branch?: string
  workersCi?: string
  commitSha?: string
  buildUuid?: string
  deployVersion?: (options: {
    surface: WorkerSurface
    environment: DeploymentEnvironment
    promote: boolean
    expectedWorker: string
    sourceId: string
    sourceLabel: string
  }) => Promise<unknown>
}): Promise<unknown>
