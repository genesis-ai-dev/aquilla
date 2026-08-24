// AQU-971 — stale-checkout guard. A reused migration checkout must match the
// remote head before it is read: silently reusing whatever sits on disk is how
// the 2026-08-20 poison sweep mapped months-old notebooks and retracted /
// re-anchored live content across 30+ prod projects.
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import git from "isomorphic-git"
import {
  ensureCheckoutCurrent,
  redactToken,
  type CheckoutGuardIo,
} from "./checkout-guard"

const SHA_A = "a".repeat(40)
const SHA_B = "b".repeat(40)

function fakeIo(overrides: Partial<CheckoutGuardIo>): CheckoutGuardIo {
  return {
    resolveLocalHead: async () => SHA_A,
    resolveRemoteHead: async () => SHA_A,
    fastForward: async () => {
      throw new Error("fastForward should not have been called")
    },
    ...overrides,
  }
}

describe("ensureCheckoutCurrent — decision flow", () => {
  it("passes silently when the checkout already matches the remote head", async () => {
    const lines: string[] = []
    await ensureCheckoutCurrent({ dir: "/x", io: fakeIo({}), log: (l) => lines.push(l) })
    expect(lines.join(" ")).toContain("current")
  })

  it("fast-forwards a checkout that is cleanly behind, then verifies it landed", async () => {
    let head = SHA_A
    const io = fakeIo({
      resolveLocalHead: async () => head,
      resolveRemoteHead: async () => SHA_B,
      fastForward: async () => {
        head = SHA_B
      },
    })
    const lines: string[] = []
    await ensureCheckoutCurrent({ dir: "/x", io, log: (l) => lines.push(l) })
    expect(lines.join(" ")).toContain("Fast-forwarded")
  })

  it("refuses when the fast-forward fails, naming both shas and the remediation", async () => {
    const io = fakeIo({
      resolveLocalHead: async () => SHA_A,
      resolveRemoteHead: async () => SHA_B,
      fastForward: async () => {
        throw new Error("Not possible to fast-forward, aborting.")
      },
    })
    await expect(ensureCheckoutCurrent({ dir: "/stale", io })).rejects.toThrow(
      /stale checkout at \/stale:.*aaaaaaaa.*bbbbbbbb.*fast-forward.*(Codex Editor|fresh clone)/s,
    )
  })

  it("refuses when the pull reports success but HEAD still is not the remote head", async () => {
    const io = fakeIo({
      resolveLocalHead: async () => SHA_A,
      resolveRemoteHead: async () => SHA_B,
      fastForward: async () => {}, // lies: nothing moved
    })
    await expect(ensureCheckoutCurrent({ dir: "/x", io })).rejects.toThrow(/still at aaaaaaaa/)
  })

  it("fails CLOSED when the remote head cannot be resolved", async () => {
    const io = fakeIo({ resolveRemoteHead: async () => null })
    await expect(ensureCheckoutCurrent({ dir: "/x", io })).rejects.toThrow(
      /cannot be verified as current/,
    )
  })

  it("treats an unresolvable local HEAD as a corrupt clone", async () => {
    const io = fakeIo({ resolveLocalHead: async () => null, resolveRemoteHead: async () => SHA_B })
    await expect(ensureCheckoutCurrent({ dir: "/x", io })).rejects.toThrow(/fresh clone/)
  })
})

describe("redactToken", () => {
  it("strips embedded credentials from anything echoed", () => {
    expect(redactToken("fatal: https://oauth2:glpat-secret123@git.host/x.git failed"))
      .toBe("fatal: https://oauth2:***@git.host/x.git failed")
  })
})

// Real-git integration: the guard's contract depends on `git pull --ff-only`
// semantics — advances a cleanly-behind checkout, refuses divergence, and
// never clobbers local work. Exercise those against real repositories (a
// file-path remote stands in for GitLab; ref reads go through the same
// isomorphic-git call the production IO uses).
describe("ensureCheckoutCurrent — real git fixtures", () => {
  let root: string
  let remote: string

  const sh = (cwd: string, args: string[]): string =>
    execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim()

  const realIo = (dir: string): CheckoutGuardIo => ({
    resolveLocalHead: async () => {
      try {
        return await git.resolveRef({ fs, dir, ref: "HEAD" })
      } catch {
        return null
      }
    },
    // A file-path remote needs no network: resolve its tip directly. The
    // production impl differs only in transport (listServerRefs over HTTP).
    resolveRemoteHead: async () => sh(remote, ["rev-parse", "main"]),
    fastForward: async () => {
      execFileSync("git", ["-C", dir, "pull", "--ff-only", remote, "main"], { encoding: "utf8" })
    },
  })

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "checkout-guard-"))
    remote = path.join(root, "remote")
    fs.mkdirSync(remote)
    sh(remote, ["init", "-b", "main"])
    sh(remote, ["config", "user.email", "t@t"])
    sh(remote, ["config", "user.name", "t"])
    fs.writeFileSync(path.join(remote, "GEN.codex"), "v1")
    sh(remote, ["add", "-A"])
    sh(remote, ["commit", "-m", "v1"])
  })

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  function cloneAt(name: string): string {
    const dir = path.join(root, name)
    execFileSync("git", ["clone", remote, dir], { encoding: "utf8" })
    return dir
  }

  it("fast-forwards a cleanly-behind checkout to the advanced remote", async () => {
    const dir = cloneAt("behind")
    fs.writeFileSync(path.join(remote, "GEN.codex"), "v2")
    sh(remote, ["commit", "-am", "v2"])
    await ensureCheckoutCurrent({ dir, io: realIo(dir) })
    expect(fs.readFileSync(path.join(dir, "GEN.codex"), "utf8")).toBe("v2")
  })

  it("refuses a diverged checkout instead of discarding its local commit", async () => {
    const dir = cloneAt("diverged")
    sh(dir, ["config", "user.email", "t@t"])
    sh(dir, ["config", "user.name", "t"])
    fs.writeFileSync(path.join(dir, "GEN.codex"), "local-only work")
    sh(dir, ["commit", "-am", "unpushed local work"])
    fs.writeFileSync(path.join(remote, "GEN.codex"), "v3")
    sh(remote, ["commit", "-am", "v3"])
    await expect(ensureCheckoutCurrent({ dir, io: realIo(dir) })).rejects.toThrow(/stale checkout/)
    // The unpushed local commit survives untouched.
    expect(fs.readFileSync(path.join(dir, "GEN.codex"), "utf8")).toBe("local-only work")
  })
})
