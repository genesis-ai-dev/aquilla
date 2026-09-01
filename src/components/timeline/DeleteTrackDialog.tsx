// AQU-646 stage 2: "are you sure?", asked before a track is deleted.
// Stage 2b: …and it may be several at once.
//
// Sam, 2026-08-22: deleting a track "will genuinely delete everything on there,
// but with a warning modal that pops up that says 'are you sure?'". So the
// confirmation's whole job is to state the consequence in a number, because the
// number is the fact the person is being asked to accept.
//
// TWO DIFFERENT CONSEQUENCES, AND CONFLATING THEM WOULD BE THE BUG.
//   · An audio track takes its RECORDINGS with it. They are soft-deleted, the
//     same way removing a take from a cell has always worked — hidden from
//     every read path and replayed as gone — not purged from storage.
//   · A folder takes NOTHING with it. Its members return to the top level,
//     because a folder is an arrangement of tracks and not a container that
//     owns them. Saying so is what stops this reading as a threat to three
//     tracks somebody spent a week recording.
//
// THE COUNTS ARE COMPUTED WHEN THE QUESTION IS ASKED, not when the menu opened.
// A collaborator can attach a take in between, and a confirmation that says "2
// recordings" while deleting 3 is worse than one that says nothing.

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

export function DeleteTrackDialog({
  tracks,
  takeCount,
  memberCount,
  onCancel,
  onConfirm,
}: {
  /** Empty closes the dialog. Resolved from ids upstream, so tracks a
   *  collaborator deleted mid-question simply drop out of the question. */
  tracks: readonly TimelineTrack[]
  /** Recordings across all of them, counted now. */
  takeCount: number
  /** Tracks inside them, for the folders among them. */
  memberCount: number
  onCancel(): void
  onConfirm(trackIds: readonly string[]): void
}) {
  const t = useT()
  const only = tracks.length === 1 ? tracks[0] : null
  const allFolders = tracks.length > 0 && tracks.every((tr) => tr.kind === "folder")

  // The consequence line, in the order the person cares about: what is
  // destroyed first, what merely moves second, and "nothing" when neither.
  const consequence = allFolders
    ? memberCount > 0
      ? t("editor.timeline.deleteFolderMembers", { count: memberCount })
      : t("editor.timeline.deleteTrackEmpty")
    : takeCount > 0
      ? t("editor.timeline.deleteTrackTakes", { count: takeCount })
      : t("editor.timeline.deleteTrackEmpty")

  return (
    <Dialog open={tracks.length > 0} onOpenChange={(next) => { if (!next) onCancel() }}>
      <DialogContent className="sm:max-w-md" data-testid="tl-delete-track-dialog">
        <DialogHeader>
          <DialogTitle>
            {only
              ? t("editor.timeline.deleteTrackTitle", { name: only.name })
              : t("editor.timeline.deleteTracksTitle", { count: tracks.length })}
          </DialogTitle>
          <DialogDescription data-testid="tl-delete-track-consequence">{consequence}</DialogDescription>
        </DialogHeader>

        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="destructive"
            data-testid="tl-delete-track-confirm"
            onClick={() => onConfirm(tracks.map((tr) => tr.id))}
          >
            {t("common.delete")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
