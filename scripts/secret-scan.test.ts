import { describe, it, expect } from "vitest"
import { isScannable, scanContent } from "./secret-scan"

// A scanner that matches nothing passes CI forever and protects nothing, so
// the positives matter at least as much as the negatives here. Every literal
// below is a synthetic shape, not a real credential.
describe("secret-scan — catches real credential shapes", () => {
  it.each([
    ["private-key", "-----BEGIN RSA PRIVATE KEY-----"],
    ["aws-access-key", "AWS_ACCESS_KEY_ID=AKIA2Z7QW9XM4TKL8PVR"],
    ["openai-key", 'OPENROUTER_API_KEY="sk-or-v1-9f3c1a7e5b2d8460af71c93e2d5b8047"'],
    ["github-token", "token: ghp_9fQ2xLm4Kd7Rt1Ns6Vb3Zc8Hj5Yw0Pa1Qe4U"],
    ["slack-token", "xoxb-4839201-cJ82Kd9Fm3Lp"],
    ["google-api-key", "AIzaBc91XkQ7wPd3Vz0Nr8Tf2Hy6Ls4Mj5Ke9Zt"],
    ["aquilla-pat", "aqk_Zx7Kd2Lm9Pq4Rt6Vb1Nc8Hj3Yw5Fa0Ge7Us2Id4Ox"],
    ["postgres-url-password", "postgres://aquilla:hunter2hunter2@ep-x.neon.tech/db"],
  ])("flags a %s", (rule, line) => {
    const findings = scanContent("config/thing.ts", line)
    expect(findings.map((f) => f.rule)).toContain(rule)
  })

  it("flags a secret pasted into a wrangler [vars] block", () => {
    const findings = scanContent("sync-worker/wrangler.toml", 'SYNC_SECRET_KEY = "s0me-real-value"')
    expect(findings.map((f) => f.rule)).toContain("wrangler-inline-secret")
  })

  it("redacts the value it reports, and reports the line number", () => {
    const [finding] = scanContent(
      "a.ts",
      ["// header", "const k = 'sk-or-v1-9f3c1a7e5b2d8460af71c93e2d5b8047'"].join("\n"),
    )
    expect(finding.line).toBe(2)
    expect(finding.excerpt).toContain("redacted")
    expect(finding.excerpt).not.toContain("9f3c1a7e5b2d8460af71c93e2d5b8047")
  })
})

describe("secret-scan — does not cry wolf", () => {
  it.each([
    ["a Cloudflare account id", 'account_id = "6a80496d1e59948a9cbaa3c643ba81d7"'],
    ["a UUIDv7 event id", 'const id = "0192f4c1-8b3e-7a21-9f6d-4c8e2b7a10d3"'],
    ["a sha256 content hash", 'sha256: "9b74c9897bac770ffc029102a200c5de1640d4e3d1a1e4e4d1e4e4d1e4e4d1e4"'],
    ["a passwordless postgres url", "postgres://aquilla@ep-x.neon.tech/db"],
    ["a phrase mentioning a token", "// the sync token is minted by identity"],
    ["a documented placeholder", 'OPENROUTER_API_KEY=""'],
  ])("ignores %s", (_label, line) => {
    expect(scanContent("src/lib/thing.ts", line)).toEqual([])
  })

  it("honours an inline suppression", () => {
    const line = "const demo = 'sk-or-v1-9f3c1a7e5b2d8460af71c93e2d5b8047' // secret-scan:allow"
    expect(scanContent("docs/example.ts", line)).toEqual([])
  })

  it("relaxes only the wrangler rule for .example files", () => {
    // `.dev.vars.example` legitimately ships dev placeholder values…
    expect(scanContent("auth-worker/.dev.vars.example", 'SECRET_KEY="dev-frontier-secret"')).toEqual([])
    // …but a real vendor-prefixed key in one is still a leak.
    expect(
      scanContent("auth-worker/.dev.vars.example", "OPENROUTER_API_KEY=sk-or-v1-9f3c1a7e5b2d8460af71c93e2d5b8047"),
    ).not.toEqual([])
  })
})

describe("secret-scan — file selection", () => {
  it.each([
    "src/lib/sync/invites.ts",
    "auth-worker/wrangler.toml",
    "config/cloudflare-deployments.json",
  ])("scans %s", (file) => {
    expect(isScannable(file)).toBe(true)
  })

  it.each([
    "auth-worker/src/__tests__/agent-memory.test.ts",
    "src/lib/sync/credentials.test.ts",
    "e2e/specs/smoke.spec.ts",
    "pnpm-lock.yaml",
    "public/aquilla-og-1200x630.png",
  ])("skips fixture/binary path %s", (file) => {
    expect(isScannable(file)).toBe(false)
  })
})
