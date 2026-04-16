import { describe, it, expect, beforeEach } from "vitest"
import * as git from "isomorphic-git"
import { createOpfsFs, type OpfsFs } from "@/lib/git/opfs-fs"
import { MemoryDirectoryHandle } from "@/lib/git/__test__/mem-fs-handles"
import { mergeRemoteIntoOurs } from "../index"

function makeFs(): OpfsFs {
  const root = new MemoryDirectoryHandle("r")
  return createOpfsFs(root as unknown as FileSystemDirectoryHandle)
}

async function write(fs: OpfsFs, path: string, content: string) {
  await fs.promises.writeFile(path, content)
  await git.add({ fs: fs as unknown as git.FsClient, dir: "/", filepath: path.replace(/^\//, "") })
}

async function commit(fs: OpfsFs, msg: string, parent?: string[]) {
  return git.commit({
    fs: fs as unknown as git.FsClient, dir: "/",
    author: { name: "t", email: "t@t" }, message: msg, parent,
  })
}

describe("mergeRemoteIntoOurs", () => {
  let fs: OpfsFs
  beforeEach(async () => { fs = makeFs(); await git.init({ fs: fs as unknown as git.FsClient, dir: "/" }) })

  it("produces a two-parent merge commit whose tree includes overrides", async () => {
    const baseNb = JSON.stringify({
      cells: [{ kind: 2, languageId: "html", value: "hi", metadata: { id: "c1", type: "text", edits: [] } }],
      metadata: { id: "f", originalName: "f" },
    })
    await write(fs, "/files/target/f.codex", baseNb)
    const baseSha = await commit(fs, "base")

    const oursNb = JSON.stringify({
      cells: [{ kind: 2, languageId: "html", value: "ours", metadata: { id: "c1", type: "text",
        edits: [{ editMap: ["value"], value: "ours", timestamp: 10, author: "a", type: "user-edit" }] } }],
      metadata: { id: "f", originalName: "f" },
    })
    await write(fs, "/files/target/f.codex", oursNb)
    const oursSha = await commit(fs, "ours", [baseSha])

    const theirsNb = JSON.stringify({
      cells: [{ kind: 2, languageId: "html", value: "theirs", metadata: { id: "c1", type: "text",
        edits: [{ editMap: ["value"], value: "theirs", timestamp: 20, author: "b", type: "user-edit" }] } }],
      metadata: { id: "f", originalName: "f" },
    })
    await fs.promises.writeFile("/files/target/f.codex", theirsNb)
    await git.add({ fs: fs as unknown as git.FsClient, dir: "/", filepath: "files/target/f.codex" })
    const theirsSha = await git.commit({
      fs: fs as unknown as git.FsClient, dir: "/",
      author: { name: "b", email: "b@b" }, message: "theirs", parent: [baseSha],
    })

    const { mergeSha, touchedPaths } = await mergeRemoteIntoOurs({
      fs, dir: "/",
      oursSha, theirsSha,
      author: { name: "t", email: "t@t" },
    })

    expect(touchedPaths).toContain("files/target/f.codex")

    const merge = await git.readCommit({ fs: fs as unknown as git.FsClient, dir: "/", oid: mergeSha })
    expect(merge.commit.parent).toEqual([oursSha, theirsSha])

    const { blob } = await git.readBlob({
      fs: fs as unknown as git.FsClient, dir: "/",
      oid: mergeSha, filepath: "files/target/f.codex",
    })
    const parsed = JSON.parse(new TextDecoder().decode(blob))
    expect(parsed.cells[0].metadata.edits.map((e: { value: string }) => e.value).sort())
      .toEqual(["ours", "theirs"])
    expect(parsed.cells[0].value).toBe("theirs")
  })

  it("on resolver throw creates a backup ref and throws", async () => {
    await write(fs, "/bad.json", JSON.stringify({ x: 1 }))
    const baseSha = await commit(fs, "base")
    await write(fs, "/bad.json", JSON.stringify({ x: 2 }))
    const oursSha = await commit(fs, "ours", [baseSha])
    await fs.promises.writeFile("/bad.json", "{not valid json")
    await git.add({ fs: fs as unknown as git.FsClient, dir: "/", filepath: "bad.json" })
    const theirsSha = await git.commit({
      fs: fs as unknown as git.FsClient, dir: "/",
      author: { name: "b", email: "b@b" }, message: "theirs", parent: [baseSha],
    })

    await expect(
      mergeRemoteIntoOurs({ fs, dir: "/", oursSha, theirsSha, author: { name: "t", email: "t@t" } }),
    ).rejects.toThrow(/couldn't auto-merge/i)

    const refs = await git.listBranches({ fs: fs as unknown as git.FsClient, dir: "/" })
    const backup = refs.find(r => r.startsWith("codex-web/backup-"))
    expect(backup).toBeTruthy()
    const backupOid = await git.resolveRef({
      fs: fs as unknown as git.FsClient, dir: "/", ref: `refs/heads/${backup}`,
    })
    expect(backupOid).toBe(oursSha)
  })
})
