#!/usr/bin/env tsx
// Refresh the shared Dev Neon branch from Production, then apply the repo's
// current migrations to the refreshed branch. Used by the daily GitHub Action
// and can be run manually from a logged-in Neon CLI session.

import { spawn } from "node:child_process"
import process from "node:process"

const DEFAULT_PROJECT_ID = "sweet-paper-88472094"
const DEFAULT_DEV_BRANCH = "dev"
const DEFAULT_SOURCE_BRANCH = "production"
const DEFAULT_DATABASE = "neondb"
const DEFAULT_ROLE = "neondb_owner"
const DEFAULT_HEALTH_URL = "https://api.dev.aquilla.app/identity/api/v2/health"
const DEFAULT_NEON_CLI_VERSION = "2.30.0"

function env(name: string, fallback?: string): string {
  const value = process.env[name]?.trim()
  if (value) return value
  if (fallback !== undefined) return fallback
  throw new Error(`${name} is required`)
}

function optionalEnv(name: string): string | null {
  return process.env[name]?.trim() || null
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

function neonArgs(args: string[]): string[] {
  const apiKey = process.env.NEON_API_KEY?.trim()
  if (process.env.GITHUB_ACTIONS === "true" && !apiKey) {
    throw new Error("NEON_API_KEY is required in GitHub Actions")
  }
  return [
    "--yes",
    `neon@${env("NEON_CLI_VERSION", DEFAULT_NEON_CLI_VERSION)}`,
    ...args,
    ...(apiKey ? ["--api-key", apiKey] : []),
    "--no-analytics",
    "--color",
    "false",
  ]
}

async function run(command: string, args: string[], options: { capture?: boolean; env?: NodeJS.ProcessEnv } = {}) {
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
      reject(new Error(`${command} ${args.join(" ")} exited ${code}${stderr ? `\n${stderr}` : ""}`))
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

async function checkProjectRead(url: string | null, token: string | null): Promise<void> {
  if (!url) {
    console.log("Skipping dev project-read health check: DEV_API_PROJECT_READ_URL is not set")
    return
  }
  if (!token) {
    throw new Error("DEV_API_PROJECT_READ_TOKEN is required when DEV_API_PROJECT_READ_URL is set")
  }
  await checkHttp(url, "Dev API project-read check", {
    Authorization: `Bearer ${token}`,
  })
}

async function main() {
  const projectId = env("NEON_PROJECT_ID", DEFAULT_PROJECT_ID)
  const devBranch = env("NEON_DEV_BRANCH", DEFAULT_DEV_BRANCH)
  const sourceBranch = env("NEON_SOURCE_BRANCH", DEFAULT_SOURCE_BRANCH)
  const database = env("NEON_DEV_DATABASE", DEFAULT_DATABASE)
  const role = env("NEON_DEV_ROLE", DEFAULT_ROLE)
  const healthUrl = env("DEV_API_HEALTH_URL", DEFAULT_HEALTH_URL)
  const projectReadUrl = optionalEnv("DEV_API_PROJECT_READ_URL")
  const projectReadToken = optionalEnv("DEV_API_PROJECT_READ_TOKEN")

  ensureSafeTarget(devBranch, sourceBranch)

  console.log(`Restoring Neon branch '${devBranch}' from '${sourceBranch}' in project ${projectId}`)
  await run("npx", neonArgs(["branches", "restore", devBranch, sourceBranch, "--project-id", projectId, "--output", "json"]))

  console.log(`Fetching direct connection parameters for '${devBranch}'`)
  const connectionString = await run(
    "npx",
    neonArgs([
      "connection-string",
      devBranch,
      "--project-id",
      projectId,
      "--database-name",
      database,
      "--role-name",
      role,
      "--ssl",
      "require",
    ]),
    { capture: true },
  )
  const migrationEnv = pgEnvFromConnectionString(connectionString)

  if (process.env.SKIP_DEV_MIGRATIONS === "1") {
    console.log("Skipping dev migrations because SKIP_DEV_MIGRATIONS=1")
  } else {
    console.log(`Applying pending migrations to '${devBranch}'`)
    await run("pnpm", ["neon:apply"], { env: migrationEnv })
  }

  await checkHttp(healthUrl, "Dev API health check")
  await checkProjectRead(projectReadUrl, projectReadToken)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
