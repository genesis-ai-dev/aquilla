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
   * AQU-633: the current user's own lane/file scopes (empty/undefined =
   * unscoped). Rows gate the per-cell Validate affordance on this so a scoped
   * member isn't offered a guaranteed-403 validate on an out-of-scope cell.
   * Passed via context (not the ~40-prop row bag) since it changes rarely
   * (once on load) and every row reads it the same way.
   */
  myScopes?: MemberScope[]
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
