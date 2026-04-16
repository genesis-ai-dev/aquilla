import { describe, it, expect } from "vitest"
import * as git from "isomorphic-git"
import { createOpfsFs, type OpfsFs } from "@/lib/git/opfs-fs"
import { MemoryDirectoryHandle } from "@/lib/git/__test__/mem-fs-handles"
import { buildTreeFromOursPlusOverrides } from "../tree-write"

async function initFixture(): Promise<{ fs: OpfsFs; sha: string }> {
  const root = new MemoryDirectoryHandle("r")
  const fs = createOpfsFs(root as unknown as FileSystemDirectoryHandle)
  await git.init({ fs: fs as unknown as git.FsClient, dir: "/" })
  for (const [p, v] of [
    ["a.txt", "aaa"],
    ["nested/b.txt", "bbb"],
    ["nested/deep/c.txt", "ccc"],
  ]) {
    await fs.promises.writeFile("/" + p, v)
    await git.add({ fs: fs as unknown as git.FsClient, dir: "/", filepath: p })
  }
  const sha = await git.commit({
    fs: fs as unknown as git.FsClient, dir: "/",
    author: { name: "t", email: "t@t" }, message: "init",
  })
  return { fs, sha }
}

async function readBlobAt(fs: OpfsFs, treeOid: string, path: string): Promise<string> {
  // Wrap the tree in a throwaway commit so readBlob's filepath resolution works
  // (it walks from a commit's tree).
  const commitOid = await git.commit({
    fs: fs as unknown as git.FsClient, dir: "/",
    tree: treeOid, parent: [],
    author: { name: "probe", email: "p@p" }, message: "probe",
  })
  const { blob } = await git.readBlob({
    fs: fs as unknown as git.FsClient, dir: "/", oid: commitOid, filepath: path,
  })
  return new TextDecoder().decode(blob)
}

describe("buildTreeFromOursPlusOverrides", () => {
  it("returns ours' tree unchanged when no overrides", async () => {
    const { fs, sha } = await initFixture()
    const commit = await git.readCommit({ fs: fs as unknown as git.FsClient, dir: "/", oid: sha })
    const treeOid = await buildTreeFromOursPlusOverrides({ fs, dir: "/", oursSha: sha, overrides: [] })
    expect(treeOid).toBe(commit.commit.tree)
  })

  it("replaces a top-level file blob", async () => {
    const { fs, sha } = await initFixture()
    const newBlobOid = await git.writeBlob({
      fs: fs as unknown as git.FsClient, dir: "/",
      blob: new TextEncoder().encode("NEW"),
    })
    const newTreeOid = await buildTreeFromOursPlusOverrides({
      fs, dir: "/", oursSha: sha,
      overrides: [{ path: "a.txt", oid: newBlobOid, mode: "100644" }],
    })
    expect(await readBlobAt(fs, newTreeOid, "a.txt")).toBe("NEW")
    // Unaffected file still resolves.
    expect(await readBlobAt(fs, newTreeOid, "nested/b.txt")).toBe("bbb")
  })

  it("replaces a deeply nested blob", async () => {
    const { fs, sha } = await initFixture()
    const oid = await git.writeBlob({
      fs: fs as unknown as git.FsClient, dir: "/",
      blob: new TextEncoder().encode("DEEP-NEW"),
    })
    const newTreeOid = await buildTreeFromOursPlusOverrides({
      fs, dir: "/", oursSha: sha,
      overrides: [{ path: "nested/deep/c.txt", oid, mode: "100644" }],
    })
    expect(await readBlobAt(fs, newTreeOid, "nested/deep/c.txt")).toBe("DEEP-NEW")
    expect(await readBlobAt(fs, newTreeOid, "nested/b.txt")).toBe("bbb")
  })

  it("adds a new file that didn't exist in ours", async () => {
    const { fs, sha } = await initFixture()
    const oid = await git.writeBlob({
      fs: fs as unknown as git.FsClient, dir: "/",
      blob: new TextEncoder().encode("NEWFILE"),
    })
    const newTreeOid = await buildTreeFromOursPlusOverrides({
      fs, dir: "/", oursSha: sha,
      overrides: [{ path: "brandnew.txt", oid, mode: "100644" }],
    })
    expect(await readBlobAt(fs, newTreeOid, "brandnew.txt")).toBe("NEWFILE")
  })
})
