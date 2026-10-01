// Rotate a Worker secret the way the runtime guard expects (AQU-1361).
//
// `wrangler secret put` is a one-shot: it patches the live Worker and routes
// traffic to a brand-new version that Cloudflare derives from the running one.
// The derived version keeps the script etag and every binding, but it does NOT
// inherit the custom version tag — and both environment guards
// (auth-worker/src/environment-guard.ts, sync-worker/src/environment-guard.ts)
// require `CF_VERSION_METADATA.tag` to name the Worker and environment serving
// a first-party API host. An ordinary secret rotation therefore took dev sync
// to a hard 503 with correct bindings and correct secrets.
//
// This script keeps the guard fail-closed and fixes the rotation instead:
//
//   1. STAGE  `wrangler versions secret put` creates a new version carrying the
//             rotated secret and the deployment tag, WITHOUT shifting traffic.
//   2. VERIFY  the staged version's actual bindings are checked against
//             config/cloudflare-deployments.json — Hyperdrive id, R2 buckets,
//             plain-text vars and required secrets — before anything is served.
//   3. PROMOTE  exactly that version id goes to 100%, then the live environment
//             is re-verified over HTTP.
//
// The secret value never enters this process: stdin is inherited straight
// through to wrangler, so pipe it in and it stays between the operator's shell
// and Cloudflare.
//
//   printf %s "$KEY" | node scripts/cloudflare-secret-rotate.mjs sync development SYNC_SECRET_KEY

import { spawn } from "node:child_process"
import { pathToFileURL } from "node:url"
import { deploymentExpectation } from "./cloudflare-deployment-manifest.mjs"
import { deploymentVersionTag } from "./cloudflare-version-deploy.mjs"
import { verifyLiveEnvironment } from "./verify-live-environment.mjs"
import {
  verifyActiveDeployment,
  verifyWorkerVersion,
} from "./verify-worker-deployment.mjs"

/**
 * Only the two API Workers rotate this way. The web surface serves immutable
 * assets whose version is verified against a preview origin before promotion,
 * so its secrets ride a full `deploy:aquilla:*:spa` instead of a patched
 * version with no preview URL to check.
 */
const ROTATABLE_SURFACES = Object.freeze(["identity", "sync"])

/** `verifyLiveEnvironment` names the identity surface `auth`. */
const LIVE_SURFACES = Object.freeze({ identity: "auth", sync: "sync" })

const VERSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const SECRET_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/

/**
 * Pull the staged version out of wrangler's success line. `versions secret put`
 * writes no machine-readable output file (only `versions upload` emits the
 * `version-upload` ndjson entry), so the id is parsed from stdout and then
 * shape-checked — a promotion must never be aimed at a guessed id.
 *
 * On no match the raw output is deliberately NOT echoed: it is wrangler's
 * secret-handling channel, and an error message is not the place to widen it.
 */
export function stagedVersionId(stdout) {
  const match = /Created version ([0-9a-fA-F-]+) with secret/.exec(stdout)
  const versionId = match?.[1]?.toLowerCase()
  if (!versionId || !VERSION_ID_PATTERN.test(versionId)) {
    throw new Error(
      "wrangler versions secret put did not report a staged version id; nothing was promoted",
    )
  }
  return versionId
}

function stageSecretVersion({
  expectation,
  secretName,
  tag,
  message,
  spawnCommand,
}) {
  const child = spawnCommand(
    "pnpm",
    [
      "exec",
      "wrangler",
      "versions",
      "secret",
      "put",
      secretName,
      `--env=${expectation.environment}`,
      "--tag",
      tag,
      "--message",
      message,
    ],
    {
      cwd: expectation.directory,
      env: process.env,
      // stdin is inherited so the piped secret goes to wrangler without this
      // process ever holding it. stdout is captured only to read the staged
      // version id back.
      stdio: ["inherit", "pipe", "inherit"],
    },
  )

  return new Promise((resolve, reject) => {
    let stdout = ""
    child.stdout?.on("data", (chunk) => { stdout += chunk })
    child.once("error", reject)
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`wrangler terminated by ${signal}`))
      else if (code !== 0) reject(new Error(`wrangler versions secret put exited with status ${code ?? 1}`))
      else resolve(stdout)
    })
  })
}

function promoteStagedVersion({ expectation, versionId, message, spawnCommand }) {
  const child = spawnCommand(
    "pnpm",
    [
      "exec",
      "wrangler",
      "versions",
      "deploy",
      `${versionId}@100%`,
      `--env=${expectation.environment}`,
      "--message",
      message,
      "--yes",
    ],
    { cwd: expectation.directory, env: process.env, stdio: "inherit" },
  )

  return new Promise((resolve, reject) => {
    child.once("error", reject)
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`wrangler terminated by ${signal}`))
      else if (code !== 0) reject(new Error(`wrangler versions deploy exited with status ${code ?? 1}`))
      else resolve()
    })
  })
}

export async function rotateWorkerSecret({
  surface,
  environment,
  secretName,
  sourceId,
  sourceLabel = "secret-rotation",
  spawnCommand = spawn,
  stage = stageSecretVersion,
  verifyVersion = verifyWorkerVersion,
  promoteVersion = promoteStagedVersion,
  verifyDeployment = verifyActiveDeployment,
  verifyLive = verifyLiveEnvironment,
  log = console.log,
} = {}) {
  if (!ROTATABLE_SURFACES.includes(surface)) {
    throw new Error(
      `cannot rotate secrets on surface ${JSON.stringify(surface)}; expected ${ROTATABLE_SURFACES.join(" or ")}`,
    )
  }
  if (!secretName || !SECRET_NAME_PATTERN.test(secretName)) {
    throw new Error(`invalid secret name ${JSON.stringify(secretName ?? null)}`)
  }

  // Throws on an unknown surface/environment pair, so the tag below can never
  // be built for a Worker this repository does not own.
  const expectation = deploymentExpectation(surface, environment)
  if (!expectation.requiredSecrets.includes(secretName)) {
    throw new Error(
      `${secretName} is not a required secret for ${expectation.worker}; add it to config/cloudflare-deployments.json first`,
    )
  }

  // The same tag the verified deployer stamps, so the staged version satisfies
  // the runtime environment guard the moment it starts serving.
  const tag = deploymentVersionTag(expectation.worker, environment, sourceId)
  const message = `${sourceLabel} rotate ${secretName} ${tag}`

  const stdout = await stage({ expectation, secretName, tag, message, spawnCommand })
  const versionId = stagedVersionId(stdout)
  log(`[secret-rotate] staged ${expectation.worker} version ${versionId} tagged ${tag}`)

  // Bindings first: a staged version with the wrong Hyperdrive, R2 bucket or
  // environment vars must never take traffic, rotation or not.
  await verifyVersion(surface, environment, versionId, { workerName: expectation.worker })

  await promoteVersion({ expectation, versionId, message, spawnCommand })
  await verifyDeployment(surface, environment, versionId, { workerName: expectation.worker })
  await verifyLive(environment, { surface: LIVE_SURFACES[surface] })

  log(
    `[secret-rotate] surface=${surface} environment=${environment} worker=${expectation.worker} secret=${secretName} version=${versionId}`,
  )
  return { versionId, workerName: expectation.worker, tag, secretName }
}

const isEntrypoint = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href

if (isEntrypoint) {
  const [surface, environment, secretName] = process.argv.slice(2)
  if (!surface || !environment || !secretName) {
    console.error(
      "usage: printf %s \"$VALUE\" | node scripts/cloudflare-secret-rotate.mjs <identity|sync> <production|development> <SECRET_NAME>",
    )
    process.exitCode = 1
  } else {
    rotateWorkerSecret({
      surface,
      environment,
      secretName,
      sourceId: process.env.GITHUB_SHA || process.env.WORKERS_CI_COMMIT_SHA,
      sourceLabel: process.env.GITHUB_REF_NAME || "manual",
    }).catch((error) => {
      console.error(`[secret-rotate] ${error instanceof Error ? error.message : String(error)}`)
      process.exitCode = 1
    })
  }
}
