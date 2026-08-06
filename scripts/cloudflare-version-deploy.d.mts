import type { spawn } from "node:child_process"
import type {
  DeploymentEnvironment,
  DeploymentExpectation,
  WorkerSurface,
} from "./cloudflare-deployment-manifest.mjs"

export interface VerifiedDeploymentResult {
  versionId: string
  workerName: string
  tag: string
  promoted: boolean
}

export function parseWranglerOutput(
  contents: string,
  expectedType: string,
): Record<string, unknown>

export function deploymentVersionTag(
  workerName: string,
  environment: DeploymentEnvironment,
  sourceId?: string,
): string

export function runVerifiedDeployment(options?: {
  surface?: WorkerSurface
  environment?: DeploymentEnvironment
  promote?: boolean
  expectedWorker?: string
  sourceId?: string
  sourceLabel?: string
  spawnCommand?: typeof spawn
  upload?: (options: {
    expectation: DeploymentExpectation
    workerName: string
    tag: string
    message: string
    spawnCommand: typeof spawn
  }) => Promise<string>
  verifyVersion?: (...args: unknown[]) => Promise<string>
  promoteVersion?: (...args: unknown[]) => Promise<void>
  verifyDeployment?: (...args: unknown[]) => Promise<string>
  verifyArtifacts?: (directory: string) => unknown
}): Promise<VerifiedDeploymentResult>
