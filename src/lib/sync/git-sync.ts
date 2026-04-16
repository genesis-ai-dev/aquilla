import * as git from "isomorphic-git"
import http from "isomorphic-git/http/web"
import { GIT_CORS_PROXY } from "@/lib/git/clone"
import type { OpfsFs } from "@/lib/git/opfs-fs"
import { getFsProvider } from "@/lib/fs"
import { opfsRepoKey, pathWithNamespaceFromCloneUrl } from "@/lib/git/repo-key"
import { loadFileDoc, destroyFileDoc, rehydrateFileDoc, type FileDocHandle } from "@/lib/store/file-doc"
import { serializeFile, serializeComments } from "@/lib/codex-editor/serialize"
import { parseCodexNotebook } from "@/lib/codex-editor/parse-codex"
import { mergeRemoteIntoOurs, MergeFailure } from "./git-merge"
import { isFileDirty } from "./dirty"
import { buildCommitMessage } from "./commit-message"
import { updateProject } from "@/lib/store/project-index"
import type { FrontierSession } from "@/lib/frontier/types"
import type { ProjectRecord } from "@/lib/parsers/types"
import * as Y from "yjs"

export type SyncPhase =
  | "idle"
  | "checking-dirty"
  | "serializing"
  | "writing"
  | "committing"
  | "merging"
  | "rehydrating"
  | "pushing"
  | "done"
  | "error"
  | "remote-moved"

export interface SyncResult {
  status: "synced" | "no-changes" | "remote-moved" | "merged" | "error"
  commitSha?: string
  mergeSha?: string
  touchedPaths?: string[]
  filesWritten?: number
  backupRef?: string
  message?: string
}

export interface SyncOptions {
  signal?: AbortSignal
  onPhase?: (phase: SyncPhase, label?: string) => void
  /**
   * Test seam: when set, use this fs instead of opening OPFS. Lets tests
   * plumb a MemoryDirectoryHandle-backed fs into syncProject without any
   * OPFS access.
   */
  fs?: OpfsFs
}

function repoKey(p: ProjectRecord): string {
  if (p.origin?.kind !== "git") throw new Error("syncProject: project has no git origin")
  return opfsRepoKey(p.origin.gitlabProjectId, pathWithNamespaceFromCloneUrl(p.origin.cloneUrl))
}

export async function syncProject(
  project: ProjectRecord,
  session: FrontierSession,
  opts: SyncOptions = {},
): Promise<SyncResult> {
  const { onPhase } = opts
  if (project.origin?.kind !== "git") {
    return { status: "error", message: "Project has no git origin" }
  }

  onPhase?.("checking-dirty")
  const fs: OpfsFs = opts.fs ?? await getFsProvider(repoKey(project))
  const authHeader = `Basic ${btoa(`oauth2:${session.gitlabToken}`)}`

  // 1) Fetch + detect remote movement (but don't early-return on it — Phase 3
  //    resolves via mergeRemoteIntoOurs after we've committed ours locally).
  let remoteHead: string
  let remoteMoved: boolean
  try {
    await git.addRemote({
      fs: fs as unknown as git.FsClient,
      dir: "/",
      remote: "origin",
      url: project.origin.cloneUrl,
      force: true,
    })

    await git.fetch({
      fs: fs as unknown as git.FsClient,
      http,
      dir: "/",
      remote: "origin",
      ref: project.origin.branch,
      singleBranch: true,
      // Two-way merge doesn't need history; only the tip trees + blobs matter.
      depth: 1,
      corsProxy: GIT_CORS_PROXY,
      headers: { Authorization: authHeader },
      onAuth: () => ({ username: "oauth2", password: session.gitlabToken }),
      onAuthFailure: () => {
        console.error("[sync] auth rejected by remote")
        return { cancel: true }
      },
    })
    remoteHead = await git.resolveRef({
      fs: fs as unknown as git.FsClient,
      dir: "/",
      ref: `refs/remotes/origin/${project.origin.branch}`,
    })
    remoteMoved = remoteHead !== project.origin.headSha
    if (remoteMoved) {
      console.warn("[sync] remote moved — will merge after local commit",
        { local: project.origin.headSha, remote: remoteHead })
    }
  } catch (e) {
    console.error("[sync] fetch failed:", e)
    return {
      status: "error",
      message: `Fetch failed: ${e instanceof Error ? e.message : String(e)}`,
    }
  }

  // 2) Load all file docs.
  onPhase?.("serializing")
  const fileHandles: Array<{ ref: ProjectRecord["files"][number]; handle: FileDocHandle }> =
    await Promise.all(
      project.files.map(async (f) => {
        const handle = loadFileDoc(f.id)
        await new Promise<void>((r) => {
          if (handle.persistence.synced) r()
          else handle.persistence.once("synced", () => r())
        })
        return { ref: f, handle }
      }),
    )

  try {
    // 3) Serialize + write each dirty file.
    onPhase?.("writing")
    const filesChanged: Array<{ name: string; cellsChanged: number }> = []
    const dirtyDocs: Y.Doc[] = []
    let filesWritten = 0
    for (const { ref, handle } of fileHandles) {
      if (!isFileDirty(handle.doc)) continue
      dirtyDocs.push(handle.doc)
      const onDiskPath = findOriginalPath(project, ref.name) ?? `/files/target/${ref.name}.codex`
      const serialized = serializeFile(handle.doc)
      const text = JSON.stringify(serialized, null, 2)
      const existing = (await fs.promises
        .readFile(onDiskPath, { encoding: "utf8" })
        .catch(() => null)) as string | null
      if (existing === text) continue
      await fs.promises.writeFile(onDiskPath, text)
      filesWritten++
      filesChanged.push({ name: ref.name, cellsChanged: countDirtyCells(handle.doc) })
    }

    // Comments: only write if the serialized output differs from disk.
    const allDocs = fileHandles.map((h) => h.handle.doc)
    const commentsJson = serializeComments(allDocs)
    const commentsText = JSON.stringify(commentsJson, null, 2)
    const commentsPath = findCommentsPath(project) ?? "/.project/comments.json"
    const existingComments = (await fs.promises
      .readFile(commentsPath, { encoding: "utf8" })
      .catch(() => null)) as string | null
    if (existingComments !== null && existingComments !== commentsText) {
      await fs.promises.writeFile(commentsPath, commentsText)
      filesWritten++
    }

    if (filesWritten === 0 && !remoteMoved) {
      return { status: "no-changes" }
    }

    // 4) Stage + commit (skip commit if nothing was written locally; we'll
    //    fast-forward to remoteHead in the merge step below).
    onPhase?.("committing")
    const fsClient = fs as unknown as git.FsClient
    let oursSha = project.origin.headSha
    if (filesWritten > 0) {
      const status = await git.statusMatrix({ fs: fsClient, dir: "/" })
      for (const [filepath, head, workdir, stage] of status) {
        if (workdir === stage) continue
        if (workdir === 0) {
          await git.remove({ fs: fsClient, dir: "/", filepath })
        } else {
          await git.add({ fs: fsClient, dir: "/", filepath })
        }
        void head
      }
      oursSha = await git.commit({
        fs: fs as unknown as git.FsClient,
        dir: "/",
        message: buildCommitMessage(filesChanged),
        author: { name: session.username, email: `${session.username}@frontier` },
      })
    }

    // 5) Merge remote into ours if remote moved. mergeRemoteIntoOurs produces
    //    a two-parent merge commit whose tree is ours+theirs per-path resolved.
    let finalSha = oursSha
    let mergeSha: string | undefined
    let touchedPaths: string[] = []
    if (remoteMoved) {
      onPhase?.("merging")
      try {
        const result = await mergeRemoteIntoOurs({
          fs, dir: "/",
          oursSha, theirsSha: remoteHead,
          author: { name: session.username, email: `${session.username}@frontier` },
        })
        mergeSha = result.mergeSha
        touchedPaths = result.touchedPaths
        finalSha = mergeSha
      } catch (e) {
        if (e instanceof MergeFailure) {
          return { status: "error", message: e.message, backupRef: e.backupRef }
        }
        throw e
      }
    }

    // 6) Push if we produced new commits locally.
    if (filesWritten > 0 || mergeSha) {
      onPhase?.("pushing")
      await git.push({
        fs: fs as unknown as git.FsClient,
        http,
        dir: "/",
        remote: "origin",
        ref: project.origin.branch,
        corsProxy: GIT_CORS_PROXY,
        headers: { Authorization: authHeader },
        onAuth: () => ({ username: "oauth2", password: session.gitlabToken }),
        onAuthFailure: () => {
          console.error("[sync] push auth rejected by remote")
          return { cancel: true }
        },
      })
    }

    // 7) Rehydrate touched Y.Docs from the merged tree's canonical bytes.
    //    Done in parallel — each rehydrate is independent and reads a
    //    different blob.
    if (touchedPaths.length > 0) {
      onPhase?.("rehydrating")
      const syncedAt = Date.now()
      await Promise.all(touchedPaths.map(async (relpath) => {
        if (!relpath.endsWith(".codex") && !relpath.endsWith(".source")) return
        const fullPath = "/" + relpath
        const match = fileHandles.find(
          (h) => findOriginalPath(project, h.ref.name) === fullPath,
        )
        if (!match) return
        try {
          const { blob } = await git.readBlob({
            fs: fs as unknown as git.FsClient,
            dir: "/",
            oid: finalSha,
            filepath: relpath,
          })
          const merged = parseCodexNotebook(new TextDecoder().decode(blob))
          rehydrateFileDoc(match.handle.doc, merged, syncedAt)
        } catch (err) {
          console.warn(`[sync] could not rehydrate ${relpath}:`, err)
        }
      }))
    }

    // 8) Bump __lastSyncedHistoryAt on non-rehydrated docs so the next sync
    //    doesn't re-serialize already-pushed edits.
    if (touchedPaths.length === 0) {
      const now = Date.now()
      for (const { handle } of fileHandles) {
        const cellsMap = handle.doc.getMap("cells")
        handle.doc.transact(() => {
          for (const id of cellsMap.keys()) {
            const c = cellsMap.get(id) as Y.Map<unknown> | undefined
            if (!c) continue
            c.set("__lastSyncedHistoryAt", now)
          }
        })
      }
    }

    // 9) Update ProjectRecord.origin.headSha.
    const updated: ProjectRecord = {
      ...project,
      origin: { ...project.origin, headSha: finalSha },
    }
    await updateProject(updated)

    onPhase?.("done")
    return mergeSha
      ? { status: "merged", commitSha: finalSha, mergeSha, touchedPaths, filesWritten }
      : { status: "synced", commitSha: finalSha, filesWritten }
  } catch (e) {
    console.error("[sync] serialize/commit/push failed:", e)
    return {
      status: "error",
      message: e instanceof Error ? e.message : String(e),
    }
  } finally {
    for (const { handle } of fileHandles) destroyFileDoc(handle)
  }
}

/**
 * Locate the on-disk path (relative to repo root, with leading "/") for a
 * codex file given its stem. `originalFileListing` keys include whatever
 * repoDir prefix existed at import time (e.g. "/repo/files/target/foo.codex");
 * we search for a key ending with `/{name}.codex` and strip the prefix back
 * to `/files/`. Returns null if nothing matches.
 */
export function findOriginalPath(project: ProjectRecord, fileName: string): string | null {
  const listing = project.originalFileListing
  if (!listing) return null
  const needle = `/${fileName}.codex`
  for (const key of Object.keys(listing)) {
    if (!key.endsWith(needle)) continue
    const idx = key.indexOf("/files/")
    if (idx >= 0) return key.slice(idx)
    // Fall back: unknown layout — return as-is.
    return key.startsWith("/") ? key : `/${key}`
  }
  return null
}

function findCommentsPath(project: ProjectRecord): string | null {
  const listing = project.originalFileListing
  if (!listing) return null
  for (const key of Object.keys(listing)) {
    if (!key.endsWith("/.project/comments.json")) continue
    const idx = key.indexOf("/.project/")
    return key.slice(idx)
  }
  return null
}

function countDirtyCells(doc: Y.Doc): number {
  const cellsMap = doc.getMap("cells")
  let n = 0
  for (const id of cellsMap.keys()) {
    const c = cellsMap.get(id) as Y.Map<unknown> | undefined
    if (!c) continue
    const lastSynced = (c.get("__lastSyncedHistoryAt") as number) ?? 0
    const histArr = c.get("history") as Y.Array<{ timestamp: string }> | undefined
    if (histArr) {
      for (const e of histArr.toArray()) {
        if (Date.parse(e.timestamp) > lastSynced) {
          n++
          break
        }
      }
    }
  }
  return n
}
