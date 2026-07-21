import type { Env } from "./types"

/**
 * The subset of the `@cloudflare/sandbox` `Sandbox` surface this worker uses.
 * Declaring it as a narrow interface lets the route layer be unit-tested with
 * an injected fake — no Docker/container runtime required in CI (contract §7).
 * The real `Sandbox` stub returned by `getSandbox()` structurally satisfies it.
 */
export interface SandboxRunResult {
  logs: { stdout: string[]; stderr: string[] }
  error?: { name: string; message: string; traceback?: string[] }
  results: Array<Record<string, unknown>>
}

export interface SandboxWriteResult {
  success: boolean
  path: string
}

export interface SandboxReadResult {
  success: boolean
  path: string
  content: string
  encoding?: string
  isBinary?: boolean
  size?: number
}

export interface SandboxLike {
  runCode(
    code: string,
    options?: {
      language?: "python" | "javascript" | "typescript"
      timeout?: number
      signal?: AbortSignal
    },
  ): Promise<SandboxRunResult>
  writeFile(
    path: string,
    content: string,
    options?: { encoding?: string },
  ): Promise<SandboxWriteResult>
  readFile(
    path: string,
    options?: { encoding?: string },
  ): Promise<SandboxReadResult>
  destroy(): Promise<void>
}

/**
 * Factory the route layer calls to obtain a per-session sandbox. The real
 * implementation (which imports `@cloudflare/sandbox`) lives in
 * `resolve-sandbox.ts` so route tests can load `app.ts` without pulling in the
 * container SDK — its transitive deps break Node's ESM loader under vitest.
 */
export type ResolveSandbox = (env: Env, sessionId: string) => SandboxLike
