import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { describe, expect, it } from "vitest"

const REPO_ROOT = path.resolve(import.meta.dirname, "..")
const deploymentManifest = JSON.parse(
  readFileSync(path.join(REPO_ROOT, "config", "cloudflare-deployments.json"), "utf8"),
) as {
  surfaces: Record<string, {
    directory: string
    requiredBindings: Record<string, string>
    environments: Record<string, {
      worker: string
      routes: string[]
      plainText: Record<string, string>
      hyperdrives: Record<string, string>
      r2Buckets: Record<string, string>
    }>
  }>
}

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

function environmentSection(config: string, environment: string): string {
  const start = config.indexOf(`\n[env.${environment}]\n`)
  expect(start).toBeGreaterThan(-1)
  const end = ["production", "development"]
    .filter((candidate) => candidate !== environment)
    .map((candidate) => config.indexOf(`\n[env.${candidate}]\n`, start + 2))
    .filter((index) => index > start)
    .sort((a, b) => a - b)[0] ?? -1
  return config.slice(start, end === -1 ? undefined : end)
}

describe("worker deployment environment contract", () => {
  it("keeps live deployment dispatch explicit and branch resolved", () => {
    const workflow = readRepoFile(".github", "workflows", "deploy-workers.yml")
    const triggers = workflow.slice(workflow.indexOf("\non:"), workflow.indexOf("\npermissions:"))

    expect(workflow).toContain("run: bash scripts/resolve-deployment-target.sh")
    expect(workflow.match(/name: \$\{\{ needs\.target\.outputs\.github_environment \}\}/g))
      .toHaveLength(3)
    expect(workflow).toContain("production) pnpm run deploy:aquilla:spa")
    expect(workflow).toContain("production) pnpm run deploy:aquilla:sync")
    expect(workflow).toContain("production) pnpm run deploy:aquilla:auth")
    expect(workflow).toContain("development) pnpm run deploy:aquilla:dev:spa")
    expect(workflow).toContain("development) pnpm run deploy:aquilla:dev:sync")
    expect(workflow).toContain("development) pnpm run deploy:aquilla:dev:auth")
    expect(workflow).toContain("all|web|sync-worker|auth-worker")
    expect(workflow).not.toContain("|| '--env=development'")
    expect(triggers).toContain("workflow_dispatch:")
    expect(triggers).not.toContain("push:")
  })

  it.each([
    ["workflow_dispatch", "main", "production", "production", "api.aquilla.app"],
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

  it.each(["feature/example", "development", "staging", "", "release"])(
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

  it.each(["main", "dev"])(
    "enforces the expected %s branch for explicit live deployments",
    (expectedBranch) => {
      const tempRepo = mkdtempSync(path.join(tmpdir(), "aquilla-deploy-guard-"))
      const guard = path.join(REPO_ROOT, "scripts", "verify-deploy-branch.sh")

      try {
        expect(spawnSync("git", ["init", "-b", expectedBranch], { cwd: tempRepo }).status).toBe(0)

        const allowed = spawnSync("bash", [guard, expectedBranch], {
          cwd: tempRepo,
          encoding: "utf8",
          env: { GITHUB_ACTIONS: "true", GITHUB_REF_NAME: expectedBranch },
        })
        expect(allowed.status).toBe(0)

        const rejected = spawnSync("bash", [guard, "feature/example"], {
          cwd: tempRepo,
          encoding: "utf8",
          env: { GITHUB_ACTIONS: "true", GITHUB_REF_NAME: expectedBranch },
        })
        expect(rejected.status).not.toBe(0)
        expect(rejected.stderr).toContain("requires branch 'feature/example'")
      } finally {
        rmSync(tempRepo, { recursive: true, force: true })
      }
    },
  )

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

  it("keeps pull-request previews on a route-free Worker", () => {
    const config = readRepoFile("wrangler.toml")
    const preview = tomlBlock(config, "[env.preview]")
    const previewAssets = tomlBlock(config, "[env.preview.assets]")

    expect(preview).toContain('name = "aquilla-web-preview"')
    expect(preview).toContain("workers_dev = true")
    expect(preview).toContain("preview_urls = true")
    expect(preview).not.toContain("routes")
    expect(previewAssets).toContain('not_found_handling = "single-page-application"')
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

  it("keeps Cloudflare Workers Builds preview-only and repository-owned", () => {
    const rootPackage = JSON.parse(readRepoFile("package.json")) as {
      scripts?: Record<string, string>
    }
    expect(rootPackage.scripts?.["deploy:workers-build"])
      .toBe("node scripts/cloudflare-build-deploy.mjs web")
    expect(rootPackage.scripts?.["build:workers-build"]).toContain("scripts/ci-build.sh")
    expect(rootPackage.scripts?.["build:workers-build:identity"])
      .toBe("CI=1 pnpm --dir auth-worker install --frozen-lockfile && pnpm --dir auth-worker run build:workers-build")
    expect(rootPackage.scripts?.["build:workers-build:sync"])
      .toBe("CI=1 pnpm --dir sync-worker install --frozen-lockfile && pnpm --dir sync-worker run build:workers-build")
    expect(rootPackage.scripts?.["deploy:workers-build:identity"])
      .toBe("pnpm --dir auth-worker run deploy:workers-build")
    expect(rootPackage.scripts?.["deploy:workers-build:sync"])
      .toBe("pnpm --dir sync-worker run deploy:workers-build")

    const workerPackage = JSON.parse(readRepoFile("sync-worker", "package.json")) as {
      scripts?: Record<string, string>
    }

    expect(workerPackage.scripts?.["build:workers-build"])
      .toContain("assert-workers-build-env.mjs")
    expect(workerPackage.scripts?.["deploy:workers-build"])
      .toBe("node ../scripts/cloudflare-build-deploy.mjs sync")
    expect(workerPackage.scripts?.deploy).toBe("pnpm --dir .. run deploy:aquilla:sync")

    const authPackage = JSON.parse(readRepoFile("auth-worker", "package.json")) as {
      scripts?: Record<string, string>
    }
    expect(authPackage.scripts?.["build:workers-build"])
      .toContain("assert-workers-build-env.mjs")
    expect(authPackage.scripts?.["deploy:workers-build"])
      .toBe("node ../scripts/cloudflare-build-deploy.mjs identity")
    expect(authPackage.scripts?.deploy).toBe("pnpm --dir .. run deploy:aquilla:auth")

    const runbook = readRepoFile("docs", "runbooks", "cloudflare-workers-builds.md")
    expect(runbook).toContain("`aquilla-web-development`")
    expect(runbook).toContain("`aquilla-dev-identity`")
    expect(runbook).toContain("`aquilla-sync-worker-dev`")
    expect(runbook).toContain("Keep all six live Workers disconnected from Git")
    expect(runbook).toContain("Production and development builds and deployments are manual only")
    expect(runbook).toContain("not attached to any live Worker")
    expect(runbook).toContain("pull-request validation is manual")
    expect(runbook).not.toContain("Development auto-deployment")

    const helper = readRepoFile("scripts", "cloudflare-build-deploy.mjs")
    expect(helper).toContain("promote: false")
    expect(helper).not.toContain("promote: true")
    expect(existsSync(path.join(REPO_ROOT, "scripts", "ci-build.sh"))).toBe(true)

    const agentPackage = JSON.parse(readRepoFile("agent-worker", "package.json")) as {
      scripts?: Record<string, string>
    }
    expect(agentPackage.scripts?.deploy).toContain("verify-deploy-branch.sh main")
    expect(agentPackage.scripts?.deploy).toContain("--env=production")
    expect(agentPackage.scripts?.["deploy:staging"]).toBeUndefined()
    expect(agentPackage.scripts?.["deploy:development"]).toContain("--env=development")
  })

  it("keeps every Wrangler environment synchronized with the canonical manifest", () => {
    const configFiles = {
      web: "wrangler.toml",
      identity: "auth-worker/wrangler.toml",
      sync: "sync-worker/wrangler.toml",
    } as const

    for (const [surface, surfaceConfig] of Object.entries(deploymentManifest.surfaces)) {
      const config = readRepoFile(...configFiles[surface as keyof typeof configFiles].split("/"))
      for (const [environment, expected] of Object.entries(surfaceConfig.environments)) {
        const section = environmentSection(config, environment)
        expect(section).toContain(`name = "${expected.worker}"`)
        for (const route of expected.routes) expect(section).toContain(`"${route}"`)
        for (const [name, value] of Object.entries(expected.plainText)) {
          expect(section).toContain(`${name} = "${value}"`)
        }
        for (const [name, id] of Object.entries(expected.hyperdrives)) {
          expect(section).toContain(`binding = "${name}"`)
          expect(section).toContain(`id = "${id}"`)
        }
        for (const [name, bucket] of Object.entries(expected.r2Buckets)) {
          expect(section).toContain(`binding = "${name}"`)
          expect(section).toContain(`bucket_name = "${bucket}"`)
        }
        for (const [name, type] of Object.entries(surfaceConfig.requiredBindings)) {
          const declaration = type === "send_email" || type === "durable_object_namespace"
            ? `name = "${name}"`
            : `binding = "${name}"`
          expect(section).toContain(declaration)
        }
      }
    }
  })

  it("keeps retired staging outside the executable deployment contract", () => {
    for (const file of [
      "wrangler.toml",
      "auth-worker/wrangler.toml",
      "sync-worker/wrangler.toml",
      "agent-worker/wrangler.toml",
    ]) {
      expect(readRepoFile(...file.split("/"))).not.toContain("[env.staging]")
    }

    for (const surface of Object.values(deploymentManifest.surfaces)) {
      expect(surface.environments.staging).toBeUndefined()
    }

    expect(existsSync(path.join(REPO_ROOT, "docs", "STAGING.md"))).toBe(false)
    expect(existsSync(path.join(REPO_ROOT, ".github", "workflows", "staging-neon-refresh.yml")))
      .toBe(false)
  })

  it("keeps the documented environment matrix synchronized with the executable contract", () => {
    const matrix = readRepoFile("docs", "DEPLOYMENT-ENVIRONMENTS.md")

    for (const row of [
      "| Production | `main` | `production` | `https://aquilla.app` | `api.aquilla.app` | `aquilla-web` | `aquilla-identity` | `aquilla-sync-worker` | `production` | `aquilla-snapshots` |",
      "| Development | `dev` | `development` | `https://dev.aquilla.app` | `api.dev.aquilla.app` | `aquilla-web-development` | `aquilla-dev-identity` | `aquilla-sync-worker-dev` | `dev` | `aquilla-snapshots-dev` |",
    ]) {
      expect(matrix).toContain(row)
    }

    expect(matrix).toContain("`main` -> `production`")
    expect(matrix).toContain("`dev` -> `development`")
    expect(matrix).toContain("Cloudflare Workers Builds owns automatic pull-request validation")
    expect(matrix).toContain("Live Aquilla deployments require an explicit human/operator action")
    expect(matrix).toContain("All unnamed Wrangler profiles are local-only")
    expect(matrix).toContain("deployment-branch policy")

    expect(readRepoFile("README.md")).toContain("docs/DEPLOYMENT-ENVIRONMENTS.md")
    expect(readRepoFile("docs", "runbooks", "cloudflare-workers-builds.md"))
      .toContain("../DEPLOYMENT-ENVIRONMENTS.md")
    expect(readRepoFile("docs", "README.md")).not.toContain("STAGING.md")
    expect(readRepoFile("AGENTS.md")).not.toContain("deployed by Cloudflare Workers Builds")
    expect(readRepoFile(".agents", "skills", "swarm-orchestration", "SKILL.md"))
      .not.toContain("push to staging")
    expect(readRepoFile("resource-worker", "README.md"))
      .toContain("This Worker has only production and development")
  })

  it("uses explicit environments and live checks in every local deploy command", () => {
    const rootPackage = JSON.parse(readRepoFile("package.json")) as {
      scripts?: Record<string, string>
    }
    const scripts = rootPackage.scripts ?? {}

    for (const [target, environment, branch] of [
      ["aquilla", "production", "main"],
      ["aquilla:dev", "development", "dev"],
    ] as const) {
      for (const [surface, manifestSurface] of [
        ["spa", "web"],
        ["sync", "sync"],
        ["auth", "identity"],
      ] as const) {
        const command = scripts[`deploy:${target}:${surface}`]
        expect(command).toContain(`bash scripts/verify-deploy-branch.sh ${branch}`)
        expect(command).toContain(`cloudflare-version-deploy.mjs ${manifestSurface} ${environment}`)
        expect(command).toContain(`verify-live-environment.mjs ${environment} --surface=${surface}`)
      }
    }

    expect(scripts["verify:live:production"]).toContain("verify-live-environment.mjs production")
    expect(scripts["verify:live:development"]).toContain("verify-live-environment.mjs development")
    expect(scripts["verify:deployment-artifacts"]).toBe("node scripts/verify-deployment-artifacts.mjs dist")
    expect(scripts["prepare:pages-deployment-artifacts"])
      .toBe("node scripts/verify-deployment-artifacts.mjs dist --pages")
    expect(scripts["verify:live:staging"]).toBeUndefined()
    expect(Object.keys(scripts).some((name) => name.includes(":staging"))).toBe(false)

    expect(scripts["deploy:aquilla:spa"]).toContain("cloudflare-version-deploy.mjs web production")
    expect(scripts["deploy:aquilla:sync"]).toContain("cloudflare-version-deploy.mjs sync production")
    expect(scripts["deploy:aquilla:auth"]).toContain("cloudflare-version-deploy.mjs identity production")

    for (const brand of ["codex", "honeycomb", "context"]) {
      const command = scripts[`deploy:${brand}`]
      expect(command).toContain("pnpm run prepare:pages-deployment-artifacts")
      expect(command.indexOf("prepare:pages-deployment-artifacts"))
        .toBeLessThan(command.indexOf("wrangler pages deploy dist"))
    }

    const workersWorkflow = readRepoFile(".github", "workflows", "deploy-workers.yml")
    expect(workersWorkflow).toContain("pnpm run deploy:aquilla:dev:spa")
    expect(workersWorkflow).toContain("pnpm run deploy:aquilla:dev:sync")
    expect(workersWorkflow).toContain("pnpm run deploy:aquilla:dev:auth")
    expect(workersWorkflow).not.toContain("staging")
    const webWorkflow = readRepoFile(".github", "workflows", "ci.yml")
    expect(webWorkflow).not.toContain("node scripts/cloudflare-version-deploy.mjs web")
  })

  it("keeps Workers Builds and manual CI on explicit environments", () => {
    const workflow = readRepoFile(".github", "workflows", "ci.yml")
    const liveDeployer = readRepoFile("scripts", "cloudflare-version-deploy.mjs")
    const workersBuild = readRepoFile("scripts", "cloudflare-build-deploy.mjs")
    const workersBuildScript = readRepoFile("scripts", "ci-build.sh")
    const buildJobStart = workflow.indexOf("  build:")
    const buildJobHeader = workflow.slice(
      buildJobStart,
      workflow.indexOf("    steps:", buildJobStart),
    )

    expect(workflow).toContain("bash scripts/verify-dist-host.sh \"${{ needs.target.outputs.api_host }}\"")
    expect(workflow).toContain("node scripts/verify-deployment-artifacts.mjs dist")
    expect(workflow).toContain("include-hidden-files: true")
    expect(workflow).toContain("run: bash scripts/resolve-deployment-target.sh")
    expect(workflow).not.toContain("node scripts/cloudflare-version-deploy.mjs web")
    expect(workflow).toContain("name: ${{ needs.target.outputs.github_environment }}")
    expect(buildJobHeader).toContain("env:")
    expect(buildJobHeader).toContain("VITE_SYNC_WORKER_HOST:")
    expect(buildJobHeader).toContain("VITE_AUTH_BASE:")
    expect(buildJobHeader).toContain("VITE_CHAT_BASE:")
    expect(workflow.match(/VITE_AUTH_BASE:/g)).toHaveLength(1)
    expect(liveDeployer).toContain("if (surface === \"web\") verifyArtifacts(join(expectation.directory, \"dist\"))")
    expect(workersBuild).toContain("normalizedBranch === \"main\" ? \"production\" : \"development\"")
    expect(workersBuild).toContain("promote: false")
    expect(workersBuildScript).toContain("main) H=api.aquilla.app")
    expect(workersBuildScript).toContain("*) H=api.dev.aquilla.app")
    expect(workersBuildScript).toContain("verify-deployment-artifacts.mjs dist")
  })

  it("runs the former required PR gates on Cloudflare infrastructure", () => {
    const rootPackage = JSON.parse(readRepoFile("package.json")) as {
      scripts?: Record<string, string>
    }
    const command = rootPackage.scripts?.["build:workers-build"] ?? ""

    expect(command).toContain("pnpm lint")
    expect(command).toContain("pnpm test")
    expect(command).toContain("playwright install --with-deps chromium")
    expect(command).toContain("pnpm test:idml")
    expect(command).toContain("pnpm neon:check")
    expect(command).toContain("npm --prefix agent-worker run type-check")
    expect(command).toContain("npm --prefix agent-worker test")
    expect(command).toContain("scripts/ci-build.sh")
  })

  it("keeps all live deployments off automatic push triggers", () => {
    const ciWorkflow = readRepoFile(".github", "workflows", "ci.yml")
    const workerWorkflow = readRepoFile(".github", "workflows", "deploy-workers.yml")
    const ciTriggers = ciWorkflow.slice(
      ciWorkflow.indexOf("\non:"),
      ciWorkflow.indexOf("\nconcurrency:"),
    )
    const workerTriggers = workerWorkflow.slice(
      workerWorkflow.indexOf("\non:"),
      workerWorkflow.indexOf("\npermissions:"),
    )

    expect(ciWorkflow).not.toContain("cloudflare-version-deploy.mjs")
    expect(ciTriggers).not.toContain("push:")
    expect(ciTriggers).not.toContain("pull_request:")
    expect(ciTriggers).toContain("workflow_dispatch:")
    expect(workerTriggers).not.toContain("push:")
    expect(workerTriggers).toContain("workflow_dispatch:")
  })

  it("keeps GitHub CI available only by explicit dispatch", () => {
    const workflow = readRepoFile(".github", "workflows", "ci.yml")
    const triggers = workflow.slice(workflow.indexOf("\non:"), workflow.indexOf("\nconcurrency:"))

    expect(triggers).not.toContain("paths-ignore")
    expect(triggers).not.toContain("paths:")
    expect(triggers).not.toContain("pull_request:")
    expect(triggers).not.toContain("push:")
    expect(triggers).toContain("workflow_dispatch:")
  })

  it("fails worker-suite change detection open for shared deployment inputs", () => {
    const workflow = readRepoFile(".github", "workflows", "ci.yml")
    const changesJob = workflow.slice(workflow.indexOf("  changes:"), workflow.indexOf("  lint:"))

    expect(changesJob).toContain("No usable diff base; running every worker suite")
    expect(changesJob).toContain("node scripts/resolve-worker-test-scope.mjs --all")
    expect(changesJob).toContain("node scripts/resolve-worker-test-scope.mjs")
  })

  it("installs root and worker dependencies before deployable worker checks", () => {
    const workflow = readRepoFile(".github", "workflows", "deploy-workers.yml")

    for (const [worker, nextWorker] of [
      ["sync-worker", "auth-worker"],
      ["auth-worker", null],
    ] as const) {
      const jobStart = workflow.indexOf(`  ${worker}:`)
      const nextJob = nextWorker === null ? -1 : workflow.indexOf(`\n  ${nextWorker}:`, jobStart)
      const job = workflow.slice(jobStart, nextJob === -1 ? undefined : nextJob)
      expect(job.match(/run: pnpm install --frozen-lockfile/g)).toHaveLength(2)
      expect(job).toContain(`working-directory: ${worker}`)
    }
  })

  it("installs Chromium before running IDML browser conformance in CI", () => {
    const workflow = readRepoFile(".github", "workflows", "ci.yml")
    const installBrowser = workflow.indexOf("pnpm exec playwright install --with-deps chromium")
    const runIdmlTests = workflow.indexOf("pnpm test:idml")

    expect(installBrowser).toBeGreaterThan(-1)
    expect(runIdmlTests).toBeGreaterThan(installBrowser)
  })
})
