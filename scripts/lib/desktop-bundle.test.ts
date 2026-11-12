// @vitest-environment node
import { spawnSync } from "node:child_process"
import { createPublicKey, generateKeyPairSync } from "node:crypto"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  bundleUrl,
  canonicalSigningString,
  DESKTOP_BUNDLE_PUBLIC_BASE,
  generateBundleKeypair,
  MANIFEST_SCHEMA,
  parseDesktopBundleArgs,
  pickCalverTag,
  readMinShellVersion,
  resolveSigningKey,
  sha256File,
  signManifest,
  SIGNING_KEY_ENV,
  tarArgs,
  verifyManifest,
  wranglerPutArgs,
  type ManifestFields,
} from "./desktop-bundle"

const fields: ManifestFields = {
  schema: MANIFEST_SCHEMA,
  version: "2026.11.05.03",
  sha: "0123456789abcdef0123456789abcdef01234567",
  url: "https://desktop-bundles.aquilla.app/production/2026.11.05.03/bundle.tar.gz",
  sha256: "ab".repeat(32),
  size: 12345678,
  minShellVersion: "0.2.0",
  createdAt: "2026-11-05T19:00:00Z",
}

describe("canonical signing string", () => {
  // The shell rebuilds this string byte for byte before verifying; any drift in
  // field order or separators silently rejects every bundle.
  it("joins the eight spec fields in spec order with \\n and no trailing newline", () => {
    expect(canonicalSigningString(fields)).toBe(
      "1\n2026.11.05.03\n0123456789abcdef0123456789abcdef01234567\n"
      + "https://desktop-bundles.aquilla.app/production/2026.11.05.03/bundle.tar.gz\n"
      + `${"ab".repeat(32)}\n12345678\n0.2.0\n2026-11-05T19:00:00Z`,
    )
  })
})

describe("manifest signing", () => {
  it("round-trips through node:crypto verify with the PEM private key and the raw hex pubkey", () => {
    const { privateKeyPem, publicKeyHex, publicKey } = generateBundleKeypair()
    const manifest = signManifest(fields, privateKeyPem)

    expect(Object.keys(manifest)).toEqual([
      "schema", "version", "sha", "url", "sha256", "size", "minShellVersion", "createdAt", "signature",
    ])
    expect(Buffer.from(manifest.signature, "base64")).toHaveLength(64)
    expect(verifyManifest(manifest, publicKey)).toBe(true)

    // The shell only has the 32 raw bytes: rebuilding the SPKI key from them must verify too.
    expect(publicKeyHex).toMatch(/^[0-9a-f]{64}$/)
    const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex")
    const fromHex = createPublicKey({
      key: Buffer.concat([spkiPrefix, Buffer.from(publicKeyHex, "hex")]),
      format: "der",
      type: "spki",
    })
    expect(verifyManifest(manifest, fromHex)).toBe(true)
  })

  it("rejects a manifest whose fields changed after signing or signed by another key", () => {
    const { privateKeyPem, publicKey } = generateBundleKeypair()
    const manifest = signManifest(fields, privateKeyPem)
    expect(verifyManifest({ ...manifest, size: manifest.size + 1 }, publicKey)).toBe(false)
    const other = generateKeyPairSync("ed25519").publicKey
    expect(verifyManifest(manifest, other)).toBe(false)
  })
})

describe("resolveSigningKey", () => {
  const fakeKeypair = () => ({
    ...generateBundleKeypair(),
    publicKeyHex: "ff".repeat(32),
  })

  it("signs with the secret when it is the ed25519 PKCS#8 PEM keygen prints, padding and CRLF included", () => {
    const { privateKeyPem, publicKey } = generateBundleKeypair()
    for (const value of [` ${privateKeyPem} `, privateKeyPem.replace(/\n/g, "\r\n")]) {
      const decision = resolveSigningKey(value, false, fakeKeypair)
      expect(decision.kind).toBe("provided")
      if (decision.kind !== "provided") throw new Error("unreachable")
      expect(decision.privateKey.asymmetricKeyType).toBe("ed25519")
      expect(verifyManifest(signManifest(fields, decision.privateKey), publicKey)).toBe(true)
    }
  })

  // The secret set on 2026-11-05 was not a PEM, and OpenSSL's one-line DECODER
  // error after the tag was all five red deploys had. Each mangling names itself.
  it("rejects a set-but-malformed secret, naming the secret and what the value looks like", () => {
    const { privateKeyPem, publicKeyHex } = generateBundleKeypair()
    const armorless = privateKeyPem.split("\n").filter((line) => line && !line.startsWith("-----")).join("")
    const ecPem = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey
      .export({ type: "pkcs8", format: "pem" }).toString()
    const cases: Array<[value: string, reason: RegExp]> = [
      [publicKeyHex, /raw public key/],
      [privateKeyPem.replace(/\n/g, "\\n"), /literal \\n/],
      [privateKeyPem.replace(/\n/g, " "), /single line/],
      [armorless, /not a PEM/],
      [ecPem, /is a ec key/],
      ["-----BEGIN PRIVATE KEY-----\nnot base64 at all\n-----END PRIVATE KEY-----", /does not decode: /],
    ]
    for (const [value, reason] of cases) {
      const decision = resolveSigningKey(value, false, fakeKeypair)
      expect(decision.kind, value.slice(0, 40)).toBe("invalid")
      if (decision.kind !== "invalid") throw new Error("unreachable")
      expect(decision.error).toContain(`${SIGNING_KEY_ENV} is set but`)
      expect(decision.error).toMatch(reason)
      expect(decision.error).toContain("desktop:bundle:keygen")
    }
  })

  it("warns and skips without the secret so the web release keeps going", () => {
    const decision = resolveSigningKey(undefined, false, fakeKeypair)
    expect(decision.kind).toBe("skip")
    if (decision.kind !== "skip") throw new Error("unreachable")
    expect(decision.warning.startsWith("::warning::")).toBe(true)
    expect(decision.warning).toContain(SIGNING_KEY_ENV)
    expect(resolveSigningKey("", false, fakeKeypair).kind).toBe("skip")
  })

  it("signs a dry run with an ephemeral key and says which", () => {
    const decision = resolveSigningKey(undefined, true, fakeKeypair)
    expect(decision.kind).toBe("ephemeral")
    if (decision.kind !== "ephemeral") throw new Error("unreachable")
    expect(decision.publicKeyHex).toBe("ff".repeat(32))
    expect(decision.privateKey.asymmetricKeyType).toBe("ed25519")
  })
})

describe("inputs from the release", () => {
  it("picks the highest calver tag on HEAD and ignores other tags", () => {
    expect(pickCalverTag("2026.11.05.02\nv0.2.0\n2026.11.05.10\n2026.11.05.03\n")).toBe("2026.11.05.10")
    expect(pickCalverTag("")).toBeNull()
    expect(pickCalverTag("v1.0.0\n")).toBeNull()
  })

  it("reads minShellVersion from tauri.conf.json and refuses a non-semver one", () => {
    expect(readMinShellVersion('{"productName":"Aquilla","version":"0.2.0"}')).toBe("0.2.0")
    expect(() => readMinShellVersion('{"version":"0.2"}')).toThrow(/MAJOR\.MINOR\.PATCH/)
    expect(() => readMinShellVersion("{}")).toThrow(/no string `version`/)
  })

  it("parses the CLI", () => {
    expect(parseDesktopBundleArgs(["production"]))
      .toEqual({ env: "production", dryRun: false, dist: "dist", preflight: false })
    expect(parseDesktopBundleArgs(["production", "--preflight"]).preflight).toBe(true)
    expect(parseDesktopBundleArgs(["--dry-run", "development", "--dist", "/tmp/d"]))
      .toEqual({ env: "development", dryRun: true, dist: "/tmp/d", preflight: false })
    expect(() => parseDesktopBundleArgs([])).toThrow(/missing environment/)
    expect(() => parseDesktopBundleArgs(["staging"])).toThrow(/unknown argument/)
  })

  it("lays objects out as <env>/<version>/bundle.tar.gz under the public base", () => {
    expect(bundleUrl("production", "2026.11.05.03"))
      .toBe(`${DESKTOP_BUNDLE_PUBLIC_BASE}/production/2026.11.05.03/bundle.tar.gz`)
    expect(wranglerPutArgs("production/latest.json", "/x/latest.json", "application/json")).toEqual([
      "r2", "object", "put", "aquilla-desktop-bundles/production/latest.json",
      "--file", "/x/latest.json", "--content-type", "application/json", "--remote",
    ])
  })
})

describe("tarball", () => {
  let work: string
  afterEach(() => rmSync(work, { recursive: true, force: true }))

  it("archives dist with index.html at the root and hashes what was written", async () => {
    work = mkdtempSync(path.join(tmpdir(), "desktop-bundle-test-"))
    const dist = path.join(work, "dist")
    mkdirSync(path.join(dist, "assets"), { recursive: true })
    writeFileSync(path.join(dist, "index.html"), "<html></html>")
    writeFileSync(path.join(dist, "assets/app.js"), "console.log(1)")
    const out = path.join(work, "bundle.tar.gz")

    expect(spawnSync("tar", tarArgs(out), { cwd: dist }).status).toBe(0)
    const listed = spawnSync("tar", ["-tzf", out], { encoding: "utf8" }).stdout
    // The shell requires index.html at the archive root after extraction.
    expect(listed).toMatch(/^\.\/index\.html$/m)
    expect(listed).toMatch(/^\.\/assets\/app\.js$/m)

    const { sha256, size } = await sha256File(out)
    expect(sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(size).toBeGreaterThan(0)
  })
})
