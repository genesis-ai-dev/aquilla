import type { spawn } from "node:child_process"
import type {
  DeploymentEnvironment,
  DeploymentExpectation,
  WorkerSurface,
} from "./cloudflare-deployment-manifest.mjs"

export interface SecretRotationResult {
  versionId: string
  workerName: string
  tag: string
  secretName: string
}

export function stagedVersionId(stdout: string): string

export function rotateWorkerSecret(options?: {
  surface?: WorkerSurface
  environment?: DeploymentEnvironment
  secretName?: string
  sourceId?: string
  sourceLabel?: string
  spawnCommand?: typeof spawn
  stage?: (options: {
    expectation: DeploymentExpectation
    secretName: string
    tag: string
    message: string
    spawnCommand: typeof spawn
  }) => Promise<string>
  verifyVersion?: (...args: unknown[]) => Promise<string>
  promoteVersion?: (options: {
    expectation: DeploymentExpectation
    versionId: string
    message: string
    spawnCommand: typeof spawn
  }) => Promise<void>
  verifyDeployment?: (...args: unknown[]) => Promise<string>
  verifyLive?: (...args: unknown[]) => Promise<void>
  log?: (message: string) => void
}): Promise<SecretRotationResult>
