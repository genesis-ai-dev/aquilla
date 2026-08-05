export interface DeploymentArtifactVerification {
  directory: string
  excludedMetadata: string[]
}

export interface PagesDeploymentArtifactPreparation {
  directory: string
  removedMetadata: string[]
}

export const REQUIRED_ASSET_IGNORE_PATTERNS: readonly string[]

export function isForbiddenDeploymentArtifactName(name: string): boolean

export function findForbiddenDeploymentArtifacts(directory: string): string[]

export function assertSafeDeploymentArtifacts(
  directory: string,
): DeploymentArtifactVerification

export function preparePagesDeploymentArtifacts(
  directory: string,
): PagesDeploymentArtifactPreparation
