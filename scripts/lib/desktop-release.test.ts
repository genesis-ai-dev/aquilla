import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto"
import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import {
  bumpVersionFile,
  manifestProblems,
  nextPatchVersion,
  parseUpdaterManifest,
  planCut,
  REQUIRED_PLATFORMS,
  VERSION_FILES,
  verifyUpdaterSignature,
} from "./desktop-release"

const root = path.resolve(import.meta.dirname, "../..")

// A shell fix reaches users only in a new shell release: the hourly web
// updates never carry Rust code. The Paratext 10 registration fix sat merged
// and unreleased for four days because cutting a release was a thing someone
// had to remember. These rules are what now decides it.
describe("planCut", () => {
  const base = { headVersion: "0.2.4", taggedVersions: ["0.2.3", "0.2.4"], changedSinceTag: [], bumpPrOpen: false }

  it("opens a bump when the shell changed since the last release", () => {
    const plan = planCut({ ...base, changedSinceTag: ["src/App.tsx", "src-tauri/src/paratext.rs"] })
    expect(plan).toMatchObject({ action: "bump", from: "0.2.4", to: "0.2.5", changed: ["src-tauri/src/paratext.rs"] })
  })

  it("does nothing for web-only changes, which hot bundles already deliver", () => {
    expect(planCut({ ...base, changedSinceTag: ["src/App.tsx", "docs/SYNC.md", "package.json"] }).action).toBe("none")
  })

  it("tags a version on dev that has no tag, however the bump got there", () => {
    // A bump merged by hand (as 0.2.4 was) must release without a second manual step.
    const plan = planCut({ ...base, headVersion: "0.2.5", changedSinceTag: ["src-tauri/src/lib.rs"] })
    expect(plan).toMatchObject({ action: "tag", version: "0.2.5" })
  })

  it("never opens a second bump while one is waiting to merge", () => {
    const plan = planCut({ ...base, changedSinceTag: ["src-tauri/src/lib.rs"], bumpPrOpen: true })
    expect(plan.action).toBe("none")
  })

  it("refuses a version it cannot increment", () => {
    expect(() => planCut({ ...base, headVersion: "0.2.4-beta" })).toThrow(/MAJOR\.MINOR\.PATCH/)
    expect(nextPatchVersion("1.9.9")).toBe("1.9.10")
  })
})

// scripts/app-version.test.ts fails CI when the copies disagree; the bump has
// to move all of them, in the repo's real files, or its own PR goes red.
describe("bumpVersionFile", () => {
  it("moves every version copy in the real files and nothing else", () => {
    const shell = (JSON.parse(readFileSync(path.join(root, "src-tauri/tauri.conf.json"), "utf8")) as { version: string }).version
    const next = nextPatchVersion(shell)
    for (const file of VERSION_FILES) {
      const before = readFileSync(path.join(root, file), "utf8")
      const after = bumpVersionFile(file, before, shell, next)
      const changed = before.split("\n").filter((line, i) => line !== after.split("\n")[i])
      expect(changed, file).toHaveLength(1)
      expect(after, file).toContain(next)
    }
  })

  it("fails instead of leaving a copy behind when a file no longer holds the version", () => {
    expect(() => bumpVersionFile("src-tauri/Cargo.toml", '[package]\nname = "app"\nversion = "9.9.9"\n', "0.2.4", "0.2.5")).toThrow(/not found/)
  })

  it("leaves a dependency that happens to share the version alone", () => {
    const lock = 'name = "other"\nversion = "0.2.4"\n\n[[package]]\nname = "app"\nversion = "0.2.4"\n'
    expect(bumpVersionFile("src-tauri/Cargo.lock", lock, "0.2.4", "0.2.5")).toBe(
      'name = "other"\nversion = "0.2.4"\n\n[[package]]\nname = "app"\nversion = "0.2.5"\n',
    )
  })
})

// An installed app asks the update feed for its own platform key. A feed
// without that key is not an error to the app: it just never updates.
describe("manifestProblems", () => {
  const entry = { signature: "s", url: "u" }
  const full = { version: "0.2.5", platforms: Object.fromEntries(REQUIRED_PLATFORMS.map((k) => [k, entry])) }

  it("passes a release that carries every platform at the tagged version", () => {
    expect(manifestProblems(full, "v0.2.5")).toEqual([])
  })

  it("names each platform a partial release would strand", () => {
    // What v0.2.4 looked like after the Intel macOS build failed notarization.
    const { "darwin-aarch64": _a, "darwin-x86_64": _b, ...rest } = full.platforms
    const problems = manifestProblems({ ...full, platforms: rest }, "v0.2.5")
    expect(problems).toHaveLength(2)
    expect(problems.join("\n")).toMatch(/darwin-aarch64[\s\S]*darwin-x86_64/)
  })

  it("rejects a feed left over from another version", () => {
    expect(manifestProblems(full, "v0.2.6")[0]).toMatch(/0\.2\.5.*v0\.2\.6/)
  })

  it("rejects a feed that is not an updater manifest", () => {
    expect(() => parseUpdaterManifest('{"version":"0.2.5"}')).toThrow(/platforms/)
    expect(() => parseUpdaterManifest('{"version":"0.2.5","platforms":{"linux-x86_64":{"url":"u"}}}')).toThrow(/signature/)
  })
})

// The app installs an update only if this signature check passes, so a release
// whose files fail it would be downloaded and refused by every user.
describe("verifyUpdaterSignature", () => {
  const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64")
  const keyId = Buffer.from("0102030405060708", "hex")

  function minisignKey() {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519")
    const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32)
    const pubkey = b64(`untrusted comment: minisign public key\n${Buffer.concat([Buffer.from("Ed"), keyId, raw]).toString("base64")}\n`)
    return { pubkey, privateKey }
  }

  function minisign(file: Buffer, privateKey: KeyObject, comment = "timestamp:1\tfile:Aquilla.app.tar.gz", prehashed = true): string {
    const sig = sign(null, prehashed ? createHash("blake2b512").update(file).digest() : file, privateKey)
    const global = sign(null, Buffer.concat([sig, Buffer.from(comment, "utf8")]), privateKey)
    const line = Buffer.concat([Buffer.from(prehashed ? "ED" : "Ed"), keyId, sig]).toString("base64")
    return b64(`untrusted comment: signature from tauri secret key\n${line}\ntrusted comment: ${comment}\n${global.toString("base64")}\n`)
  }

  const file = Buffer.from("the bytes of an update archive")

  it("accepts a file signed by the release key, in both minisign modes", () => {
    const { pubkey, privateKey } = minisignKey()
    expect(verifyUpdaterSignature(file, minisign(file, privateKey), pubkey)).toBe(true)
    expect(verifyUpdaterSignature(file, minisign(file, privateKey, "c", false), pubkey)).toBe(true)
  })

  it("rejects a file that changed after it was signed", () => {
    const { pubkey, privateKey } = minisignKey()
    const signature = minisign(file, privateKey)
    expect(verifyUpdaterSignature(Buffer.from("the bytes of an update archivE"), signature, pubkey)).toBe(false)
  })

  it("rejects a signature made with any other key", () => {
    const signature = minisign(file, minisignKey().privateKey)
    expect(verifyUpdaterSignature(file, signature, minisignKey().pubkey)).toBe(false)
  })

  it("rejects a signature whose trusted comment was swapped", () => {
    const { pubkey, privateKey } = minisignKey()
    const lines = Buffer.from(minisign(file, privateKey), "base64").toString("utf8").split("\n")
    lines[2] = "trusted comment: timestamp:1\tfile:something-else.tar.gz"
    expect(verifyUpdaterSignature(file, b64(lines.join("\n")), pubkey)).toBe(false)
  })

  it("reads the public key the shell is built with", () => {
    const conf = JSON.parse(readFileSync(path.join(root, "src-tauri/tauri.conf.json"), "utf8")) as { plugins: { updater: { pubkey: string } } }
    // Not signed by it, but the key must parse: a malformed key would throw here.
    expect(verifyUpdaterSignature(file, minisign(file, minisignKey().privateKey), conf.plugins.updater.pubkey)).toBe(false)
  })
})
