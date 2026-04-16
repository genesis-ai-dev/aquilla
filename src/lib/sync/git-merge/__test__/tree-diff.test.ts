import { describe, it, expect, beforeEach } from "vitest"
import * as git from "isomorphic-git"
import { createOpfsFs, type OpfsFs } from "@/lib/git/opfs-fs"
import { MemoryDirectoryHandle } from "@/lib/git/__test__/mem-fs-handles"
import { buildTreeDiff } from "../tree-diff"

function makeFs(): OpfsFs {
  const root = new MemoryDirectoryHandle("r")
  return createOpfsFs(root as unknown as FileSystemDirectoryHandle)
}

async function init(fs: OpfsFs) {
  await git.init({ fs: fs as unknown as git.FsClient, dir: "/" })
}

async function writeAndCommit(
  fs: OpfsFs, files: Record<string, string>, message: string, parent?: string[],
): Promise<string> {
  for (const [p, contents] of Object.entries(files)) {
    await fs.promises.writeFile(p, contents)
    await git.add({ fs: fs as unknown as git.FsClient, dir: "/", filepath: p.replace(/^\//, "") })
  }
  return git.commit({
    fs: fs as unknown as git.FsClient, dir: "/",
    author: { name: "t", email: "t@t" },
    message, parent,
  })
}

describe("buildTreeDiff", () => {
  let fs: OpfsFs
  beforeEach(async () => { fs = makeFs(); await init(fs) })

  it("classifies both-same paths as skipped", async () => {
    const oursSha = await writeAndCommit(fs, { "/a.txt": "hello" }, "c1")
    const theirsSha = oursSha
    const entries = await buildTreeDiff({ fs, dir: "/", oursSha, theirsSha })
    expect(entries).toHaveLength(0)
  })

  it("classifies ours-only and theirs-only paths", async () => {
    const base = await writeAndCommit(fs, { "/shared.txt": "x" }, "base")
    const oursSha = await writeAndCommit(fs, { "/only-ours.txt": "o" }, "ours", [base])

    await fs.promises.writeFile("/only-theirs.txt", "t")
    await git.add({ fs: fs as unknown as git.FsClient, dir: "/", filepath: "only-theirs.txt" })
    await fs.promises.unlink("/only-ours.txt")
    await git.remove({ fs: fs as unknown as git.FsClient, dir: "/", filepath: "only-ours.txt" })
    const theirsSha = await git.commit({
      fs: fs as unknown as git.FsClient, dir: "/",
      author: { name: "t", email: "t@t" }, message: "theirs", parent: [base],
    })

    const entries = await buildTreeDiff({ fs, dir: "/", oursSha, theirsSha })
    const byPath = Object.fromEntries(entries.map(e => [e.path, e.kind]))
    expect(byPath["only-ours.txt"]).toBe("ours-only")
    expect(byPath["only-theirs.txt"]).toBe("theirs-only")
  })

  it("classifies differing-content paths as both-differ", async () => {
    const base = await writeAndCommit(fs, { "/shared.txt": "v1" }, "base")
    const oursSha = await writeAndCommit(fs, { "/shared.txt": "v-ours" }, "ours", [base])
    await fs.promises.writeFile("/shared.txt", "v-theirs")
    await git.add({ fs: fs as unknown as git.FsClient, dir: "/", filepath: "shared.txt" })
    const theirsSha = await git.commit({
      fs: fs as unknown as git.FsClient, dir: "/",
      author: { name: "t", email: "t@t" }, message: "theirs", parent: [base],
    })
    const entries = await buildTreeDiff({ fs, dir: "/", oursSha, theirsSha })
    const e = entries.find(x => x.path === "shared.txt")
    expect(e?.kind).toBe("both-differ")
    expect(e?.oursOid).toBeDefined()
    expect(e?.theirsOid).toBeDefined()
  })
})
