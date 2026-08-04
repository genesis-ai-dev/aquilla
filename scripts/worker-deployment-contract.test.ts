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

      const rejected = spawnSync("bash", [guard, "dev"], {
        cwd: tempRepo,
        encoding: "utf8",
        env: { GITHUB_ACTIONS: "true", GITHUB_REF_NAME: "main" },
      })
      expect(rejected.status).not.toBe(0)
      expect(rejected.stderr).toContain("requires branch 'dev'")
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
    "wrangler.toml",
    "sync-worker/wrangler.toml",
    "auth-worker/wrangler.toml",
    "agent-worker/wrangler.toml",
  ])("leaves no staging profile behind in %s", (file) => {
    expect(readRepoFile(...file.split("/"))).not.toContain("[env.staging")
  })

  // scripts/ci-build.sh is the build command Cloudflare Workers Builds runs for
  // the SPA — a second, dashboard-configured path into the same Workers that
  // GitHub Actions deploys. It bakes VITE_* from $WORKERS_CI_BRANCH, so a stale
  // branch arm here ships a bundle pointing at a dead API host. It is easy to
  // miss precisely because nothing in .github/ references it.
  it("maps Cloudflare Workers Builds branches to the two live environments", () => {
    const script = readRepoFile("scripts", "ci-build.sh")

    expect(script).toContain("main)    H=api.aquilla.app ;;")
    expect(script).toContain("*)       H=api.dev.aquilla.app ;;")
    expect(script).not.toContain("staging")
  })

  it.each([
    ["production", "production", "https://api.aquilla.app/identity"],
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
    expect(agentPackage.scripts?.["deploy:development"]).toContain("--env=development")
  })

  it("keeps the documented environment matrix synchronized with the executable contract", () => {
    const matrix = readRepoFile("docs", "DEPLOYMENT-ENVIRONMENTS.md")

    for (const row of [
      "| Production | `main` | `production` | `https://aquilla.app` | `api.aquilla.app` | `aquilla-web` | `aquilla-identity` | `aquilla-sync-worker` | `production` | `aquilla-snapshots` |",
      "| Development | `dev` | `development` | `https://dev.aquilla.app` | `api.dev.aquilla.app` | `aquilla-web-development` | `aquilla-dev-identity` | `aquilla-sync-worker-dev` | `dev` | `aquilla-snapshots-dev` |",
    ]) {
      expect(matrix).toContain(row)
    }

    expect(matrix).toContain("`main` -> `--env=production`")
    expect(matrix).toContain("`dev` -> `--env=development`")
    expect(matrix).toContain("`pnpm run deploy:workers-build`")
    expect(matrix).toContain("All unnamed Wrangler profiles are local-only")
    expect(matrix).toContain("deployment-branch policy")

    expect(readRepoFile("README.md")).toContain("docs/DEPLOYMENT-ENVIRONMENTS.md")
    expect(readRepoFile("docs", "runbooks", "cloudflare-workers-builds.md"))
      .toContain("../DEPLOYMENT-ENVIRONMENTS.md")
    expect(readRepoFile("resource-worker", "README.md"))
      .toContain("only production and development\n   profiles")

    // Two live environments, no more. A reintroduced staging row here would
    // silently diverge from the Wrangler profiles and the branch resolver.
    expect(matrix).not.toContain("api.staging.aquilla.app")
    expect(matrix).not.toContain("--env=staging")
  })

  it("uses explicit environments and live checks in every local deploy command", () => {
    const rootPackage = JSON.parse(readRepoFile("package.json")) as {
      scripts?: Record<string, string>
    }
    const scripts = rootPackage.scripts ?? {}

    for (const [target, profile] of [
      ["aquilla", "production"],
      ["aquilla:dev", "development"],
    ] as const) {
      for (const surface of ["spa", "sync", "auth"] as const) {
        const command = scripts[`deploy:${target}:${surface}`]
        expect(command).toContain(`--env=${profile}`)
        expect(command).toContain(`verify-live-environment.mjs ${profile} --surface=${surface}`)
      }
    }

    expect(scripts["verify:live:production"]).toContain("verify-live-environment.mjs production")
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
    expect(workflow).toContain("wrangler versions upload --env=preview")
    expect(workflow).toContain("name: ${{ needs.target.outputs.github_environment }}")
    expect(workflow).not.toContain("|| '--env=development'")
    expect(deployJobHeader).toContain("env:")
    expect(deployJobHeader).toContain("VITE_SYNC_WORKER_HOST:")
    expect(deployJobHeader).toContain("VITE_AUTH_BASE:")
    expect(deployJobHeader).toContain("VITE_CHAT_BASE:")
    expect(workflow.match(/VITE_AUTH_BASE:/g)).toHaveLength(1)
    expect(workflow).not.toContain("refs/heads/main' && ' '")
  })

  // A preview that silently does not build is worse than no preview: the job
  // still reports green, so nobody notices QA has nothing to click. Every
  // non-draft PR must produce a URL, and the URL must be proven to serve the
  // SPA before it is advertised.
  it("uploads a preview for every non-draft PR and proves the URL works", () => {
    const workflow = readRepoFile(".github", "workflows", "deploy.yml")

    // The upload's only condition is "this is a PR". The commit-message
    // opt-in that used to gate it (`[preview]`/`[deploy]` grepped in a
    // `decide` step) skipped every single upload while still reporting green.
    expect(workflow).toContain("        id: deploy_preview\n        if: github.event_name == 'pull_request'\n")
    expect(workflow).not.toContain("steps.decide.outputs.deploy")

    expect(workflow).toContain("if: github.event.pull_request.draft != true")
    expect(workflow).toContain("ALIAS: pr-${{ github.event.number }}")
    expect(workflow).toContain("--preview-alias \"$ALIAS\"")
    expect(workflow).toContain("name: Smoke-check the preview URL")

    // `versions upload` cannot create a Worker. Without the bootstrap the very
    // first PR — and any PR after someone deletes aquilla-web-preview — fails
    // with "does not yet exist".
    expect(workflow).toContain("wrangler deploy --env=preview")
  })

  it("installs Chromium before running IDML browser conformance in Web CI", () => {
    const workflow = readRepoFile(".github", "workflows", "web-ci.yml")
    const installBrowser = workflow.indexOf("pnpm exec playwright install --with-deps chromium")
    const runIdmlTests = workflow.indexOf("pnpm test:idml")

    expect(installBrowser).toBeGreaterThan(-1)
    expect(runIdmlTests).toBeGreaterThan(installBrowser)
  })
})
