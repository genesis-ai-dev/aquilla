import type { SandboxRunResult } from "./sandbox"

/**
 * Bytes of stdout/stderr kept for the caller. exec.ts caps the wire contract at
 * 64 KiB (`OUTPUT_CAP_BYTES`); this leaves room for the error tail it appends
 * and for a multi-byte character cut at the boundary.
 */
export const OUTPUT_HEAD_BYTES = 256 * 1024

/**
 * Trailing bytes of stdout searched for the runner's envelope. A result larger
 * than this is dropped (`resultJson` stays undefined) rather than truncated into
 * invalid JSON; stdout itself is unaffected.
 */
export const RESULT_TAIL_BYTES = 1024 * 1024

/**
 * Keeps the first `headCap` and the last `tailCap` bytes of a stream plus its
 * total length, discarding the middle. `process.output()` would hold the whole
 * output in the Durable Object's memory, and a runaway `print` loop must not
 * take the object down with it — so the Durable Object drains the process
 * streams through this instead. Everything is still read, so the process never
 * blocks on a full pipe.
 */
export class CappedCollector {
  total = 0
  private readonly head: Uint8Array[] = []
  private headLen = 0
  private readonly tail: Uint8Array[] = []
  private tailLen = 0

  constructor(
    private readonly headCap: number,
    private readonly tailCap: number,
  ) {}

  push(chunk: Uint8Array): void {
    this.total += chunk.length
    if (this.headLen < this.headCap) {
      const room = this.headCap - this.headLen
      const part = chunk.length > room ? chunk.subarray(0, room) : chunk
      this.head.push(part)
      this.headLen += part.length
    }
    if (this.tailCap <= 0) return
    this.tail.push(chunk)
    this.tailLen += chunk.length
    // Drop whole leading chunks while the rest still covers the cap.
    while (this.tail.length > 1 && this.tailLen - this.tail[0].length >= this.tailCap) {
      const dropped = this.tail.shift()
      this.tailLen -= dropped ? dropped.length : 0
    }
    if (this.tail.length === 1 && this.tailLen > this.tailCap) {
      const only = this.tail[0]
      this.tail[0] = only.subarray(only.length - this.tailCap)
      this.tailLen = this.tailCap
    }
  }

  /** The first bytes, at most `headCap` of them. */
  headBytes(): Uint8Array {
    return concat(this.head, this.headLen)
  }

  /** The last bytes; they start at offset `total - tailBytes().length`. */
  tailBytes(): Uint8Array {
    return concat(this.tail, this.tailLen)
  }

  /** True when more than `headCap` bytes arrived, i.e. `headBytes()` is a prefix. */
  get truncated(): boolean {
    return this.total > this.headCap
  }
}

function concat(parts: Uint8Array[], length: number): Uint8Array {
  if (parts.length === 1) return parts[0]
  const out = new Uint8Array(length)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

/** Pull a process stream to EOF into a collector. A missing stream is empty. */
export async function drain(stream: ReadableStream<Uint8Array> | null, into: CappedCollector): Promise<void> {
  if (!stream) return
  const reader = stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return
    if (value) into.push(value)
  }
}

export interface RunnerError {
  name: string
  message: string
  traceback?: string[]
}

/** What runner/run.py and runner/run.mjs print after the sentinel. */
export interface RunnerEnvelope {
  result?: unknown
  error?: RunnerError | null
}

const encoder = new TextEncoder()
// Non-fatal: a multi-byte sequence cut at the cap decodes to U+FFFD, not a throw.
const decoder = new TextDecoder()

function lastIndexOf(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = haystack.length - needle.length; i >= 0; i--) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer
    }
    return i
  }
  return -1
}

/**
 * Separate what the code printed from the runner's envelope. The envelope
 * follows the LAST `\n<sentinel>\n` in the tail (the code cannot know the
 * sentinel short of reading /proc/self/cmdline, and forging its own result
 * harms nobody but itself); everything before that marker is the code's stdout.
 */
export function splitRunnerOutput(
  stdout: CappedCollector,
  sentinel: string,
): { stdout: string; envelope: RunnerEnvelope | null } {
  const marker = encoder.encode(`\n${sentinel}\n`)
  const tail = stdout.tailBytes()
  const head = stdout.headBytes()
  const at = lastIndexOf(tail, marker)
  if (at < 0) return { stdout: decoder.decode(head), envelope: null }
  const absolute = stdout.total - tail.length + at
  const printed = head.subarray(0, Math.min(head.length, absolute))
  const payload = decoder.decode(tail.subarray(at + marker.length))
  return { stdout: decoder.decode(printed), envelope: parseEnvelope(payload) }
}

function parseEnvelope(text: string): RunnerEnvelope | null {
  const line = text.split("\n", 1)[0] ?? ""
  try {
    const parsed: unknown = JSON.parse(line)
    return typeof parsed === "object" && parsed !== null ? (parsed as RunnerEnvelope) : null
  } catch {
    return null
  }
}

export interface FinishedRun {
  exitCode: number
  stdout: string
  stderr: string
  envelope: RunnerEnvelope | null
  timedOut: boolean
  timeoutMs: number
}

/**
 * Shape one finished process as the interpreter-style result exec.ts consumes
 * (`SandboxRunResult`): the printed streams, the exception as `error`, and the
 * last expression's value as a `json` result. A deadline is reported as a
 * `TimeoutError` the way the 0.x SDK did; a process that died without leaving
 * an envelope (OOM-killed, `os._exit`, a crashed runtime) becomes `ProcessExit`.
 */
export function shapeRunResult(run: FinishedRun): SandboxRunResult {
  let error: RunnerError | undefined
  if (run.timedOut) {
    error = { name: "TimeoutError", message: `Command timeout after ${run.timeoutMs}ms` }
  } else if (run.envelope?.error) {
    error = run.envelope.error
  } else if (run.exitCode !== 0) {
    error = { name: "ProcessExit", message: `process exited with code ${run.exitCode}` }
  }
  const value = run.envelope?.result
  return {
    logs: { stdout: [run.stdout], stderr: [run.stderr] },
    ...(error ? { error } : {}),
    results: value === undefined || value === null ? [] : [{ json: value }],
  }
}
