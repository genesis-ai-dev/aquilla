#!/usr/bin/env tsx
import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import process from "node:process"
import { childArgs, type NeonTargetCommand } from "./neon-target-args"
import { decideApplyGuard, MIGRATION_COMMANDS, NO_SNAPSHOT_FLAG, SNAPSHOT_FLAG } from "./neon-apply-guard"

type RemoteTarget = "production" | "dev"
type Target = RemoteTarget | "local"
// One union, owned by neon-target-args.ts, so the two files cannot drift apart.
type Command = NeonTargetCommand
type PgKey = "HOST" | "DB" | "ROLE" | "PASSWORD"

const DEFAULT_PROJECT_ID = "sweet-paper-88472094"
const DEFAULT_NEON_CLI_VERSION = "2.30.0"
const TARGET_ALIASES: Record<string, Target> = {
  main: "production",
  prod: "production",
  production: "production",
  dev: "dev",
  development: "dev",
  local: "local",
}
const TARGET_BRANCH_DEFAULTS: Record<RemoteTarget, string> = {
  production: "production",
  dev: "dev",
}
const TARGET_ENV_NAMES: Record<RemoteTarget, string[]> = {
  production: ["PRODUCTION", "PROD"],
  dev: ["DEV", "DEVELOPMENT"],
}
// Same default and overrides as scripts/dev-stack.ts.
const DEFAULT_LOCAL_PG_URL = "postgresql://aquilla:aquilla@127.0.0.1:5432/aquilla_dev"

const DEFAULTS: Partial<Record<PgKey, string>> = {
  DB: "neondb",
  ROLE: "neondb_owner",
}
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

function usage(): never {
  console.error("usage: tsx scripts/neon-target.ts <production|dev|local> <status|apply|baseline|prepare-comments-key|backfill-progress|backfill-activity|backfill-lanes|backfill-lane-batch|prune-phantom-voices|verify-lanes|seed-extract>")
  console.error(`       production apply requires ${SNAPSHOT_FLAG} (take a Neon snapshot branch first) or ${NO_SNAPSHOT_FLAG}`)
  process.exit(1)
}

function parseTarget(value: string | undefined): Target {
  if (!value) usage()
  const target = TARGET_ALIASES[value.toLowerCase()]
  if (!target) usage()
  return target
}

function parseCommand(value: string | undefined): Command {
  if (value === "prepare-comments-key" || value === "status" || value === "apply" || value === "baseline" || value === "backfill-progress" || value === "backfill-activity" || value === "backfill-lanes" || value === "backfill-lane-batch" || value === "prune-phantom-voices" || value === "verify-lanes" || value === "seed-extract") return value
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

function candidates(target: RemoteTarget, key: PgKey): string[] {
  if (target === "production") return [`NEON_PG_${key}`]
  const upper = target.toUpperCase()
  return [`NEON_${upper}_PG_${key}`, `NEON_PG_${upper}_${key}`]
}

function envCandidates(target: RemoteTarget, suffix: string): string[] {
  return TARGET_ENV_NAMES[target].map((name) => `NEON_${name}_${suffix}`)
}

function firstEnv(names: string[]): string | null {
  for (const name of names) {
    const value = process.env[name]?.trim()
    if (value) return value
  }
  return null
}

function resolveValue(target: RemoteTarget, key: PgKey): string {
  const value = firstEnv(candidates(target, key))
  if (value) return value
  const fallback = DEFAULTS[key]
  if (fallback) return fallback
  throw new Error(`${candidates(target, key).join(" or ")} is required for Neon ${target}`)
}

function staticPgEnv(target: RemoteTarget): NodeJS.ProcessEnv | null {
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

function targetBranch(target: RemoteTarget): string {
  return firstEnv(envCandidates(target, "BRANCH")) ?? TARGET_BRANCH_DEFAULTS[target]
}

async function branchPgEnv(target: RemoteTarget): Promise<NodeJS.ProcessEnv> {
  const projectId = requiredEnv("NEON_PROJECT_ID", DEFAULT_PROJECT_ID)
  const branch = targetBranch(target)
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
  if (target === "local") {
    const url =
      process.env.WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE?.trim() ||
      process.env.LOCAL_PG_URL?.trim() ||
      DEFAULT_LOCAL_PG_URL
    // AQUILLA_LOCAL_PG_URL switches scripts/pg.ts to a no-SSL client;
    // AQUILLA_DATABASE_URL is what the backfill scripts read.
    return { ...process.env, AQUILLA_LOCAL_PG_URL: url, AQUILLA_DATABASE_URL: url }
  }
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

/**
 * AQU-1877: a production migration apply is gated on a snapshot. The decision
 * is pure (`neon-apply-guard.ts`); this runs it, and takes the Neon branch
 * when the operator asked for one.
 */
async function guardMigrationApply(target: Target, command: Command, flags: string[]): Promise<void> {
  if (!(MIGRATION_COMMANDS as readonly string[]).includes(command)) return
  const decision = decideApplyGuard({
    target,
    command,
    flags,
    projectId: requiredEnv("NEON_PROJECT_ID", DEFAULT_PROJECT_ID),
    parentBranch: target === "local" ? "local" : targetBranch(target),
    cliVersion: requiredEnv("NEON_CLI_VERSION", DEFAULT_NEON_CLI_VERSION),
    now: new Date(),
  })
  if (decision.kind === "refuse") {
    console.error(decision.message)
    process.exit(1)
  }
  if (decision.note) console.log(decision.note)
  if (decision.kind === "snapshot") {
    console.log(await runCapture("npx", neonArgs(decision.args)))
    console.log(`✓ snapshot branch '${decision.branchName}' created — restore from it if the apply goes wrong`)
  }
}

async function main() {
  loadDotEnv()
  const target = parseTarget(process.argv[2])
  const command = parseCommand(process.argv[3])

  // Everything after the command reaches a backfill or verify script as its
  // own flags (`--missing-books`, `--apply`, `--require-complete`). See
  // `neon-target-args.ts` for why dropping those flags ever ran the wrong job.
  // A migration command takes no passthrough flags, so its own are read here
  // (the snapshot gate) and validated rather than silently dropped.
  const passthrough = process.argv.slice(4)
  await guardMigrationApply(target, command, passthrough)
  const env = await resolvePgEnv(target)
  // The decision above is this run's; neon-migrate.ts must not ask again.
  env.AQUILLA_MIGRATION_SNAPSHOT_DECISION = `${target}:${command}`
  // AQU-1941: which database the child is actually pointed at. A script holding
  // raw NEON_PG_* credentials cannot tell, so a child that gates its own writes
  // on "is this production?" reads this instead of guessing
  // (scripts/phantom-voice-prune-gate.ts).
  env.AQUILLA_NEON_TARGET = target
  const args = childArgs(command, passthrough)
  console.log(`neon-target ${target} ${command}${passthrough.length ? " " + passthrough.join(" ") : ""} -> ${target === "local" ? "local Postgres" : env.NEON_PG_HOST}`)
  process.exit(await run("tsx", args, env))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
