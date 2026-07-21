import type { SandboxLike } from "./sandbox"

/** stdout/stderr are each capped at 64KB (contract §1). */
export const OUTPUT_CAP_BYTES = 64 * 1024
/** Default / max execution timeout (contract §1). */
export const DEFAULT_TIMEOUT_MS = 60_000
export const MAX_TIMEOUT_MS = 300_000

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
 * contract with output caps and timeout semantics. On timeout the container
 * signal fires and we return `{ ok: false, stderr: "timeout" }`.
 */
export async function execCode(sandbox: SandboxLike, input: ExecInput): Promise<ExecOutput> {
  const timeout = clampTimeout(input.timeoutMs)
  const language = input.language === "python" ? "python" : "javascript"
  const started = Date.now()

  const controller = new AbortController()
  const timer = new Promise<"__timeout__">((resolve) => {
    setTimeout(() => {
      controller.abort()
      resolve("__timeout__")
    }, timeout)
  })

  let result: Awaited<ReturnType<SandboxLike["runCode"]>> | "__timeout__"
  try {
    result = await Promise.race([
      sandbox.runCode(input.code, { language, timeout, signal: controller.signal }),
      timer,
    ])
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const durationMs = Date.now() - started
    if (/timeout|abort/i.test(message)) return { ok: false, stdout: "", stderr: "timeout", durationMs }
    return { ok: false, stdout: "", stderr: message, durationMs }
  }

  if (result === "__timeout__") {
    return { ok: false, stdout: "", stderr: "timeout", durationMs: Date.now() - started }
  }

  // SWARM-TODO(aqu-agent): joins interpreter output chunks with "" assuming
  // each OutputMessage already carries its own newline. If live-container
  // output looks concatenated across print() calls, switch to "\n".
  const stdoutRaw = (result.logs?.stdout ?? []).join("")
  const errorTail = result.error
    ? `${result.error.name}: ${result.error.message}\n${(result.error.traceback ?? []).join("\n")}`
    : ""
  const stderrRaw = (result.logs?.stderr ?? []).join("") + errorTail

  const stdout = cap(stdoutRaw)
  const stderr = cap(stderrRaw)

  return {
    ok: !result.error,
    stdout: stdout.value,
    stderr: stderr.value,
    resultJson: pickResultJson(result.results ?? []),
    durationMs: Date.now() - started,
    truncated: stdout.truncated || stderr.truncated,
  }
}
