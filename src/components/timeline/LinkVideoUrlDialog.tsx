// Linking (or clearing) the file's core video. (AQU-646)
//
// This replaces a `window.prompt`. That was not only unstyled and unlabelled —
// it validated nothing, so whatever the OS dialog returned was emitted straight
// into the file's metadata, and the local QA project ended up with a paragraph
// of English prose stored as its video URL. Nothing downstream could tell that
// apart from a real address; the video simply rendered as a black rectangle.

import { useEffect, useState } from "react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

/** Accepts what a <video src> can actually fetch, and nothing else. */
export function isLinkableVideoUrl(value: string): boolean {
  const trimmed = value.trim()
  if (!trimmed) return false
  try {
    const { protocol } = new URL(trimmed)
    return protocol === "http:" || protocol === "https:" || protocol === "blob:"
  } catch {
    return false
  }
}

interface Props {
  open: boolean
  currentUrl: string | null
  /** null clears the link. The caller closes this dialog BEFORE running, so a
   *  follow-up dialog (the Free-timing warning) never opens over a live focus
   *  trap. */
  onSave(url: string | null): void
  onCancel(): void
}

export function LinkVideoUrlDialog({ open, currentUrl, onSave, onCancel }: Props) {
  const [value, setValue] = useState(currentUrl ?? "")
  const [touched, setTouched] = useState(false)

  useEffect(() => {
    if (open) {
      setValue(currentUrl ?? "")
      setTouched(false)
    }
  }, [open, currentUrl])

  const invalid = touched && value.trim().length > 0 && !isLinkableVideoUrl(value)
  const canSave = isLinkableVideoUrl(value)

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onCancel() }}>
      <DialogContent data-testid="link-video-url-dialog">
        <DialogHeader>
          <DialogTitle>{currentUrl ? "Change the linked video" : "Link a video"}</DialogTitle>
          <DialogDescription>
            Paste the address of the video this file was dubbed from. It plays
            beside the text, muted and in step with the audio — the recording you
            hear is always the one on the timeline.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <Label htmlFor="link-video-url">Video address</Label>
          <Input
            id="link-video-url"
            data-testid="link-video-url-input"
            value={value}
            autoFocus
            placeholder="https://example.com/episode.mp4"
            onChange={(e) => { setValue(e.target.value); setTouched(true) }}
            onKeyDown={(e) => { if (e.key === "Enter" && canSave) onSave(value.trim()) }}
          />
          {invalid && (
            <p data-testid="link-video-url-error" className="text-xs text-red-600 dark:text-red-400">
              That doesn't look like a web address. It should start with http:// or https://.
            </p>
          )}
        </div>
        <DialogFooter className="sm:justify-between">
          {currentUrl ? (
            <Button
              variant="outline"
              data-testid="link-video-clear"
              onClick={() => onSave(null)}
            >
              Clear video
            </Button>
          ) : <span />}
          <div className="flex gap-2">
            <Button variant="outline" onClick={onCancel}>Cancel</Button>
            <Button
              data-testid="link-video-save"
              disabled={!canSave}
              onClick={() => onSave(value.trim())}
            >
              Save
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
