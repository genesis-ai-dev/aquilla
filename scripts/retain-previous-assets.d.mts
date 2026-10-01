export interface AssetManifestEntry {
  /** Published path relative to the asset root, e.g. "assets/app-chunk-x.js". */
  path: string
  /** ISO timestamp after which a superseded asset may be dropped; null while live. */
  retainUntil: string | null
}

export interface AssetManifest {
  schemaVersion: number
  generatedAt: string
  assets: AssetManifestEntry[]
}

export interface ReconcileInput {
  currentPaths: string[]
  previous: unknown
  now: Date
  retentionMs?: number
}

export interface ReconcileResult {
  manifest: AssetManifest
  restore: AssetManifestEntry[]
}

export interface RetainOptions {
  distDir: string
  baseUrl: string
  now?: Date
  retentionMs?: number
  fetchImpl?: typeof fetch
  log?: Pick<Console, "log" | "warn">
}

export interface RetainResult {
  manifest: AssetManifest
  restored: string[]
  unavailable: string[]
}

export const ASSET_MANIFEST_PATH: string
export const RETENTION_MS: number
export const RETAINED_PREFIX: string

export function currentAssetPaths(distDir: string): string[]
export function parseAssetManifest(raw: unknown): { assets: AssetManifestEntry[] }
export function reconcileAssetManifest(input: ReconcileInput): ReconcileResult
export function retainPreviousAssets(options: RetainOptions): Promise<RetainResult>
