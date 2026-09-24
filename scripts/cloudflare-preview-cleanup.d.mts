export const ACCOUNT_ID: string
export const PREVIEW_WORKER_NAMES: string[]
export const DEFAULT_IDLE_DAYS: number
export const MAX_DELETIONS_PER_WORKER: number

/** One entry of GET /accounts/{account}/workers/workers/{worker}/previews. */
export interface CloudflarePreview {
  id?: string
  name: string
  created_on?: string | null
  updated_on?: string | null
  deployed_on?: string | null
  [key: string]: unknown
}

export interface StalePreview {
  name: string
  reason: string
  /** Epoch ms of the last deploy/update/create; NaN when unknown. */
  lastActivity: number
}

export interface KeptCounts {
  current: number
  foreign: number
  live: number
  fresh: number
}

export interface StaleSelection {
  stale: StalePreview[]
  deferred: number
  kept: KeptCounts
}

export function previewLastActivity(preview: CloudflarePreview): number

export function selectStalePreviews(options: {
  previews: CloudflarePreview[]
  currentAlias?: string | null
  liveAliases?: Set<string> | null
  now?: number
  idleDays?: number
  limit?: number
}): StaleSelection

export type ExecFile = (
  file: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number; maxBuffer?: number },
) => Promise<{ stdout: string | Buffer }>

export interface LiveBranchAliases {
  source: "git" | "github" | null
  aliases: Set<string> | null
}

export function liveBranchAliases(options?: {
  cwd?: string
  env?: NodeJS.ProcessEnv
  exec?: ExecFile
  fetchImpl?: typeof fetch
}): Promise<LiveBranchAliases>

export interface WorkerCleanupResult {
  worker: string
  total: number
  stale: number
  deleted: number
  failed: number
  deferred: number
  kept: KeptCounts
}

export interface CleanupResult {
  skipped?: "disabled" | "no-token"
  source?: "git" | "github" | null
  dryRun?: boolean
  workers: WorkerCleanupResult[]
}

export function cleanupStalePreviews(options?: {
  cwd?: string
  env?: NodeJS.ProcessEnv
  currentAlias?: string | null
  workers?: string[]
  fetchImpl?: typeof fetch
  exec?: ExecFile
  now?: number
  dryRun?: boolean
  concurrency?: number
  log?: (line: string) => void
  warn?: (line: string) => void
}): Promise<CleanupResult>
