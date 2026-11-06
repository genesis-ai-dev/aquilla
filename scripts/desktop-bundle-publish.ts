// Publishes the built SPA (dist/) as a signed desktop hot bundle to R2.
// Runs at the end of `deploy:aquilla`, after tag-release.sh, so the calver tag
// on HEAD is the bundle version. Spec: docs/superpowers/specs/2026-11-05-desktop-hot-bundle.md.
//
//   tsx scripts/desktop-bundle-publish.ts production
//   tsx scripts/desktop-bundle-publish.ts development --dry-run [--dist <dir>]
//
// Exit codes: a missing DESKTOP_BUNDLE_SIGNING_KEY is a ::warning:: and exit 0
// (the web release must not break before the key exists); every other failure
// is non-zero.

import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  bundleObjectKey,
  bundleUrl,
  manifestObjectKey,
  MANIFEST_SCHEMA,
  parseDesktopBundleArgs,
  pickCalverTag,
  readMinShellVersion,
  resolveSigningKey,
  sha256File,
  signManifest,
  SIGNING_KEY_ENV,
  tarArgs,
  wranglerPutArgs,
  type ManifestFields,
} from "./lib/desktop-bundle"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const log = (message: string): void => console.log(`[desktop:bundle] ${message}`)

function fail(message: string): never {
  console.error(`[desktop:bundle] ${message}`)
  process.exit(1)
}

function git(args: string[]): string {
  const result = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" })
  if (result.status !== 0) fail(`git ${args.join(" ")} failed: ${result.stderr}`)
  return result.stdout
}

function run(command: string, args: string[], cwd: string): void {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", env: process.env })
  if (result.error) fail(`failed to start ${command}: ${result.error.message}`)
  if ((result.status ?? 1) !== 0) fail(`${command} ${args.join(" ")} exited ${result.status}`)
}

async function main(): Promise<void> {
  let args
  try {
    args = parseDesktopBundleArgs(process.argv.slice(2))
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }
  const { env, dryRun } = args
  const dist = path.resolve(repoRoot, args.dist)
  if (!existsSync(path.join(dist, "index.html"))) {
    fail(`${dist}/index.html does not exist; build the SPA first`)
  }

  const signing = resolveSigningKey(process.env[SIGNING_KEY_ENV], dryRun)
  if (signing.kind === "skip") {
    console.log(signing.warning)
    return
  }
  if (signing.kind === "ephemeral") {
    log(`${SIGNING_KEY_ENV} is unset; dry run signs with an EPHEMERAL key (pubkey ${signing.publicKeyHex}). No shell will accept this manifest.`)
  }

  const sha = git(["rev-parse", "HEAD"]).trim()
  let version = pickCalverTag(git(["tag", "--points-at", "HEAD", "--list", "20*"]))
  if (!version) {
    if (!dryRun) fail("HEAD carries no calver tag (YYYY.MM.DD.NN); run after scripts/tag-release.sh")
    version = `0000.00.00.00-dryrun-${sha.slice(0, 7)}`
    log(`HEAD carries no calver tag; dry run uses ${version}`)
  }
  const minShellVersion = readMinShellVersion(
    readFileSync(path.join(repoRoot, "src-tauri/tauri.conf.json"), "utf8"),
  )

  const work = mkdtempSync(path.join(tmpdir(), "aquilla-desktop-bundle-"))
  try {
    const tarball = path.join(work, "bundle.tar.gz")
    log(`archiving ${dist} → ${tarball}`)
    run("tar", tarArgs(tarball), dist)
    const { sha256, size } = await sha256File(tarball)

    const fields: ManifestFields = {
      schema: MANIFEST_SCHEMA,
      version,
      sha,
      url: bundleUrl(env, version),
      sha256,
      size,
      minShellVersion,
      createdAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    }
    const manifest = signManifest(fields, signing.privateKeyPem)
    const manifestPath = path.join(work, "latest.json")
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    log(`manifest:\n${JSON.stringify(manifest, null, 2)}`)

    if (dryRun) {
      log(`dry run: not uploading to ${bundleObjectKey(env, version)} / ${manifestObjectKey(env)}`)
      return
    }
    for (const name of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]) {
      if (!process.env[name]) fail(`${name} is required to upload to R2`)
    }
    const wrangler = path.join(repoRoot, "node_modules/.bin/wrangler")
    // The bundle first, the manifest last: a manifest never points at a missing object.
    run(wrangler, wranglerPutArgs(bundleObjectKey(env, version), tarball, "application/gzip"), repoRoot)
    run(wrangler, wranglerPutArgs(manifestObjectKey(env), manifestPath, "application/json"), repoRoot)
    log(`published ${version} to ${env}`)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

main().catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)))
