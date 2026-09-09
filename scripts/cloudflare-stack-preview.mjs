import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { workersBuildMetadata } from "./assert-workers-build-env.mjs"
import { runCommand, workersBuildPreviewAlias } from "./cloudflare-pr-preview.mjs"
import { parseWranglerOutput } from "./cloudflare-version-deploy.mjs"
import { assertSafeDeploymentArtifacts } from "./verify-deployment-artifacts.mjs"

export const PREVIEW_WORKERS = {
  web: "aquilla-web-preview",
  auth: "aquilla-auth-preview",
  sync: "aquilla-sync-preview",
}
const UNREADY = "https://preview-not-ready.invalid"

// Deliberately independent of production Wrangler profiles. Runtime secrets
// come from each parent's Previews Base, never from local .dev.vars files.
export function previewConfig(surface, { cwd, urls = {} }) {
  const name = PREVIEW_WORKERS[surface]
  if (!name) throw new Error(`Unknown preview surface: ${surface}`)
  const config = {
    name,
    account_id: "6a80496d1e59948a9cbaa3c643ba81d7",
    main: resolve(cwd, surface === "web" ? "worker/index.ts" : `${surface === "auth" ? "auth" : "sync"}-worker/src/index.ts`),
    compatibility_date: surface === "web" ? "2025-05-01" : "2024-12-01",
    compatibility_flags: surface === "web" ? [] : ["nodejs_compat"],
    workers_dev: true,
    preview_urls: true,
    previews: { observability: { enabled: true } },
  }
  if (surface === "web") {
    config.assets = { directory: resolve(cwd, "dist"), binding: "ASSETS", not_found_handling: "single-page-application" }
    return config
  }
  config.previews.hyperdrive = [{ binding: "HYPERDRIVE", id: "53581197ff7a4202a5ed0ef08537d4a6" }]
  config.previews.r2_buckets = [{ binding: "SNAPSHOTS", bucket_name: "aquilla-snapshots-dev" }]
  config.previews.version_metadata = { binding: "CF_VERSION_METADATA" }
  config.previews.vars = {
    ENVIRONMENT: "development",
    DEPLOYMENT_WORKER_NAME: name,
    BASE_URL: urls.web ?? UNREADY,
  }
  if (surface === "auth") {
    Object.assign(config.previews.vars, {
      ALGORITHM: "HS256",
      ACCESS_TOKEN_EXPIRE_MINUTES: "43200",
      SYNC_WORKER_URL: urls.sync ? `${urls.sync}/sync` : UNREADY,
      LEGACY_USER_MIGRATION_ENABLED: "false",
      ADMIN_REQUIRE_ELEVATION: "true",
      DEFAULT_LLM_MODEL: "openai/gpt-5.6-luna",
    })
  } else {
    config.previews.vars.AUTH_WORKER_URL = urls.auth ? `${urls.auth}/identity` : UNREADY
    config.previews.durable_objects = { bindings: [{ name: "ProjectSync", class_name: "ProjectSync" }] }
    config.migrations = [
      { tag: "v1", new_sqlite_classes: ["FileSync"] },
      { tag: "v2", new_sqlite_classes: ["ProjectSync"] },
    ]
  }
  return config
}

export function previewOrigin(entry, surface, name) {
  if (entry.worker_name !== PREVIEW_WORKERS[surface] || entry.preview_name !== name || !entry.deployment_id) {
    throw new Error(`Unexpected ${surface} preview deployment identity`)
  }
  const value = entry.preview_urls?.[0]
  if (!value) throw new Error(`Enable Preview Deployments URLs for ${PREVIEW_WORKERS[surface]}`)
  const url = new URL(value)
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash
      || !(url.hostname.endsWith(".workers.dev") || url.hostname.endsWith(".cloudflare.app"))) {
    throw new Error(`Unexpected ${surface} preview URL`)
  }
  return url.origin
}

export async function deployStackPreview({ cwd = process.cwd(), env = process.env, run = runCommand, verify = assertSafeDeploymentArtifacts } = {}) {
  const { branch, commitSha } = workersBuildMetadata(env)
  const name = workersBuildPreviewAlias(branch)
  const temp = mkdtempSync(join(tmpdir(), "aquilla-stack-preview-"))
  const urls = {}
  let deploymentIndex = 0
  const deploy = async (surface) => {
    const configPath = join(temp, `${surface}.json`)
    const outputPath = join(temp, `${deploymentIndex++}.ndjson`)
    writeFileSync(configPath, JSON.stringify(previewConfig(surface, { cwd, urls })))
    await run("pnpm", ["exec", "wrangler", "preview", "--config", configPath,
      "--name", name, "--tag", commitSha, "--message", `Branch ${branch} @ ${commitSha}`], {
      cwd, env: { ...env, WRANGLER_OUTPUT_FILE_PATH: outputPath },
    })
    const origin = previewOrigin(parseWranglerOutput(readFileSync(outputPath, "utf8"), "preview"), surface, name)
    if (urls[surface] && urls[surface] !== origin) throw new Error(`${surface} preview URL changed during deployment`)
    urls[surface] = origin
  }
  try {
    for (const surface of ["auth", "sync"]) {
      const configPath = join(temp, `${surface}.json`)
      writeFileSync(configPath, JSON.stringify(previewConfig(surface, { cwd, urls })))
      const result = await run("pnpm", ["exec", "wrangler", "preview", "base-config", "secret", "list",
        "--config", configPath, "--json"], { cwd, env })
      const names = new Set(JSON.parse(result.stdout).map((secret) => secret.name))
      const required = surface === "auth" ? ["SECRET_KEY", "SYNC_SECRET_KEY", "ADMIN_SECRET"] : ["SYNC_SECRET_KEY", "ADMIN_SECRET"]
      const missing = required.filter((key) => !names.has(key))
      if (missing.length) throw new Error(`${PREVIEW_WORKERS[surface]} Previews Base is missing: ${missing.join(", ")}`)
    }
    // Discover real Cloudflare URLs rather than guessing beta hostname formats.
    // Cross-service callbacks fail closed until all three previews are wired.
    await deploy("auth")
    await deploy("sync")
    const buildEnv = {
      ...env,
      VITE_AUTH_BASE: `${urls.auth}/identity`,
      VITE_CHAT_BASE: `${urls.auth}/chat`,
      VITE_SYNC_WORKER_HOST: `${new URL(urls.sync).host}/sync`,
    }
    await run("pnpm", ["exec", "vite", "build"], { cwd, env: buildEnv })
    rmSync(join(cwd, "dist", "_redirects"), { force: true })
    verify(join(cwd, "dist"))
    await deploy("web")
    await deploy("auth")
    await deploy("sync")
    console.log(`[cloudflare-preview] branch=${branch} commit=${commitSha} app=${urls.web} auth=${urls.auth} sync=${urls.sync}`)
    return { name, urls }
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  deployStackPreview().catch((error) => {
    console.error(`[cloudflare-preview] ${error.message}`)
    process.exitCode = 1
  })
}
