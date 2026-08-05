import { spawn } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { randomUUID } from "node:crypto"
import { deploymentExpectation } from "./cloudflare-deployment-manifest.mjs"
import { assertSafeDeploymentArtifacts } from "./verify-deployment-artifacts.mjs"
import {
  verifyActiveDeployment,
  verifyWorkerVersion,
} from "./verify-worker-deployment.mjs"

function spawnAndWait(spawnCommand, command, args, { cwd, env }) {
  const child = spawnCommand(command, args, {
    cwd,
    env,
    stdio: "inherit",
  })

  return new Promise((resolve, reject) => {
    child.once("error", reject)
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`${command} terminated by ${signal}`))
      else if (code !== 0) reject(new Error(`${command} exited with status ${code ?? 1}`))
      else resolve()
    })
  })
}

export function parseWranglerOutput(contents, expectedType) {
  const entries = contents
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  const matches = entries.filter((entry) => entry.type === expectedType)
  if (matches.length !== 1) {
    throw new Error(`Wrangler output must contain exactly one ${expectedType} entry`)
  }
  return matches[0]
}

async function uploadWorkerVersion({
  expectation,
  workerName,
  tag,
  message,
  spawnCommand,
}) {
  const outputDirectory = mkdtempSync(join(tmpdir(), "aquilla-wrangler-"))
  const outputPath = join(outputDirectory, "output.ndjson")
  try {
    await spawnAndWait(
      spawnCommand,
      "pnpm",
      [
        "exec",
        "wrangler",
        "versions",
        "upload",
        `--env=${expectation.environment}`,
        "--tag",
        tag,
        "--message",
        message,
      ],
      {
        cwd: expectation.directory,
        env: { ...process.env, WRANGLER_OUTPUT_FILE_PATH: outputPath },
      },
    )
    const entry = parseWranglerOutput(readFileSync(outputPath, "utf8"), "version-upload")
    const versionId = entry.version_id
    if (typeof versionId !== "string" || !versionId) {
      throw new Error("Wrangler version-upload output did not contain a version_id")
    }
    if (entry.worker_name !== workerName) {
      throw new Error(`Wrangler uploaded ${entry.worker_name ?? "an unknown Worker"}; expected ${workerName}`)
    }
    return versionId
  } finally {
    rmSync(outputDirectory, { recursive: true, force: true })
  }
}

async function promoteWorkerVersion({
  expectation,
  workerName,
  versionId,
  message,
  spawnCommand,
}) {
  const commandEnvironment = process.env
  await spawnAndWait(
    spawnCommand,
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
    { cwd: expectation.directory, env: commandEnvironment },
  )
  await spawnAndWait(
    spawnCommand,
    "pnpm",
    [
      "exec",
      "wrangler",
      "triggers",
      "deploy",
      `--env=${expectation.environment}`,
    ],
    { cwd: expectation.directory, env: commandEnvironment },
  )
}

function normalizedSourceId(sourceId) {
  const value = sourceId?.trim() || randomUUID()
  return value.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12)
}

export function deploymentVersionTag(workerName, environment, sourceId) {
  return `${workerName}-${environment}-${normalizedSourceId(sourceId)}`
}

export async function runVerifiedDeployment({
  surface,
  environment,
  promote = true,
  expectedWorker,
  sourceId,
  sourceLabel = "manual",
  spawnCommand = spawn,
  upload = uploadWorkerVersion,
  verifyVersion = verifyWorkerVersion,
  promoteVersion = promoteWorkerVersion,
  verifyDeployment = verifyActiveDeployment,
  verifyArtifacts = assertSafeDeploymentArtifacts,
} = {}) {
  const expectation = deploymentExpectation(surface, environment)
  const workerName = expectedWorker ?? expectation.worker
  if (promote && workerName !== expectation.worker) {
    throw new Error(`refusing to promote ${environment} bindings to ${workerName}; expected ${expectation.worker}`)
  }
  if (surface === "web") verifyArtifacts(join(expectation.directory, "dist"))
  const tag = deploymentVersionTag(workerName, environment, sourceId)
  const message = `${sourceLabel} ${tag}`

  const versionId = await upload({
    expectation,
    workerName,
    tag,
    message,
    spawnCommand,
  })
  await verifyVersion(surface, environment, versionId, { workerName })

  if (promote) {
    await promoteVersion({
      expectation,
      workerName,
      versionId,
      message,
      spawnCommand,
    })
    await verifyDeployment(surface, environment, versionId, { workerName })
  }

  console.log(
    `[cloudflare-deploy] surface=${surface} environment=${environment} worker=${workerName} version=${versionId} promoted=${promote}`,
  )
  return { versionId, workerName, tag, promoted: promote }
}

const isEntrypoint = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href

if (isEntrypoint) {
  runVerifiedDeployment({
    surface: process.argv[2],
    environment: process.argv[3],
    sourceId: process.env.WORKERS_CI_COMMIT_SHA || process.env.GITHUB_SHA,
    sourceLabel: process.env.GITHUB_REF_NAME || process.env.WORKERS_CI_BRANCH || "manual",
  }).catch((error) => {
    console.error(`[cloudflare-deploy] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
