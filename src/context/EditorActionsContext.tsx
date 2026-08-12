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
