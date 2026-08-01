import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

const REPO_ROOT = path.resolve(import.meta.dirname, "..")

function readRepoFile(...segments: string[]): string {
  return readFileSync(path.join(REPO_ROOT, ...segments), "utf8")
}

function tomlBlock(config: string, marker: string): string {
  const markerIndex = config.indexOf(`\n${marker}\n`)
  expect(markerIndex).toBeGreaterThan(-1)
  const start = markerIndex + 1
  const end = config.indexOf("\n[", start + marker.length)
  return config.slice(start, end === -1 ? undefined : end)
}

describe("worker deployment environment contract", () => {
  it("always passes an explicit named environment to GitHub worker deploys", () => {
    const workflow = readRepoFile(".github", "workflows", "deploy-workers.yml")
    const deploymentExpression =
      "github.ref == 'refs/heads/main' && '--env=production' || github.ref == 'refs/heads/staging' && '--env=staging' || '--env=development'"

    expect(workflow.match(new RegExp(deploymentExpression.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")))
      .toHaveLength(2)
    expect(workflow).not.toContain("refs/heads/main' && ' '")
  })

  it("keeps account_id above the first TOML table", () => {
    const config = readRepoFile("sync-worker", "wrangler.toml")
    const topLevel = config.slice(0, config.indexOf("\n["))
    const localVars = tomlBlock(config, "[vars]")

    expect(topLevel).toContain('account_id = "6a80496d1e59948a9cbaa3c643ba81d7"')
    expect(localVars).not.toContain("account_id")
  })

  it.each([
    ["production", "production", "https://api.aquilla.app/identity"],
    ["staging", "staging", "https://api.staging.aquilla.app/identity"],
    ["development", "development", "https://api.dev.aquilla.app/identity"],
  ])("keeps %s sync variables in one environment", (profile, environment, authWorkerUrl) => {
    const config = readRepoFile("sync-worker", "wrangler.toml")
    const vars = tomlBlock(config, `[env.${profile}.vars]`)

    expect(vars).toContain(`ENVIRONMENT = "${environment}"`)
    expect(vars).toContain(`AUTH_WORKER_URL = "${authWorkerUrl}"`)
  })

  it.each([
    ["production", "aquilla-web", "aquilla.app/*"],
    ["staging", "aquilla-web-staging", "staging.aquilla.app/*"],
    ["development", "aquilla-web-development", "dev.aquilla.app/*"],
  ])("keeps %s SPA routing isolated", (profile, workerName, route) => {
    const config = readRepoFile("wrangler.toml")
    const environment = tomlBlock(config, `[env.${profile}]`)

    expect(environment).toContain(`name = "${workerName}"`)
    expect(environment).toContain(`routes = ["${route}"]`)
  })

  it.each([
    ["production", "aquilla-identity", "api.aquilla.app", "https://aquilla.app"],
    ["staging", "aquilla-staging-identity", "api.staging.aquilla.app", "https://staging.aquilla.app"],
    ["development", "aquilla-dev-identity", "api.dev.aquilla.app", "https://dev.aquilla.app"],
  ])("keeps %s identity and chat routing isolated", (profile, workerName, apiHost, baseUrl) => {
    const config = readRepoFile("auth-worker", "wrangler.toml")
    const environment = tomlBlock(config, `[env.${profile}]`)
    const vars = tomlBlock(config, `[env.${profile}.vars]`)

    expect(environment).toContain(`name = "${workerName}"`)
    expect(environment).toContain(`"${apiHost}/identity/*"`)
    expect(environment).toContain(`"${apiHost}/chat/*"`)
    expect(vars).toContain(`BASE_URL = "${baseUrl}"`)
    expect(vars).toContain(`SYNC_WORKER_URL = "https://${apiHost}/sync"`)
    expect(vars).toContain(`ENVIRONMENT = "${profile}"`)
  })

  it("exposes the repository-owned Workers Builds command", () => {
    const workerPackage = JSON.parse(readRepoFile("sync-worker", "package.json")) as {
      scripts?: Record<string, string>
    }

    expect(workerPackage.scripts?.["deploy:workers-build"])
      .toBe("node scripts/cloudflare-build-deploy.mjs")
  })

  it("uses explicit environments and live checks in every local deploy command", () => {
    const rootPackage = JSON.parse(readRepoFile("package.json")) as {
      scripts?: Record<string, string>
    }
    const scripts = rootPackage.scripts ?? {}

    for (const [target, profile] of [
      ["aquilla", "production"],
      ["aquilla:staging", "staging"],
      ["aquilla:dev", "development"],
    ] as const) {
      for (const surface of ["spa", "sync", "auth"] as const) {
        const command = scripts[`deploy:${target}:${surface}`]
        expect(command).toContain(`--env=${profile}`)
        expect(command).toContain(`verify-live-environment.mjs ${profile} --surface=${surface}`)
      }
    }

    expect(scripts["verify:live:production"]).toContain("verify-live-environment.mjs production")
    expect(scripts["verify:live:staging"]).toContain("verify-live-environment.mjs staging")
    expect(scripts["verify:live:development"]).toContain("verify-live-environment.mjs development")
  })

  it("keeps SPA CI builds and deploys on the same explicit environment", () => {
    const workflow = readRepoFile(".github", "workflows", "deploy.yml")
    const deployJobHeader = workflow.slice(
      workflow.indexOf("  deploy:"),
      workflow.indexOf("    steps:"),
    )

    expect(workflow).toContain("bash scripts/verify-dist-host.sh \"$host\"")
    expect(workflow).toContain("node scripts/verify-live-environment.mjs \"$target\" --surface=spa")
    expect(workflow).toContain(
      "github.ref == 'refs/heads/main' && '--env=production' || github.ref == 'refs/heads/staging' && '--env=staging' || '--env=development'",
    )
    expect(deployJobHeader).toContain("env:")
    expect(deployJobHeader).toContain("VITE_SYNC_WORKER_HOST:")
    expect(deployJobHeader).toContain("VITE_AUTH_BASE:")
    expect(deployJobHeader).toContain("VITE_CHAT_BASE:")
    expect(workflow.match(/VITE_AUTH_BASE:/g)).toHaveLength(1)
    expect(workflow).not.toContain("refs/heads/main' && ' '")
  })

  it("installs Chromium before running IDML browser conformance in Web CI", () => {
    const workflow = readRepoFile(".github", "workflows", "web-ci.yml")
    const installBrowser = workflow.indexOf("pnpm exec playwright install --with-deps chromium")
    const runIdmlTests = workflow.indexOf("pnpm test:idml")

    expect(installBrowser).toBeGreaterThan(-1)
    expect(runIdmlTests).toBeGreaterThan(installBrowser)
  })
})
