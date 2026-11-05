// Pure helpers for the desktop hot-bundle publisher (scripts/desktop-bundle-publish.ts).
// The manifest format and the signing string are normative in
// docs/superpowers/specs/2026-11-05-desktop-hot-bundle.md; keep them in step with
// src-tauri/src/hot_bundle.rs, which verifies what this produces.

import { createHash, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto"
import { createReadStream, statSync } from "node:fs"

export const DESKTOP_BUNDLE_ENVS = ["production", "development"] as const
export type DesktopBundleEnv = (typeof DESKTOP_BUNDLE_ENVS)[number]

/** R2 bucket that holds `<env>/<version>/bundle.tar.gz` and `<env>/latest.json`. */
export const DESKTOP_BUNDLE_BUCKET = "aquilla-desktop-bundles"

/**
 * Public origin of the bucket. The custom domain is attached to the bucket in the
 * Cloudflare dashboard (R2 → aquilla-desktop-bundles → Settings → Custom domains);
 * nothing in this repo creates it. The shell fetches `<base>/<env>/latest.json`.
 */
export const DESKTOP_BUNDLE_PUBLIC_BASE = "https://desktop-bundles.aquilla.app"

/** Name of the repo secret holding the PKCS#8 PEM ed25519 private key. */
export const SIGNING_KEY_ENV = "DESKTOP_BUNDLE_SIGNING_KEY"

export const MANIFEST_SCHEMA = 1

export interface ManifestFields {
  schema: typeof MANIFEST_SCHEMA
  version: string
  sha: string
  url: string
  sha256: string
  size: number
  minShellVersion: string
  createdAt: string
}

export interface BundleManifest extends ManifestFields {
  signature: string
}

export interface PublishArgs {
  env: DesktopBundleEnv
  dryRun: boolean
  dist: string
}

export const DESKTOP_BUNDLE_USAGE =
  "usage: tsx scripts/desktop-bundle-publish.ts <production|development> [--dry-run] [--dist <dir>]"

export function parseDesktopBundleArgs(argv: string[]): PublishArgs {
  let env: DesktopBundleEnv | undefined
  let dryRun = false
  let dist = "dist"
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--dry-run") {
      dryRun = true
    } else if (arg === "--dist") {
      const value = argv[++i]
      if (!value) throw new Error(`--dist needs a directory\n${DESKTOP_BUNDLE_USAGE}`)
      dist = value
    } else if ((DESKTOP_BUNDLE_ENVS as readonly string[]).includes(arg)) {
      if (env) throw new Error(`environment given twice\n${DESKTOP_BUNDLE_USAGE}`)
      env = arg as DesktopBundleEnv
    } else {
      throw new Error(`unknown argument '${arg}'\n${DESKTOP_BUNDLE_USAGE}`)
    }
  }
  if (!env) throw new Error(`missing environment\n${DESKTOP_BUNDLE_USAGE}`)
  return { env, dryRun, dist }
}

export function bundleObjectKey(env: DesktopBundleEnv, version: string): string {
  return `${env}/${version}/bundle.tar.gz`
}

export function manifestObjectKey(env: DesktopBundleEnv): string {
  return `${env}/latest.json`
}

export function bundleUrl(env: DesktopBundleEnv, version: string): string {
  return `${DESKTOP_BUNDLE_PUBLIC_BASE}/${bundleObjectKey(env, version)}`
}

/**
 * Picks the calver tag on HEAD from `git tag --points-at HEAD --list '20*'` output.
 * Returns the highest by version sort, or null when HEAD carries none.
 */
export function pickCalverTag(gitTagOutput: string): string | null {
  const tags = gitTagOutput
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^20\d{2}\.\d{2}\.\d{2}\.\d{2}$/.test(line))
  if (tags.length === 0) return null
  tags.sort((a, b) => {
    const pa = a.split(".").map(Number)
    const pb = b.split(".").map(Number)
    for (let i = 0; i < pa.length; i++) {
      if (pa[i] !== pb[i]) return pa[i] - pb[i]
    }
    return 0
  })
  return tags[tags.length - 1]
}

/** `minShellVersion` is the shell's own `version` in src-tauri/tauri.conf.json. */
export function readMinShellVersion(tauriConfJson: string): string {
  const parsed: unknown = JSON.parse(tauriConfJson)
  if (
    typeof parsed !== "object" || parsed === null
    || typeof (parsed as { version?: unknown }).version !== "string"
  ) {
    throw new Error("src-tauri/tauri.conf.json has no string `version`")
  }
  const version = (parsed as { version: string }).version
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`src-tauri/tauri.conf.json version '${version}' is not MAJOR.MINOR.PATCH`)
  }
  return version
}

/** The spec's signing string: the eight fields joined by `\n`, no trailing newline. */
export function canonicalSigningString(fields: ManifestFields): string {
  return [
    String(fields.schema),
    fields.version,
    fields.sha,
    fields.url,
    fields.sha256,
    String(fields.size),
    fields.minShellVersion,
    fields.createdAt,
  ].join("\n")
}

export function signManifest(fields: ManifestFields, privateKey: KeyObject | string): BundleManifest {
  const signature = sign(null, Buffer.from(canonicalSigningString(fields), "utf8"), privateKey)
  return { ...fields, signature: signature.toString("base64") }
}

export function verifyManifest(manifest: BundleManifest, publicKey: KeyObject | string): boolean {
  const { signature, ...fields } = manifest
  return verify(
    null,
    Buffer.from(canonicalSigningString(fields), "utf8"),
    publicKey,
    Buffer.from(signature, "base64"),
  )
}

export interface Ed25519Keypair {
  /** PKCS#8 PEM — the value of the DESKTOP_BUNDLE_SIGNING_KEY secret. */
  privateKeyPem: string
  /** Raw 32-byte public key as lowercase hex — the value of AQUILLA_BUNDLE_PUBKEY. */
  publicKeyHex: string
  publicKey: KeyObject
}

/**
 * ed25519 keypair in the two encodings the pipeline needs. The SPKI DER of an
 * ed25519 public key is a fixed 12-byte prefix followed by the raw 32-byte key.
 */
export function generateBundleKeypair(): Ed25519Keypair {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519")
  const spki = publicKey.export({ type: "spki", format: "der" })
  if (spki.length !== 44) throw new Error(`unexpected ed25519 SPKI length ${spki.length}`)
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyHex: spki.subarray(12).toString("hex"),
    publicKey,
  }
}

export type SigningKeyDecision =
  | { kind: "provided"; privateKeyPem: string }
  | { kind: "ephemeral"; privateKeyPem: string; publicKeyHex: string }
  | { kind: "skip"; warning: string }

/**
 * Who signs. A missing secret must not fail the hourly web release before the
 * key exists, so without `--dry-run` it is a GitHub warning and a clean exit;
 * a dry run signs with a throwaway key so the manifest shape can still be checked.
 */
export function resolveSigningKey(
  envValue: string | undefined,
  dryRun: boolean,
  makeKeypair: () => Ed25519Keypair = generateBundleKeypair,
): SigningKeyDecision {
  const pem = envValue?.trim()
  if (pem) return { kind: "provided", privateKeyPem: pem }
  if (dryRun) {
    const { privateKeyPem, publicKeyHex } = makeKeypair()
    return { kind: "ephemeral", privateKeyPem, publicKeyHex }
  }
  return {
    kind: "skip",
    warning:
      `::warning::${SIGNING_KEY_ENV} is not set; skipping the desktop hot-bundle publish. `
      + "Generate one with `pnpm desktop:bundle:keygen` and add the private key as that repo secret.",
  }
}

/** Arguments for the `tar` CLI. Relative to `cwd` so the archive root is the dist root. */
export function tarArgs(outFile: string): string[] {
  // -C <dist> . puts index.html at the archive root, which the shell requires
  // after extraction. gzip output is not byte-reproducible across tar builds;
  // the manifest's sha256 is what the shell checks, so that is acceptable.
  return ["-czf", outFile, "."]
}

/** Arguments for `wrangler r2 object put` against the remote bucket. */
export function wranglerPutArgs(key: string, file: string, contentType: string): string[] {
  return [
    "r2", "object", "put", `${DESKTOP_BUNDLE_BUCKET}/${key}`,
    "--file", file,
    "--content-type", contentType,
    "--remote",
  ]
}

export async function sha256File(file: string): Promise<{ sha256: string; size: number }> {
  const hash = createHash("sha256")
  await new Promise<void>((resolve, reject) => {
    createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", resolve)
  })
  return { sha256: hash.digest("hex"), size: statSync(file).size }
}
