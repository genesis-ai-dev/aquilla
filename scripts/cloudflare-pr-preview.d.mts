export interface PullRequestPreviewResult {
  alias: string
  url: string
  versionId: string
  workerName: string
}

export interface CommandResult {
  stdout: string
  stderr: string
}

export interface CommandOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
}

export type CommandRunner = (
  command: string,
  args: string[],
  options?: CommandOptions,
) => Promise<CommandResult>

export function pullRequestPreviewAlias(prNumber: string | number): string

export function previewUrlFromUpload(
  entry: Record<string, unknown>,
  options: { alias: string; workerName?: string },
): string

export function runCommand(
  command: string,
  args: string[],
  options?: CommandOptions,
): Promise<CommandResult>

export function uploadPullRequestPreview(options?: {
  prNumber?: string | number
  commitSha?: string
  cwd?: string
  githubOutputPath?: string | null
  run?: CommandRunner
  log?: (message: string) => void
  verifyArtifacts?: (directory: string) => unknown
}): Promise<PullRequestPreviewResult>
