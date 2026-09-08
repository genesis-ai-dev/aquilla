// @vitest-environment node
import { describe, it, expect, beforeAll } from "vitest"
import { execFile } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { ensureCheckout, authedUrl, redact } from "../stages/fetch"

// Not util.promisify(execFile) — see the comment in ../stages/fetch.ts: this
// repo's vite-plugin-node-polyfills setup breaks execFile's promisify.custom
// even under @vitest-environment node, so a plain callback wrapper is used.
const x = (cmd: string, args: string[], options?: { cwd?: string }): Promise<{ stdout: string; stderr: string }> =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, options ?? {}, (err, stdout, stderr) => {
      if (err) reject(err)
      else resolve({ stdout: stdout.toString(), stderr: stderr.toString() })
    })
  })
const git = (cwd: string, ...a: string[]) => x("git", a, { cwd })

let bare: string, work: string, clones: string
beforeAll(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mdfetch-"))
  bare = path.join(root, "remote.git"); work = path.join(root, "work"); clones = path.join(root, "clones")
  await x("git", ["init", "--bare", "-b", "main", bare])
  await x("git", ["clone", bare, work])
  await git(work, "config", "user.email", "t@t"); await git(work, "config", "user.name", "t")
  fs.writeFileSync(path.join(work, "a.txt"), "1"); await git(work, "add", "."); await git(work, "commit", "-m", "c1"); await git(work, "push", "origin", "main")
})
const head = async () => (await git(work, "rev-parse", "HEAD")).stdout.trim()

describe("ensureCheckout", () => {
  it("clones fresh, then fast-forwards, then re-clones when ff is impossible", async () => {
    const sha1 = await head()
    const r1 = await ensureCheckout({ clonesDir: clones, gitlabToken: "" }, { gitlabId: 7, httpUrlToRepo: bare, branch: "main", wantSha: sha1 })
    expect(r1).toMatchObject({ sha: sha1, recloned: true })
    expect(fs.existsSync(path.join(clones, "7", "a.txt"))).toBe(true)

    fs.writeFileSync(path.join(work, "a.txt"), "2"); await git(work, "commit", "-am", "c2"); await git(work, "push")
    const sha2 = await head()
    const r2 = await ensureCheckout({ clonesDir: clones, gitlabToken: "" }, { gitlabId: 7, httpUrlToRepo: bare, branch: "main", wantSha: sha2 })
    expect(r2).toMatchObject({ sha: sha2, recloned: false })

    await git(work, "reset", "--hard", "HEAD~1"); fs.writeFileSync(path.join(work, "a.txt"), "3"); await git(work, "commit", "-am", "c3"); await git(work, "push", "--force")
    const sha3 = await head()
    const r3 = await ensureCheckout({ clonesDir: clones, gitlabToken: "" }, { gitlabId: 7, httpUrlToRepo: bare, branch: "main", wantSha: sha3 })
    expect(r3).toMatchObject({ sha: sha3, recloned: true })
    expect(fs.readFileSync(path.join(clones, "7", "a.txt"), "utf8")).toBe("3")
  })
  it("throws when the remote head is older than wantSha (webhook raced ahead of the mirror)", async () => {
    await expect(ensureCheckout({ clonesDir: clones, gitlabToken: "" }, { gitlabId: 7, httpUrlToRepo: bare, branch: "main", wantSha: "0".repeat(40) })).rejects.toThrow(/wantSha/)
  })

  it("never persists the token in .git/config, even with a non-empty gitlabToken", async () => {
    const sha1 = await head()
    const r = await ensureCheckout(
      { clonesDir: clones, gitlabToken: "SECRET123" },
      { gitlabId: 8, httpUrlToRepo: `file://${bare}`, branch: "main", wantSha: sha1 },
    )
    expect(r.sha).toBe(sha1)
    const remote = await git(path.join(clones, "8"), "remote", "get-url", "origin")
    expect(remote.stdout.trim()).toBe(`file://${bare}`)
    expect(remote.stdout).not.toContain("oauth2:")
    const config = fs.readFileSync(path.join(clones, "8", ".git", "config"), "utf8")
    expect(config).not.toContain("SECRET123")
    expect(config).not.toContain("oauth2:")
  })
})

describe("authedUrl", () => {
  it("rewrites https URLs to the oauth2 basic-auth form", () => {
    expect(authedUrl("https://h/p.git", "tok")).toBe("https://oauth2:tok@h/p.git")
  })
  it("leaves non-https URLs unchanged", () => {
    expect(authedUrl("file:///tmp/x.git", "tok")).toBe("file:///tmp/x.git")
    expect(authedUrl("git@h:p.git", "tok")).toBe("git@h:p.git")
  })
  it("leaves the URL unchanged when there is no token", () => {
    expect(authedUrl("https://h/p.git", "")).toBe("https://h/p.git")
  })
})

describe("redact", () => {
  it("masks the oauth2:<token>@ form", () => {
    expect(redact("fatal: clone https://oauth2:SECRET123@h/p.git failed")).toBe("fatal: clone https://oauth2:***@h/p.git failed")
  })
  it("masks a bare token string when passed explicitly", () => {
    expect(redact("token SECRET123 rejected", "SECRET123")).toBe("token *** rejected")
  })
})

describe("ensureCheckout error redaction", () => {
  it("never leaks the token when the connection fails", async () => {
    await expect(
      ensureCheckout(
        { clonesDir: clones, gitlabToken: "SECRET123" },
        { gitlabId: 9, httpUrlToRepo: "https://127.0.0.1:9/x.git", branch: "main", wantSha: "0".repeat(40) },
      ),
    ).rejects.toMatchObject({
      message: expect.not.stringContaining("SECRET123"),
    })
    try {
      await ensureCheckout(
        { clonesDir: clones, gitlabToken: "SECRET123" },
        { gitlabId: 9, httpUrlToRepo: "https://127.0.0.1:9/x.git", branch: "main", wantSha: "0".repeat(40) },
      )
      throw new Error("expected ensureCheckout to reject")
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      expect(msg).not.toContain("SECRET123")
      expect(msg).not.toContain("oauth2:SECRET123@")
      expect(msg).toContain("oauth2:***@")
    }
  }, 20000)
})
