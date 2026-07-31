// Media-lens empty state for a time-ordered file: attach a clip to THIS file
// by uploading audio/video bytes, or by linking a direct media URL (streamed
// from its source — only timing/metadata is captured, nothing is copied).
//
// Replaces the old prose-only hint, which pointed at the Import dialog — that
// flow always creates a NEW time-ordered file and can't populate this one.

import { useState } from "react"
import { FileAudio } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { detectFileType, isMediaFileType } from "@/lib/parsers/types"

/** Same audio/video extensions the Import dialog accepts. */
const MEDIA_FILE_ACCEPT = ".mp3,.wav,.m4a,.aac,.flac,.ogg,.oga,.opus,.mp4,.m4v,.mov,.webm,.mkv"

interface TimelineAddMediaProps {
  onAttachFile: (file: File) => Promise<void>
  onAttachUrl: (url: string) => Promise<void>
}

export function TimelineAddMedia({ onAttachFile, onAttachUrl }: TimelineAddMediaProps) {
  const [busy, setBusy] = useState<"file" | "url" | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [url, setUrl] = useState("")

  const attachFile = async (file: File) => {
    const type = detectFileType(file.name)
    if (!type || !isMediaFileType(type)) {
      setError(`"${file.name}" isn't a supported audio/video format.`)
      return
    }
    setBusy("file")
    setError(null)
    try {
      await onAttachFile(file)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const attachUrl = async () => {
    if (!url.trim() || busy) return
    setBusy("url")
    setError(null)
    try {
      await onAttachUrl(url)
      setUrl("")
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="mx-auto w-full max-w-md px-4 py-10">
      <div
        className={cn(
          "flex flex-col items-center rounded-lg border-2 border-dashed p-6 text-center transition-colors",
          dragOver ? "border-primary bg-primary/5" : "border-muted",
        )}
        onDragOver={(e) => {
          e.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragOver(false)
          const file = e.dataTransfer.files?.[0]
          if (file && !busy) void attachFile(file)
        }}
      >
        {busy === "file" ? (
          <p className="flex items-center gap-2 text-sm font-medium">
            <Spinner /> Adding media to this file…
          </p>
        ) : (
          <>
            <FileAudio className="mb-2 h-6 w-6 text-muted-foreground" />
            <p className="text-sm font-medium">No media on this file yet</p>
            <p className="mt-1 text-xs text-muted-foreground">Drag & drop an audio or video file here, or</p>
            <Button
              variant="outline"
              size="sm"
              className="mt-2"
              nativeButton={false}
              render={<label />}
            >
              Choose media file
              <input
                type="file"
                className="hidden"
                accept={MEDIA_FILE_ACCEPT}
                disabled={busy != null}
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  e.target.value = ""
                  if (file) void attachFile(file)
                }}
              />
            </Button>
          </>
        )}
      </div>

      <div className="mt-3">
        <div className="flex items-center gap-2">
          <Input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void attachUrl()
            }}
            placeholder="https://example.com/episode.mp4"
            disabled={busy != null}
            aria-label="Media URL"
            className="h-8 text-sm"
          />
          <Button size="sm" variant="outline" onClick={() => void attachUrl()} disabled={busy != null || !url.trim()}>
            {busy === "url" ? <Spinner /> : "Attach"}
          </Button>
        </div>
        <p className="mt-1.5 text-xs text-muted-foreground">
          Or paste a direct media URL — the clip streams from its source; only timing metadata is stored.
        </p>
      </div>

      {error && <p className="mt-2 text-center text-xs text-destructive">{error}</p>}
    </div>
  )
}
