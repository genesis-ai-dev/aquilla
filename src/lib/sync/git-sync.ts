import * as git from "isomorphic-git"
import http from "isomorphic-git/http/web"
import { GIT_CORS_PROXY } from "@/lib/git/clone"
import { openOpfsRepoDir, createOpfsFs, type OpfsFs } from "@/lib/git/opfs-fs"
import { loadFileDoc, destroyFileDoc, type FileDocHandle } from "@/lib/store/file-doc"
import { serializeFile, serializeComments } from "@/lib/codex-editor/serialize"
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
  | "pushing"
  | "done"
  | "error"
  | "remote-moved"

export interface SyncResult {
  status: "synced" | "no-changes" | "remote-moved" | "error"
  commitSha?: string
  filesWritten?: number
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
  return `${p.origin.gitlabProjectId}-${p.origin.cloneUrl.split("/").slice(-2).join("_")}`
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
  const fs: OpfsFs = opts.fs ?? createOpfsFs(await openOpfsRepoDir(repoKey(project)))
  const authHeader = `Basic ${btoa(`oauth2:${session.gitlabToken}`)}`

  // 1) Fetch + compare heads.
  try {
    // Ensure origin is registered with a wildcard refspec. clone({singleBranch})
    // sometimes omits the refspec, which makes subsequent fetch() throw
    // NoRefspecError. addRemote with force:true rewrites config idempotently.
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
      depth: 1,
      corsProxy: GIT_CORS_PROXY,
      headers: { Authorization: authHeader },
      onAuth: () => ({ username: "oauth2", password: session.gitlabToken }),
      onAuthFailure: () => {
        console.error("[sync] auth rejected by remote")
        return { cancel: true }
      },
    })
    const remoteHead = await git.resolveRef({
      fs: fs as unknown as git.FsClient,
      dir: "/",
      ref: `refs/remotes/origin/${project.origin.branch}`,
    })
    if (remoteHead !== project.origin.headSha) {
      onPhase?.("remote-moved")
      return {
        status: "remote-moved",
        message: "Remote has new commits. Sync requires Phase 3 (merge).",
      }
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

    if (filesWritten === 0) {
      return { status: "no-changes" }
    }

    // 4) Stage + commit + push.
    onPhase?.("committing")
    await git.add({ fs: fs as unknown as git.FsClient, dir: "/", filepath: "." })
    const commitSha = await git.commit({
      fs: fs as unknown as git.FsClient,
      dir: "/",
      message: buildCommitMessage(filesChanged),
      author: { name: session.username, email: `${session.username}@frontier` },
    })

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

    // 5) Bump __lastSyncedHistoryAt on every cell across every doc. Writes
    // through to IndexedDB via the open IndexeddbPersistence.
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

    // 6) Update ProjectRecord.origin.headSha.
    const updated: ProjectRecord = {
      ...project,
      origin: { ...project.origin, headSha: commitSha },
    }
    await updateProject(updated)

    onPhase?.("done")
    return { status: "synced", commitSha, filesWritten }
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
