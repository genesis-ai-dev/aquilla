import { describe, expect, it } from "vitest"
import {
  backupBranchName,
  classifyNeonCliFailure,
  isPreflightOnly,
  neonCliArgs,
  parseBranchList,
  planRestore,
  preflightFailureMessage,
  relevantCliStderr,
  restoreArgs,
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

describe("planRestore", () => {
  const PROJECT = "sweet-paper-88472094"
  const PRODUCTION_ID = "br-cool-heart-ajossgkw"
  const DEV = { id: "br-hidden-scene-aj3vb03f", name: "dev" }
  const production = { id: PRODUCTION_ID, name: "production", default: true, primary: true, protected: true }
  const dev = { ...DEV, parent_id: PRODUCTION_ID, default: false, primary: false, protected: false }
  const snapshot = { id: "br-purple-wave-ajpzeqgm", name: "premigrate-2026-11-17-15-59-48", parent_id: PRODUCTION_ID }

  // Trimmed from `neon branches list --output json` on 2026-11-20, the eighth
  // morning the restore stopped on "Branch has children, preserve_under_name is
  // required" (run 44709111635): two QA branches PR previews forked from dev.
  const LIST_2026_11_20 = JSON.stringify([
    production,
    dev,
    {
      id: "br-blue-dawn-ajlxlosk",
      name: "qa-aqu-2631-login-security",
      parent_id: DEV.id,
      expires_at: "2026-11-30T23:59:59Z",
    },
    { id: "br-ancient-bonus-ajvlvb5x", name: "qa-aqu-2553-pr2002", parent_id: DEV.id },
    snapshot,
  ])
  const plan = (stdout: string, now = new Date("2026-11-21T09:16:25Z")) =>
    planRestore({ branches: parseBranchList(stdout), target: DEV, sourceId: PRODUCTION_ID, now })

  it("keeps the old dev under a name when branches are forked from it, as Neon requires", () => {
    const result = plan(LIST_2026_11_20)
    expect(result.children.map((branch) => [branch.name, branch.expiresAt])).toEqual([
      ["qa-aqu-2631-login-security", "2026-11-30T23:59:59Z"],
      ["qa-aqu-2553-pr2002", null],
    ])
    expect(result.preserveUnderName).toBe("dev-pre-refresh-2026-11-21-09-16-25")
    expect(result.staleBackups).toEqual([])
    expect(
      restoreArgs({
        target: "dev",
        source: "production",
        projectId: PROJECT,
        preserveUnderName: result.preserveUnderName,
      }),
    ).toEqual([
      "branches",
      "restore",
      "dev",
      "production",
      "--project-id",
      PROJECT,
      "--preserve-under-name",
      "dev-pre-refresh-2026-11-21-09-16-25",
      "--output",
      "json",
    ])
  })

  it("restores exactly as before when nothing is forked from dev", () => {
    const result = plan(JSON.stringify([production, dev, snapshot]))
    expect(result).toEqual({ children: [], preserveUnderName: null, staleBackups: [], heldBackups: [] })
    expect(
      restoreArgs({ target: "dev", source: "production", projectId: PROJECT, preserveUnderName: null }),
    ).toEqual(["branches", "restore", "dev", "production", "--project-id", PROJECT, "--output", "json"])
  })

  it("deletes only its own backups, and only once nothing is forked from them", () => {
    const held = backupBranchName("dev", new Date("2026-11-21T09:16:25Z"))
    const stale = backupBranchName("dev", new Date("2026-11-14T09:16:25Z"))
    const result = plan(
      JSON.stringify({
        branches: [
          production,
          dev,
          // The morning after a restore moved a QA branch onto its backup.
          { id: "br-held", name: held, parent_id: PRODUCTION_ID },
          { id: "br-qa", name: "qa-aqu-2631-login-security", parent_id: "br-held" },
          // An older backup whose QA branch has since expired.
          { id: "br-stale", name: stale, parent_id: PRODUCTION_ID },
          // Childless as well, and never this script's to delete: someone
          // else's snapshot, another target's backup, a hand-named lookalike,
          // and a backup somebody protected.
          snapshot,
          { id: "br-other-target", name: `x${stale}`, parent_id: PRODUCTION_ID },
          { id: "br-hand-named", name: "dev-pre-refresh-keep-this", parent_id: PRODUCTION_ID },
          { id: "br-protected", name: `${stale.slice(0, -1)}9`, parent_id: PRODUCTION_ID, protected: true },
        ],
      }),
      new Date("2026-11-22T09:16:25Z"),
    )
    expect(result.staleBackups.map((branch) => branch.id)).toEqual(["br-stale"])
    expect(
      result.heldBackups.map(({ backup, children }) => [backup.id, children.map((child) => child.id)]),
    ).toEqual([["br-held", ["br-qa"]]])
    expect(result.preserveUnderName).toBeNull()
  })

  it("rejects CLI output that is not a branch list", () => {
    expect(() => parseBranchList("{}")).toThrow(/no branch list/)
    expect(() => parseBranchList('[{"name":"dev"}]')).toThrow(/without id or name/)
  })
})
