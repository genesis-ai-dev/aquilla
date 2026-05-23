// Phase 2c-gamma: ParallelPassagesPanel was the search + replace surface,
// driven by an in-process Y.Doc-backed index plus a Y.Doc-based bulk-replace
// writer. Both depended on the per-file Y.Doc handle that's now gone.
//
// Project-wide search returns in v1.x via the server-side branching-search
// endpoint plus a target-cell.commit-flavored bulk writer. Until then the
// dialog renders a "feature unavailable in this build" placeholder so the
// keyboard shortcuts and command-palette wiring stay intact.

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import type { WorkspaceSearchResult, SearchOptions } from "@/lib/search/workspace-index"

export type ParallelPanelMode = "search" | "replace"
export type ParallelPanelScope = "file" | "project"

interface ParallelPassagesPanelProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  mode: ParallelPanelMode
  scope: ParallelPanelScope
  onScopeChange?: (s: ParallelPanelScope) => void
  onModeChange?: (m: ParallelPanelMode) => void

  activeFileId?: string | null
  activeFileName?: string | null
  activeDoc?: unknown

  loading?: boolean
  ready?: boolean
  results?: WorkspaceSearchResult[]
  onReady?: () => void | Promise<void>
  onSearch?: (query: string, options: SearchOptions) => void
  onClear?: () => void
  onSelect?: (result: WorkspaceSearchResult, query: string) => void | Promise<void>
  [extraProp: string]: unknown
}

export function ParallelPassagesPanel(props: ParallelPassagesPanelProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Parallel passages unavailable</DialogTitle>
          <DialogDescription>
            Project-wide search and replace are disabled in this build. The
            feature returns alongside the server-side branching-search index
            in v1.x.
          </DialogDescription>
        </DialogHeader>
      </DialogContent>
    </Dialog>
  )
}
