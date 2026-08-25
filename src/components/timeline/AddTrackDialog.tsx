// AQU-646 stage 2: making a new audio track.
//
// A dialog rather than an in-place edit — unlike a new FOLDER, which is made
// immediately and named in the gutter — because a track has a decision to make
// that cannot be undone later: WHICH TRACK ITS RECORDINGS LINE UP WITH. Sam's
// call (2026-08-22) is that alignment is chosen at creation and never changed
// afterwards, so it has to be asked before the track exists rather than offered
// as a setting on it.
//
// That is a real constraint and not a shortcut. Re-aligning a track that
// already holds recordings would mean deciding what happens to every take
// whose line no longer exists on the new source, which is a migration
// masquerading as a dropdown.

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
import type { TimelineTrack } from "@/lib/timeline/tracks"
import { useT } from "@/lib/i18n/I18nProvider"

export function AddTrackDialog({
  open,
  tracks,
  defaultName,
  onCancel,
  onConfirm,
}: {
  open: boolean
  /** Every track on this file — the alignment candidates are drawn from it. */
  tracks: readonly TimelineTrack[]
  defaultName: string
  onCancel(): void
  onConfirm(spec: { name: string; sourceTrackId: string | null }): void
}) {
  const t = useT()
  const [name, setName] = useState(defaultName)

  // WHAT A NEW TRACK CAN LINE UP WITH is the rows that actually carry lines:
  // the subtitle rows and the source-audio row. A folder holds no lines of its
  // own, and another audio track's takes are not a grid to align against — they
  // are the same lines, once removed.
  const candidates = tracks.filter(
    (track) =>
      track.kind === "source-subtitles" ||
      track.kind === "target-subtitles" ||
      track.kind === "source-audio",
  )
  const [sourceTrackId, setSourceTrackId] = useState<string>(candidates[0]?.id ?? "")

  // Reseed on every open. Without this, cancelling with a half-typed name and
  // reopening would show that name again as though it had been saved.
  useEffect(() => {
    if (!open) return
    setName(defaultName)
    setSourceTrackId(candidates[0]?.id ?? "")
    // `candidates` is derived from `tracks` and recomputed each render; keying
    // the effect on it would reseed the field while somebody was typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, defaultName])

  const trimmed = name.trim()

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onCancel() }}>
      <DialogContent className="sm:max-w-md" data-testid="tl-add-track-dialog">
        <DialogHeader>
          <DialogTitle>{t("editor.timeline.addTrackTitle")}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <label className="block space-y-1.5">
            <span className="text-sm font-medium">{t("common.name")}</span>
            <input
              data-testid="tl-add-track-name"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && trimmed) onConfirm({ name: trimmed, sourceTrackId: sourceTrackId || null })
              }}
              className="w-full rounded-md border border-input bg-background px-2 py-1 text-sm outline-none focus:ring-1 focus:ring-sky-500"
            />
          </label>

          <label className="block space-y-1.5">
            <span className="text-sm font-medium">{t("editor.timeline.addTrackAlignLabel")}</span>
            <select
              data-testid="tl-add-track-align"
              value={sourceTrackId}
              onChange={(e) => setSourceTrackId(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-2 py-1 text-sm outline-none focus:ring-1 focus:ring-sky-500"
            >
              {candidates.map((track) => (
                <option key={track.id} value={track.id}>
                  {track.name}
                </option>
              ))}
            </select>
            <DialogDescription className="text-xs">
              {t("editor.timeline.addTrackAlignHint")}
            </DialogDescription>
          </label>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            {t("common.cancel")}
          </Button>
          <Button
            data-testid="tl-add-track-confirm"
            disabled={!trimmed}
            onClick={() => onConfirm({ name: trimmed, sourceTrackId: sourceTrackId || null })}
          >
            {t("editor.timeline.trackAdd")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
