export type PreviewSurface = "web" | "auth" | "sync"
export const PREVIEW_WORKERS: Record<string, string>
export interface PreviewConfig {
  name: string
  account_id: string
  main: string
  compatibility_date: string
  compatibility_flags: string[]
  workers_dev: boolean
  preview_urls: boolean
  assets?: {
    directory: string
    binding: string
    not_found_handling: string
  }
  migrations?: Array<{ tag: string; new_sqlite_classes: string[] }>
  previews: {
    observability: { enabled: boolean }
    vars?: Record<string, string>
    hyperdrive?: Array<{ binding: string; id: string }>
    r2_buckets?: Array<{ binding: string; bucket_name: string }>
    version_metadata?: { binding: string }
    durable_objects?: {
      bindings: Array<{ name: string; class_name: string }>
    }
  }
}
export function previewConfig(
  surface: string,
  options: { cwd: string; urls?: Partial<Record<PreviewSurface, string>> },
): PreviewConfig
export function previewOrigin(
  entry: Record<string, unknown>, surface: string, name: string,
): string
export function deployStackPreview(options?: {
  cwd?: string
  env?: NodeJS.ProcessEnv
  run?: (
    command: string, args: string[],
    options: { cwd: string; env: NodeJS.ProcessEnv },
  ) => Promise<{ stdout: string }>
  notify?: (options: { env: NodeJS.ProcessEnv; urls: Record<PreviewSurface, string> }) => Promise<void>
  verify?: (directory: string) => unknown
  cleanup?: (options: {
    cwd: string; env: NodeJS.ProcessEnv; currentAlias: string; workers: string[]
  }) => Promise<unknown>
}): Promise<{ name: string; urls: Record<PreviewSurface, string> }>
