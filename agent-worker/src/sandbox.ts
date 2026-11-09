import type { Env } from "./types"

/**
 * The sandbox surface the route layer uses, declared as a narrow interface so
 * app.ts can be unit-tested with an injected fake — no Docker/container runtime
 * required in CI (contract §7).
 *
 * The shapes are the ones the 0.x Sandbox SDK's code interpreter returned.
 * Since the 1.x migration the real implementation is our own `Sandbox` Durable
 * Object (sandbox-do.ts) reached over RPC, with resolve-sandbox.ts adapting its
 * byte-oriented methods to this seam; the runner scripts in runner/ reproduce
 * `logs` / `error` / `results` from a plain process so exec.ts and the harness
 * that reads its output did not have to change.
 */
export interface SandboxRunResult {
  logs: { stdout: string[]; stderr: string[] }
  /**
   * The exception that stopped the code, if any. `TimeoutError` means the
   * container stopped the run at its deadline; `ProcessExit` means the process
   * died without reporting (killed, `os._exit`, a crashed runtime).
   */
  error?: { name: string; message: string; traceback?: string[] }
  /** The value of the last expression, as `[{ json: value }]`, or empty. */
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
  /**
   * Run code in a fresh process. `timeout` (ms) is enforced inside the
   * container; nothing but files under /workspace carries over between calls.
   */
  runCode(
    code: string,
    options?: {
      language?: "python" | "javascript" | "typescript"
      timeout?: number
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
 * implementation lives in `resolve-sandbox.ts` (a stub of our Durable Object);
 * the Durable Object itself (sandbox-do.ts) is the only module that imports
 * `@cloudflare/sandbox` and `cloudflare:workers`, so route tests load app.ts
 * without either.
 */
export type ResolveSandbox = (env: Env, sessionId: string) => SandboxLike
