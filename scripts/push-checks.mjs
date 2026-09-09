import { spawn } from "node:child_process"
import { pathToFileURL } from "node:url"

// Validation belongs before push; Cloudflare only compiles PR previews.
// Scan first so an unrelated lint/test failure cannot hide a credential leak.
const SECRET_LANE = {
  name: "secrets",
  steps: [["pnpm", ["run", "scan:secrets"]]],
}
const ROOT_LANE = {
  name: "root",
  steps: [["pnpm", ["test", "--maxWorkers=2"]]],
}
const LINT_LANE = {
  name: "lint",
  steps: [["pnpm", ["lint"]], ["pnpm", ["run", "i18n:check"]]],
}
const workerLane = (name, directory) => ({
  name,
  steps: [
    ["pnpm", ["--dir", directory, "run", "type-check"]],
    ["pnpm", ["--dir", directory, "test", "--maxWorkers=2"]],
  ],
})
const RELEASE_LANE = {
  name: "release-contracts",
  steps: [
    ["pnpm", ["test:idml"]],
    ["pnpm", ["neon:check"]],
    ["pnpm", ["idml:gate"]],
  ],
}
const WEB_LANE = {
  name: "web-worker",
  steps: [["pnpm", ["test:worker", "--maxWorkers=2"]]],
}

// Keep database-heavy root and sync suites apart and cap Vitest concurrency
// so validation remains usable on smaller developer machines.
export const CHECK_PHASES = [
  { name: "credentials", lanes: [SECRET_LANE] },
  { name: "frontend-contracts", lanes: [ROOT_LANE, LINT_LANE] },
  { name: "backend-contracts", lanes: [workerLane("sync", "sync-worker")] },
  { name: "identity", lanes: [workerLane("identity", "auth-worker")] },
  { name: "agent", lanes: [workerLane("agent-worker", "agent-worker")] },
  { name: "release", lanes: [RELEASE_LANE, WEB_LANE] },
]

export const CHECK_LANES = CHECK_PHASES.flatMap(({ lanes }) => lanes)

export function runCommand(command, args, { cwd = process.cwd(), env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: "inherit" })
    child.once("error", reject)
    child.once("exit", (code, signal) => {
      if (code === 0) return resolve()
      reject(new Error(`${command} ${args.join(" ")} exited with ${signal ? `signal ${signal}` : `status ${code}`}`))
    })
  })
}

export async function runParallelChecks({
  env = process.env,
  cwd = process.cwd(),
  phases = CHECK_PHASES,
  run = runCommand,
  log = console.log,
} = {}) {
  log(`[push-checks] running ${CHECK_LANES.length} checks in ${phases.length} bounded phases before push`)

  for (const phase of phases) {
    log(`[push-checks:${phase.name}] starting ${phase.lanes.length} lane(s)`)
    const results = await Promise.allSettled(phase.lanes.map(async ({ name, steps }) => {
      log(`[push-checks:${name}] started`)
      for (const [command, args] of steps) await run(command, args, { cwd, env })
      log(`[push-checks:${name}] passed`)
    }))
    const failures = results.flatMap((result, index) => result.status === "rejected"
      ? [`${phase.lanes[index].name}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`]
      : [])
    if (failures.length > 0) {
      throw new Error(`Push check lane failure(s):\n${failures.join("\n")}`)
    }
  }
}

const isEntrypoint = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href

if (isEntrypoint) {
  runParallelChecks().catch((error) => {
    console.error(`[push-checks] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
