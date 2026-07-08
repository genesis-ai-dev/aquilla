#!/usr/bin/env tsx
import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import process from "node:process"

type Target = "production" | "staging" | "dev"
type Command = "status" | "apply" | "baseline"
type PgKey = "HOST" | "DB" | "ROLE" | "PASSWORD"

const TARGET_ALIASES: Record<string, Target> = {
  main: "production",
  prod: "production",
  production: "production",
  staging: "staging",
  stage: "staging",
  dev: "dev",
  development: "dev",
}

const DEFAULTS: Partial<Record<PgKey, string>> = {
  DB: "neondb",
  ROLE: "neondb_owner",
}
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

function usage(): never {
  console.error("usage: tsx scripts/neon-target.ts <production|staging|dev> <status|apply|baseline>")
  process.exit(1)
}

function parseTarget(value: string | undefined): Target {
  if (!value) usage()
  const target = TARGET_ALIASES[value.toLowerCase()]
  if (!target) usage()
  return target
}

function parseCommand(value: string | undefined): Command {
  if (value === "status" || value === "apply" || value === "baseline") return value
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

function resolveValue(target: Target, key: PgKey): string {
  for (const name of candidates(target, key)) {
    const value = process.env[name]?.trim()
    if (value) return value
  }
  const fallback = DEFAULTS[key]
  if (fallback) return fallback
  throw new Error(`${candidates(target, key).join(" or ")} is required for Neon ${target}`)
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
  const env = {
    ...process.env,
    NEON_PG_HOST: resolveValue(target, "HOST"),
    NEON_PG_DB: resolveValue(target, "DB"),
    NEON_PG_ROLE: resolveValue(target, "ROLE"),
    NEON_PG_PASSWORD: resolveValue(target, "PASSWORD"),
  }

  console.log(`neon-target ${target} ${command} -> ${env.NEON_PG_HOST}`)
  process.exit(await run("tsx", ["scripts/neon-migrate.ts", command], env))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
