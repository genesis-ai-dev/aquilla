/**
 * How the `Sandbox` Durable Object (sandbox-do.ts) runs one piece of agent code
 * inside its container, as pure data: the policy that used to be class fields
 * on the 0.x SDK's `Sandbox` (`enableInternet`, `sleepAfter`, the wrangler
 * `instance_type`), and the argv/env of the process that replaces the 0.x code
 * interpreter. Nothing here touches a binding, so test/runtime-policy.test.ts
 * reads the real values instead of grepping for them.
 */

/** The only directory agent code may read or write (paths.ts enforces it). */
export const WORKSPACE = "/workspace"

/**
 * AQU-1848: how long an idle container lives before Cloudflare stops it.
 *
 * Replaces the 0.x `sleepAfter = "10m"` class field. In 1.x the Durable Object
 * calls `setInactivityTimeout()` after `start()`, and again in its constructor
 * when a restarted object finds the container still running (the timeout does
 * not survive a Durable Object restart). It must outlive the longest legitimate
 * gap between two `/exec` calls in one session — an import pauses for a model
 * round trip between them — which 10 minutes comfortably does; the pool lease
 * TTL in `pool.ts` is what reclaims a slot whose holder actually died.
 */
export const INACTIVITY_TIMEOUT_MS = 10 * 60 * 1000

/** Replaces `instance_type = "standard-1"` in wrangler.toml (contract §6). */
export const INSTANCE_TYPE = "standard-1" as const

/**
 * Untrusted import code must not be able to exfiltrate uploaded content, so the
 * container starts with no outbound network at all (no DNS answers either).
 * 1.x defaults this to `false` where 0.x defaulted to `true`, but every
 * `start()` call must pass the flag explicitly, so the policy lives here and
 * test/runtime-policy.test.ts asserts that `start()` reads it.
 */
export const ENABLE_INTERNET = false

/**
 * Key under `containers[].images` in wrangler.toml. Wrangler builds the
 * Dockerfile and exposes the digest-pinned reference as
 * `ctx.container.images.sandbox`.
 */
export const IMAGE_NAME = "sandbox"

export type RunLanguage = "python" | "javascript"

/**
 * `/exec` accepts "js" | "python" (exec.ts maps js → javascript); the 0.x SDK
 * also knew "typescript". Anything that is not python runs as JavaScript.
 */
export function normalizeLanguage(language: string | undefined): RunLanguage {
  return language === "python" ? "python" : "javascript"
}

/**
 * The per-call runners baked into the image (Dockerfile → /opt/aquilla). Each
 * reads the agent's code from stdin, runs it, and ends stdout with a sentinel
 * line followed by one JSON line `{ result, error }`: the value of the code's
 * last expression and the exception that stopped it — the two things the 0.x
 * interpreter returned that a plain process cannot report through exit codes.
 * See runner/run.py and runner/run.mjs; run-output.ts decodes the envelope.
 */
export const RUNNERS: Readonly<Record<RunLanguage, { interpreter: string; script: string }>> = {
  python: { interpreter: "/usr/local/bin/python3", script: "/opt/aquilla/run.py" },
  javascript: { interpreter: "/usr/bin/node", script: "/opt/aquilla/run.mjs" },
}

/**
 * `exec()` inherits nothing from the image's ENV lines or from `start()` except
 * PATH, so every variable the runners rely on is stated here. No secret ever
 * belongs in this map — the container holds none by design (docs/AGENT-SANDBOX.md).
 */
export const EXEC_ENV: Readonly<Record<string, string>> = {
  PATH: "/usr/local/bin:/usr/bin:/bin",
  HOME: "/root",
  LANG: "C.UTF-8",
  LC_ALL: "C.UTF-8",
  PYTHONUNBUFFERED: "1",
  PYTHONDONTWRITEBYTECODE: "1",
  PYTHONIOENCODING: "utf-8",
  NODE_NO_WARNINGS: "1",
}

/** Seconds GNU `timeout` waits after SIGTERM before it sends SIGKILL. */
export const KILL_AFTER_SECONDS = 5

/** GNU `timeout` exit codes: 124 = the limit passed; 137 = it had to SIGKILL. */
export const TIMEOUT_EXIT_CODE = 124
export const KILLED_EXIT_CODE = 137

/** `timeout` takes a floating-point number of seconds. */
export function timeoutSecondsArg(timeoutMs: number): string {
  return (Math.max(1, timeoutMs) / 1000).toFixed(3)
}

/**
 * The argv of one `/exec` call. GNU coreutils `timeout` is the 1.x way to
 * enforce a deadline: it stops the runner AND the processes the code started
 * (the Container API's `kill()`/`signal` reach only the direct child), so a
 * timed-out run cannot keep changing files after we report it — the 0.x SDK
 * let it run on. The sentinel is the only argument the runner takes; the code
 * itself arrives on stdin, so there is no argv length limit and no temp file.
 */
export function buildRunCommand(language: RunLanguage, timeoutMs: number, sentinel: string): string[] {
  const runner = RUNNERS[language]
  return [
    "/usr/bin/timeout",
    `--kill-after=${KILL_AFTER_SECONDS}`,
    timeoutSecondsArg(timeoutMs),
    runner.interpreter,
    runner.script,
    sentinel,
  ]
}

/**
 * Did the run hit its deadline? 124 is unambiguous. 137 is `timeout` reporting
 * a SIGKILL — its own `--kill-after` blow, or the kernel's OOM killer — so it
 * only counts as a timeout when the process actually lived that long.
 */
export function isTimeoutExit(exitCode: number, elapsedMs: number, timeoutMs: number): boolean {
  if (exitCode === TIMEOUT_EXIT_CODE) return true
  return exitCode === KILLED_EXIT_CODE && elapsedMs >= timeoutMs
}
