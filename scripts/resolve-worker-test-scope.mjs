import { appendFileSync } from "node:fs"
import { pathToFileURL } from "node:url"

const ALL_WORKERS = Object.freeze({ auth: true, sync: true, agent: true })

const SHARED_INPUTS = [
  /^\.github\/workflows\/(?:ci|deploy-workers)\.yml$/,
  /^pnpm-lock\.yaml$/,
  /^package\.json$/,
  /^tsconfig[^/]*\.json$/,
  /^db\//,
  /^shared\//,
  /^config\/cloudflare-deployments\.json$/,
  /^scripts\/(?:cloudflare-|resolve-worker-test-scope\.|verify-worker-deployment\.|verify-live-environment\.|resolve-deployment-target\.|verify-deploy-branch\.)/,
]

const WORKER_INPUTS = {
  auth: [/^auth-worker\//, /^src\/lib\/migrate\//, /^scripts\/mock-openrouter\./],
  sync: [/^sync-worker\//, /^scripts\/lib\/fold-projection\./],
  agent: [/^agent-worker\//],
}

export function resolveWorkerTestScope(files, { forceAll = false } = {}) {
  const changed = files.map((file) => file.trim()).filter(Boolean)
  if (forceAll || changed.some((file) => SHARED_INPUTS.some((pattern) => pattern.test(file)))) {
    return { ...ALL_WORKERS }
  }

  return Object.fromEntries(
    Object.entries(WORKER_INPUTS).map(([worker, patterns]) => [
      worker,
      changed.some((file) => patterns.some((pattern) => pattern.test(file))),
    ]),
  )
}

export function formatWorkerTestScope(scope) {
  return ["auth", "sync", "agent"]
    .map((worker) => `${worker}=${scope[worker] ? "true" : "false"}`)
    .join("\n") + "\n"
}

async function main() {
  let input = ""
  for await (const chunk of process.stdin) input += chunk
  const scope = resolveWorkerTestScope(input.split(/\r?\n/), {
    forceAll: process.argv.includes("--all"),
  })
  const output = formatWorkerTestScope(scope)
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, output)
  else process.stdout.write(output)
}

const isEntrypoint = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href

if (isEntrypoint) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
