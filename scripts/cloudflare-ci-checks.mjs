import { spawn } from "node:child_process"
import { pathToFileURL } from "node:url"
import { workersBuildMetadata } from "./assert-workers-build-env.mjs"

const ROOT_LANE = { name: "root", steps: [["pnpm", ["test"]]] }
// The credential scan (docs/OPSEC.md §5) rides in the lint lane rather than
// its own so it shares an already-required check — a secret scan that can be
// merged past is decoration. This script is the gate that actually runs on
// pull requests (AQU-564); the ci.yml lint job mirrors it for dispatch runs.
// i18n context-catalog check (AQU-832) rides in the lint lane for the same
// reason scan:secrets does: it shares an already-required check rather than
// adding a new one. Previously wired into `pnpm test` only — grep found zero
// i18n references anywhere in CI before this, so a context regression could
// merge unnoticed until someone ran `pnpm test` locally.
const LINT_LANE = {
  name: "lint",
  steps: [
    ["pnpm", ["lint"]],
    ["pnpm", ["run", "i18n:check"]],
    ["pnpm", ["run", "scan:secrets"]],
  ],
}
const IDENTITY_LANE = { name: "identity", steps: [["pnpm", ["run", "build:workers-build:identity"]]] }
const SYNC_LANE = { name: "sync", steps: [["pnpm", ["run", "build:workers-build:sync"]]] }
const RELEASE_LANE = {
  name: "release-contracts",
  steps: [
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
// `pnpm test` (ROOT_LANE) excludes every worker package, so the aquilla-web
// Worker's own suite — routing, invite-meta rewriting, security headers, and
// the wrangler.toml deployment-config guards — ran in no lane at all. A stale
// assertion in it had been failing on dev unnoticed as a result. It costs
// ~0.3s and it gates the same artifact this lane builds, so it runs first:
// a broken deployment-config contract should fail before the SPA build does.
// See docs/OPSEC-REVIEW-2026-08-10.md (OPS-4).
const SPA_LANE = {
  name: "spa",
  steps: [
    ["pnpm", ["test:worker"]],
    ["bash", ["scripts/ci-build.sh"]],
  ],
}

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
