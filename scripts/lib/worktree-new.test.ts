// @vitest-environment node
import path from "node:path"
import { describe, expect, it } from "vitest"
import {
  defaultWorktreeDir,
  parseBaseRef,
  parseWorktreeNewArgs,
  shouldUnsetUpstream,
  worktreeAddArgs,
  worktreeCheckout,
  worktreeDirectoryName,
  worktreeSetupSteps,
} from "./worktree-new"

const repoRoot = "/repos/aquilla"

describe("worktree directory", () => {
  it("names a sibling after the branch ticket", () => {
    expect(worktreeDirectoryName("aqu-1234-short-title")).toBe("aquilla-aqu-1234")
    expect(worktreeDirectoryName("ryder/aqu-1234-short-title")).toBe("aquilla-aqu-1234")
    expect(worktreeDirectoryName("AQU-99-mixed-case")).toBe("aquilla-aqu-99")
    expect(defaultWorktreeDir(repoRoot, "ryder/aqu-1234-short-title")).toBe(
      path.resolve(repoRoot, "..", "aquilla-aqu-1234"),
    )
  })

  it("uses the first ticket when a branch names two", () => {
    expect(worktreeDirectoryName("aqu-10-then-aqu-20")).toBe("aquilla-aqu-10")
  })

  it("slugs a branch that has no ticket", () => {
    expect(worktreeDirectoryName("feature/no-ticket")).toBe("aquilla-feature-no-ticket")
    expect(defaultWorktreeDir(repoRoot, "feature/no-ticket")).toBe(
      path.resolve(repoRoot, "..", "aquilla-feature-no-ticket"),
    )
  })
})

describe("parseWorktreeNewArgs", () => {
  it("defaults the base to origin/dev and the dir to the ticket sibling", () => {
    expect(parseWorktreeNewArgs(["aqu-1234-short-title"], repoRoot)).toEqual({
      branch: "aqu-1234-short-title",
      dir: path.resolve(repoRoot, "..", "aquilla-aqu-1234"),
      remote: "origin",
      baseBranch: "dev",
      baseRef: "origin/dev",
    })
  })

  it("accepts an explicit directory and a --base ref", () => {
    expect(parseWorktreeNewArgs(
      ["--", "--base", "origin/main", "aqu-1234-short-title", "/tmp/aquilla-wt"],
      repoRoot,
    )).toEqual({
      branch: "aqu-1234-short-title",
      dir: "/tmp/aquilla-wt",
      remote: "origin",
      baseBranch: "main",
      baseRef: "origin/main",
    })
  })

  it("treats a bare --base name as origin/<name> and keeps slashes in the branch", () => {
    expect(parseBaseRef("dev")).toEqual({ remote: "origin", baseBranch: "dev", baseRef: "origin/dev" })
    expect(parseWorktreeNewArgs(["--base=origin/release/2026/10/02", "aqu-1-x"], repoRoot)).toMatchObject({
      remote: "origin",
      baseBranch: "release/2026/10/02",
      baseRef: "origin/release/2026/10/02",
    })
  })

  it("resolves a relative directory against the repo root", () => {
    expect(parseWorktreeNewArgs(["aqu-5-x", "../aquilla-custom"], repoRoot).dir).toBe(
      path.resolve(repoRoot, "../aquilla-custom"),
    )
  })

  it("rejects a missing branch, an unknown flag, and the repo root as the destination", () => {
    expect(() => parseWorktreeNewArgs([], repoRoot)).toThrow(/pnpm worktree:new/)
    expect(() => parseWorktreeNewArgs(["--nope", "aqu-1-x"], repoRoot)).toThrow(/unknown flag/)
    expect(() => parseWorktreeNewArgs(["aqu-1-x", repoRoot], repoRoot)).toThrow(/repo root/)
  })
})

describe("worktree checkout", () => {
  const base = { baseRef: "origin/dev", remoteRef: "origin/aqu-1-x" }

  it("creates from the base only when the branch is new", () => {
    const checkout = worktreeCheckout({ ...base, localBranchExists: false, remoteBranchExists: false })
    expect(checkout).toEqual({ action: "create", startPoint: "origin/dev" })
    expect(worktreeAddArgs("/tmp/wt", "aqu-1-x", checkout)).toEqual([
      "worktree", "add", "-b", "aqu-1-x", "/tmp/wt", "origin/dev",
    ])
  })

  it("checks out a local branch without -b", () => {
    const checkout = worktreeCheckout({ ...base, localBranchExists: true, remoteBranchExists: true })
    expect(checkout).toEqual({ action: "checkout-local" })
    expect(worktreeAddArgs("/tmp/wt", "aqu-1-x", checkout)).toEqual([
      "worktree", "add", "/tmp/wt", "aqu-1-x",
    ])
  })

  it("checks out an origin branch from that ref, not from the base", () => {
    const checkout = worktreeCheckout({ ...base, localBranchExists: false, remoteBranchExists: true })
    expect(checkout).toEqual({ action: "checkout-remote", startPoint: "origin/aqu-1-x" })
    expect(worktreeAddArgs("/tmp/wt", "aqu-1-x", checkout)).toEqual([
      "worktree", "add", "-b", "aqu-1-x", "/tmp/wt", "origin/aqu-1-x",
    ])
  })

  it("unsets upstream only when it is the base ref", () => {
    expect(shouldUnsetUpstream("origin/dev", "origin/dev")).toBe(true)
    expect(shouldUnsetUpstream("origin/aqu-1-x", "origin/dev")).toBe(false)
    expect(shouldUnsetUpstream(null, "origin/dev")).toBe(false)
  })
})

describe("worktree setup steps", () => {
  it("mirrors CI installs and then installs Playwright chromium", () => {
    expect(worktreeSetupSteps()).toEqual([
      { cwd: ".", command: "pnpm", args: ["install", "--frozen-lockfile"] },
      { cwd: "sync-worker", command: "pnpm", args: ["install", "--frozen-lockfile"] },
      { cwd: "auth-worker", command: "pnpm", args: ["install", "--frozen-lockfile"] },
      { cwd: "agent-worker", command: "npm", args: ["ci"] },
      { cwd: ".", command: "pnpm", args: ["exec", "playwright", "install", "chromium"] },
    ])
  })
})
