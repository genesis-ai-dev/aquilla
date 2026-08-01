export interface DeploymentPlan {
  mode: "production" | "preview"
  environment: "production" | "staging" | "development"
  args: string[]
}

export function deploymentPlan(branch: string | undefined): DeploymentPlan

export function runDeployment(options?: {
  branch?: string
  workersCi?: string
  spawnCommand?: typeof import("node:child_process").spawn
}): Promise<void>
