export const SURFACES: string[]
export const DEFAULT_WATCH_MINUTES: number
export const MIN_REQUESTS: number
export const RATE_FLOOR: number
export const RATE_FACTOR: number
export const EARLY_EXIT_RATE: number

/** Invocation counts for one Worker over a window. */
export interface InvocationSample {
  requests: number
  errors: number
}

export type WorkerVerdict = { verdict: "ok" | "bad" | "quiet" | "no-signal"; why: string; rate?: number }

/** One Worker's verdict from its failed-invocation counts before and after the deploy. */
export function workerVerdict(samples: { before?: InvocationSample | null; after?: InvocationSample | null }): WorkerVerdict

/** Whether a mid-watch reading is bad enough to stop watching and decide now. */
export function decisiveEarly(workers: WorkerVerdict[]): boolean

/** The release's decision from every Worker's verdict and the live probe. */
export function decideRollback(input: {
  workers: ({ worker: string } & WorkerVerdict)[]
  probe?: { ok: boolean; why?: string }
}): { action: "rollback" | "none" | "no-signal"; reason: string }

/** The version a `wrangler deployments status --json` document says serves all traffic, or null. */
export function activeVersion(deployment: unknown): string | null

export interface SurfaceSnapshot {
  surface: string
  worker: string
  directory: string
  versionId: string | null
}

/** Every surface whose recorded version is not the one serving now. */
export function rollbackPlan(
  snapshot: { surfaces: SurfaceSnapshot[] },
  current: Record<string, string | null>,
): { surface: string; worker: string; directory: string; versionId: string }[]
