// src/hooks/useCellAudio.ts
// React hook that loads per-cell LFS audio on demand. Owns the
// HTMLAudioElement lifecycle and revokes the object URL on unmount /
// selectedAudioId change.

import { useCallback, useEffect, useRef, useState } from "react"
import { createOpfsFs, openOpfsRepoDir } from "@/lib/git/opfs-fs"
import { opfsRepoKey, pathWithNamespaceFromCloneUrl } from "@/lib/git/repo-key"
import { parsePointerContent } from "@/lib/lfs/pointer"
import { lfsCacheGet, lfsCachePut } from "@/lib/lfs/cache"
import { downloadLfsBlob } from "@/lib/lfs/download"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import type { CodexCell } from "@/lib/codex-editor/types"
import type { ProjectRecord } from "@/lib/parsers/types"

export type AudioErrorKind =
  | "pointer-missing"
  | "pointer-invalid"
  | "batch-failed"
  | "download-failed"
  | "no-session"
  | "no-git-origin"

export interface AudioError {
  kind: AudioErrorKind
  message: string
}

export interface UseCellAudioResult {
  state: "idle" | "loading" | "ready" | "error"
  error: AudioError | null
  isPlaying: boolean
  play: () => Promise<void>
  pause: () => void
}

export function useCellAudio(
  project: ProjectRecord,
  cell: CodexCell,
): UseCellAudioResult {
  const { session } = useFrontierSession()
  const [state, setState] = useState<UseCellAudioResult["state"]>("idle")
  const [error, setError] = useState<AudioError | null>(null)
  const [isPlaying, setIsPlaying] = useState(false)

  const audioRef = useRef<HTMLAudioElement | null>(null)
  const urlRef = useRef<string | null>(null)

  const selectedAudioId = cell.metadata?.selectedAudioId
  const attachment = selectedAudioId
    ? cell.metadata?.attachments?.[selectedAudioId]
    : undefined
  const attachmentUrl = attachment?.url

  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause()
        audioRef.current = null
      }
      if (urlRef.current) {
        URL.revokeObjectURL(urlRef.current)
        urlRef.current = null
      }
      setState("idle")
      setIsPlaying(false)
      setError(null)
    }
  }, [selectedAudioId])

  const load = useCallback(async (): Promise<Uint8Array> => {
    if (!attachmentUrl) {
      throw { kind: "pointer-missing", message: "No audio attachment on this cell" } as AudioError
    }
    if (project.origin?.kind !== "git") {
      throw { kind: "no-git-origin", message: "Project has no git origin" } as AudioError
    }
    if (!session?.gitlabToken) {
      throw { kind: "no-session", message: "Not signed in" } as AudioError
    }

    const repoHandle = await openOpfsRepoDir(
      opfsRepoKey(
        project.origin.gitlabProjectId,
        pathWithNamespaceFromCloneUrl(project.origin.cloneUrl),
      ),
    )
    const repoFs = createOpfsFs(repoHandle)
    let pointerText: string
    try {
      const data = await repoFs.promises.readFile(attachmentUrl, { encoding: "utf8" })
      pointerText = typeof data === "string" ? data : new TextDecoder().decode(data)
    } catch {
      // The codex-editor metadata stores paths as `.project/attachments/files/...`
      // but the git repo may store them under `.project/attachments/pointers/...`.
      // Try the alternate path before giving up.
      const altUrl = attachmentUrl.replace("/attachments/files/", "/attachments/pointers/")
      try {
        const data = await repoFs.promises.readFile(altUrl, { encoding: "utf8" })
        pointerText = typeof data === "string" ? data : new TextDecoder().decode(data)
      } catch (e2) {
        throw {
          kind: "pointer-missing",
          message: `Could not read ${attachmentUrl} (also tried ${altUrl}): ${e2 instanceof Error ? e2.message : String(e2)}`,
        } as AudioError
      }
    }

    const pointer = parsePointerContent(pointerText)
    if (!pointer) {
      throw { kind: "pointer-invalid", message: `${attachmentUrl} is not a valid LFS pointer` } as AudioError
    }

    const cached = await lfsCacheGet(pointer.oid)
    if (cached) return cached

    try {
      const bytes = await downloadLfsBlob({
        cloneUrl: project.origin.cloneUrl,
        gitlabToken: session.gitlabToken,
        oid: pointer.oid,
        size: pointer.size,
      })
      try { await lfsCachePut(pointer.oid, bytes) } catch { /* non-fatal */ }
      return bytes
    } catch (e) {
      if (e && typeof e === "object" && "kind" in e) throw e as AudioError
      throw { kind: "download-failed", message: e instanceof Error ? e.message : String(e) } as AudioError
    }
  }, [attachmentUrl, project, session])

  const play = useCallback(async () => {
    if (audioRef.current) {
      try { await audioRef.current.play() } catch (e) {
        console.error("[useCellAudio] play() rejected", e)
      }
      return
    }
    setState("loading")
    setError(null)
    try {
      const bytes = await load()
      const blob = new Blob([bytes as BlobPart])
      const url = URL.createObjectURL(blob)
      urlRef.current = url
      const audio = new Audio(url)
      audio.onplay = () => setIsPlaying(true)
      audio.onpause = () => setIsPlaying(false)
      audio.onended = () => setIsPlaying(false)
      audioRef.current = audio
      setState("ready")
      try {
        await audio.play()
      } catch (e) {
        console.error("[useCellAudio] play() rejected on fresh audio", e)
      }
    } catch (e) {
      const err = (e && typeof e === "object" && "kind" in e)
        ? (e as AudioError)
        : { kind: "download-failed" as const, message: String(e) }
      console.error("[useCellAudio]", err)
      setError(err)
      setState("error")
    }
  }, [load])

  const pause = useCallback(() => {
    audioRef.current?.pause()
  }, [])

  return { state, error, isPlaying, play, pause }
}
