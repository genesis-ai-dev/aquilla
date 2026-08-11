import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { parseWranglerOutput } from "./cloudflare-version-deploy.mjs"
import { workersBuildMetadata } from "./assert-workers-build-env.mjs"
import { assertSafeDeploymentArtifacts } from "./verify-deployment-artifacts.mjs"

const PREVIEW_WORKER = "aquilla-web-preview"
const MISSING_WORKER_PATTERN = new RegExp(
  `cannot upload a new version|${PREVIEW_WORKER}[^\\n]*(?:does not (?:yet )?exist|not found)`,
  "i",
)

export function pullRequestPreviewAlias(prNumber) {
  const value = String(prNumber ?? "").trim()
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new Error(`invalid pull request number ${JSON.stringify(prNumber)}`)
  }
  return `pr-${value}`
}

export function workersBuildPreviewAlias(branch) {
  const value = String(branch ?? "").trim()
  if (!value) throw new Error("a Workers Builds branch is required")
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30)
    .replace(/-+$/g, "") || "branch"
  const hash = createHash("sha256").update(value).digest("hex").slice(0, 8)
  return `ci-${slug}-${hash}`
}

export function previewUrlFromUpload(entry, { alias, workerName = PREVIEW_WORKER }) {
  if (entry.worker_name !== workerName) {
    throw new Error(`Wrangler uploaded ${entry.worker_name ?? "an unknown Worker"}; expected ${workerName}`)
  }
  if (typeof entry.version_id !== "string" || !entry.version_id) {
    throw new Error("Wrangler version-upload output did not contain a version_id")
  }
  if (typeof entry.preview_alias_url !== "string" || !entry.preview_alias_url) {
    throw new Error("Wrangler version-upload output did not contain a preview_alias_url")
  }

  const previewUrl = new URL(entry.preview_alias_url)
  const expectedPrefix = `${alias}-${workerName}.`
  if (
    previewUrl.protocol !== "https:"
    || !previewUrl.hostname.startsWith(expectedPrefix)
    || !previewUrl.hostname.endsWith(".workers.dev")
    || previewUrl.username
    || previewUrl.password
    || previewUrl.pathname !== "/"
    || previewUrl.search
    || previewUrl.hash
  ) {
    throw new Error(
      `Wrangler returned preview URL ${entry.preview_alias_url}; expected https://${expectedPrefix}<account>.workers.dev`,
    )
  }
  return previewUrl.origin
}

export function runCommand(command, args, { cwd = process.cwd(), env = process.env } = {}) {
  const child = spawn(command, args, {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  })
  let stdout = ""
  let stderr = ""

  child.stdout.on("data", (chunk) => {
    const value = String(chunk)
    stdout += value
    process.stdout.write(value)
  })
  child.stderr.on("data", (chunk) => {
    const value = String(chunk)
    stderr += value
    process.stderr.write(value)
  })

  return new Promise((resolve, reject) => {
    child.once("error", reject)
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`${command} terminated by ${signal}`))
      } else if (code !== 0) {
        const error = new Error(`${command} exited with status ${code ?? 1}`)
        error.output = `${stdout}\n${stderr}`
        reject(error)
      } else {
        resolve({ stdout, stderr })
      }
    })
  })
}

async function uploadPreviewVersion({ alias, message, cwd, run }) {
  const outputDirectory = mkdtempSync(join(tmpdir(), "aquilla-preview-"))
  const outputPath = join(outputDirectory, "output.ndjson")
  try {
    await run(
      "pnpm",
      [
        "exec",
        "wrangler",
        "versions",
        "upload",
        "--env=preview",
        `--name=${PREVIEW_WORKER}`,
        `--preview-alias=${alias}`,
        "--message",
        message,
      ],
      {
        cwd,
        env: { ...process.env, WRANGLER_OUTPUT_FILE_PATH: outputPath },
      },
    )
    return parseWranglerOutput(readFileSync(outputPath, "utf8"), "version-upload")
  } finally {
    rmSync(outputDirectory, { recursive: true, force: true })
  }
}

async function bootstrapPreviewWorker({ cwd, run }) {
  await run(
    "pnpm",
    [
      "exec",
      "wrangler",
      "deploy",
      "--env=preview",
      `--name=${PREVIEW_WORKER}`,
    ],
    { cwd, env: process.env },
  )
}

export async function uploadRouteFreePreview({
  alias,
  message,
  cwd = process.cwd(),
  githubOutputPath = process.env.GITHUB_OUTPUT,
  run = runCommand,
  log = console.log,
  verifyArtifacts = assertSafeDeploymentArtifacts,
} = {}) {
  const safeAlias = String(alias ?? "").trim()
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(safeAlias)) {
    throw new Error(`invalid preview alias ${JSON.stringify(alias)}`)
  }
  const uploadMessage = String(message ?? "").trim()
  if (!uploadMessage) throw new Error("a preview upload message is required")

  verifyArtifacts(join(cwd, "dist"))

  let entry
  try {
    entry = await uploadPreviewVersion({ alias: safeAlias, message: uploadMessage, cwd, run })
  } catch (error) {
    const output = error instanceof Error && "output" in error ? String(error.output) : ""
    if (!MISSING_WORKER_PATTERN.test(`${error instanceof Error ? error.message : String(error)}\n${output}`)) {
      throw error
    }
    log(`[cloudflare-preview] ${PREVIEW_WORKER} is missing; bootstrapping the route-free preview Worker`)
    await bootstrapPreviewWorker({ cwd, run })
    entry = await uploadPreviewVersion({ alias: safeAlias, message: uploadMessage, cwd, run })
  }

  const url = previewUrlFromUpload(entry, { alias: safeAlias })
  if (githubOutputPath) appendFileSync(githubOutputPath, `url=${url}\n`)
  log(`[cloudflare-preview] worker=${PREVIEW_WORKER} version=${entry.version_id} alias=${safeAlias} url=${url}`)
  return { alias: safeAlias, url, versionId: entry.version_id, workerName: PREVIEW_WORKER }
}

export async function uploadPullRequestPreview(options = {}) {
  const alias = pullRequestPreviewAlias(options.prNumber)
  const source = String(options.commitSha ?? "").trim()
  if (!source) throw new Error("a pull request commit SHA is required")
  return uploadRouteFreePreview({
    ...options,
    alias,
    message: `PR ${String(options.prNumber).trim()} @ ${source}`,
  })
}

export async function uploadWorkersBuildPreview({
  env = process.env,
  ...options
} = {}) {
  const { branch, commitSha } = workersBuildMetadata(env)
  const alias = workersBuildPreviewAlias(branch)
  const buildId = env.WORKERS_CI_BUILD_UUID?.trim() || "unknown-build"
  return uploadRouteFreePreview({
    ...options,
    alias,
    message: `workers-build:${branch}:${buildId} @ ${commitSha}`,
  })
}

const isEntrypoint = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href

if (isEntrypoint) {
  const operation = process.argv[2] === "--workers-build"
    ? uploadWorkersBuildPreview()
    : uploadPullRequestPreview({
        prNumber: process.argv[2],
        commitSha: process.argv[3],
      })
  operation.catch((error) => {
    console.error(`[cloudflare-preview] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
