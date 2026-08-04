import { spawn } from "node:child_process"
import { pathToFileURL } from "node:url"

/**
 * Keep the Cloudflare Workers Builds dashboard command stable while the
 * repository owns branch-to-environment selection. Only main may promote a
 * version. Development and feature branches produce preview versions without
 * changing live traffic.
 */
export function deploymentPlan(branch) {
  const normalizedBranch = branch?.trim()
  if (!normalizedBranch) {
    throw new Error("WORKERS_CI_BRANCH is required; refusing to guess a deployment environment")
  }

  if (normalizedBranch === "main") {
    return {
      mode: "production",
      environment: "production",
      args: ["deploy", "--env=production"],
    }
  }

  if (normalizedBranch === "dev" || normalizedBranch === "development") {
    return {
      mode: "preview",
      environment: "development",
      args: ["versions", "upload", "--env=development"],
    }
  }

  // Cloudflare may build arbitrary feature branches. They use isolated
  // development bindings and remain preview-only; they must never inherit
  // production bindings and must never promote live traffic.
  return {
    mode: "preview",
    environment: "development",
    args: ["versions", "upload", "--env=development"],
  }
}

export async function runDeployment({
  branch = process.env.WORKERS_CI_BRANCH,
  workersCi = process.env.WORKERS_CI,
  spawnCommand = spawn,
} = {}) {
  if (workersCi !== "1") {
    throw new Error("WORKERS_CI=1 is required; use the environment-specific local deploy scripts")
  }
  const plan = deploymentPlan(branch)
  console.log(
    `[workers-build] branch=${branch} mode=${plan.mode} environment=${plan.environment}`,
  )

  const child = spawnCommand("pnpm", ["exec", "wrangler", ...plan.args], {
    env: process.env,
    stdio: "inherit",
  })

  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject)
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`Wrangler terminated by ${signal}`))
        return
      }
      resolve(code ?? 1)
    })
  })

  if (exitCode !== 0) {
    throw new Error(`Wrangler exited with status ${exitCode}`)
  }
}

const isEntrypoint = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href

if (isEntrypoint) {
  runDeployment().catch((error) => {
    console.error(`[workers-build] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
