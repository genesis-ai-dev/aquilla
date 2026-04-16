// src/lib/sync/git-merge/tree-write.ts
// Build a root tree by overlaying ours' commit tree with a set of blob
// overrides. Recursively rewrites intermediate tree objects so nested paths
// work.
import * as git from "isomorphic-git"
import type { OpfsFs } from "@/lib/git/opfs-fs"

export interface Override {
  path: string
  oid: string
  mode: string
}

export interface BuildTreeArgs {
  fs: OpfsFs
  dir: string
  oursSha: string
  overrides: Override[]
}

interface TreeEntry {
  mode: string
  path: string
  oid: string
  type: "blob" | "tree" | "commit"
}

interface OverlayNode {
  subdirs: Map<string, OverlayNode>
  files: Map<string, { oid: string; mode: string }>
}

function makeNode(): OverlayNode {
  return { subdirs: new Map(), files: new Map() }
}

export async function buildTreeFromOursPlusOverrides({
  fs, dir, oursSha, overrides,
}: BuildTreeArgs): Promise<string> {
  const commit = await git.readCommit({ fs: fs as unknown as git.FsClient, dir, oid: oursSha })
  const rootOid = commit.commit.tree

  if (overrides.length === 0) return rootOid

  const overlayRoot = makeNode()
  for (const o of overrides) {
    const parts = o.path.split("/").filter(Boolean)
    let cur = overlayRoot
    for (let i = 0; i < parts.length - 1; i++) {
      const name = parts[i]
      let child = cur.subdirs.get(name)
      if (!child) {
        child = makeNode()
        cur.subdirs.set(name, child)
      }
      cur = child
    }
    cur.files.set(parts[parts.length - 1], { oid: o.oid, mode: o.mode })
  }

  async function writeTreeAt(treeOid: string | null, overlay: OverlayNode): Promise<string> {
    const existing: TreeEntry[] = treeOid
      ? ((await git.readTree({ fs: fs as unknown as git.FsClient, dir, oid: treeOid })).tree as unknown as TreeEntry[])
      : []

    const byName = new Map<string, TreeEntry>()
    for (const e of existing) byName.set(e.path, e)

    for (const [name, fileOverride] of overlay.files.entries()) {
      byName.set(name, {
        mode: fileOverride.mode,
        path: name,
        oid: fileOverride.oid,
        type: "blob",
      })
    }

    for (const [name, sub] of overlay.subdirs.entries()) {
      const existingEntry = byName.get(name)
      const childTreeOid = existingEntry && existingEntry.type === "tree" ? existingEntry.oid : null
      const newSubOid = await writeTreeAt(childTreeOid, sub)
      byName.set(name, { mode: "040000", path: name, oid: newSubOid, type: "tree" })
    }

    const finalEntries = [...byName.values()].sort((a, b) => a.path < b.path ? -1 : 1)
    // git.writeTree returns an OID string directly (not {oid}).
    return git.writeTree({
      fs: fs as unknown as git.FsClient, dir,
      tree: finalEntries as unknown as Parameters<typeof git.writeTree>[0]["tree"],
    })
  }

  return writeTreeAt(rootOid, overlayRoot)
}
