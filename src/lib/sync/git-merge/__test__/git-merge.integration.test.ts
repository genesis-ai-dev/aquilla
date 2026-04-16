// Two-user end-to-end test: Alice and Bob edit the same cell from a shared
// base, Bob pushes first, Alice merges. The merged commit must contain BOTH
// edits — nothing is ever lost.
import { describe, it, expect } from "vitest"
import * as git from "isomorphic-git"
import { createOpfsFs, type OpfsFs } from "@/lib/git/opfs-fs"
import { MemoryDirectoryHandle } from "@/lib/git/__test__/mem-fs-handles"
import { mergeRemoteIntoOurs } from "../index"

function makeFs(): OpfsFs {
  const root = new MemoryDirectoryHandle("r")
  return createOpfsFs(root as unknown as FileSystemDirectoryHandle)
}

function cell(id: string, value: string, edits: unknown[] = []) {
  return { kind: 2, languageId: "html", value, metadata: { id, type: "text", edits } }
}

function nb(cells: ReturnType<typeof cell>[]) {
  return JSON.stringify({ cells, metadata: { id: "f", originalName: "f" } })
}

async function write(fs: OpfsFs, path: string, content: string) {
  await fs.promises.writeFile(path, content)
  await git.add({ fs: fs as unknown as git.FsClient, dir: "/", filepath: path.replace(/^\//, "") })
}

describe("two-user merge integration", () => {
  it("preserves both users' edits across a merge", async () => {
    const fs = makeFs()
    await git.init({ fs: fs as unknown as git.FsClient, dir: "/" })

    // 1. Base state.
    await write(fs, "/files/target/f.codex", nb([cell("c1", "base")]))
    const baseSha = await git.commit({
      fs: fs as unknown as git.FsClient, dir: "/",
      author: { name: "u", email: "u@u" }, message: "base",
    })

    // 2. Alice edits c1 with ts=10 on top of base.
    await write(fs, "/files/target/f.codex", nb([
      cell("c1", "alice-edit", [
        { editMap: ["value"], value: "alice-edit", timestamp: 10, author: "alice", type: "user-edit" },
      ]),
    ]))
    const aliceSha = await git.commit({
      fs: fs as unknown as git.FsClient, dir: "/",
      author: { name: "alice", email: "alice@a" }, message: "alice", parent: [baseSha],
    })

    // 3. Bob edits c1 with ts=20, also on top of base (simulating a parallel
    //    commit on the same branch tip). We stage bob's blob directly since
    //    we're modeling him as a separate writer in the same repo.
    await fs.promises.writeFile("/files/target/f.codex", nb([
      cell("c1", "bob-edit", [
        { editMap: ["value"], value: "bob-edit", timestamp: 20, author: "bob", type: "user-edit" },
      ]),
    ]))
    await git.add({ fs: fs as unknown as git.FsClient, dir: "/", filepath: "files/target/f.codex" })
    const bobSha = await git.commit({
      fs: fs as unknown as git.FsClient, dir: "/",
      author: { name: "bob", email: "bob@b" }, message: "bob", parent: [baseSha],
    })

    // 4. Alice merges bob's work into hers.
    const { mergeSha } = await mergeRemoteIntoOurs({
      fs, dir: "/",
      oursSha: aliceSha, theirsSha: bobSha,
      author: { name: "alice", email: "alice@a" },
    })

    // 5. Merge commit parents + merged file contents.
    const merge = await git.readCommit({ fs: fs as unknown as git.FsClient, dir: "/", oid: mergeSha })
    expect(merge.commit.parent).toEqual([aliceSha, bobSha])

    const { blob } = await git.readBlob({
      fs: fs as unknown as git.FsClient, dir: "/",
      oid: mergeSha, filepath: "files/target/f.codex",
    })
    const parsed = JSON.parse(new TextDecoder().decode(blob))

    const editValues = parsed.cells[0].metadata.edits
      .map((e: { value: string }) => e.value)
      .sort()
    expect(editValues).toEqual(["alice-edit", "bob-edit"])
    expect(parsed.cells[0].value).toBe("bob-edit") // latest timestamp wins
  })

  it("adopts a theirs-only file without conflict", async () => {
    const fs = makeFs()
    await git.init({ fs: fs as unknown as git.FsClient, dir: "/" })

    await write(fs, "/files/target/f.codex", nb([cell("c1", "base")]))
    const baseSha = await git.commit({
      fs: fs as unknown as git.FsClient, dir: "/",
      author: { name: "u", email: "u@u" }, message: "base",
    })

    // Ours: no changes.
    const oursSha = baseSha

    // Theirs: adds a new file.
    await write(fs, "/files/target/g.codex", nb([cell("c2", "their-new-file")]))
    const theirsSha = await git.commit({
      fs: fs as unknown as git.FsClient, dir: "/",
      author: { name: "u", email: "u@u" }, message: "theirs adds g", parent: [baseSha],
    })

    const { mergeSha, touchedPaths } = await mergeRemoteIntoOurs({
      fs, dir: "/",
      oursSha, theirsSha,
      author: { name: "me", email: "m@m" },
    })
    expect(touchedPaths).toContain("files/target/g.codex")

    const { blob } = await git.readBlob({
      fs: fs as unknown as git.FsClient, dir: "/",
      oid: mergeSha, filepath: "files/target/g.codex",
    })
    expect(new TextDecoder().decode(blob)).toContain("their-new-file")
  })
})
