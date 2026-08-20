import { pathToFileURL } from "node:url"

export function workersBuildMetadata(env = process.env) {
  if (env.WORKERS_CI !== "1") {
    throw new Error("WORKERS_CI=1 is required; refusing to run outside Cloudflare Workers Builds")
  }

  const branch = env.WORKERS_CI_BRANCH?.trim()
  if (!branch) {
    throw new Error("WORKERS_CI_BRANCH is required; refusing to guess a deployment environment")
  }

  const commitSha = env.WORKERS_CI_COMMIT_SHA?.trim()
  if (!commitSha) {
    throw new Error("WORKERS_CI_COMMIT_SHA is required; refusing an untraceable build")
  }

  return { branch, commitSha }
}

const isEntrypoint = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href

if (isEntrypoint) {
  try {
    const metadata = workersBuildMetadata()
    console.log(`[workers-build] metadata accepted branch=${metadata.branch} commit=${metadata.commitSha}`)
  } catch (error) {
    console.error(`[workers-build] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
