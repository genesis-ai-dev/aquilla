/** Minimal fetch shape recordDeployment/hasSuccessfulDeployment need — real `fetch` satisfies it. */
export type FetchImpl = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; redirect?: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status?: number; json: () => Promise<unknown>; text: () => Promise<string> }>

export interface DeploymentLookup {
  sha: string
  environment: string
  repo?: string
  token: string
  fetchImpl?: FetchImpl
}

export function hasSuccessfulDeployment(opts: DeploymentLookup): Promise<boolean>

export interface RecordDeploymentOptions extends DeploymentLookup {
  description: string
}

export function recordDeployment(
  opts: RecordDeploymentOptions,
): Promise<{ created: boolean; id?: number }>
