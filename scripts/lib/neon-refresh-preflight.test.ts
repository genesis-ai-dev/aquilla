import { describe, expect, it } from "vitest"
import {
  classifyNeonCliFailure,
  isPreflightOnly,
  neonCliArgs,
  preflightFailureMessage,
  relevantCliStderr,
  summarizeBranchJson,
} from "./neon-refresh-preflight"

// Verbatim stderr of GitHub run 39393566862 (2026-10-20, "Refresh Dev Neon
// Branch"): the rejected NEON_API_KEY, then the CLI's yargs retry artifact.
const REJECTED_KEY_STDERR = [
  "INFO: Authentication failed, deleting credentials...",
  "ERROR: Not enough non-option arguments: got 1, need at least 2",
  "",
].join("\n")

describe("neonCliArgs", () => {
  it("pins the CLI, disables analytics/color, and never puts the API key on argv", () => {
    const args = neonCliArgs(["branches", "get", "dev", "--project-id", "sweet-paper-88472094"])
    expect(args).toEqual([
      "--yes",
      "neon@2.30.0",
      "branches",
      "get",
      "dev",
      "--project-id",
      "sweet-paper-88472094",
      "--no-analytics",
      "--color",
      "false",
    ])
    expect(args).not.toContain("--api-key")
  })

  it("honours a CLI version override", () => {
    expect(neonCliArgs(["me"], "2.31.1")[1]).toBe("neon@2.31.1")
  })
})

describe("classifyNeonCliFailure", () => {
  it("reads the failed GitHub run's stderr as an authentication failure", () => {
    expect(classifyNeonCliFailure(REJECTED_KEY_STDERR)).toBe("auth")
  })

  it("recognises the API's 401 body text under DEBUG output", () => {
    expect(
      classifyNeonCliFailure(
        "DEBUG: 401 Unauthorized\nDEBUG: Stack: NeonApiError: supplied credentials do not pass authentication",
      ),
    ).toBe("auth")
  })

  it("separates a key that authenticates but cannot see the project", () => {
    expect(classifyNeonCliFailure("ERROR: project not found")).toBe("not-found")
  })

  it("leaves everything else alone", () => {
    expect(classifyNeonCliFailure("ERROR: Request timed out")).toBe("other")
  })
})

describe("relevantCliStderr", () => {
  it("drops the yargs retry artifact and blank lines but keeps the real diagnostic", () => {
    expect(relevantCliStderr(REJECTED_KEY_STDERR)).toBe("INFO: Authentication failed, deleting credentials...")
  })

  it("drops npm's pnpm-environment warnings that npx prints before the CLI runs", () => {
    const local = [
      'npm warn Unknown env config "verify-deps-before-run". This will stop working in the next major version of npm.',
      'npm warn Unknown env config "_jsr-registry". This will stop working in the next major version of npm.',
      REJECTED_KEY_STDERR,
    ].join("\n")
    expect(relevantCliStderr(local)).toBe("INFO: Authentication failed, deleting credentials...")
  })
})

describe("preflightFailureMessage", () => {
  const base = {
    branch: "dev",
    projectId: "sweet-paper-88472094",
    orgLabel: "Frontier R&D (org-cold-butterfly-03397216)",
    cliVersion: "2.30.0",
  }

  it("tells a CI operator the secret is rejected, that nothing was restored, and how to rotate and verify", () => {
    const message = preflightFailureMessage({
      ...base,
      kind: "auth",
      usingApiKey: true,
      stderr: relevantCliStderr(REJECTED_KEY_STDERR),
    })
    expect(message).toContain("NEON_API_KEY was rejected by the Neon API (HTTP 401")
    expect(message).toContain("Nothing was restored")
    expect(message).toContain("Frontier R&D (org-cold-butterfly-03397216)")
    expect(message).toContain("GitHub repository secret NEON_API_KEY")
    expect(message).toContain("NEON_REFRESH_PREFLIGHT_ONLY=1 pnpm neon:refresh:dev")
    expect(message).toContain("INFO: Authentication failed, deleting credentials...")
    expect(message).not.toContain("Not enough non-option arguments")
  })

  it("sends a local OAuth login back to `neon auth` instead of to the GitHub secret", () => {
    const message = preflightFailureMessage({ ...base, kind: "auth", usingApiKey: false, stderr: "" })
    expect(message).toContain("npx --yes neon@2.30.0 auth")
    expect(message).not.toContain("GitHub repository secret")
  })

  it("explains a 404 as a key from the wrong project or organization", () => {
    const message = preflightFailureMessage({
      ...base,
      kind: "not-found",
      usingApiKey: true,
      stderr: "ERROR: project not found",
    })
    expect(message).toContain("authenticated, but branch 'dev'")
    expect(message).toContain("scoped to another project")
  })
})

describe("isPreflightOnly", () => {
  it("accepts 1 and true, case-insensitively, and nothing else", () => {
    expect(isPreflightOnly({ NEON_REFRESH_PREFLIGHT_ONLY: "1" })).toBe(true)
    expect(isPreflightOnly({ NEON_REFRESH_PREFLIGHT_ONLY: "TRUE" })).toBe(true)
    expect(isPreflightOnly({ NEON_REFRESH_PREFLIGHT_ONLY: "0" })).toBe(false)
    expect(isPreflightOnly({ NEON_REFRESH_PREFLIGHT_ONLY: "false" })).toBe(false)
    expect(isPreflightOnly({})).toBe(false)
  })
})

describe("summarizeBranchJson", () => {
  it("reads id, name and last_reset_at from a bare branch object", () => {
    expect(
      summarizeBranchJson(
        JSON.stringify({ id: "br-x-1", name: "dev", last_reset_at: "2026-09-29T14:19:00Z", parent_id: "br-p" }),
      ),
    ).toEqual({ id: "br-x-1", name: "dev", lastResetAt: "2026-09-29T14:19:00Z" })
  })

  it("accepts a { branch } envelope and a branch never reset", () => {
    expect(summarizeBranchJson(JSON.stringify({ branch: { id: "br-y", name: "production" } }))).toEqual({
      id: "br-y",
      name: "production",
      lastResetAt: null,
    })
  })

  it("rejects output without a branch", () => {
    expect(() => summarizeBranchJson("[]")).toThrow(/missing id or name/)
    expect(() => summarizeBranchJson("null")).toThrow(/no branch object/)
  })
})
