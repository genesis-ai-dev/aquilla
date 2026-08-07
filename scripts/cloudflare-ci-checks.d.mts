export interface CheckLane {
  name: string
  steps: Array<[command: string, args: string[]]>
}

export type CheckRunner = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
) => Promise<void>

export const CHECK_LANES: CheckLane[]

export function runCommand(
  command: string,
  args: string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv },
): Promise<void>

export function runParallelChecks(options?: {
  env?: NodeJS.ProcessEnv
  cwd?: string
  lanes?: CheckLane[]
  run?: CheckRunner
  log?: (message: string) => void
}): Promise<void>
