/**
 * apiRev 4: the source selection toolbar's host popovers for an extension
 * editor — "View term" (TermLookupPopover) and "Add to terminology"
 * (AddConceptPopover) — the SAME components the built-in editor opens,
 * anchored over the sandboxed frame at the selection's rect.
 */

import { useEffect, useRef, useState } from "react"
import type { CellStore } from "@/hooks/useActiveCellStore"
import { AddConceptPopover } from "@/components/AddConceptDialog"
import { TermLookupPopover } from "@/components/TermLookupPopover"
import type { Concept, ConceptDraft, TermMatchingSettings } from "@/lib/terminology/types"
import type { ToolRect } from "../../../shared/tools/editor-api-rev4"

export interface ExtensionTermRequest {
  kind: "view" | "add"
  text: string
  rect: ToolRect
  nonce: number
}

export interface ExtensionTermPopoversProps {
  request: ExtensionTermRequest | null
  onClose: () => void
  concepts: Concept[]
  termMatching?: TermMatchingSettings
  onViewConcept?: (conceptId: string) => void
  onAdd?: (draft: ConceptDraft) => void | Promise<void>
  blockedReason?: string | null
  canApprove?: boolean
  cellStore?: CellStore
  onSetUpAffixes?: () => void
}

/** The extension editor's frame on screen (the selection rect is relative to it). */
function frameBox(): DOMRect | null {
  const frame = document.querySelector('[data-testid="extension-editor-surface"] iframe')
  return frame ? frame.getBoundingClientRect() : null
}

export function ExtensionTermPopovers({ request, onClose, concepts, termMatching, onViewConcept, onAdd, blockedReason, canApprove, cellStore, onSetUpAffixes }: ExtensionTermPopoversProps) {
  const anchorRef = useRef<HTMLButtonElement | null>(null)
  const [anchorEl, setAnchorEl] = useState<HTMLButtonElement | null>(null)
  const box = request ? frameBox() : null
  const style = request && box
    ? { position: "fixed" as const, left: box.left + request.rect.left, top: box.top + request.rect.top, width: Math.max(1, request.rect.width), height: Math.max(1, request.rect.height), opacity: 0, pointerEvents: "none" as const }
    : { display: "none" }

  // The add popover opens from its trigger: press it once it is placed.
  useEffect(() => {
    if (request?.kind !== "add") return
    const id = requestAnimationFrame(() => anchorRef.current?.click())
    return () => cancelAnimationFrame(id)
  }, [request])

  if (!request) return null
  const anchor = <button ref={(el) => { anchorRef.current = el; setAnchorEl(el) }} type="button" tabIndex={-1} aria-hidden style={style} data-testid="extension-term-anchor" />
  if (request.kind === "view") {
    return (
      <>
        {anchor}
        <TermLookupPopover
          key={request.nonce}
          sourceTerm={request.text}
          concepts={concepts.filter((c) => c.status === "active")}
          termMatching={termMatching}
          onViewConcept={onViewConcept}
          open
          onOpenChange={(open) => { if (!open) onClose() }}
          anchor={anchorEl}
        >
          <span />
        </TermLookupPopover>
      </>
    )
  }
  return (
    <AddConceptPopover
      key={request.nonce}
      sourceTerm={request.text}
      blockedReason={blockedReason}
      canApprove={canApprove}
      cellStore={cellStore}
      termMatching={termMatching}
      onSetUpAffixes={onSetUpAffixes}
      onConfirm={async (draft) => { await onAdd?.(draft); onClose() }}
      onOpenChange={(open) => { if (!open) onClose() }}
    >
      {anchor}
    </AddConceptPopover>
  )
}
