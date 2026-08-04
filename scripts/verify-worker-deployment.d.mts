import type {
  DeploymentEnvironment,
  DeploymentExpectation,
  WorkerSurface,
} from "./cloudflare-deployment-manifest.mjs"

export interface WorkerDeployment {
  versions?: Array<{
    version_id?: string
    percentage?: number
  }>
}

export interface WorkerVersion {
  id?: string
  resources?: {
    bindings?: Array<Record<string, unknown>>
  }
}

export function validateWorkerVersion(
  version: WorkerVersion,
  expectation: DeploymentExpectation,
  expectedVersionId?: string,
): string

export function validateActiveDeployment(
  deployment: WorkerDeployment,
  expectedVersionId: string,
  expectation: DeploymentExpectation,
): string

export function validateProductionDeployment(
  deployment: WorkerDeployment,
  version: WorkerVersion,
  expectation: DeploymentExpectation,
): string

export function verifyWorkerVersion(
  surface: WorkerSurface,
  environment: DeploymentEnvironment,
  versionId: string,
  options?: Record<string, unknown>,
): Promise<string>

export function verifyActiveDeployment(
  surface: WorkerSurface,
  environment: DeploymentEnvironment,
  versionId: string,
  options?: Record<string, unknown>,
): Promise<string>

export function verifyProductionDeployment(
  surface: WorkerSurface,
  options?: Record<string, unknown>,
): Promise<string>
