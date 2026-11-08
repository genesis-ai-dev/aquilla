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
import { useT } from "@/lib/i18n/I18nProvider"

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

/** An imported film's stored address: an upload, not a link anyone typed. */
const UPLOADED_FILM_SCHEME = "frontier-audio://"

interface Props {
  open: boolean
  currentUrl: string | null
  /** The file's name, which is an imported film's name (import map D#14):
   *  shown instead of its internal address. */
  filmName?: string | null
  /** null clears the link. The caller closes this dialog BEFORE running, so a
   *  follow-up dialog (the Free-timing warning) never opens over a live focus
   *  trap. */
  onSave(url: string | null): void
  onCancel(): void
}

export function LinkVideoUrlDialog({ open, currentUrl, filmName, onSave, onCancel }: Props) {
  const t = useT()
  // An imported film has no address anyone could read or retype, so the
  // field starts empty, and Save with it still empty keeps the film.
  const imported = currentUrl?.startsWith(UPLOADED_FILM_SCHEME) ?? false
  const startValue = imported ? "" : currentUrl ?? ""
  const [value, setValue] = useState(startValue)
  const [touched, setTouched] = useState(false)

  useEffect(() => {
    if (open) {
      setValue(startValue)
      setTouched(false)
    }
  }, [open, startValue])

  const invalid = touched && value.trim().length > 0 && !isLinkableVideoUrl(value)
  const unchanged = imported && value.trim() === ""
  const canSave = unchanged || isLinkableVideoUrl(value)
  const save = () => {
    if (unchanged) onCancel()
    else if (isLinkableVideoUrl(value)) onSave(value.trim())
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onCancel() }}>
      <DialogContent data-testid="link-video-url-dialog">
        <DialogHeader>
          <DialogTitle>{currentUrl ? t("editor.timeline.linkVideoTitleChange") : t("editor.timeline.linkVideoTitleNew")}</DialogTitle>
          <DialogDescription>
            {t("editor.timeline.linkVideoDescription")}
          </DialogDescription>
        </DialogHeader>
        {imported && (
          <p data-testid="link-video-imported" className="text-sm">
            {t("editor.timeline.linkVideoImported", { name: filmName ?? "" })}
          </p>
        )}
        <div className="flex flex-col gap-2">
          <Label htmlFor="link-video-url">{t("editor.timeline.linkVideoAddressLabel")}</Label>
          <Input
            id="link-video-url"
            data-testid="link-video-url-input"
            value={value}
            autoFocus
            placeholder="https://example.com/episode.mp4"
            onChange={(e) => { setValue(e.target.value); setTouched(true) }}
            onKeyDown={(e) => { if (e.key === "Enter" && canSave) save() }}
          />
          {invalid && (
            <p data-testid="link-video-url-error" className="text-xs text-red-600 dark:text-red-400">
              {t("editor.timeline.linkVideoInvalid")}
            </p>
          )}
          {imported && (
            <p className="text-xs text-muted-foreground">{t("editor.timeline.linkVideoImportedClear")}</p>
          )}
        </div>
        <DialogFooter className="sm:justify-between">
          {currentUrl ? (
            <Button
              variant="outline"
              data-testid="link-video-clear"
              onClick={() => onSave(null)}
            >
              {t("editor.timeline.linkVideoClear")}
            </Button>
          ) : <span />}
          <div className="flex gap-2">
            <Button variant="outline" onClick={onCancel}>{t("common.cancel")}</Button>
            <Button
              data-testid="link-video-save"
              disabled={!canSave}
              onClick={save}
            >
              {t("common.save")}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
