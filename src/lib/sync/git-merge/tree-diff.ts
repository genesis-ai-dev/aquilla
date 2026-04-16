// src/lib/sync/git-merge/tree-diff.ts
// Walk two commits' trees side-by-side and emit a flat list of entries where
// the two trees differ. Returning `null` from map would stop traversal into
// that subtree (iso-git's contract); we return `undefined` for dirs so the
// walker recurses, and return DiffEntry for files that actually differ.
import * as git from "isomorphic-git"
import type { OpfsFs } from "@/lib/git/opfs-fs"

export type DiffKind = "both-differ" | "ours-only" | "theirs-only"

export interface DiffEntry {
  path: string
  kind: DiffKind
  oursOid?: string
  theirsOid?: string
  mode: string
}

export interface BuildTreeDiffArgs {
  fs: OpfsFs
  dir: string
  oursSha: string
  theirsSha: string
}

export async function buildTreeDiff({
  fs, dir, oursSha, theirsSha,
}: BuildTreeDiffArgs): Promise<DiffEntry[]> {
  const result = await git.walk({
    fs: fs as unknown as git.FsClient,
    dir,
    trees: [git.TREE({ ref: oursSha }), git.TREE({ ref: theirsSha })],
    map: async (relpath, walkEntries) => {
      if (relpath === ".") return undefined
      const [ours, theirs] = walkEntries ?? []
      if (!ours && !theirs) return undefined

      const oursType = ours ? await ours.type() : null
      const theirsType = theirs ? await theirs.type() : null
      if (oursType === "tree" || theirsType === "tree") return undefined

      const oursOid = ours ? await ours.oid() : undefined
      const theirsOid = theirs ? await theirs.oid() : undefined
      if (oursOid === theirsOid) return undefined

      const modeNum = ours ? await ours.mode() : await theirs!.mode()
      const mode = modeNum.toString(8).padStart(6, "0")

      const kind: DiffKind =
        !oursOid ? "theirs-only" :
        !theirsOid ? "ours-only" :
        "both-differ"

      const entry: DiffEntry = { path: relpath, kind, mode }
      if (oursOid) entry.oursOid = oursOid
      if (theirsOid) entry.theirsOid = theirsOid
      return entry
    },
  })
  // The default reduce flat-maps children into parent — result is an array of
  // DiffEntry (or undefined, which the reducer filters out). Ensure array shape.
  return Array.isArray(result) ? (result as DiffEntry[]) : []
}
