import { pathToFileURL } from "node:url"
import { deploymentExpectation, WORKER_SURFACES } from "./cloudflare-deployment-manifest.mjs"
import { runVerifiedDeployment } from "./cloudflare-version-deploy.mjs"

const SUPPORTED_SURFACES = new Set(WORKER_SURFACES)

/**
 * Keep the Cloudflare Workers Builds dashboard command stable while the
 * repository owns branch-to-environment selection. Only main may promote a
 * version. Staging, development, and feature branches produce preview
 * versions without changing live traffic.
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
      promote: true,
    }
  }

  if (normalizedBranch === "staging") {
    return {
      mode: "preview",
      environment: "staging",
      promote: false,
    }
  }

  // Development and arbitrary feature branches are isolated behind the
  // development profile. A version upload creates a previewable version but
  // cannot change live traffic or routes.
  return {
    mode: "preview",
    environment: "development",
    promote: false,
  }
}

export async function runDeployment({
  surface,
  branch = process.env.WORKERS_CI_BRANCH,
  workersCi = process.env.WORKERS_CI,
  commitSha = process.env.WORKERS_CI_COMMIT_SHA,
  buildUuid = process.env.WORKERS_CI_BUILD_UUID,
  deployVersion = runVerifiedDeployment,
} = {}) {
  if (workersCi !== "1") {
    throw new Error("WORKERS_CI=1 is required; use the environment-specific local deploy scripts")
  }
  if (!SUPPORTED_SURFACES.has(surface)) {
    throw new Error(`Worker surface is required; expected ${[...SUPPORTED_SURFACES].join(", ")}`)
  }
  if (!commitSha?.trim()) {
    throw new Error("WORKERS_CI_COMMIT_SHA is required; refusing an untraceable deployment")
  }

  const plan = deploymentPlan(branch)
  console.log(
    `[workers-build] surface=${surface} branch=${branch} mode=${plan.mode} environment=${plan.environment}`,
  )

  const productionWorker = deploymentExpectation(surface, "production").worker
  return deployVersion({
    surface,
    environment: plan.environment,
    promote: plan.promote,
    expectedWorker: productionWorker,
    sourceId: commitSha,
    sourceLabel: `workers-build:${branch}:${buildUuid || "unknown-build"}`,
  })
}

const isEntrypoint = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href

if (isEntrypoint) {
  runDeployment({ surface: process.argv[2] }).catch((error) => {
    console.error(`[workers-build] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
