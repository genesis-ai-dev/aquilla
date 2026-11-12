#!/usr/bin/env tsx
// Refresh a shared non-production Neon branch from Production, apply the repo's
// current migrations to that branch, then run lightweight API health checks.
//
// Before anything destructive, a read-only preflight (`neon branches get` on the
// target and on the source) proves the credentials. The Neon CLI hides a
// rejected key behind a yargs retry artifact ("Not enough non-option
// arguments: got 1, need at least 2"); the preflight turns that into a message
// that names the fix. With NEON_REFRESH_PREFLIGHT_ONLY=1 the preflight is all
// this script does, which is how a rotated NEON_API_KEY is verified without
// restoring anything.

import { spawn } from "node:child_process"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import process from "node:process"
import {
  classifyNeonCliFailure,
  DEFAULT_NEON_CLI_VERSION,
  isPreflightOnly,
  neonCliArgs,
  preflightFailureMessage,
  PREFLIGHT_ONLY_ENV,
  relevantCliStderr,
  summarizeBranchJson,
} from "./lib/neon-refresh-preflight"

type Target = "dev"

const DEFAULT_PROJECT_ID = "sweet-paper-88472094"
/** Neon organization that owns DEFAULT_PROJECT_ID; named in credential errors. */
const NEON_ORG_LABEL = "Frontier R&D (org-cold-butterfly-03397216)"
const DEFAULT_SOURCE_BRANCH = "production"
const DEFAULT_DATABASE = "neondb"
const DEFAULT_ROLE = "neondb_owner"

const TARGET_ALIASES: Record<string, Target> = {
  dev: "dev",
  development: "dev",
}

const TARGET_DEFAULTS: Record<
  Target,
  {
    branch: string
    envPrefix: "DEV"
    healthUrl: string
  }
> = {
  dev: {
    branch: "dev",
    envPrefix: "DEV",
    healthUrl: "https://api.dev.aquilla.app/identity/api/v2/health",
  },
}

function usage(): never {
  console.error("usage: tsx scripts/refresh-neon-branch.ts <dev>")
  process.exit(1)
}

function parseTarget(value: string | undefined): Target {
  if (!value) usage()
  const target = TARGET_ALIASES[value.toLowerCase()]
  if (!target) usage()
  return target
}

function env(name: string, fallback?: string): string {
  const value = process.env[name]?.trim()
  if (value) return value
  if (fallback !== undefined) return fallback
  throw new Error(`${name} is required`)
}

function optionalEnv(name: string): string | null {
  return process.env[name]?.trim() || null
}

function targetEnv(target: Target, suffix: string, fallback?: string): string {
  const { envPrefix } = TARGET_DEFAULTS[target]
  return env(`NEON_${envPrefix}_${suffix}`, fallback)
}

function targetOptionalEnv(target: Target, name: string): string | null {
  const { envPrefix } = TARGET_DEFAULTS[target]
  return optionalEnv(`${envPrefix}_${name}`)
}

function ensureSafeTarget(branch: string, source: string): void {
  const normalized = branch.toLowerCase()
  if (["main", "prod", "production"].includes(normalized)) {
    throw new Error(`Refusing to refresh protected branch target: ${branch}`)
  }
  if (normalized === source.toLowerCase()) {
    throw new Error(`Refusing to restore ${branch} from itself`)
  }
}

const neonCliVersion = env("NEON_CLI_VERSION", DEFAULT_NEON_CLI_VERSION)

function neonArgs(args: string[]): string[] {
  return neonCliArgs(args, neonCliVersion)
}

let scratchConfigHome: string | null = null

/**
 * Environment for one Neon CLI child. The key travels in NEON_API_KEY (the
 * CLI's `--api-key` default), never on argv. When a key is in use the CLI's
 * stored OAuth login is irrelevant, yet on a 401 the CLI still deletes
 * `$XDG_CONFIG_HOME/neonctl/credentials.json`; a scratch config home keeps a
 * rejected key from logging a developer out of `neon auth`.
 */
function neonEnv(): { env: NodeJS.ProcessEnv; usingApiKey: boolean } {
  const apiKey = process.env.NEON_API_KEY?.trim()
  if (process.env.GITHUB_ACTIONS === "true" && !apiKey) {
    throw new Error("NEON_API_KEY is required in GitHub Actions")
  }
  if (!apiKey) return { env: {}, usingApiKey: false }
  scratchConfigHome ??= mkdtempSync(join(tmpdir(), "neon-refresh-"))
  return { env: { NEON_API_KEY: apiKey, XDG_CONFIG_HOME: scratchConfigHome }, usingApiKey: true }
}

class CommandError extends Error {
  readonly stderr: string

  constructor(message: string, stderr: string) {
    super(message)
    this.name = "CommandError"
    this.stderr = stderr
  }
}

async function run(
  command: string,
  args: string[],
  options: { capture?: boolean; env?: NodeJS.ProcessEnv } = {},
) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: { ...process.env, ...options.env },
      stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    })

    let stdout = ""
    let stderr = ""
    if (options.capture) {
      child.stdout?.on("data", (chunk) => {
        stdout += String(chunk)
      })
      child.stderr?.on("data", (chunk) => {
        stderr += String(chunk)
      })
    }

    child.on("error", reject)
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout.trim())
        return
      }
      reject(
        new CommandError(
          `${command} ${args.join(" ")} exited ${code}${stderr ? `\n${stderr}` : ""}`,
          stderr,
        ),
      )
    })
  })
}

function maskForGitHub(value: string): void {
  if (process.env.GITHUB_ACTIONS === "true" && value) {
    console.log(`::add-mask::${value}`)
  }
}

function pgEnvFromConnectionString(connectionString: string): NodeJS.ProcessEnv {
  maskForGitHub(connectionString)
  const url = new URL(connectionString)
  if (!url.hostname || !url.username || !url.password || url.pathname.length <= 1) {
    throw new Error("Neon connection string is missing required connection parameters")
  }

  const password = decodeURIComponent(url.password)
  maskForGitHub(password)

  return {
    NEON_PG_HOST: url.hostname,
    NEON_PG_DB: decodeURIComponent(url.pathname.slice(1)),
    NEON_PG_ROLE: decodeURIComponent(url.username),
    NEON_PG_PASSWORD: password,
  }
}

/**
 * Prove the credentials can read both branches before touching either. A
 * rejected NEON_API_KEY fails here with an explanation instead of surfacing
 * as the CLI's "Not enough non-option arguments" retry artifact.
 */
async function preflight(projectId: string, branches: string[]): Promise<void> {
  const { env: cliEnv, usingApiKey } = neonEnv()
  console.log(
    `Preflight: reading ${branches.map((name) => `'${name}'`).join(" and ")} in project ${projectId} with ${usingApiKey ? "NEON_API_KEY" : "the local Neon CLI login"}`,
  )
  for (const name of branches) {
    let stdout: string
    try {
      stdout = await run(
        "npx",
        neonArgs(["branches", "get", name, "--project-id", projectId, "--output", "json"]),
        { capture: true, env: cliEnv },
      )
    } catch (error) {
      const stderr = error instanceof CommandError ? error.stderr : String(error)
      throw new Error(
        preflightFailureMessage({
          kind: classifyNeonCliFailure(stderr),
          branch: name,
          projectId,
          orgLabel: NEON_ORG_LABEL,
          usingApiKey,
          stderr: relevantCliStderr(stderr),
          cliVersion: neonCliVersion,
        }),
        { cause: error },
      )
    }
    const summary = summarizeBranchJson(stdout)
    console.log(
      `✓ '${summary.name}' is ${summary.id} (last_reset_at ${summary.lastResetAt ?? "never"})`,
    )
  }
}

async function checkHttp(
  url: string,
  label: string,
  headers: Record<string, string> = {},
): Promise<void> {
  const attempts = 6
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 15_000)
      const response = await fetch(url, { signal: controller.signal, headers })
      clearTimeout(timeout)
      if (response.ok) {
        console.log(`✓ ${label} passed: ${url}`)
        return
      }
      const body = await response.text().catch(() => "")
      console.log(`${label} attempt ${attempt}/${attempts} returned HTTP ${response.status}${body ? `: ${body.slice(0, 300)}` : ""}`)
    } catch (error) {
      console.log(`${label} attempt ${attempt}/${attempts} failed: ${String(error)}`)
    }

    if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 5_000))
  }
  throw new Error(`${label} failed after ${attempts} attempts: ${url}`)
}

async function checkProjectRead(target: Target, url: string | null, token: string | null): Promise<void> {
  if (!url) {
    console.log(`Skipping ${target} project-read health check: ${TARGET_DEFAULTS[target].envPrefix}_API_PROJECT_READ_URL is not set`)
    return
  }
  if (!token) {
    throw new Error(`${TARGET_DEFAULTS[target].envPrefix}_API_PROJECT_READ_TOKEN is required when ${TARGET_DEFAULTS[target].envPrefix}_API_PROJECT_READ_URL is set`)
  }
  await checkHttp(url, `${target} API project-read check`, {
    Authorization: `Bearer ${token}`,
  })
}

async function main() {
  const target = parseTarget(process.argv[2])
  const defaults = TARGET_DEFAULTS[target]
  const projectId = env("NEON_PROJECT_ID", DEFAULT_PROJECT_ID)
  const branch = targetEnv(target, "BRANCH", defaults.branch)
  const sourceBranch = env("NEON_SOURCE_BRANCH", env("NEON_PRODUCTION_BRANCH", DEFAULT_SOURCE_BRANCH))
  const database = targetEnv(target, "DATABASE", targetEnv(target, "DB", DEFAULT_DATABASE))
  const role = targetEnv(target, "ROLE", DEFAULT_ROLE)
  const healthUrl = env(`${defaults.envPrefix}_API_HEALTH_URL`, defaults.healthUrl)
  const projectReadUrl = targetOptionalEnv(target, "API_PROJECT_READ_URL")
  const projectReadToken = targetOptionalEnv(target, "API_PROJECT_READ_TOKEN")
  const skipMigrations = process.env[`SKIP_${defaults.envPrefix}_MIGRATIONS`] === "1" || process.env.SKIP_MIGRATIONS === "1"

  ensureSafeTarget(branch, sourceBranch)

  await preflight(projectId, [branch, sourceBranch])
  if (isPreflightOnly(process.env)) {
    console.log(`${PREFLIGHT_ONLY_ENV} is set: credentials verified, not restoring '${branch}'.`)
    return
  }

  console.log(`Restoring Neon branch '${branch}' from '${sourceBranch}' in project ${projectId}`)
  await run(
    "npx",
    neonArgs(["branches", "restore", branch, sourceBranch, "--project-id", projectId, "--output", "json"]),
    { env: neonEnv().env },
  )

  console.log(`Fetching direct connection parameters for '${branch}'`)
  const connectionString = await run(
    "npx",
    neonArgs([
      "connection-string",
      branch,
      "--project-id",
      projectId,
      "--database-name",
      database,
      "--role-name",
      role,
      "--ssl",
      "require",
    ]),
    { capture: true, env: neonEnv().env },
  )
  const migrationEnv = pgEnvFromConnectionString(connectionString)

  if (skipMigrations) {
    console.log(`Skipping ${target} migrations because SKIP_${defaults.envPrefix}_MIGRATIONS=1 or SKIP_MIGRATIONS=1`)
  } else {
    console.log(`Applying pending migrations to '${branch}'`)
    // This branch was just recreated from upstream, so there is nothing a
    // pre-migration snapshot would protect (AQU-1877's gate).
    await run("pnpm", ["neon:apply", "--no-snapshot"], { env: migrationEnv })
  }

  // AQU-1775: the restore copied every org's encrypted integration tokens
  // (Monday) from production. Delete them before the dev workers — same signing
  // key as production — can decrypt, refresh or push with them. The script
  // refuses a production target itself; this is the restored branch only.
  console.log(`Scrubbing integration connections copied from '${sourceBranch}'`)
  await run("pnpm", ["exec", "tsx", "scripts/neon-scrub-integrations.ts"], {
    env: { ...migrationEnv, AQUILLA_NEON_TARGET: target },
  })

  await checkHttp(healthUrl, `${target} API health check`)
  await checkProjectRead(target, projectReadUrl, projectReadToken)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
