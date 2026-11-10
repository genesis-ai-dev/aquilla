import type { SandboxLike, SandboxRunResult } from "./sandbox"

/** stdout/stderr are each capped at 64KB (contract §1). */
export const OUTPUT_CAP_BYTES = 64 * 1024
/** Default / max execution timeout (contract §1). */
export const DEFAULT_TIMEOUT_MS = 60_000
export const MAX_TIMEOUT_MS = 300_000

/**
 * The container enforces the deadline itself: the code runs under GNU
 * `timeout` (container-exec.ts), which stops it and everything it started and
 * reports a `TimeoutError`. The Worker-side race in `execCode` is only a
 * backstop for a container or RPC that hangs, so it allows for the cold start a
 * first `/exec` pays before the deadline even begins. The allowance is bounded
 * by the timeout itself so a 20 ms test timeout still fails fast.
 */
export const START_GRACE_MS = 30_000

export function backstopMs(timeoutMs: number): number {
  return timeoutMs + Math.min(timeoutMs, START_GRACE_MS)
}

export interface ExecInput {
  language: "js" | "python"
  code: string
  timeoutMs?: number
}

export interface ExecOutput {
  ok: boolean
  stdout: string
  stderr: string
  resultJson?: string
  durationMs: number
  truncated?: boolean
}

const encoder = new TextEncoder()

/** Cap a string to `OUTPUT_CAP_BYTES` bytes, flagging truncation. */
function cap(value: string): { value: string; truncated: boolean } {
  const bytes = encoder.encode(value)
  if (bytes.length <= OUTPUT_CAP_BYTES) return { value, truncated: false }
  // Slice on a byte boundary, then drop any partial trailing UTF-8 sequence.
  const sliced = bytes.slice(0, OUTPUT_CAP_BYTES)
  // Default TextDecoder is non-fatal: a partial trailing UTF-8 sequence at the
  // cut point is replaced rather than throwing.
  const decoded = new TextDecoder().decode(sliced)
  return { value: decoded, truncated: true }
}

export function clampTimeout(timeoutMs?: number): number {
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return DEFAULT_TIMEOUT_MS
  }
  return Math.min(Math.floor(timeoutMs), MAX_TIMEOUT_MS)
}

/** Pick a JSON-serializable value out of the interpreter's rich results. */
function pickResultJson(results: Array<Record<string, unknown>>): string | undefined {
  if (!Array.isArray(results) || results.length === 0) return undefined
  const last = results[results.length - 1]
  if (!last) return undefined
  const candidate =
    "json" in last ? last.json : "data" in last ? last.data : "text" in last ? last.text : undefined
  if (candidate === undefined) return undefined
  try {
    return JSON.stringify(candidate)
  } catch {
    return undefined
  }
}

/**
 * Run js/python in the sandbox, shaping the interpreter result to the wire
 * contract with output caps and timeout semantics. A run the container stopped
 * at its deadline comes back as `{ ok: false, stderr: "timeout" }` with
 * whatever it printed first; a hung container hits the backstop with no output.
 */
export async function execCode(sandbox: SandboxLike, input: ExecInput): Promise<ExecOutput> {
  const timeout = clampTimeout(input.timeoutMs)
  const language = input.language === "python" ? "python" : "javascript"
  const started = Date.now()

  let timer: ReturnType<typeof setTimeout> | undefined
  const backstop = new Promise<"__timeout__">((resolve) => {
    timer = setTimeout(() => resolve("__timeout__"), backstopMs(timeout))
  })

  let result: SandboxRunResult | "__timeout__"
  try {
    result = await Promise.race([sandbox.runCode(input.code, { language, timeout }), backstop])
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const durationMs = Date.now() - started
    if (/timeout|abort/i.test(message)) return { ok: false, stdout: "", stderr: "timeout", durationMs }
    return { ok: false, stdout: "", stderr: message, durationMs }
  } finally {
    clearTimeout(timer)
  }

  if (result === "__timeout__") {
    return { ok: false, stdout: "", stderr: "timeout", durationMs: Date.now() - started }
  }

  // The Durable Object hands back one string per stream (the whole captured
  // output), so joining with "" is exact; the 0.x interpreter's per-message
  // chunks carried their own newlines and joined the same way.
  const stdout = cap((result.logs?.stdout ?? []).join(""))

  if (result.error?.name === "TimeoutError") {
    return {
      ok: false,
      stdout: stdout.value,
      stderr: "timeout",
      durationMs: Date.now() - started,
      truncated: stdout.truncated,
    }
  }

  const errorTail = result.error
    ? `${result.error.name}: ${result.error.message}\n${(result.error.traceback ?? []).join("\n")}`
    : ""
  const stderr = cap((result.logs?.stderr ?? []).join("") + errorTail)

  return {
    ok: !result.error,
    stdout: stdout.value,
    stderr: stderr.value,
    resultJson: pickResultJson(result.results ?? []),
    durationMs: Date.now() - started,
    truncated: stdout.truncated || stderr.truncated,
  }
}
