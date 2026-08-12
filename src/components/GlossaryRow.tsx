/**
 * GlossaryRow — one concept as an editor-like row.
 *
 * Left: source headword (inline-editable). Right: primary rendering
 * (inline-editable), with an expander revealing the full rendering set and
 * their statuses. Lifecycle affordances vary by concept.status:
 *   active     → Archive
 *   draft      → Accept / Dismiss (rendered ghosted)
 *   deprecated → Restore (rendered dimmed)
 * Presentational only; all mutations bubble through callbacks.
 */
import { useEffect, useState } from "react"
import { ChevronDown, ChevronRight, Archive, RotateCcw, Check, X, Plus, Info } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { Concept, TermRendering, RenderingStatus } from "@/lib/terminology/types"
import { primaryRendering } from "@/lib/terminology/glossary-view"
import { cn } from "@/lib/utils"

const RENDERING_STATUS_OPTIONS: { value: RenderingStatus; label: string }[] = [
  { value: "preferred", label: "required" },
  { value: "admitted", label: "alternate" },
  { value: "forbidden", label: "forbidden" },
]

export interface GlossaryRowProps {
  concept: Concept
  canManage: boolean
  onEditSource: (id: string, sourceTerm: string) => void
  onEditPrimary: (id: string, text: string) => void
  onEditRenderings: (
    id: string,
    update: (current: TermRendering[]) => TermRendering[],
  ) => void
  onEditNotes: (id: string, notes: string) => void
  onOpenDetails: (id: string) => void
  onArchive: (id: string) => void
  onRestore: (id: string) => void
  onAccept: (id: string) => void
  onDismiss: (id: string) => void
}

function ExpanderNotes({
  concept,
  canManage,
  onCommit,
}: {
  concept: Concept
  canManage: boolean
  onCommit: (notes: string) => void
}) {
  const [draft, setDraft] = useState(concept.notes ?? "")
  return (
    <Textarea
      value={draft}
      aria-label={`Notes for ${concept.sourceTerm}`}
      placeholder="Contextual notes for translators"
      disabled={!canManage}
      className="min-h-16 resize-y text-sm"
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        if (draft !== (concept.notes ?? "")) onCommit(draft)
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          setDraft(concept.notes ?? "")
          event.currentTarget.blur()
        }
      }}
    />
  )
}

/** A single inline-editable text cell: click to edit, commit on blur/Enter. */
function InlineCell({
  value,
  placeholder,
  editable,
  onCommit,
  className,
}: {
  value: string
  placeholder: string
  editable: boolean
  onCommit: (next: string) => void
  className?: string
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  if (editing && editable) {
    return (
      <Input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          setEditing(false)
          if (draft !== value) onCommit(draft)
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur()
          if (e.key === "Escape") {
            setDraft(value)
            setEditing(false)
          }
        }}
        className={cn("h-8 text-sm", className)}
      />
    )
  }
  return (
    <button
      type="button"
      className={cn(
        "w-full text-start text-sm leading-relaxed rounded px-1 -mx-1",
        editable && "cursor-text hover:bg-muted/50 transition-colors",
        !value.trim() && "text-muted-foreground italic",
        className,
      )}
      onClick={() => {
        if (editable) {
          setDraft(value)
          setEditing(true)
        }
      }}
    >
      {value.trim() || placeholder}
    </button>
  )
}

/**
 * One rendering row inside the expander: text buffers locally and commits
 * on blur/Enter (Escape reverts), mirroring InlineCell — status + remove
 * stay immediate since they're discrete actions, not free text.
 */
function ExpanderRenderingRow({
  index,
  rendering,
  canManage,
  onCommitText,
  onChangeStatus,
  onRemove,
}: {
  index: number
  rendering: TermRendering
  canManage: boolean
  onCommitText: (next: string) => void
  onChangeStatus: (next: RenderingStatus) => void
  onRemove: () => void
}) {
  const [draft, setDraft] = useState(rendering.rendering)

  useEffect(() => {
    setDraft(rendering.rendering)
  }, [rendering.rendering])

  return (
    <div className="flex items-center gap-2">
      <Input
        value={draft}
        aria-label={`Rendering ${index + 1} text`}
        placeholder="rendering"
        disabled={!canManage}
        className="h-7 flex-1 text-sm"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft !== rendering.rendering) onCommitText(draft)
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur()
          if (e.key === "Escape") setDraft(rendering.rendering)
        }}
      />
      <Select
        items={RENDERING_STATUS_OPTIONS}
        value={rendering.status}
        onValueChange={(v: string | null) => onChangeStatus((v ?? rendering.status) as RenderingStatus)}
      >
        <SelectTrigger aria-label={`Rendering ${index + 1} status`} className="h-7 w-32 text-xs" disabled={!canManage}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {RENDERING_STATUS_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      {canManage && (
        <Button variant="ghost" size="icon-sm" aria-label={`Remove rendering ${index + 1}`} onClick={onRemove}>
          <X />
        </Button>
      )}
    </div>
  )
}

export function GlossaryRow({
  concept,
  canManage,
  onEditSource,
  onEditPrimary,
  onEditRenderings,
  onEditNotes,
  onOpenDetails,
  onArchive,
  onRestore,
  onAccept,
  onDismiss,
}: GlossaryRowProps) {
  const [expanded, setExpanded] = useState(false)
  const primary = primaryRendering(concept)

  const updateRendering = (index: number, next: TermRendering) =>
    onEditRenderings(
      concept.id,
      (current) => current.map((r, i) => (i === index ? next : r)),
    )
  const removeRendering = (index: number) =>
    onEditRenderings(
      concept.id,
      (current) => current.filter((_, i) => i !== index),
    )
  const addRendering = () =>
    onEditRenderings(concept.id, (current) => [
      ...current,
      { rendering: "", status: "admitted" },
    ])

  return (
    <div
      className={cn(
        "border-b last:border-0",
        concept.status === "draft" && "bg-amber-50/40 dark:bg-amber-950/20",
        concept.status === "deprecated" && "opacity-60",
      )}
      data-status={concept.status}
      data-testid="glossary-row"
      data-concept-id={concept.id}
    >
      <div className="flex items-start gap-3 px-3 py-2">
        {/* Expander toggle */}
        <button
          type="button"
          aria-label={expanded ? "Collapse renderings" : "Expand renderings"}
          className="mt-0.5 text-muted-foreground hover:text-foreground"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </button>

        {/* Source (left) */}
        <div className="flex-1 min-w-0">
          <InlineCell
            value={concept.sourceTerm}
            placeholder="(source term)"
            editable={canManage}
            onCommit={(next) => onEditSource(concept.id, next)}
          />
        </div>

        {/* Primary rendering (right) */}
        <div className="flex-1 min-w-0">
          <InlineCell
            value={primary?.rendering ?? ""}
            placeholder="(add rendering)"
            editable={canManage}
            onCommit={(next) => onEditPrimary(concept.id, next)}
          />
        </div>

        {/* Lifecycle affordances */}
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Open details for ${concept.sourceTerm}`}
            onClick={() => onOpenDetails(concept.id)}
          >
            <Info />
          </Button>
          {concept.status === "draft" && canManage && (
            <>
              <Button variant="ghost" size="icon-sm" aria-label="Accept term" onClick={() => onAccept(concept.id)}>
                <Check className="h-4 w-4 text-emerald-600" />
              </Button>
              <Button variant="ghost" size="icon-sm" aria-label="Dismiss term" onClick={() => onDismiss(concept.id)}>
                <X />
              </Button>
            </>
          )}
          {concept.status === "active" && canManage && (
            <Button variant="ghost" size="icon-sm" aria-label="Archive term" onClick={() => onArchive(concept.id)}>
              <Archive className="h-4 w-4" />
            </Button>
          )}
          {concept.status === "deprecated" && canManage && (
            <Button variant="ghost" size="icon-sm" aria-label="Restore term" onClick={() => onRestore(concept.id)}>
              <RotateCcw className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>

      {/* Expander: full rendering set */}
      {expanded && (
        <div className="space-y-1.5 border-t bg-muted/30 px-10 py-2">
          {concept.renderings.length === 0 && (
            <p className="text-xs text-muted-foreground">No renderings yet.</p>
          )}
          {concept.renderings.map((r, i) => (
            <ExpanderRenderingRow
              key={i}
              index={i}
              rendering={r}
              canManage={canManage}
              onCommitText={(next) => updateRendering(i, { ...r, rendering: next })}
              onChangeStatus={(next) => updateRendering(i, { ...r, status: next })}
              onRemove={() => removeRendering(i)}
            />
          ))}
          {canManage && (
            <Button variant="ghost" size="sm" className="text-xs" onClick={addRendering}>
              <Plus data-icon="inline-start" /> Add rendering
            </Button>
          )}
          <ExpanderNotes
            concept={concept}
            canManage={canManage}
            onCommit={(notes) => onEditNotes(concept.id, notes)}
          />
        </div>
      )}
    </div>
  )
}
