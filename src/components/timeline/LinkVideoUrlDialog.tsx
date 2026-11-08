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
import { InfoReveal, InfoToggle, useInfoOpen } from "@/components/ui/info-tip"
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
  const t = useT()
  const [value, setValue] = useState(currentUrl ?? "")
  const [touched, setTouched] = useState(false)
  // One short line; the rest (how its sound plays) behind a click (i) that
  // opens in place (D#17: the old 60-word paragraph).
  const [moreOpen, toggleMore] = useInfoOpen()

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
          <DialogTitle>{currentUrl ? t("editor.timeline.linkVideoTitleChange") : t("editor.timeline.linkVideoTitleNew")}</DialogTitle>
          <DialogDescription className="flex items-start gap-1">
            <span className="min-w-0">{t("editor.timeline.linkVideoLead")}</span>
            <InfoToggle
              open={moreOpen}
              onToggle={toggleMore}
              label={t("editor.timeline.linkVideoMoreLabel")}
              controls="link-video-more"
              testId="link-video-more-toggle"
            />
          </DialogDescription>
          <InfoReveal open={moreOpen} id="link-video-more" testId="link-video-more" className="text-sm text-muted-foreground">
            {t("editor.timeline.linkVideoMore")}
          </InfoReveal>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <Label htmlFor="link-video-url">{t("editor.timeline.linkVideoAddressLabel")}</Label>
          <Input
            id="link-video-url"
            data-testid="link-video-url-input"
            value={value}
            autoFocus
            // Its own placeholder (D#13): the empty-file card's address field
            // takes a different kind of link and stores it differently.
            placeholder={t("editor.timeline.linkVideoPlaceholder")}
            onChange={(e) => { setValue(e.target.value); setTouched(true) }}
            onKeyDown={(e) => { if (e.key === "Enter" && canSave) onSave(value.trim()) }}
          />
          {invalid && (
            <p data-testid="link-video-url-error" className="text-xs text-red-600 dark:text-red-400">
              {t("editor.timeline.linkVideoInvalid")}
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
              {t("editor.timeline.linkVideoClear")}
            </Button>
          ) : <span />}
          <div className="flex gap-2">
            <Button variant="outline" onClick={onCancel}>{t("common.cancel")}</Button>
            <Button
              data-testid="link-video-save"
              disabled={!canSave}
              onClick={() => onSave(value.trim())}
            >
              {t("common.save")}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
