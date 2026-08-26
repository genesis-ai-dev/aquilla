// AQU-1005: sync-worker fences the whole /migrate/* surface behind an
// identification header (sync-worker/src/lib/migrate-fence.ts) — every run
// must say who or what is running it, so bulk ingests are attributable in the
// audit log and any un-updated automation surfaces as a logged 503 instead of
// an anonymous load spike. Call installMigrateRunnerHeader() once at the top
// of every CLI entrypoint that talks to /migrate/*; the wrapper stamps every
// migrate call, including those made by src/lib/migrate libraries.
//
// Override the auto id (user@host) with MIGRATE_RUNNER, e.g.
//   MIGRATE_RUNNER=nightly-delta-sync tsx scripts/migrate-all.ts …

import os from "node:os"

export const MIGRATE_RUNNER_HEADER = "x-migrate-runner"

export function migrateRunnerId(): string {
  const explicit = process.env.MIGRATE_RUNNER?.trim()
  if (explicit) return explicit
  try {
    return `${os.userInfo().username}@${os.hostname()}`
  } catch {
    return `unknown@${os.hostname()}`
  }
}

export function installMigrateRunnerHeader(): void {
  const original = globalThis.fetch
  const runner = migrateRunnerId()
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    if (!url.includes("/migrate/")) return original(input as RequestInfo, init)
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    )
    if (!headers.has(MIGRATE_RUNNER_HEADER)) headers.set(MIGRATE_RUNNER_HEADER, runner)
    return original(input as RequestInfo, { ...init, headers })
  }) as typeof fetch
}
