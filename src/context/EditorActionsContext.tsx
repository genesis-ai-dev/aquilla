/**
 * EditorActionsContext — pure pass-through "open a drawer/dialog" callbacks
 * for EditorTable rows.
 *
 * Perf/architecture review: these openers were drilled EditorTable ->
 * MemoizedRow -> EditorRow with no intermediate layer ever calling them
 * (header/toolbar/footnote tray don't touch them) — they just fattened the
 * ~40-prop row bag that React.memo diffs on every render. ProjectWorkspace
 * owns the actual drawer state (e.g. `commentsCellId`, `historyCellId`) and
 * renders the drawers OUTSIDE the table, so rows never needed to re-render
 * when these identities changed; they just needed a stable way to fire them.
 *
 * Scoped to the EditorTable subtree only — provided once at the EditorTable
 * render site in ProjectWorkspace, not at the app root.
 */

import { createContext, useContext, type ReactNode } from "react"
import type { MemberScope } from "@/lib/sync/member-scopes"

export interface EditorActionsContextValue {
  onInfractionClick?: (ruleId: string) => void
  onOpenComments?: (cellId: string) => void
  onOpenHistory?: (cellId: string) => void
  /** Opens the matching concept in the Terminology page. */
  onOpenTerminologyConcept?: (conceptId: string) => void
  onAiSetupNeeded?: () => void
  onOpenRecording?: (cellId: string) => void
  /**
   * 2026-08-07 (wire b): a plain row click, when the timeline is stacked
   * above the table — points the timeline at this cell (select the chip,
   * center the track, cue playback paused). The workspace's impl no-ops
   * outside the stacked media lens; ref-wrapped so the value stays stable.
   */
  onMediaRowActivate?: (cellId: string) => void
  /**
   * 2026-08-07: the character gutter's PURE voice assignment (never
   * synthesizes; applyToSpeaker covers every line sharing the cell's
   * diarized cast_name). Ref-wrapped in the workspace so the context value
   * stays identity-stable while cast data changes underneath.
   */
  onAssignCastVoice?: (
    cell: import("@/hooks/useCells").CellData,
    voiceId: string,
    opts?: { applyToSpeaker?: boolean },
  ) => void
  /**
   * Matt's QA (2026-08-21): the inverse — take the character OFF a line
   * without putting another in its place. Returns the row to the NC ring.
   * Clears the voice-map entry and the line's cast NAME only; the camera
   * angle and the client's line number are sheet data and survive.
   * `applyToSpeaker` mirrors the assign side's checkbox: every line in the
   * file sharing this cell's cast name goes back to NC together.
   */
  onClearCastVoice?: (
    cell: import("@/hooks/useCells").CellData,
    opts?: { applyToSpeaker?: boolean },
  ) => void
  /**
   * AQU-633: the current user's own lane/file scopes (empty/undefined =
   * unscoped). Rows gate the per-cell Validate affordance on this so a scoped
   * member isn't offered a guaranteed-403 validate on an out-of-scope cell.
   * Passed via context (not the ~40-prop row bag) since it changes rarely
   * (once on load) and every row reads it the same way.
   */
  myScopes?: MemberScope[]
  /**
   * AQU-646: a take just landed on this cell (mic or file upload). The
   * workspace uses it to give a text-less line a target row, so a recording
   * counts as translated work rather than an empty cell that happens to make
   * noise. Context rather than a row prop: rows only forward it, and it is
   * identity-stable in the workspace.
   */
  onTakeSaved?: (cellId: string) => void
  /**
   * AQU-646 stage 3f: where this row's audio actually belongs.
   *
   * On a file with an audio-cue sibling a take hangs off the HEARD LINE that
   * performs the subtitle, in the cue sibling — never on the subtitle cell. The
   * mic already knew this (`onOpenRecording` redirects); the TTS button in the
   * same row did not, so a generated voice landed on the subtitle cell where
   * the timeline cannot draw it.
   *
   * Returns the cell itself in every arrangement without cues, and null when a
   * cue sibling exists but nothing is linked — there is genuinely nowhere to
   * put audio for that line, and writing it to the subtitle would hide it.
   * Context rather than a row prop: rows only forward it, and the workspace
   * keeps it identity-stable.
   *
   * CELLS, NOT IDS, AND THAT IS LOAD-BEARING. The row's voice button is a
   * REPLAY button as much as a generate one — it looks for an already-generated
   * clip before synthesizing anything. That lookup reads
   * `selectedGeneratedVoiceAudioId` and `attachments`, which live on the cue,
   * so handing back bare ids would leave it looking at the subtitle, finding
   * nothing, and re-synthesizing on every single press.
   *
   * ALL of them, in film order: one subtitle can be performed by several heard
   * lines and Sam's ruling (2026-08-25) is that each gets the whole line, so
   * nothing is left silent. Callers that can only write one — the microphone —
   * take the first.
   */
  audioHomeFor?: (
    cell: import("@/hooks/useCells").CellData,
  ) => readonly import("@/hooks/useCells").CellData[] | null
  /**
   * AQU-1068 item 5: the source cell's menu — the structural actions behind
   * its entries, and the two facts about timing it has to know.
   *
   * These are HERE rather than on the row for the reason this module exists.
   * The reasons an entry is unavailable are per-row and travel down as plain
   * strings, which React.memo compares happily; the actions are the same
   * three functions for every row in the file, and threading a fresh closure
   * per row through `MemoizedRow` would re-render every rendered row on every
   * store bump — the whole-file churn round 6 of this PR went into removing.
   *
   * The workspace keeps all five identity-stable.
   */
  /** Insert a line into a silence on a TIMED file — the span comes from the
   *  gap the row is offering, already filtered and floored. */
  onAddLineAt?: (startSec: number, endSec: number) => void
  /** Insert a cell beside this one on a file with no clock, where the anchor
   *  chain is the order and there is always room. */
  onInsertCellBeside?: (cellId: string, position: "above" | "below") => void
  /** Take this cell out, after the confirmation its inventory earns. */
  onRemoveCell?: (cellId: string) => void
  /** Retime one line. The workspace's handler owns the lock check and the
   *  media-vs-text choice of event, so the menu adds nothing to it. */
  onRetimeCell?: (cellId: string, startSec: number, endSec: number) => void
  /**
   * AQU-646's project-wide lock on imported timings, and whether this person
   * can lift it. Scalars that change about once a session, so they cost the
   * subtree nothing to read here — the same argument `myScopes` above makes.
   */
  timingLocked?: boolean
  canUnlockTiming?: boolean
  /** Takes a maintainer to the setting that holds the lock. Deliberately not
   *  a toggle: the lock is project-wide, so they should see its scope before
   *  changing it (Sam, 2026-09-09). */
  onOpenTimingSettings?: () => void
}

const EditorActionsContext = createContext<EditorActionsContextValue>({})

export function useEditorActions(): EditorActionsContextValue {
  return useContext(EditorActionsContext)
}

export function EditorActionsProvider({
  value,
  children,
}: {
  value: EditorActionsContextValue
  children: ReactNode
}) {
  return (
    <EditorActionsContext.Provider value={value}>
      {children}
    </EditorActionsContext.Provider>
  )
}
