// @vitest-environment node
import { describe, it, expect, beforeAll } from "vitest"
import { execFile } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { ensureCheckout } from "../stages/fetch"

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
})
