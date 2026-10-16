import { readFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { pathToFileURL } from "node:url"
import path from "node:path"

// Public ingestion token, never a personal API key. Only hosted Aquilla builds
// consume this configuration; ordinary/self-hosted builds retain their env.
export const hostedPosthog = Object.freeze(JSON.parse(
  readFileSync(path.resolve(import.meta.dirname, "../config/posthog.json"), "utf8"),
))

export function hostedPosthogEnv(env = process.env) {
  return {
    ...env,
    VITE_POSTHOG_KEY: hostedPosthog.projectToken,
    VITE_POSTHOG_HOST: hostedPosthog.ingestHost,
  }
}

if (process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = spawnSync("npm", ["run", "build"], {
    env: hostedPosthogEnv(),
    stdio: "inherit",
  })
  if (result.error) throw result.error
  process.exit(result.status ?? 1)
}
