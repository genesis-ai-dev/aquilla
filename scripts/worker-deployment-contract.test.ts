import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
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
  it("resolves GitHub deploys once and never falls through to an environment", () => {
    const workflow = readRepoFile(".github", "workflows", "deploy-workers.yml")
    const deployCommand = "command: deploy --env=${{ needs.target.outputs.wrangler_environment }}"

    expect(workflow.match(new RegExp(deployCommand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")))
      .toHaveLength(2)
    expect(workflow).toContain("run: bash scripts/resolve-deployment-target.sh")
    expect(workflow.match(/name: \$\{\{ needs\.target\.outputs\.github_environment \}\}/g))
      .toHaveLength(2)
    expect(workflow).not.toContain("|| '--env=development'")
  })

  it.each([
    ["push", "main", "production", "production", "api.aquilla.app"],
    ["push", "staging", "staging", "staging", "api.staging.aquilla.app"],
    ["workflow_dispatch", "dev", "development", "development", "api.dev.aquilla.app"],
    ["pull_request", "123/merge", "preview", "development", "api.dev.aquilla.app"],
  ])(
    "resolves %s on %s without an implicit fallback",
    (eventName, refName, wranglerEnvironment, liveEnvironment, apiHost) => {
      const result = spawnSync(
        "bash",
        [path.join(REPO_ROOT, "scripts", "resolve-deployment-target.sh"), eventName, refName],
        { encoding: "utf8", env: {} },
      )

      expect(result.status).toBe(0)
      expect(result.stdout).toContain(`wrangler_environment=${wranglerEnvironment}`)
      expect(result.stdout).toContain(`live_environment=${liveEnvironment}`)
      expect(result.stdout).toContain(`api_host=${apiHost}`)
    },
  )

  it.each(["feature/example", "development", "", "release"])(
    "rejects unauthorized live deployment ref %j",
    (refName) => {
      const result = spawnSync(
        "bash",
        [path.join(REPO_ROOT, "scripts", "resolve-deployment-target.sh"), "workflow_dispatch", refName],
        { encoding: "utf8", env: {} },
      )

      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain("ABORT:")
    },
  )

  it("enforces the expected branch inside named production profiles", () => {
    const tempRepo = mkdtempSync(path.join(tmpdir(), "aquilla-deploy-guard-"))
    const guard = path.join(REPO_ROOT, "scripts", "verify-deploy-branch.sh")

    try {
      expect(spawnSync("git", ["init", "-b", "main"], { cwd: tempRepo }).status).toBe(0)

      const allowed = spawnSync("bash", [guard, "main"], {
        cwd: tempRepo,
        encoding: "utf8",
        env: { GITHUB_ACTIONS: "true", GITHUB_REF_NAME: "main" },
      })
      expect(allowed.status).toBe(0)

      const rejected = spawnSync("bash", [guard, "staging"], {
        cwd: tempRepo,
        encoding: "utf8",
        env: { GITHUB_ACTIONS: "true", GITHUB_REF_NAME: "main" },
      })
      expect(rejected.status).not.toBe(0)
      expect(rejected.stderr).toContain("requires branch 'staging'")
    } finally {
      rmSync(tempRepo, { recursive: true, force: true })
    }
  })

  it("keeps account_id above the first TOML table", () => {
    const config = readRepoFile("sync-worker", "wrangler.toml")
    const topLevel = config.slice(0, config.indexOf("\n["))
    const localVars = tomlBlock(config, "[vars]")

    expect(topLevel).toContain('account_id = "6a80496d1e59948a9cbaa3c643ba81d7"')
    expect(localVars).not.toContain("account_id")
  })

  it.each([
    ["wrangler.toml", "aquilla-web-local", "aquilla-web", "bash scripts/verify-deploy-branch.sh main"],
    ["sync-worker/wrangler.toml", "aquilla-sync-worker-local", "aquilla-sync-worker", "bash ../scripts/verify-deploy-branch.sh main"],
    ["auth-worker/wrangler.toml", "aquilla-identity-local", "aquilla-identity", "bash ../scripts/verify-deploy-branch.sh main"],
    ["agent-worker/wrangler.toml", "aquilla-agent-sandbox-local", "aquilla-agent-sandbox", "bash ../scripts/verify-deploy-branch.sh main"],
    ["resource-worker/wrangler.toml", "aquilla-resources-local", "aquilla-resources", "bash ../scripts/verify-deploy-branch.sh main"],
  ])(
    "keeps the unnamed profile in %s away from production",
    (file, localName, productionName, guardCommand) => {
      const config = readRepoFile(...file.split("/"))
      const topLevel = config.slice(0, config.indexOf("\n["))
      const production = tomlBlock(config, "[env.production]")
      const productionBuild = tomlBlock(config, "[env.production.build]")

      expect(topLevel).toContain(`name = "${localName}"`)
      expect(topLevel).not.toContain(`name = "${productionName}"`)
      expect(production).toContain(`name = "${productionName}"`)
      expect(productionBuild).toContain(`command = "${guardCommand}"`)
    },
  )

  it.each([
    ["wrangler.toml", "bash scripts/verify-deploy-branch.sh staging"],
    ["sync-worker/wrangler.toml", "bash ../scripts/verify-deploy-branch.sh staging"],
    ["auth-worker/wrangler.toml", "bash ../scripts/verify-deploy-branch.sh staging"],
    ["agent-worker/wrangler.toml", "bash ../scripts/verify-deploy-branch.sh staging"],
  ])("enforces staging branch ownership in %s", (file, guardCommand) => {
    const config = readRepoFile(...file.split("/"))
    const stagingBuild = tomlBlock(config, "[env.staging.build]")

    expect(stagingBuild).toContain(`command = "${guardCommand}"`)
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
    [
      "production",
      "aquilla-sync-worker",
      "api.aquilla.app/sync/*",
      "aquilla-snapshots",
      "69bcc10e67464f2eaf4fe91a9141e7cd",
    ],
    [
      "staging",
      "aquilla-sync-worker-staging",
      "api.staging.aquilla.app/sync/*",
      "aquilla-snapshots-staging",
      "822231ade4da4db5b1955702e13d1ac3",
    ],
    [
      "development",
      "aquilla-sync-worker-dev",
      "api.dev.aquilla.app/sync/*",
      "aquilla-snapshots-dev",
      "53581197ff7a4202a5ed0ef08537d4a6",
    ],
  ])(
    "keeps %s sync routing and storage isolated",
    (profile, workerName, route, bucket, hyperdriveId) => {
      const config = readRepoFile("sync-worker", "wrangler.toml")
      const environment = tomlBlock(config, `[env.${profile}]`)
      const snapshots = tomlBlock(config, `[[env.${profile}.r2_buckets]]`)
      const hyperdrive = tomlBlock(config, `[[env.${profile}.hyperdrive]]`)

      expect(environment).toContain(`name = "${workerName}"`)
      expect(environment).toContain(`routes = ["${route}"]`)
      expect(snapshots).toContain(`bucket_name = "${bucket}"`)
      expect(hyperdrive).toContain(`id = "${hyperdriveId}"`)
    },
  )

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
    [
      "production",
      "aquilla-identity",
      "api.aquilla.app",
      "https://aquilla.app",
      "aquilla-snapshots",
      "69bcc10e67464f2eaf4fe91a9141e7cd",
    ],
    [
      "staging",
      "aquilla-staging-identity",
      "api.staging.aquilla.app",
      "https://staging.aquilla.app",
      "aquilla-snapshots-staging",
      "822231ade4da4db5b1955702e13d1ac3",
    ],
    [
      "development",
      "aquilla-dev-identity",
      "api.dev.aquilla.app",
      "https://dev.aquilla.app",
      "aquilla-snapshots-dev",
      "53581197ff7a4202a5ed0ef08537d4a6",
    ],
  ])(
    "keeps %s identity and chat routing isolated",
    (profile, workerName, apiHost, baseUrl, bucket, hyperdriveId) => {
      const config = readRepoFile("auth-worker", "wrangler.toml")
      const environment = tomlBlock(config, `[env.${profile}]`)
      const vars = tomlBlock(config, `[env.${profile}.vars]`)
      const snapshots = tomlBlock(config, `[[env.${profile}.r2_buckets]]`)
      const hyperdrive = tomlBlock(config, `[[env.${profile}.hyperdrive]]`)

      expect(environment).toContain(`name = "${workerName}"`)
      expect(environment).toContain(`"${apiHost}/identity/*"`)
      expect(environment).toContain(`"${apiHost}/chat/*"`)
      expect(vars).toContain(`BASE_URL = "${baseUrl}"`)
      expect(vars).toContain(`SYNC_WORKER_URL = "https://${apiHost}/sync"`)
      expect(vars).toContain(`ENVIRONMENT = "${profile}"`)
      expect(snapshots).toContain(`bucket_name = "${bucket}"`)
      expect(hyperdrive).toContain(`id = "${hyperdriveId}"`)
    },
  )

  it("exposes the repository-owned Workers Builds command", () => {
    const workerPackage = JSON.parse(readRepoFile("sync-worker", "package.json")) as {
      scripts?: Record<string, string>
    }

    expect(workerPackage.scripts?.["deploy:workers-build"])
      .toBe("node scripts/cloudflare-build-deploy.mjs")
    expect(workerPackage.scripts?.deploy).toBe("pnpm --dir .. run deploy:aquilla:sync")

    const authPackage = JSON.parse(readRepoFile("auth-worker", "package.json")) as {
      scripts?: Record<string, string>
    }
    expect(authPackage.scripts?.deploy).toBe("pnpm --dir .. run deploy:aquilla:auth")

    const agentPackage = JSON.parse(readRepoFile("agent-worker", "package.json")) as {
      scripts?: Record<string, string>
    }
    expect(agentPackage.scripts?.deploy).toContain("verify-deploy-branch.sh main")
    expect(agentPackage.scripts?.deploy).toContain("--env=production")
    expect(agentPackage.scripts?.["deploy:staging"]).toContain("--env=staging")
    expect(agentPackage.scripts?.["deploy:development"]).toContain("--env=development")
  })

  it("keeps the documented environment matrix synchronized with the executable contract", () => {
    const matrix = readRepoFile("docs", "DEPLOYMENT-ENVIRONMENTS.md")

    for (const row of [
      "| Production | `main` | `production` | `https://aquilla.app` | `api.aquilla.app` | `aquilla-web` | `aquilla-identity` | `aquilla-sync-worker` | `production` | `aquilla-snapshots` |",
      "| Staging | `staging` | `staging` | `https://staging.aquilla.app` | `api.staging.aquilla.app` | `aquilla-web-staging` | `aquilla-staging-identity` | `aquilla-sync-worker-staging` | `staging` | `aquilla-snapshots-staging` |",
      "| Development | `dev` | `development` | `https://dev.aquilla.app` | `api.dev.aquilla.app` | `aquilla-web-development` | `aquilla-dev-identity` | `aquilla-sync-worker-dev` | `dev` | `aquilla-snapshots-dev` |",
    ]) {
      expect(matrix).toContain(row)
    }

    expect(matrix).toContain("`main` -> `--env=production`")
    expect(matrix).toContain("`staging` -> `--env=staging`")
    expect(matrix).toContain("`dev` -> `--env=development`")
    expect(matrix).toContain("`pnpm run deploy:workers-build`")
    expect(matrix).toContain("All unnamed Wrangler profiles are local-only")
    expect(matrix).toContain("deployment-branch policy")

    expect(readRepoFile("README.md")).toContain("docs/DEPLOYMENT-ENVIRONMENTS.md")
    expect(readRepoFile("docs", "STAGING.md")).toContain("DEPLOYMENT-ENVIRONMENTS.md")
    expect(readRepoFile("docs", "runbooks", "cloudflare-workers-builds.md"))
      .toContain("../DEPLOYMENT-ENVIRONMENTS.md")
    expect(readRepoFile("resource-worker", "README.md"))
      .toContain("This Worker has no staging profile or staging hostname")
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
    const deployJobStart = workflow.indexOf("  deploy:")
    const deployJobHeader = workflow.slice(
      deployJobStart,
      workflow.indexOf("    steps:", deployJobStart),
    )

    expect(workflow).toContain("bash scripts/verify-dist-host.sh \"${{ needs.target.outputs.api_host }}\"")
    expect(workflow).toContain("node scripts/verify-live-environment.mjs \"${{ needs.target.outputs.live_environment }}\" --surface=spa")
    expect(workflow).toContain("run: bash scripts/resolve-deployment-target.sh")
    expect(workflow).toContain("command: deploy --env=${{ needs.target.outputs.wrangler_environment }}")
    expect(workflow).toContain("command: versions upload --env=preview")
    expect(workflow).toContain("name: ${{ needs.target.outputs.github_environment }}")
    expect(workflow).not.toContain("|| '--env=development'")
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
