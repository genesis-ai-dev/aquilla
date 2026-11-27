// AQU-2664 (board 71): the one Even out window, holding which request opened
// it. The request lives here rather than in ProjectWorkspace so opening and
// closing the window re-renders only the window, not the whole workspace
// (scripts/perf/structure-ratchet.test.ts). The workspace opens it through the
// handle; the scopes are worked out from the takes and tracks it hands down.
import { useImperativeHandle, useMemo, useState, type Ref } from "react"
import type { CellData } from "@/hooks/useCells"
import type { TimelineTrack } from "@/lib/timeline/tracks"
import { evenOutScopes, type EvenOutRequest } from "@/lib/audio/even-out-scopes"
import { EvenOutDialog, type EvenOutDialogProps } from "./EvenOutDialog"

export interface EvenOutWindowHandle {
  open(req: EvenOutRequest): void
}

export interface EvenOutWindowProps extends Omit<EvenOutDialogProps, "open" | "onOpenChange" | "scopes" | "start"> {
  ref?: Ref<EvenOutWindowHandle>
  cells: readonly CellData[]
  tracks: readonly TimelineTrack[]
}

export function EvenOutWindow({ ref, cells, tracks, ...dialog }: EvenOutWindowProps) {
  const [req, setReq] = useState<EvenOutRequest | null>(null)
  useImperativeHandle(ref, () => ({ open: setReq }), [])
  const win = useMemo(() => (req ? evenOutScopes(cells, tracks, req) : null), [req, cells, tracks])
  if (!win) return null
  return (
    <EvenOutDialog
      {...dialog}
      open
      onOpenChange={(o) => { if (!o) setReq(null) }}
      scopes={win.scopes}
      start={win.start}
    />
  )
}
