export interface CheckLane {
  name: string
  steps: Array<[command: string, args: string[]]>
}

export interface CheckPhase {
  name: string
  lanes: CheckLane[]
}

export type CheckRunner = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
) => Promise<void>

export const CHECK_LANES: CheckLane[]
export const CHECK_PHASES: CheckPhase[]

export function runCommand(
  command: string,
  args: string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv },
): Promise<void>

export function runParallelChecks(options?: {
  env?: NodeJS.ProcessEnv
  cwd?: string
  phases?: CheckPhase[]
  run?: CheckRunner
  log?: (message: string) => void
}): Promise<void>
