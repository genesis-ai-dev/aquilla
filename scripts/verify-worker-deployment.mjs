import { spawn } from "node:child_process"
import { pathToFileURL } from "node:url"
import {
  DEPLOYMENT_MANIFEST,
  deploymentExpectation,
} from "./cloudflare-deployment-manifest.mjs"

export { DEPLOYMENT_MANIFEST }

function bindingMap(version) {
  const bindings = version?.resources?.bindings
  if (!Array.isArray(bindings)) {
    throw new Error("version JSON does not contain resources.bindings")
  }
  return new Map(bindings.map((binding) => [binding.name, binding]))
}

function versionBindingErrors(version, expectation, expectedVersionId) {
  const errors = []
  if (expectedVersionId && version?.id !== expectedVersionId) {
    errors.push(`version JSON ${version?.id ?? "unset"} does not match expected version ${expectedVersionId}`)
  }

  let bindings
  try {
    bindings = bindingMap(version)
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error))
    bindings = new Map()
  }

  for (const [name, expectedValue] of Object.entries(expectation.plainText)) {
    const binding = bindings.get(name)
    if (!binding) errors.push(`missing plain-text binding ${name}`)
    else if (binding.type !== "plain_text") errors.push(`${name} must be plain_text, received ${binding.type}`)
    else if (binding.text !== expectedValue) errors.push(`${name} expected ${expectedValue}, received ${binding.text}`)
  }

  for (const [name, expectedId] of Object.entries(expectation.hyperdrives)) {
    const binding = bindings.get(name)
    if (!binding) errors.push(`missing Hyperdrive binding ${name}`)
    else if (binding.type !== "hyperdrive") errors.push(`${name} must be hyperdrive, received ${binding.type}`)
    else if (binding.id !== expectedId) errors.push(`${name} expected Hyperdrive ${expectedId}, received ${binding.id}`)
  }

  for (const [name, expectedBucket] of Object.entries(expectation.r2Buckets)) {
    const binding = bindings.get(name)
    if (!binding) errors.push(`missing R2 binding ${name}`)
    else if (binding.type !== "r2_bucket") errors.push(`${name} must be r2_bucket, received ${binding.type}`)
    else if (binding.bucket_name !== expectedBucket) errors.push(`${name} expected R2 bucket ${expectedBucket}, received ${binding.bucket_name}`)
  }

  for (const name of expectation.requiredSecrets) {
    const binding = bindings.get(name)
    if (!binding) errors.push(`missing required secret binding ${name}`)
    else if (binding.type !== "secret_text") errors.push(`${name} must be secret_text, received ${binding.type}`)
  }

  for (const [name, expectedType] of Object.entries(expectation.requiredBindings)) {
    const binding = bindings.get(name)
    if (!binding) errors.push(`missing required binding ${name}`)
    else if (binding.type !== expectedType) errors.push(`${name} must be ${expectedType}, received ${binding.type}`)
  }

  return errors
}

export function validateWorkerVersion(version, expectation, expectedVersionId = version?.id) {
  const errors = versionBindingErrors(version, expectation, expectedVersionId)
  if (errors.length > 0) {
    throw new Error(`${expectation.worker} ${expectation.environment} version verification failed:\n- ${errors.join("\n- ")}`)
  }
  return expectedVersionId
}

export function validateActiveDeployment(deployment, expectedVersionId, expectation) {
  const traffic = deployment?.versions
  if (!Array.isArray(traffic) || traffic.length !== 1 || traffic[0]?.percentage !== 100) {
    throw new Error(`${expectation.worker} traffic must contain exactly one version at 100%`)
  }
  const activeVersion = traffic[0]?.version_id
  if (activeVersion !== expectedVersionId) {
    throw new Error(`${expectation.worker} active version ${activeVersion ?? "unset"} does not match expected version ${expectedVersionId}`)
  }
  return activeVersion
}

// Compatibility seam used by the production regression tests and callers that
// already have both JSON documents in hand.
export function validateProductionDeployment(deployment, version, expectation) {
  const activeVersion = deployment?.versions?.[0]?.version_id
  validateActiveDeployment(deployment, activeVersion, expectation)
  validateWorkerVersion(version, expectation, activeVersion)
  return activeVersion
}

function runCommand(command, args, { cwd }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => { stdout += chunk })
    child.stderr.on("data", (chunk) => { stderr += chunk })
    child.once("error", reject)
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`${command} terminated by ${signal}`))
      else if (code !== 0) reject(new Error(`${command} exited with status ${code}: ${stderr.trim()}`))
      else resolve(stdout)
    })
  })
}

function parseWranglerJson(stdout, command) {
  try {
    return JSON.parse(stdout)
  } catch {
    throw new Error(`${command} did not return valid JSON`)
  }
}

export async function verifyWorkerVersion(surface, environment, versionId, {
  workerName,
  run = runCommand,
  log = console.log,
} = {}) {
  const expectation = deploymentExpectation(surface, environment)
  const targetWorker = workerName ?? expectation.worker
  const args = [
    "exec",
    "wrangler",
    "versions",
    "view",
    versionId,
    `--name=${targetWorker}`,
    "--json",
  ]
  const output = await run("pnpm", args, { cwd: expectation.directory })
  const version = parseWranglerJson(output, `wrangler versions view ${versionId} --json`)
  validateWorkerVersion(version, expectation, versionId)
  log(`[verify-worker-deployment] ${targetWorker} ${versionId} has verified ${environment} bindings`)
  return versionId
}

export async function verifyActiveDeployment(surface, environment, versionId, {
  workerName,
  run = runCommand,
  log = console.log,
  attempts = 5,
  poll = (delay) => new Promise((resolve) => setTimeout(resolve, delay)),
} = {}) {
  const expectation = deploymentExpectation(surface, environment)
  const targetWorker = workerName ?? expectation.worker
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const args = [
      "exec",
      "wrangler",
      "deployments",
      "status",
      `--name=${targetWorker}`,
      "--json",
    ]
    const output = await run("pnpm", args, { cwd: expectation.directory })
    const deployment = parseWranglerJson(output, "wrangler deployments status --json")
    try {
      validateActiveDeployment(deployment, versionId, expectation)
      await verifyWorkerVersion(surface, environment, versionId, { workerName: targetWorker, run, log })
      log(`[verify-worker-deployment] ${targetWorker} ${versionId} has 100% traffic`)
      return versionId
    } catch (error) {
      lastError = error
      if (attempt < attempts) await poll(500)
    }
  }
  throw lastError
}

export async function verifyProductionDeployment(surface, options = {}) {
  const expectation = deploymentExpectation(surface, "production")
  const targetWorker = options.workerName ?? expectation.worker
  const run = options.run ?? runCommand
  const args = [
    "exec",
    "wrangler",
    "deployments",
    "status",
    `--name=${targetWorker}`,
    "--json",
  ]
  const output = await run("pnpm", args, { cwd: expectation.directory })
  const deployment = parseWranglerJson(output, "wrangler deployments status --json")
  const versionId = deployment?.versions?.[0]?.version_id
  if (!versionId) validateActiveDeployment(deployment, "missing", expectation)
  return verifyActiveDeployment(surface, "production", versionId, { ...options, workerName: targetWorker, run })
}

const isEntrypoint = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href

if (isEntrypoint) {
  verifyProductionDeployment(process.argv[2]).catch((error) => {
    console.error(`[verify-worker-deployment] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
