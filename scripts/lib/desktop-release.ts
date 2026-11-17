// Pure helpers for the desktop shell release line: deciding when to cut a
// release (scripts/desktop-release-cut.ts) and proving a built release is
// complete and signed before installed apps are offered it
// (scripts/desktop-release-verify.ts). The rules are in docs/DESKTOP-RELEASES.md.

import { createHash, createPublicKey, verify } from "node:crypto"

/** The four files that carry the product version (scripts/app-version.test.ts). */
export const VERSION_FILES = [
  "src-tauri/tauri.conf.json",
  "src-tauri/Cargo.toml",
  "src-tauri/Cargo.lock",
  "package.json",
] as const
export type VersionFile = (typeof VERSION_FILES)[number]

/** A change under one of these paths is a change to what the shell binary does. */
export const SHELL_PATHS = ["src-tauri/"] as const

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/

export function nextPatchVersion(version: string): string {
  const m = SEMVER.exec(version)
  if (!m) throw new Error(`version '${version}' is not MAJOR.MINOR.PATCH`)
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`
}

export type CutPlan =
  /** dev's version has no tag yet: tag it. Covers a bump merged by hand too. */
  | { action: "tag"; version: string; reason: string }
  /** The shell changed since the last release and nothing is in flight: open the bump. */
  | { action: "bump"; from: string; to: string; changed: string[]; reason: string }
  | { action: "none"; reason: string }

export interface CutInputs {
  /** `version` in src-tauri/tauri.conf.json at dev's head. */
  headVersion: string
  /** Versions that already have a `v*` tag, without the `v`. */
  taggedVersions: readonly string[]
  /** Paths changed between the tag of `headVersion` and dev's head; unused when that tag is missing. */
  changedSinceTag: readonly string[]
  /** An open bump pull request already exists. */
  bumpPrOpen: boolean
}

/**
 * One release in flight at a time, in this order: an untagged version on dev
 * is a release somebody asked for, so it is tagged before anything else is
 * considered; only a shell change earns a new version.
 */
export function planCut(inputs: CutInputs): CutPlan {
  const { headVersion, taggedVersions, changedSinceTag, bumpPrOpen } = inputs
  if (!SEMVER.test(headVersion)) throw new Error(`version '${headVersion}' is not MAJOR.MINOR.PATCH`)
  if (!taggedVersions.includes(headVersion)) {
    return { action: "tag", version: headVersion, reason: `dev is at ${headVersion} and v${headVersion} does not exist` }
  }
  const changed = changedSinceTag.filter((p) => SHELL_PATHS.some((prefix) => p.startsWith(prefix)))
  if (changed.length === 0) {
    return { action: "none", reason: `no shell change since v${headVersion}` }
  }
  if (bumpPrOpen) {
    return { action: "none", reason: "a version bump pull request is already open" }
  }
  return {
    action: "bump",
    from: headVersion,
    to: nextPatchVersion(headVersion),
    changed,
    reason: `${changed.length} shell file(s) changed since v${headVersion}`,
  }
}

/**
 * Rewrite one version file. Throws unless exactly one copy of the old version
 * was found where that file keeps it, so a format change fails the cut instead
 * of releasing a shell whose copies disagree.
 */
export function bumpVersionFile(file: VersionFile, text: string, from: string, to: string): string {
  const patterns: Record<VersionFile, RegExp> = {
    "src-tauri/tauri.conf.json": new RegExp(`^(\\s*"version":\\s*")${escapeRe(from)}(")`, "m"),
    "package.json": new RegExp(`^(\\s*"version":\\s*")${escapeRe(from)}(")`, "m"),
    "src-tauri/Cargo.toml": new RegExp(`^(\\[package\\][^[]*?^version\\s*=\\s*")${escapeRe(from)}(")`, "ms"),
    "src-tauri/Cargo.lock": new RegExp(`^(name = "app"\\nversion = ")${escapeRe(from)}(")`, "m"),
  }
  const pattern = patterns[file]
  if (!pattern.test(text)) throw new Error(`${file}: version ${from} not found where it is expected`)
  return text.replace(pattern, `$1${to}$2`)
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

// ── What a complete release looks like ──────────────────────────────────────

/**
 * Updater targets every release must carry. An installed app asks for exactly
 * one of these keys; a release that lacks one leaves that platform's users on
 * the old shell with no error anywhere (v0.2.4 was first published without
 * either macOS key, after Apple's notary service failed one build).
 */
export const REQUIRED_PLATFORMS = ["darwin-aarch64", "darwin-x86_64", "windows-x86_64", "linux-x86_64"] as const

export interface UpdaterManifest {
  version: string
  platforms: Record<string, { signature: string; url: string }>
}

export function parseUpdaterManifest(json: string): UpdaterManifest {
  const parsed: unknown = JSON.parse(json)
  const m = parsed as Partial<UpdaterManifest> | null
  if (!m || typeof m.version !== "string" || typeof m.platforms !== "object" || m.platforms === null) {
    throw new Error("latest.json has no `version` or no `platforms`")
  }
  for (const [key, p] of Object.entries(m.platforms)) {
    if (typeof p?.signature !== "string" || typeof p?.url !== "string") {
      throw new Error(`latest.json platform ${key} has no signature or url`)
    }
  }
  return m as UpdaterManifest
}

/** Problems that must stop a release from being promoted; empty when it is complete. */
export function manifestProblems(manifest: UpdaterManifest, tag: string): string[] {
  const problems: string[] = []
  const expected = tag.replace(/^v/, "")
  if (manifest.version !== expected) problems.push(`latest.json is version ${manifest.version}, the tag is ${tag}`)
  for (const key of REQUIRED_PLATFORMS) {
    if (!manifest.platforms[key]) problems.push(`latest.json has no ${key} entry: that platform would never be offered this release`)
  }
  return problems
}

// ── Updater signatures (minisign, as the Tauri updater checks them) ─────────

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex")

function minisignLines(base64Text: string, what: string): string[] {
  const lines = Buffer.from(base64Text, "base64").toString("utf8").split(/\r?\n/).filter((l) => l.length > 0)
  if (lines.length < 2 || !lines[0].startsWith("untrusted comment:")) throw new Error(`${what} is not a minisign file`)
  return lines
}

/**
 * True when `signature` (a latest.json `signature`, which is also the content
 * of the asset's `.sig` file) is a valid signature of `file` by `pubkey`
 * (`plugins.updater.pubkey` in tauri.conf.json). This is the check an
 * installed app makes before it installs an update, so a release that fails it
 * here would be refused by every app.
 */
export function verifyUpdaterSignature(file: Buffer, signature: string, pubkey: string): boolean {
  const pubLines = minisignLines(pubkey, "the updater public key")
  const pub = Buffer.from(pubLines[1], "base64")
  if (pub.length !== 42) throw new Error("the updater public key has the wrong length")
  const sigLines = minisignLines(signature, "the signature")
  const sig = Buffer.from(sigLines[1], "base64")
  if (sig.length !== 74) throw new Error("the signature has the wrong length")
  if (!sig.subarray(2, 10).equals(pub.subarray(2, 10))) return false // signed by another key

  const algorithm = sig.subarray(0, 2).toString("latin1")
  const message = algorithm === "ED" ? createHash("blake2b512").update(file).digest() : algorithm === "Ed" ? file : null
  if (!message) throw new Error(`unknown minisign algorithm '${algorithm}'`)
  const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, pub.subarray(10)]), format: "der", type: "spki" })
  if (!verify(null, message, key, sig.subarray(10))) return false

  // The trusted comment (it carries the file name) is signed too.
  const trusted = sigLines[2]?.startsWith("trusted comment: ") ? sigLines[2].slice("trusted comment: ".length) : null
  const globalSig = sigLines[3] ? Buffer.from(sigLines[3], "base64") : null
  if (trusted === null || !globalSig) return false
  return verify(null, Buffer.concat([sig.subarray(10), Buffer.from(trusted, "utf8")]), key, globalSig)
}
