export interface WorkerTestScope {
  auth: boolean
  sync: boolean
  agent: boolean
  monitor: boolean
}

export function resolveWorkerTestScope(
  files: string[],
  options?: { forceAll?: boolean },
): WorkerTestScope

export function formatWorkerTestScope(scope: WorkerTestScope): string
