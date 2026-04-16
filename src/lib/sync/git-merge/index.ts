// src/lib/sync/git-merge/index.ts
// Orchestrator for the Phase 3 merge. Produces a two-parent merge commit whose
// tree merges ours + theirs via per-path two-way resolvers. On resolver
// failure, stashes a backup branch at oursSha and throws — nothing is lost.
import * as git from "isomorphic-git"
import type { OpfsFs } from "@/lib/git/opfs-fs"
import { buildTreeDiff } from "./tree-diff"
import { buildTreeFromOursPlusOverrides, type Override } from "./tree-write"
import { resolveTwoWay } from "@/lib/codex-editor/merge/resolvers"

export interface MergeArgs {
  fs: OpfsFs
  dir: string
  oursSha: string
  theirsSha: string
  author: { name: string; email: string }
  message?: string
}

export interface MergeResult {
  mergeSha: string
  touchedPaths: string[]
}

export class MergeFailure extends Error {
  backupRef?: string
  constructor(message: string, opts: { backupRef?: string } = {}) {
    super(message)
    this.name = "MergeFailure"
    this.backupRef = opts.backupRef
  }
}

async function readBlobText(fs: OpfsFs, dir: string, oid: string): Promise<string> {
  const { blob } = await git.readBlob({ fs: fs as unknown as git.FsClient, dir, oid })
  return new TextDecoder().decode(blob)
}

async function writeBlobText(fs: OpfsFs, dir: string, text: string): Promise<string> {
  return git.writeBlob({
    fs: fs as unknown as git.FsClient, dir,
    blob: new TextEncoder().encode(text),
  })
}

export async function mergeRemoteIntoOurs({
  fs, dir, oursSha, theirsSha, author, message,
}: MergeArgs): Promise<MergeResult> {
  const diff = await buildTreeDiff({ fs, dir, oursSha, theirsSha })
  const overrides: Override[] = []
  const touchedPaths: string[] = []
  const failures: Array<{ path: string; reason: string }> = []

  for (const entry of diff) {
    if (entry.kind === "ours-only") continue
    if (entry.kind === "theirs-only") {
      overrides.push({ path: entry.path, oid: entry.theirsOid!, mode: entry.mode })
      touchedPaths.push(entry.path)
      continue
    }
    try {
      const ourText = await readBlobText(fs, dir, entry.oursOid!)
      const theirText = await readBlobText(fs, dir, entry.theirsOid!)
      const resolved = await resolveTwoWay(entry.path, ourText, theirText)
      if (resolved === ourText) continue
      const newOid = await writeBlobText(fs, dir, resolved)
      overrides.push({ path: entry.path, oid: newOid, mode: entry.mode })
      touchedPaths.push(entry.path)
    } catch (e) {
      failures.push({
        path: entry.path,
        reason: e instanceof Error ? e.message : String(e),
      })
    }
  }

  if (failures.length > 0) {
    const backupRef = `codex-web/backup-${new Date().toISOString().replace(/[:.]/g, "-")}`
    await git.writeRef({
      fs: fs as unknown as git.FsClient, dir,
      ref: `refs/heads/${backupRef}`,
      value: oursSha, force: true,
    })
    const summary = failures.map(f => `  • ${f.path}: ${f.reason}`).join("\n")
    throw new MergeFailure(
      `Couldn't auto-merge ${failures.length} file(s) — your work is safe on branch ${backupRef}.\n${summary}`,
      { backupRef },
    )
  }

  const mergeTreeOid = await buildTreeFromOursPlusOverrides({ fs, dir, oursSha, overrides })

  const mergeSha = await git.commit({
    fs: fs as unknown as git.FsClient, dir,
    tree: mergeTreeOid,
    parent: [oursSha, theirsSha],
    author, committer: author,
    message: message ?? `merge: sync with ${theirsSha.slice(0, 7)}`,
  })

  return { mergeSha, touchedPaths }
}
