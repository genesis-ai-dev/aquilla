// AQU-646 stage 2: what right-clicking a timeline track offers.
// Stage 2b: …and it acts on the SELECTION, not on one row.
//
// ONE ITEM LIST, THREE ROOTS. A track is two elements on screen — its name in
// the gutter and its lane beside it — and Sam's ruling is that right-clicking
// anywhere in a track that is not a chip opens the same menu. So both columns
// get a context-menu root, and a third dropdown root hangs off a handle for the
// `⋯` button and the keyboard. All three render this. Written as a function
// returning nodes rather than a component so the identical children can be
// mounted in three places without three components' worth of state.
//
// WITH TRACK EDITING OFF, THE EXTRA ITEMS ARE ABSENT, NOT DISABLED (Sam,
// 2026-08-22). A greyed-out row advertises a capability the project has
// switched off and invites someone to go hunting for why it will not click;
// nothing at all is the honest picture of a feature this project does not use.
// Rename is here either way — it is maintainer work that already shipped, and
// a setting defaulting to off must not take it away.
//
// EVERY ITEM IS SCOPED TO WHAT IT CAN ACTUALLY ACT ON, and says how many.
// Colour is ALL-OR-NOTHING over the selection (Sam, 2026-08-24): three selected
// of which two are colourable offers nothing, rather than colouring two and
// saying "2 tracks". Acting on part of a selection is the thing that makes bulk
// operations frightening to use, and the menu cannot show you WHICH part.
// Delete stays scoped-and-counted — "delete the 2 added tracks out of these 5"
// is a sentence a person can check against what they selected, because the
// derived rows visibly cannot be deleted at all.
//
// AND IF NOTHING IS OFFERED, THE MENU DOES NOT OPEN. See `trackMenuIsEmpty`.

import type { ReactNode } from "react"
import { FolderPlus, FolderMinus, Palette, Pencil, Trash2 } from "lucide-react"
import {
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu"
import { cn } from "@/lib/utils"
import {
  TRACK_HUES,
  isColorableKind,
  parseTrackHue,
} from "@/lib/timeline/track-colors"
import { DEFAULT_TRACK_IDS, type TimelineTrack } from "@/lib/timeline/tracks"
import type { useT } from "@/lib/i18n/I18nProvider"

export interface TrackEditingActions {
  /**
   * PER-TRACK VALUES, not one value for the whole list — stage 3c.
   *
   * Colour became two independent axes, so "make these five tracks lime" means
   * "set each one's PRIMARY to lime and leave its own secondary alone", and the
   * five resulting strings can all differ. One call, so it is still a single
   * enqueue.
   */
  onSetColor(updates: ReadonlyArray<{ trackId: string; color: string | null }>): void
  onLeaveFolder(trackIds: readonly string[]): void
  onCreateFolderFrom(trackIds: readonly string[]): void
  onDelete(trackIds: readonly string[]): void
}

/**
 * A track someone MADE, as opposed to one the file derives.
 *
 * Only these can be deleted. A derived row is a fact about the file — its
 * subtitles, its source audio, its dub — so "delete" would have to mean either
 * "hide it", which we have no state for, or "reset its overrides", which is a
 * different verb that would sit under the same word. Resetting is what
 * `patch: null` does and it is not offered here.
 */
export const isAddedTrack = (track: TimelineTrack) => !DEFAULT_TRACK_IDS.has(track.id)

/**
 * WHAT THIS MENU WOULD ACT ON, worked out once.
 *
 * Extracted (2026-08-24) so the TRIGGER and the ITEMS read the same answer.
 * They used to be computed only while rendering the items, which meant nothing
 * could ask "will this menu have anything in it?" before opening it — and with
 * several derived tracks selected the answer is no: Rename is single-track
 * only, and every other item needs either a colourable track, a foldable one or
 * a deletable one. Right-clicking that selection opened an empty popup. Sam,
 * 2026-08-24: "we shouldn't even have a drop down thingy show up in the first
 * place." `trackMenuIsEmpty` below is what lets the trigger decline.
 */
export function trackMenuScopes({
  targets,
  canRename,
  canEdit,
}: {
  targets: readonly TimelineTrack[]
  canRename: boolean
  canEdit: boolean
}) {
  const only = targets.length === 1 ? targets[0] : null

  // ALL OF THEM OR NONE (Sam, 2026-08-24, revising the first rule). Colouring
  // "the two of these five that can take one" is the kind of partial success
  // that makes a bulk operation frightening to use — you cannot see from the
  // menu which two it meant. Either the whole selection is colourable and the
  // item acts on the whole selection, or the item is not offered.
  const allColourable = targets.length > 0 && targets.every((tr) => isColorableKind(tr.kind))
  const colourable = allColourable ? targets : []

  const deletable = targets.filter(isAddedTrack)

  // THE FOLDERING VERBS ARE ALL-OR-NONE TOO, and for a sharper reason than
  // colour's. A folder is never inside another folder (track-groups never reads
  // a folder's own groupId), so neither verb is offered on one; and a track that
  // is ALREADY in a folder cannot start a new one, because the verb would
  // quietly eject it and make a fresh top-level folder at the bottom of the
  // list, which is not what "new folder from this track" says it does. Sam chose
  // withholding it over allowing subfolders.
  //
  // A MIXED SELECTION — some inside a folder, some outside — GETS NEITHER VERB
  // (Sam, 2026-08-25). It used to get BOTH, each quietly scoped to its own half,
  // so one menu offered to make a folder out of two of your five tracks and to
  // eject the other three, with nothing on screen saying which was which. The
  // two verbs are opposites; a selection that could take either is a selection
  // the user has not finished making.
  const plainTracks = targets.filter((tr) => tr.kind !== "folder")
  const anyFoldered = plainTracks.some((tr) => Boolean(tr.groupId))
  const allFoldered = plainTracks.length > 0 && plainTracks.every((tr) => Boolean(tr.groupId))
  const foldable = plainTracks.length > 0 && !anyFoldered ? plainTracks : []
  const inAFolder = allFoldered ? plainTracks : []

  return {
    only,
    rename: canRename ? only : null,
    colourable: canEdit ? colourable : [],
    foldable: canEdit ? foldable : [],
    inAFolder: canEdit ? inAFolder : [],
    deletable: canEdit ? deletable : [],
  }
}

/** Would this menu render nothing at all? Then it must not open. */
export function trackMenuIsEmpty(scopes: ReturnType<typeof trackMenuScopes>): boolean {
  return (
    scopes.rename == null &&
    scopes.colourable.length === 0 &&
    scopes.foldable.length === 0 &&
    scopes.inAFolder.length === 0 &&
    scopes.deletable.length === 0
  )
}

export function trackMenuItems({
  targets,
  t,
  onRename,
  editing,
}: {
  /**
   * The tracks this menu acts on — the selection when the right-clicked row is
   * in it, otherwise just that row. Never contains a folder when it holds more
   * than one track, because folders cannot be selected.
   */
  targets: readonly TimelineTrack[]
  t: ReturnType<typeof useT>
  /** Maintainer clearance. NOT gated on the track-editing setting. */
  onRename?: (trackId: string) => void
  /** Maintainer clearance AND the setting. Absent withholds every item below
   *  the separator — which is the whole affordance, not a disabled one. */
  editing?: TrackEditingActions
}): ReactNode {
  // ONE AUTHORITY, read here and by the trigger that decided to open at all.
  const { rename, colourable, foldable, inAFolder, deletable } = trackMenuScopes({
    targets,
    canRename: Boolean(onRename),
    canEdit: Boolean(editing),
  })

  const ids = (list: readonly TimelineTrack[]) => list.map((tr) => tr.id)

  return (
    <>
      {/* Renaming is a single-track verb: there is one field and one name.
          With several selected it is simply absent rather than renaming an
          arbitrary one of them. */}
      {onRename && rename && (
        <ContextMenuItem onClick={() => onRename(rename.id)}>
          <Pencil className="h-3.5 w-3.5" />
          {t("editor.timeline.trackRename")}
        </ContextMenuItem>
      )}
      {/* Only when something actually follows it — a separator under the last
          item is a line with nothing beneath it. */}
      {onRename && rename && (colourable.length > 0 || foldable.length > 0
        || inAFolder.length > 0 || deletable.length > 0) && <ContextMenuSeparator />}

      {/* AQU-646 stage 7: SIX SWATCHES, AND NOTHING ELSE (Sam, 2026-08-27:
          "all the user needs to see is the six colors to pick from. no previews
          or anything").

          It is a submenu again. The dialog that briefly stood here existed for
          exactly one reason — a native `<input type="color">` hands focus to
          the operating system, and a context menu closes on that — and with the
          custom picker gone so is the reason. A submenu recolours in one click
          instead of three, which is the whole point of simplifying it. */}
      {editing && colourable.length > 0 && (
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <Palette className="h-3.5 w-3.5" />
            {colourable.length > 1
              ? t("editor.timeline.trackColorCount", { count: colourable.length })
              : t("editor.timeline.trackColor")}
          </ContextMenuSubTrigger>
          <ContextMenuSubContent className="w-auto min-w-0 p-1">
            {TRACK_HUES.map((hue) => {
              // "Every one of them is already this", which is the only thing a
              // selected state could honestly mean across several tracks.
              const current = colourable.every((tr) => parseTrackHue(tr.color) === hue.hex)
              return (
                <ContextMenuItem
                  key={hue.id}
                  className="gap-2"
                  onClick={() =>
                    editing.onSetColor(colourable.map((tr) => ({ trackId: tr.id, color: hue.id })))
                  }
                >
                  <span
                    aria-hidden
                    className={cn(
                      "h-3.5 w-3.5 shrink-0 rounded-full",
                      current && "ring-2 ring-foreground/50 ring-offset-1 ring-offset-popover",
                    )}
                    style={{ backgroundColor: hue.hex }}
                  />
                  {t(hue.labelKey as Parameters<typeof t>[0])}
                </ContextMenuItem>
              )
            })}
          </ContextMenuSubContent>
        </ContextMenuSub>
      )}

      {/* Stage 2b: "Move to folder" is GONE. Sam, 2026-08-24: "there shouldn't
          be the option to add to a folder, the option should be to create a new
          folder containing these tracks. And if a folder already exists, it
          should be possible to drag a track into that folder." A submenu
          listing folders was a worse answer to the same question — it grows
          with the file and it makes the common case (there is no folder yet)
          an empty popup. */}
      {editing && foldable.length > 0 && (
        <ContextMenuItem onClick={() => editing.onCreateFolderFrom(ids(foldable))}>
          <FolderPlus className="h-3.5 w-3.5" />
          {foldable.length > 1
            ? t("editor.timeline.trackNewFolderFromCount", { count: foldable.length })
            : t("editor.timeline.trackNewFolderFrom")}
        </ContextMenuItem>
      )}

      {editing && inAFolder.length > 0 && (
        <ContextMenuItem onClick={() => editing.onLeaveFolder(ids(inAFolder))}>
          <FolderMinus className="h-3.5 w-3.5" />
          {inAFolder.length > 1
            ? t("editor.timeline.trackLeaveFolderCount", { count: inAFolder.length })
            : t("editor.timeline.trackLeaveFolder")}
        </ContextMenuItem>
      )}

      {editing && deletable.length > 0 && (
        <ContextMenuItem variant="destructive" onClick={() => editing.onDelete(ids(deletable))}>
          <Trash2 className="h-3.5 w-3.5" />
          {deletable.length > 1
            ? t("editor.timeline.trackDeleteCount", { count: deletable.length })
            : deletable[0].kind === "folder"
              ? t("editor.timeline.trackDeleteFolder")
              : t("editor.timeline.trackDelete")}
        </ContextMenuItem>
      )}
    </>
  )
}
