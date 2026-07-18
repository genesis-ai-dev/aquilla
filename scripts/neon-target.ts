#!/usr/bin/env tsx
import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import process from "node:process"

type Target = "production" | "staging" | "dev"
type Command = "status" | "apply" | "baseline" | "backfill-progress"
type PgKey = "HOST" | "DB" | "ROLE" | "PASSWORD"

const DEFAULT_PROJECT_ID = "sweet-paper-88472094"
const DEFAULT_NEON_CLI_VERSION = "2.30.0"
const TARGET_ALIASES: Record<string, Target> = {
  main: "production",
  prod: "production",
  production: "production",
  staging: "staging",
  stage: "staging",
  dev: "dev",
  development: "dev",
}
const TARGET_BRANCH_DEFAULTS: Record<Target, string> = {
  production: "production",
  staging: "staging",
  dev: "dev",
}
const TARGET_ENV_NAMES: Record<Target, string[]> = {
  production: ["PRODUCTION", "PROD"],
  staging: ["STAGING"],
  dev: ["DEV", "DEVELOPMENT"],
}

const DEFAULTS: Partial<Record<PgKey, string>> = {
  DB: "neondb",
  ROLE: "neondb_owner",
}
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

function usage(): never {
  console.error("usage: tsx scripts/neon-target.ts <production|staging|dev> <status|apply|baseline|backfill-progress>")
  process.exit(1)
}

function parseTarget(value: string | undefined): Target {
  if (!value) usage()
  const target = TARGET_ALIASES[value.toLowerCase()]
  if (!target) usage()
  return target
}

function parseCommand(value: string | undefined): Command {
  if (value === "status" || value === "apply" || value === "baseline" || value === "backfill-progress") return value
  usage()
}

function loadDotEnv(): void {
  const envFile = path.join(REPO_ROOT, ".env")
  if (!fs.existsSync(envFile)) return
  for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "")
  }
}

function candidates(target: Target, key: PgKey): string[] {
  if (target === "production") return [`NEON_PG_${key}`]
  const upper = target.toUpperCase()
  return [`NEON_${upper}_PG_${key}`, `NEON_PG_${upper}_${key}`]
}

function envCandidates(target: Target, suffix: string): string[] {
  return TARGET_ENV_NAMES[target].map((name) => `NEON_${name}_${suffix}`)
}

function firstEnv(names: string[]): string | null {
  for (const name of names) {
    const value = process.env[name]?.trim()
    if (value) return value
  }
  return null
}

function resolveValue(target: Target, key: PgKey): string {
  const value = firstEnv(candidates(target, key))
  if (value) return value
  const fallback = DEFAULTS[key]
  if (fallback) return fallback
  throw new Error(`${candidates(target, key).join(" or ")} is required for Neon ${target}`)
}

function staticPgEnv(target: Target): NodeJS.ProcessEnv | null {
  const host = firstEnv(candidates(target, "HOST"))
  const password = firstEnv(candidates(target, "PASSWORD"))
  if (!host && !password) return null
  if (!host || !password) {
    throw new Error(`${candidates(target, host ? "PASSWORD" : "HOST").join(" or ")} is required with static Neon ${target} credentials`)
  }
  return {
    ...process.env,
    NEON_PG_HOST: host,
    NEON_PG_DB: resolveValue(target, "DB"),
    NEON_PG_ROLE: resolveValue(target, "ROLE"),
    NEON_PG_PASSWORD: password,
  }
}

function requiredEnv(name: string, fallback?: string): string {
  const value = process.env[name]?.trim()
  if (value) return value
  if (fallback !== undefined) return fallback
  throw new Error(`${name} is required`)
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
    ...process.env,
    NEON_PG_HOST: url.hostname,
    NEON_PG_DB: decodeURIComponent(url.pathname.slice(1)),
    NEON_PG_ROLE: decodeURIComponent(url.username),
    NEON_PG_PASSWORD: password,
  }
}

function neonArgs(args: string[]): string[] {
  const apiKey = process.env.NEON_API_KEY?.trim()
  if (process.env.GITHUB_ACTIONS === "true" && !apiKey) {
    throw new Error("NEON_API_KEY is required in GitHub Actions when target-specific NEON_*_PG_* credentials are absent")
  }
  return [
    "--yes",
    `neon@${requiredEnv("NEON_CLI_VERSION", DEFAULT_NEON_CLI_VERSION)}`,
    ...args,
    ...(apiKey ? ["--api-key", apiKey] : []),
    "--no-analytics",
    "--color",
    "false",
  ]
}

async function runCapture(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk)
    })
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk)
    })
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

async function branchPgEnv(target: Target): Promise<NodeJS.ProcessEnv> {
  const projectId = requiredEnv("NEON_PROJECT_ID", DEFAULT_PROJECT_ID)
  const branch = firstEnv(envCandidates(target, "BRANCH")) ?? TARGET_BRANCH_DEFAULTS[target]
  const database = firstEnv(envCandidates(target, "DATABASE")) ?? DEFAULTS.DB!
  const role = firstEnv(envCandidates(target, "ROLE")) ?? DEFAULTS.ROLE!
  const connectionString = await runCapture("npx", neonArgs([
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
  ]))
  console.log(`neon-target ${target}: resolved branch '${branch}' in project ${projectId}`)
  return pgEnvFromConnectionString(connectionString)
}

async function resolvePgEnv(target: Target): Promise<NodeJS.ProcessEnv> {
  if (process.env.GITHUB_ACTIONS === "true" && process.env.NEON_API_KEY?.trim()) {
    return branchPgEnv(target)
  }
  const staticEnv = staticPgEnv(target)
  if (staticEnv) return staticEnv
  return branchPgEnv(target)
}

async function run(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env,
      stdio: "inherit",
    })
    child.on("error", reject)
    child.on("close", (code) => resolve(code ?? 1))
  })
}

async function main() {
  loadDotEnv()
  const target = parseTarget(process.argv[2])
  const command = parseCommand(process.argv[3])
  const env = await resolvePgEnv(target)

  console.log(`neon-target ${target} ${command} -> ${env.NEON_PG_HOST}`)
  const script = command === "backfill-progress"
    ? "scripts/neon-backfill-progress.ts"
    : "scripts/neon-migrate.ts"
  const args = command === "backfill-progress" ? [script] : [script, command]
  process.exit(await run("tsx", args, env))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
