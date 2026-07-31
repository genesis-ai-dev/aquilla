import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

const REPO_ROOT = path.resolve(import.meta.dirname, "..")

function readRepoFile(...segments: string[]): string {
  return readFileSync(path.join(REPO_ROOT, ...segments), "utf8")
}

function tomlBlock(config: string, marker: string): string {
  const start = config.indexOf(marker)
  expect(start).toBeGreaterThan(-1)
  const end = config.indexOf("\n[", start + marker.length)
  return config.slice(start, end === -1 ? undefined : end)
}

describe("worker deployment environment contract", () => {
  it("always passes an explicit named environment to both worker deploys", () => {
    const workflow = readRepoFile(".github", "workflows", "deploy-workers.yml")
    const deploymentExpression =
      "github.ref == 'refs/heads/main' && '--env=production' || github.ref == 'refs/heads/staging' && '--env=staging' || '--env=development'"

    expect(workflow.match(new RegExp(deploymentExpression.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")))
      .toHaveLength(2)
    expect(workflow).not.toContain("refs/heads/main' && ' '")
  })

  it.each([
    ["production", "production", "https://api.aquilla.app/identity"],
    ["staging", "staging", "https://api.staging.aquilla.app/identity"],
    ["development", "development", "https://api.dev.aquilla.app/identity"],
  ])("keeps %s sync bindings in one environment", (profile, environment, authWorkerUrl) => {
    const config = readRepoFile("sync-worker", "wrangler.toml")
    const vars = tomlBlock(config, `[env.${profile}.vars]`)

    expect(vars).toContain(`ENVIRONMENT = "${environment}"`)
    expect(vars).toContain(`AUTH_WORKER_URL = "${authWorkerUrl}"`)
  })
})
