import os from "node:os"
import path from "node:path"

export interface DaemonConfig {
  home: string
  syncBase: string
  syncSecret: string
  gitlabUrl: string
  gitlabToken: string
  runner: string
  pushEventsPerSec: number
  chunkStart: number
  chunkMin: number
  chunkMax: number
  fetchConcurrency: number
  materializeConcurrency: number
  inboxPollMs: number
  reconcileMs: number
  orgMapsRefreshMs: number
  discordWebhookUrl?: string
  r2?: { accountId: string; accessKeyId: string; secretAccessKey: string }
  dryRun: boolean
}

const num = (v: string | undefined, d: number): number => (v && Number.isFinite(Number(v)) ? Number(v) : d)

export function loadConfig(env: NodeJS.ProcessEnv = process.env, overrides: Partial<DaemonConfig> = {}): DaemonConfig {
  const required = (k: string): string => {
    const v = env[k]
    if (!v) throw new Error(`${k} not set`)
    return v
  }
  const r2 = env.R2_ACCOUNT_ID && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY
    ? { accountId: env.R2_ACCOUNT_ID, accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY }
    : undefined
  return {
    home: env.MIGRATE_HOME ?? path.join(os.homedir(), "aquilla-migrate"),
    syncBase: env.SYNC_BASE ?? "https://api.aquilla.app/sync",
    syncSecret: required("SYNC_SECRET_KEY"),
    gitlabUrl: required("GITLAB_URL"),
    gitlabToken: required("FRONTIER_TOKEN"),
    runner: env.MIGRATE_RUNNER ?? `daemon@${os.hostname()}`,
    pushEventsPerSec: num(env.PUSH_EVENTS_PER_SEC, 400),
    chunkStart: 500,
    chunkMin: 50,
    chunkMax: 2500,
    fetchConcurrency: num(env.FETCH_CONCURRENCY, 4),
    materializeConcurrency: num(env.MATERIALIZE_CONCURRENCY, 2),
    inboxPollMs: 30_000,
    reconcileMs: 15 * 60_000,
    orgMapsRefreshMs: 60 * 60_000,
    discordWebhookUrl: env.DISCORD_WEBHOOK_URL,
    r2,
    dryRun: false,
    ...overrides,
  }
}
