import { readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const modulePath = fileURLToPath(import.meta.url)
export const REPO_ROOT = resolve(dirname(modulePath), "..")

export const DEPLOYMENT_MANIFEST = JSON.parse(
  readFileSync(join(REPO_ROOT, "config", "cloudflare-deployments.json"), "utf8"),
)

export const WORKER_SURFACES = Object.freeze(Object.keys(DEPLOYMENT_MANIFEST.surfaces))
export const DEPLOYMENT_ENVIRONMENTS = Object.freeze(["production", "staging", "development"])

export function deploymentExpectation(surface, environment) {
  const surfaceConfig = DEPLOYMENT_MANIFEST.surfaces[surface]
  if (!surfaceConfig) {
    throw new Error(`unknown worker surface ${JSON.stringify(surface)}; expected ${WORKER_SURFACES.join(", ")}`)
  }
  const environmentConfig = surfaceConfig.environments[environment]
  if (!environmentConfig) {
    throw new Error(`unknown deployment environment ${JSON.stringify(environment)}; expected ${DEPLOYMENT_ENVIRONMENTS.join(", ")}`)
  }
  return {
    ...environmentConfig,
    surface,
    environment,
    directory: resolve(REPO_ROOT, surfaceConfig.directory),
    requiredSecrets: [
      ...surfaceConfig.requiredSecrets,
      ...(environmentConfig.requiredSecrets ?? []),
    ],
    requiredBindings: surfaceConfig.requiredBindings,
  }
}
