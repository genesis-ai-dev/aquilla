export interface WorkersBuildMetadata {
  branch: string
  commitSha: string
}

export function workersBuildMetadata(env?: NodeJS.ProcessEnv): WorkersBuildMetadata
