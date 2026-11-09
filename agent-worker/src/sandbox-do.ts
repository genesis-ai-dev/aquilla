import { DurableObject } from "cloudflare:workers"
import { Files, SandboxFileError } from "@cloudflare/sandbox"
import {
  buildRunCommand,
  ENABLE_INTERNET,
  EXEC_ENV,
  IMAGE_NAME,
  INACTIVITY_TIMEOUT_MS,
  INSTANCE_TYPE,
  isTimeoutExit,
  normalizeLanguage,
  WORKSPACE,
} from "./container-exec"
import { clampTimeout } from "./exec"
import {
  CappedCollector,
  drain,
  OUTPUT_HEAD_BYTES,
  RESULT_TAIL_BYTES,
  shapeRunResult,
  splitRunnerOutput,
} from "./run-output"
import type { SandboxRunResult } from "./sandbox"
import type { Env } from "./types"

/** Options `runCode` takes over RPC. Plain data — an AbortSignal cannot cross the stub. */
export interface RunCodeOptions {
  language?: string
  timeoutMs?: number
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function bytesToStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

function parentDir(path: string): string | null {
  const slash = path.lastIndexOf("/")
  return slash <= 0 ? null : path.slice(0, slash)
}

/**
 * The container-backed Durable Object — one instance per agent session, bound
 * by wrangler.toml as `Sandbox` (the class name is load-bearing: it is the
 * container application's identity).
 *
 * Sandbox SDK 1.x has no `Sandbox` base class and no `getSandbox()`: this class
 * starts and drives its container through the native `ctx.container` API, and
 * the package contributes only `Files` (which runs the `sandbox-shim` helper
 * the Dockerfile copies into the image). The Worker reaches these methods on
 * the stub `env.Sandbox.getByName(sessionId)` — see resolve-sandbox.ts, which
 * adapts them to the `SandboxLike` seam the routes are written against.
 *
 * Policy (egress off, 10-minute idle sleep, `standard-1`) lives in
 * container-exec.ts so the runtime-policy tests can read it.
 */
export class Sandbox extends DurableObject<Env> {
  private setup: Promise<void> | null = null
  private filesHelper: Files | null = null

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    const container = ctx.container
    // The inactivity timeout does not survive a Durable Object restart (a
    // deploy, an eviction): a restarted object that finds its container running
    // must set it again, or the container stops shortly after the next request.
    if (container?.running) {
      void ctx.blockConcurrencyWhile(() => container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS))
    }
  }

  private get container(): Container {
    const container = this.ctx.container
    if (!container) throw new Error("No container is configured for this Durable Object")
    return container
  }

  /** `ctx.container` stays the same object for the life of the Durable Object, so one `Files` serves every container it starts. */
  private get files(): Files {
    if (!this.filesHelper) this.filesHelper = new Files(this.container)
    return this.filesHelper
  }

  /**
   * Start the container once per fresh container, and once more when a
   * restarted Durable Object finds it running. `running` is true as soon as
   * `start()` returns, so concurrent requests share one setup; `exec()` itself
   * waits for a container that is still booting.
   */
  private ensureRunning(): Promise<void> {
    if (this.setup === null || !this.container.running) {
      this.setup = this.startContainer().catch((err: unknown) => {
        this.setup = null
        throw err
      })
    }
    return this.setup
  }

  private async startContainer(): Promise<void> {
    const container = this.container
    if (!container.running) {
      const image = container.images[IMAGE_NAME]
      if (!image) throw new Error(`wrangler.toml declares no containers.images.${IMAGE_NAME} for this class`)
      container.start({
        image,
        instance: INSTANCE_TYPE,
        // Untrusted code: no outbound network (docs/AGENT-SANDBOX.md "Default-deny egress").
        enableInternet: ENABLE_INTERNET,
      })
    }
    try {
      await container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS)
    } catch (err) {
      // Never leave a half-set-up container around: the next request starts a new one.
      await container.destroy()
      throw err
    }
  }

  /**
   * Run one piece of agent code: a fresh `python3`/`node` process under GNU
   * `timeout`, code on stdin, result envelope on stdout (container-exec.ts).
   * Nothing carries over between calls except files under /workspace, which is
   * how both callers (the agent's `run_code` tool and the sandbox import route)
   * already use it.
   */
  async runCode(code: string, options: RunCodeOptions = {}): Promise<SandboxRunResult> {
    const language = normalizeLanguage(options.language)
    const timeoutMs = clampTimeout(options.timeoutMs)
    await this.ensureRunning()

    const sentinel = crypto.randomUUID()
    const started = Date.now()
    const process = await this.container.exec(buildRunCommand(language, timeoutMs, sentinel), {
      cwd: WORKSPACE,
      env: { ...EXEC_ENV },
      stdin: bytesToStream(encoder.encode(code)),
    })
    const stdout = new CappedCollector(OUTPUT_HEAD_BYTES, RESULT_TAIL_BYTES)
    const stderr = new CappedCollector(OUTPUT_HEAD_BYTES, 0)
    const [exitCode] = await Promise.all([
      process.exitCode,
      drain(process.stdout, stdout),
      drain(process.stderr, stderr),
    ])
    const elapsedMs = Date.now() - started

    const split = splitRunnerOutput(stdout, sentinel)
    return shapeRunResult({
      exitCode,
      stdout: split.stdout,
      stderr: decoder.decode(stderr.headBytes()),
      envelope: split.envelope,
      timedOut: isTimeoutExit(exitCode, elapsedMs, timeoutMs),
      timeoutMs,
    })
  }

  /**
   * Write bytes to an absolute path under /workspace (paths.ts has already
   * normalised it). 0.x created missing parents; `Files` does only what it is
   * asked, so the parent is created first.
   */
  async writeFile(path: string, content: ReadableStream<Uint8Array>): Promise<void> {
    await this.ensureRunning()
    const dir = parentDir(path)
    if (dir) await this.files.mkdir(dir, { recursive: true })
    await this.files.writeFile(path, content)
  }

  /** The file's bytes as a stream, or `null` when there is no such file. */
  async readFile(path: string): Promise<ReadableStream<Uint8Array> | null> {
    await this.ensureRunning()
    try {
      const response = await this.files.readFile(path)
      return response.body
    } catch (cause) {
      if (SandboxFileError.is(cause) && (cause.code === "ENOENT" || cause.code === "ENOTDIR")) return null
      throw cause
    }
  }

  /** Stop the container. Idempotent: a container that is not running is already gone. */
  async destroy(): Promise<void> {
    this.setup = null
    const container = this.ctx.container
    if (container?.running) await container.destroy()
  }

  /**
   * 0.x kept an alarm set while a container ran. After the switch to 1.x that
   * alarm fires once per sandbox that was active; without a handler it fails
   * with an internal error and is retried with backoff ("Plan the move to
   * Sandbox SDK 1.0"). Nothing in this class schedules alarms of its own.
   */
  override async alarm(): Promise<void> {}
}
