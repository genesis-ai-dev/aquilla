import { mkdtempSync, readFileSync, rmSync } from "node:fs"
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
  // GitHub Actions no longer deploys. Cloudflare Workers Builds owns every
  // deploy, one connection per Worker script, with non-production branch builds
  // disabled so only that connection's own branch can touch its Workers. What
  // Actions still owns is gating a pull request, on an allowance this repo
  // exhausts in about a week — so the workflow must stay lean and must not
  // regrow a deploy path.
  it("keeps GitHub Actions out of deployment", () => {
    const workflows = readRepoFile(".github", "workflows", "ci.yml")

    expect(workflows).not.toContain("wrangler")
    expect(workflows).not.toContain("CLOUDFLARE_API_TOKEN")
    expect(workflows).not.toContain("versions upload")

    // pull_request only: a push trigger would re-run checks the PR already
    // paid for, and Cloudflare re-runs type-check and the worker suites before
    // it deploys either environment.
    const triggers = workflows.slice(
      workflows.indexOf("\non:"),
      workflows.indexOf("\nconcurrency:"),
    )
    expect(triggers).toContain("pull_request:")
    expect(triggers).not.toContain("push:")

    // A required status check filtered out by a paths filter never reports,
    // and the PR can never merge.
    expect(triggers).not.toContain("paths-ignore")
    expect(triggers).not.toContain("paths:")
    for (const job of ["  lint:", "  typecheck:", "  unit:", "  build:"]) {
      expect(workflows).toContain(job)
    }
  })

  it("retires the workflows Cloudflare replaced", () => {
    for (const gone of ["deploy.yml", "deploy-workers.yml", "web-ci.yml", "staging-neon-refresh.yml"]) {
      expect(() => readRepoFile(".github", "workflows", gone)).toThrow()
    }
  })

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

  it("keeps the documented environment matrix synchronized with the executable contract", () => {
    const matrix = readRepoFile("docs", "DEPLOYMENT-ENVIRONMENTS.md")

    for (const row of [
      "| Production | `main` | `production` | `https://aquilla.app` | `api.aquilla.app` | `aquilla-web` | `aquilla-identity` | `aquilla-sync-worker` | `production` | `aquilla-snapshots` |",
      "| Development | `dev` | `development` | `https://dev.aquilla.app` | `api.dev.aquilla.app` | `aquilla-web-development` | `aquilla-dev-identity` | `aquilla-sync-worker-dev` | `dev` | `aquilla-snapshots-dev` |",
    ]) {
      expect(matrix).toContain(row)
    }

    // The doc must name every Workers Builds connection, because a connection
    // is bound to one script and the binding is the only thing stopping a
    // branch build from writing to the wrong Worker.
    for (const worker of [
      "aquilla-web", "aquilla-identity", "aquilla-sync-worker",
      "aquilla-web-development", "aquilla-dev-identity", "aquilla-sync-worker-dev",
    ]) {
      expect(matrix).toContain(`\`${worker}\``)
    }
    expect(matrix).toContain("builds for non-production branches disabled")
    expect(matrix).toContain("All unnamed Wrangler profiles are local-only")

    expect(readRepoFile("README.md")).toContain("docs/DEPLOYMENT-ENVIRONMENTS.md")
    expect(readRepoFile("docs", "runbooks", "cloudflare-workers-builds.md"))
      .toContain("../DEPLOYMENT-ENVIRONMENTS.md")
    // Two live environments, no more. A reintroduced staging row would
    // silently diverge from the Wrangler profiles and the manifest.
    expect(matrix).not.toContain("api.staging.aquilla.app")
    expect(matrix).not.toContain("--env=staging")
  })

  it("uses explicit environments and live checks in every local deploy command", () => {
    const rootPackage = JSON.parse(readRepoFile("package.json")) as {
      scripts?: Record<string, string>
    }
    const scripts = rootPackage.scripts ?? {}

    for (const [target, environment] of [
      ["aquilla", "production"],
      ["aquilla:dev", "development"],
    ] as const) {
      for (const [surface, manifestSurface] of [
        ["spa", "web"],
        ["sync", "sync"],
        ["auth", "identity"],
      ] as const) {
        const command = scripts[`deploy:${target}:${surface}`]
        expect(command).toContain(`cloudflare-version-deploy.mjs ${manifestSurface} ${environment}`)
        expect(command).toContain(`verify-live-environment.mjs ${environment} --surface=${surface}`)
      }
    }

    expect(scripts["verify:live:production"]).toContain("verify-live-environment.mjs production")
    expect(scripts["verify:live:development"]).toContain("verify-live-environment.mjs development")

    expect(scripts["deploy:aquilla:spa"]).toContain("cloudflare-version-deploy.mjs web production")
    expect(scripts["deploy:aquilla:sync"]).toContain("cloudflare-version-deploy.mjs sync production")
    expect(scripts["deploy:aquilla:auth"]).toContain("cloudflare-version-deploy.mjs identity production")
  })

  it("installs Chromium before running IDML browser conformance", () => {
    const workflow = readRepoFile(".github", "workflows", "ci.yml")
    const installBrowser = workflow.indexOf("pnpm exec playwright install --with-deps chromium")
    const runIdmlTests = workflow.indexOf("pnpm test:idml")

    expect(installBrowser).toBeGreaterThan(-1)
    expect(runIdmlTests).toBeGreaterThan(installBrowser)
  })
})
