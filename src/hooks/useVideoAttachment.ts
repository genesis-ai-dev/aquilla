import { useEffect, useState, useCallback } from "react"
import * as Y from "yjs"
import { getVideoBlob } from "@/lib/video/video-store"
import type { VideoAttachment } from "@/lib/parsers/types"

/**
 * Reads the video attachment metadata from a file's Y.Doc (meta map),
 * resolves the source URL (blob URL for local files, or the stored URL),
 * and exposes a save handler that writes back to the meta map.
 */
export function useVideoAttachment(doc: Y.Doc | null) {
  const [attachment, setAttachment] = useState<VideoAttachment>({})
  const [resolvedSrc, setResolvedSrc] = useState<string | null>(null)
  const [blobUnavailable, setBlobUnavailable] = useState(false)

  // Subscribe to meta map changes
  useEffect(() => {
    if (!doc) {
      setAttachment({})
      return
    }
    const meta = doc.getMap("meta")
    function readAttachment() {
      setAttachment({
        videoUrl: (meta.get("videoUrl") as string | undefined) || undefined,
        videoLocalFileId: (meta.get("videoLocalFileId") as string | undefined) || undefined,
        videoFileName: (meta.get("videoFileName") as string | undefined) || undefined,
      })
    }
    readAttachment()
    meta.observe(readAttachment)
    return () => { meta.unobserve(readAttachment) }
  }, [doc])

  // Resolve source URL: prefer local blob if we have it, else fall back to URL
  useEffect(() => {
    let cancelled = false
    let objectUrlToRevoke: string | null = null

    async function resolve() {
      setBlobUnavailable(false)
      if (attachment.videoLocalFileId) {
        const blob = await getVideoBlob(attachment.videoLocalFileId)
        if (cancelled) return
        if (blob) {
          const url = URL.createObjectURL(blob)
          objectUrlToRevoke = url
          setResolvedSrc(url)
          return
        }
        // Blob not available on this device — fall through to URL if any
        setBlobUnavailable(true)
      }
      if (attachment.videoUrl) {
        setResolvedSrc(attachment.videoUrl)
      } else {
        setResolvedSrc(null)
      }
    }
    resolve()

    return () => {
      cancelled = true
      if (objectUrlToRevoke) URL.revokeObjectURL(objectUrlToRevoke)
    }
  }, [attachment.videoLocalFileId, attachment.videoUrl])

  const save = useCallback((next: VideoAttachment | null) => {
    if (!doc) return
    const meta = doc.getMap("meta")
    doc.transact(() => {
      if (!next) {
        meta.delete("videoUrl")
        meta.delete("videoLocalFileId")
        meta.delete("videoFileName")
        return
      }
      if (next.videoUrl !== undefined) meta.set("videoUrl", next.videoUrl)
      else meta.delete("videoUrl")
      if (next.videoLocalFileId !== undefined) meta.set("videoLocalFileId", next.videoLocalFileId)
      else meta.delete("videoLocalFileId")
      if (next.videoFileName !== undefined) meta.set("videoFileName", next.videoFileName)
      else meta.delete("videoFileName")
    })
  }, [doc])

  return { attachment, resolvedSrc, blobUnavailable, save }
}
