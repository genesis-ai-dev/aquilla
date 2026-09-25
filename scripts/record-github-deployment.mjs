// Records a GitHub Deployment for a verified production deploy, so the
// "release tags" ruleset's required_deployments check has something real to
// find. Nothing in the deploy chain (cloudflare-version-deploy.mjs,
// verify-live-environment.mjs) talks to GitHub; this is the one piece that
// does, kept apart for the same reason release-plan-walk.mjs is separate
// from release-plan.mjs — a network bug can't hide inside deploy logic.
const REPO = "genesis-ai-dev/aquilla"

async function githubApi(path, { repo, token, fetchImpl, method = "GET", body }) {
  const response = await fetchImpl(`https://api.github.com/repos/${repo}${path}`, {
    method,
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!response.ok) {
    const text = await response.text().catch(() => "")
    throw new Error(`GitHub request failed: HTTP ${response.status} ${text}`)
  }
  return response.json()
}

// A retried deploy (same sha redeployed) should not pile up duplicate
// deployment records — check for one that already succeeded first.
export async function hasSuccessfulDeployment({ sha, environment, repo = REPO, token, fetchImpl = fetch }) {
  const opts = { repo, token, fetchImpl }
  const deployments = await githubApi(`/deployments?sha=${sha}&environment=${environment}&per_page=100`, opts)
  const rows = Array.isArray(deployments) ? deployments : []
  for (const deployment of rows) {
    const statuses = await githubApi(`/deployments/${deployment.id}/statuses?per_page=10`, opts)
    if (Array.isArray(statuses) && statuses.some((status) => status.state === "success")) return true
  }
  return false
}

export async function recordDeployment({ sha, environment, description, repo = REPO, token, fetchImpl = fetch }) {
  const opts = { repo, token, fetchImpl }
  if (await hasSuccessfulDeployment({ sha, environment, repo, token, fetchImpl })) {
    return { created: false }
  }
  const deployment = await githubApi("/deployments", {
    ...opts,
    method: "POST",
    body: {
      ref: sha,
      environment,
      description,
      auto_merge: false,
      required_contexts: [],
      production_environment: environment === "production",
      transient_environment: false,
    },
  })
  await githubApi(`/deployments/${deployment.id}/statuses`, {
    ...opts,
    method: "POST",
    // GitHub caps a deployment status description at 140 characters.
    body: { state: "success", environment, description: description.slice(0, 140) },
  })
  return { created: true, id: deployment.id }
}

async function main() {
  const [sha, environment] = process.argv.slice(2)
  if (!sha || !environment) {
    console.error("Usage: record-github-deployment.mjs <sha> <production|development>")
    process.exit(1)
  }
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
  if (!token) {
    console.error("ABORT: GITHUB_TOKEN (or GH_TOKEN) is required to record the deployment.")
    process.exit(1)
  }
  const result = await recordDeployment({
    sha,
    environment,
    description: `Verified live via verify-live-environment.mjs ${environment}`,
    token,
  })
  console.log(
    result.created
      ? `OK: recorded a ${environment} deployment for ${sha}.`
      : `OK: ${sha} already has a successful ${environment} deployment.`,
  )
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`ABORT: ${error.message}`)
    process.exit(1)
  })
}
