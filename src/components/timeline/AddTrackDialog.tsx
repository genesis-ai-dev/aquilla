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

import { useEffect, useRef, useState } from "react"

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
  candidates,
  defaultName,
  onCancel,
  onConfirm,
}: {
  open: boolean
  /**
   * What this track can line up with — RESOLVED BY THE CALLER (stage 6J).
   *
   * The dialog used to take every track on the file and filter for the rows
   * that carry lines. That was the right shape while the answer was structural,
   * but two of Sam's 2026-08-27 rulings made it a question only the editor can
   * answer. Target text is not a source and is never offered. And on a file
   * where the source audio is linked to the source text, every remaining
   * candidate resolves to the SAME cells — the heard lines — so offering two
   * names for one outcome was a choice with no consequence, which is worse than
   * no choice at all. The editor computes the honest list; this renders it.
   */
  candidates: readonly TimelineTrack[]
  defaultName: string
  onCancel(): void
  onConfirm(spec: { name: string; sourceTrackId: string | null }): void
}) {
  const t = useT()
  const [name, setName] = useState(defaultName)
  const [sourceTrackId, setSourceTrackId] = useState<string>(candidates[0]?.id ?? "")
  // Sam, 2026-08-27: "if there's only one option, the modal shouldn't present a
  // dropdown. It should just list that one option as what it's going to be
  // aligned with." A picker with one item asks a question whose answer is
  // already fixed — and, worse, looks like it has alternatives hidden in it.
  const onlyCandidate = candidates.length === 1 ? candidates[0] : null

  // Reseed ON THE OPENING EDGE, and only there. Without any reseed, cancelling
  // with a half-typed name and reopening would show that name again as though
  // it had been saved.
  //
  // KEYING THIS ON `defaultName` WAS A BUG (stage 6J, found in review). It was
  // safe while the default was a constant string, but 6J made it
  // `nextTrackName(tracks)` — derived from the synced track list — so a track
  // arriving from anywhere (a collaborator, or your own add's round-trip
  // landing) changes it WHILE THE DIALOG IS OPEN, re-runs this effect, and
  // wipes whatever you were typing. The live values are read through a ref so
  // the effect depends on the one thing that should retrigger it: opening.
  const seed = useRef({ defaultName, candidates })
  seed.current = { defaultName, candidates }
  useEffect(() => {
    if (!open) return
    setName(seed.current.defaultName)
    setSourceTrackId(seed.current.candidates[0]?.id ?? "")
  }, [open])

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

          <div className="block space-y-1.5">
            {/* A `<span id>` + `aria-labelledby`, not a `<label>`: this wrapper
                stopped being a `<label>` when the single-candidate branch put a
                `<p>` inside it, and a bare span left the `<select>` with no
                accessible name at all (found in review). */}
            <span id="tl-add-track-align-label" className="text-sm font-medium">
              {t("editor.timeline.addTrackAlignLabel")}
            </span>
            {onlyCandidate ? (
              // Stated, not asked. It still says WHAT the track will line up
              // with — that is the fact the hint below is about, and it does
              // not stop being true just because there is nothing to decide.
              <p data-testid="tl-add-track-align-fixed" className="text-sm">
                {onlyCandidate.name}
              </p>
            ) : (
              <select
                data-testid="tl-add-track-align"
                aria-labelledby="tl-add-track-align-label"
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
            )}
            <DialogDescription className="text-xs">
              {t("editor.timeline.addTrackAlignHint")}
            </DialogDescription>
          </div>
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
