import { useEffect, useState, useRef } from "react"
import { Film, Upload, Link as LinkIcon, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { Input } from "@/components/ui/input"
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog"
import { storeVideoBlob, deleteVideoBlob } from "@/lib/video/video-store"
import { v4 as uuid } from "uuid"
import { cn } from "@/lib/utils"
import type { VideoAttachment } from "@/lib/parsers/types"

interface VideoAttachmentDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  current: VideoAttachment
  onSave: (attachment: VideoAttachment | null) => void
}

type Tab = "url" | "upload"

export function VideoAttachmentDialog({ open, onOpenChange, current, onSave }: VideoAttachmentDialogProps) {
  const [tab, setTab] = useState<Tab>(current.videoUrl ? "url" : "upload")
  const [urlInput, setUrlInput] = useState(current.videoUrl || "")
  const [fileNameInput, setFileNameInput] = useState(current.videoFileName || "")
  const [offsetInput, setOffsetInput] = useState<string>(
    current.videoStartOffset !== undefined ? String(current.videoStartOffset) : ""
  )
  const [uploading, setUploading] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) {
      setTab(current.videoUrl ? "url" : "upload")
      setUrlInput(current.videoUrl || "")
      setFileNameInput(current.videoFileName || "")
      setOffsetInput(current.videoStartOffset !== undefined ? String(current.videoStartOffset) : "")
      setError(null)
    }
  }, [open, current.videoUrl, current.videoFileName, current.videoStartOffset])

  function parseOffset(): number | undefined {
    const trimmed = offsetInput.trim()
    if (!trimmed) return undefined
    const n = Number(trimmed)
    if (!isFinite(n)) return undefined
    return n
  }

  async function handleRemove() {
    if (current.videoLocalFileId) {
      try { await deleteVideoBlob(current.videoLocalFileId) } catch { /* ignore */ }
    }
    onSave(null)
    onOpenChange(false)
  }

  async function handleSaveUrl() {
    const trimmed = urlInput.trim()
    if (!trimmed) {
      setError("Enter a video URL")
      return
    }
    // If they had a local file before, clean it up
    if (current.videoLocalFileId) {
      try { await deleteVideoBlob(current.videoLocalFileId) } catch { /* ignore */ }
    }
    onSave({
      videoUrl: trimmed,
      videoFileName: fileNameInput.trim() || undefined,
      videoStartOffset: parseOffset(),
    })
    onOpenChange(false)
  }

  async function handleFile(file: File) {
    setUploading(true)
    setError(null)
    try {
      // Replace any existing local blob
      if (current.videoLocalFileId) {
        try { await deleteVideoBlob(current.videoLocalFileId) } catch { /* ignore */ }
      }
      const id = uuid()
      await storeVideoBlob(id, file)
      onSave({
        videoLocalFileId: id,
        videoFileName: file.name,
        videoStartOffset: parseOffset(),
      })
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed")
    } finally {
      setUploading(false)
    }
  }

  function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (file) handleFile(file)
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault()
    setDragOver(false)
    const file = e.dataTransfer.files?.[0]
    if (file) handleFile(file)
  }

  const currentLabel = current.videoUrl
    ? (current.videoFileName || current.videoUrl)
    : current.videoLocalFileId
      ? (current.videoFileName || "Uploaded video")
      : null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Film className="h-5 w-5" /> Attach Video
          </DialogTitle>
        </DialogHeader>

        {currentLabel && (
          <div className="space-y-2 rounded border bg-muted/30 p-2">
            <div className="flex items-center gap-2">
              <div className="flex-1 min-w-0">
                <p className="text-xs text-muted-foreground">Currently attached</p>
                <p className="text-sm truncate">{currentLabel}</p>
              </div>
              <Button variant="ghost" size="icon-sm" onClick={handleRemove} title="Remove attachment" aria-label="Remove attachment">
                <Trash2 className="text-destructive" />
              </Button>
            </div>
            <Field orientation="horizontal" className="items-center gap-2">
              <FieldLabel htmlFor="vstart" className="text-xs whitespace-nowrap">
                Start offset (s)
              </FieldLabel>
              <Input
                id="vstart"
                type="number"
                step="0.1"
                value={offsetInput}
                onChange={(e) => setOffsetInput(e.target.value)}
                placeholder="0"
                className="h-7 w-24 text-xs"
              />
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  onSave({
                    videoUrl: current.videoUrl,
                    videoLocalFileId: current.videoLocalFileId,
                    videoFileName: current.videoFileName,
                    videoStartOffset: parseOffset(),
                  })
                  onOpenChange(false)
                }}
                className="h-7 text-xs"
              >
                Save offset
              </Button>
            </Field>
            <FieldDescription className="text-[11px]">
              Seconds to wait before cues align. If your video has an intro, set this
              to the duration of the intro so subtitles line up correctly.
            </FieldDescription>
          </div>
        )}

        <div className="flex gap-1 border-b">
          <button
            type="button"
            onClick={() => setTab("url")}
            className={cn(
              "flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm",
              tab === "url" ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"
            )}
          >
            <LinkIcon className="h-3.5 w-3.5" /> From URL
          </button>
          <button
            type="button"
            onClick={() => setTab("upload")}
            className={cn(
              "flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm",
              tab === "upload" ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"
            )}
          >
            <Upload className="h-3.5 w-3.5" /> Upload file
          </button>
        </div>

        {tab === "url" ? (
          <FieldGroup className="space-y-3">
            <Field>
              <FieldLabel htmlFor="vurl">Video URL</FieldLabel>
              <Input
                id="vurl"
                value={urlInput}
                onChange={(e) => setUrlInput(e.target.value)}
                placeholder="https://example.com/video.mp4"
              />
              <FieldDescription>
                Direct video URL (MP4, WebM, etc). URL syncs across collaborators.
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="vname">Display name (optional)</FieldLabel>
              <Input
                id="vname"
                value={fileNameInput}
                onChange={(e) => setFileNameInput(e.target.value)}
                placeholder="Episode 1"
              />
            </Field>
            {error && <FieldError>{error}</FieldError>}
            <Button onClick={handleSaveUrl} className="w-full">
              Save URL
            </Button>
          </FieldGroup>
        ) : (
          <div className="space-y-3">
            <div
              className={cn(
                "flex flex-col items-center justify-center rounded-lg border-2 border-dashed p-6 transition-colors",
                dragOver ? "border-primary bg-primary/5" : "border-muted"
              )}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
              onDragLeave={() => setDragOver(false)}
              onDrop={onDrop}
            >
              {uploading ? (
                <>
                  <Spinner className="size-6 text-primary" />
                  <p className="mt-2 text-sm text-muted-foreground">Storing video locally...</p>
                </>
              ) : (
                <>
                  <Upload className="h-6 w-6 text-muted-foreground" />
                  <p className="mt-2 text-sm text-muted-foreground">
                    Drag a video file here, or
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => fileInputRef.current?.click()}
                    className="mt-1"
                  >
                    Choose file
                  </Button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="video/*"
                    className="hidden"
                    onChange={onFileChange}
                  />
                  <p className="mt-2 text-[11px] text-muted-foreground">
                    Stored locally on this device only (not synced to peers).
                  </p>
                </>
              )}
            </div>
            {error && <FieldError>{error}</FieldError>}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
