import { pathToFileURL } from "node:url"
import { deploymentExpectation, WORKER_SURFACES } from "./cloudflare-deployment-manifest.mjs"
import { runVerifiedDeployment } from "./cloudflare-version-deploy.mjs"
import { workersBuildMetadata } from "./assert-workers-build-env.mjs"

const SUPPORTED_SURFACES = new Set(WORKER_SURFACES)

/**
 * Workers Builds owns validation and route-free versions, never live traffic.
 * Main is verified with production bindings; every other branch is isolated
 * behind the development profile. Promotion remains an explicit operator act.
 */
export function deploymentPlan(branch) {
  const normalizedBranch = branch?.trim()
  if (!normalizedBranch) {
    throw new Error("WORKERS_CI_BRANCH is required; refusing to guess a deployment environment")
  }

  return {
    mode: "preview",
    environment: normalizedBranch === "main" ? "production" : "development",
    promote: false,
  }
}

export async function runDeployment({
  surface,
  env = process.env,
  deployVersion = runVerifiedDeployment,
} = {}) {
  const { branch, commitSha } = workersBuildMetadata(env)
  if (!SUPPORTED_SURFACES.has(surface)) {
    throw new Error(`Worker surface is required; expected ${[...SUPPORTED_SURFACES].join(", ")}`)
  }

  const plan = deploymentPlan(branch)
  const expectedWorker = deploymentExpectation(surface, plan.environment).worker
  console.log(
    `[workers-build] surface=${surface} branch=${branch} mode=${plan.mode} environment=${plan.environment}`,
  )

  return deployVersion({
    surface,
    environment: plan.environment,
    promote: false,
    expectedWorker,
    sourceId: commitSha,
    sourceLabel: `workers-build:${branch}:${env.WORKERS_CI_BUILD_UUID || "unknown-build"}`,
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
