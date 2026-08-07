import { spawn } from "node:child_process"
import { pathToFileURL } from "node:url"
import { workersBuildMetadata } from "./assert-workers-build-env.mjs"

const ROOT_LANE = { name: "root", steps: [["pnpm", ["test"]]] }
const LINT_LANE = { name: "lint", steps: [["pnpm", ["lint"]]] }
const IDENTITY_LANE = { name: "identity", steps: [["pnpm", ["run", "build:workers-build:identity"]]] }
const SYNC_LANE = { name: "sync", steps: [["pnpm", ["run", "build:workers-build:sync"]]] }
const RELEASE_LANE = {
  name: "release-contracts",
  steps: [
    ["pnpm", ["exec", "playwright", "install", "chromium"]],
    ["pnpm", ["test:idml"]],
    ["pnpm", ["neon:check"]],
  ],
}
const AGENT_LANE = {
  name: "agent-worker",
  steps: [
    ["npm", ["ci", "--prefix", "agent-worker"]],
    ["npm", ["--prefix", "agent-worker", "run", "type-check"]],
    ["npm", ["--prefix", "agent-worker", "test"]],
  ],
}
const SPA_LANE = { name: "spa", steps: [["bash", ["scripts/ci-build.sh"]]] }

// Root and sync both contain long, database-heavy Vitest suites. Keep them in
// separate phases so resource contention cannot strand async UI tests in their
// loading state. Overlap each with only shorter, bounded checks.
export const CHECK_PHASES = [
  {
    name: "frontend-contracts",
    lanes: [ROOT_LANE, LINT_LANE, AGENT_LANE],
  },
  {
    name: "backend-contracts",
    lanes: [SYNC_LANE, RELEASE_LANE],
  },
  {
    name: "final",
    lanes: [IDENTITY_LANE, SPA_LANE],
  },
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
  const metadata = workersBuildMetadata(env)
  log(`[workers-build] running ${CHECK_LANES.length} checks in ${phases.length} bounded phases for ${metadata.branch}`)

  for (const phase of phases) {
    log(`[workers-build:${phase.name}] starting ${phase.lanes.length} lane(s)`)
    const results = await Promise.allSettled(phase.lanes.map(async ({ name, steps }) => {
      log(`[workers-build:${name}] started`)
      for (const [command, args] of steps) await run(command, args, { cwd, env })
      log(`[workers-build:${name}] passed`)
    }))
    const failures = results.flatMap((result, index) => result.status === "rejected"
      ? [`${phase.lanes[index].name}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`]
      : [])
    if (failures.length > 0) {
      throw new Error(`Cloudflare check lane failure(s):\n${failures.join("\n")}`)
    }
  }
}

const isEntrypoint = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href

if (isEntrypoint) {
  runParallelChecks().catch((error) => {
    console.error(`[workers-build] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
