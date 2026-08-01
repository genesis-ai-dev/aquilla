export type LiveEnvironment = "production" | "staging" | "development"
export type LiveSurface = "all" | "auth" | "sync" | "spa"

export interface LiveVerificationOptions {
  surface?: LiveSurface
  fetchImpl?: typeof fetch
  lookup?: (
    hostname: string,
    options: { all: true },
  ) => Promise<Array<{ address: string; family: number }>>
  attempts?: number
  retryDelayMs?: number
  log?: (message: string) => void
}

export function verifyLiveEnvironment(
  environment: LiveEnvironment | string,
  options?: LiveVerificationOptions,
): Promise<void>
