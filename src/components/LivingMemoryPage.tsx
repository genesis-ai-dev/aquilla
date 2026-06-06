/**
 * LivingMemoryPage — shows three sections:
 *   1. Instructions  — authored guidance entries (kind="instruction")
 *   2. Standards     — authored standards entries  (kind="standard")
 *   3. Recent Examples — validated source→target pairs (read-only)
 *
 * SWARM-TODO(living-memory): add nav entry in ProjectWorkspace nav items
 *   (e.g. next to Rules / Comments) pointing to /project/:id/memory.
 */

import React, { useMemo, useState } from "react"
import { useParams, useNavigate } from "react-router-dom"
import { ArrowLeft, BookOpen, Users, AlertTriangle, Plus, Pencil, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { useLivingMemory } from "@/hooks/useLivingMemory"
import type { LivingMemoryCell } from "@/hooks/useLivingMemory"
import { useLiveness } from "@/hooks/useLiveness"
import { useProject } from "@/hooks/useProject"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import type { LivingMemoryEntry } from "@/lib/parsers/types"

// ── Pure helpers (add/update/delete for living memory entries) ─────────────

export function addEntry(
  entries: LivingMemoryEntry[],
  kind: LivingMemoryEntry["kind"],
  text: string,
  author: string,
): LivingMemoryEntry[] {
  const entry: LivingMemoryEntry = {
    id: crypto.randomUUID(),
    kind,
    text: text.trim(),
    createdAt: new Date().toISOString(),
    author,
  }
  return [...entries, entry]
}

export function updateEntry(
  entries: LivingMemoryEntry[],
  id: string,
  text: string,
): LivingMemoryEntry[] {
  return entries.map((e) => (e.id === id ? { ...e, text: text.trim() } : e))
}

export function deleteEntry(
  entries: LivingMemoryEntry[],
  id: string,
): LivingMemoryEntry[] {
  return entries.filter((e) => e.id !== id)
}

// ── Skeleton placeholder while loading ────────────────────────────────────

function LivingMemorySkeleton() {
  return (
    <div className="flex flex-col gap-3" role="status" aria-label="Loading validated translations">
      {Array.from({ length: 6 }).map((_, i) => (
        <Card key={i} className="overflow-hidden">
          <CardContent className="p-3 flex flex-col gap-2">
            <Skeleton className="h-2.5 w-20" />
            <Skeleton className="h-3.5 w-full" />
            <Skeleton className="h-4 w-3/4" />
          </CardContent>
        </Card>
      ))}
      <span className="sr-only">Loading…</span>
    </div>
  )
}

// ── Empty state ────────────────────────────────────────────────────────────

function LivingMemoryEmpty() {
  return (
    <div
      className="flex flex-col items-center justify-center gap-4 py-24 text-muted-foreground"
      role="status"
      aria-label="No validated translations"
    >
      <div className="rounded-2xl bg-muted/50 p-4">
        <BookOpen className="h-8 w-8 opacity-40" aria-hidden="true" />
      </div>
      <div className="flex flex-col items-center gap-1.5 text-center">
        <p className="text-sm font-medium text-foreground/70">No validated translations yet</p>
        <p className="text-xs text-muted-foreground max-w-xs leading-relaxed">
          Validated cells will appear here once translators and reviewers reach the required
          validation threshold.
        </p>
      </div>
    </div>
  )
}

// ── Single validated cell card ─────────────────────────────────────────────

function ValidatedCellCard({ cell }: { cell: LivingMemoryCell }) {
  return (
    <Card className="overflow-hidden transition-shadow hover:shadow-sm">
      <CardContent className="p-3 flex flex-col gap-1.5">
        {/* Reference label */}
        {cell.group && (
          <span
            className="text-[10px] font-mono text-muted-foreground/80 leading-none tracking-wide"
            aria-label={`Reference: ${cell.group}`}
          >
            {cell.group}
          </span>
        )}

        {/* Source text */}
        <p
          className="text-xs text-muted-foreground leading-relaxed"
          lang="und"
          aria-label="Source text"
        >
          {cell.original || <em className="opacity-50 not-italic">—</em>}
        </p>

        {/* Divider */}
        <div className="h-px bg-border/50 -mx-0.5" role="separator" aria-hidden="true" />

        {/* Target text */}
        <p className="text-sm leading-relaxed font-medium" aria-label="Translation">
          {cell.translated || <em className="text-muted-foreground opacity-50 not-italic">—</em>}
        </p>

        {/* Validators */}
        {cell.activeValidators.length > 0 && (
          <div
            className="flex flex-wrap items-center gap-1 pt-0.5"
            aria-label={`Validated by: ${cell.activeValidators.join(", ")}`}
          >
            <Users className="h-3 w-3 text-muted-foreground/60 shrink-0" aria-hidden="true" />
            {cell.activeValidators.map((v) => (
              <Badge key={v} variant="secondary" className="text-[10px] px-1.5 h-4 font-normal">
                {v}
              </Badge>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ── File group heading ──────────────────────────────────────────────────────

function FileGroupHeading({ fileName }: { fileName: string }) {
  return (
    <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mt-6 mb-2 px-0.5 first:mt-0 flex items-center gap-2">
      <span className="flex-1 truncate">{fileName}</span>
    </h2>
  )
}

// ── Grouped cell list ──────────────────────────────────────────────────────

function CellList({ cells }: { cells: LivingMemoryCell[] }) {
  // Group cells by file while preserving sort order.
  const groups = useMemo(() => {
    const seen: string[] = []
    const byFile = new Map<string, { fileName: string; cells: LivingMemoryCell[] }>()

    for (const cell of cells) {
      if (!byFile.has(cell.fileId)) {
        seen.push(cell.fileId)
        byFile.set(cell.fileId, { fileName: cell.fileName, cells: [] })
      }
      byFile.get(cell.fileId)!.cells.push(cell)
    }

    return seen.map((fileId) => byFile.get(fileId)!)
  }, [cells])

  return (
    <>
      {groups.map((group) => (
        <div key={group.fileName}>
          <FileGroupHeading fileName={group.fileName} />
          <div className="flex flex-col gap-2">
            {group.cells.map((cell) => (
              <ValidatedCellCard key={cell.id} cell={cell} />
            ))}
          </div>
        </div>
      ))}
    </>
  )
}

// ── Entry form (inline add / edit) ─────────────────────────────────────────

interface EntryFormProps {
  initialText?: string
  onSave: (text: string) => void
  onCancel: () => void
}

function EntryForm({ initialText = "", onSave, onCancel }: EntryFormProps) {
  const [text, setText] = useState(initialText)
  return (
    <div className="flex flex-col gap-2">
      <textarea
        value={text}
        onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setText(e.target.value)}
        placeholder="Enter text…"
        className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm min-h-[72px] resize-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        autoFocus
      />
      <div className="flex gap-2 justify-end">
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size="sm"
          onClick={() => { if (text.trim()) onSave(text) }}
          disabled={!text.trim()}
        >
          Save
        </Button>
      </div>
    </div>
  )
}

// ── Authored entries section ───────────────────────────────────────────────

interface AuthoredEntriesSectionProps {
  title: string
  kind: LivingMemoryEntry["kind"]
  entries: LivingMemoryEntry[]
  canEdit: boolean
  onAdd: (text: string) => void
  onUpdate: (id: string, text: string) => void
  onDelete: (id: string) => void
}

function AuthoredEntriesSection({
  title,
  kind,
  entries,
  canEdit,
  onAdd,
  onUpdate,
  onDelete,
}: AuthoredEntriesSectionProps) {
  const [adding, setAdding] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<LivingMemoryEntry | null>(null)

  const filtered = entries.filter((e) => e.kind === kind)

  return (
    <section aria-label={title} className="mb-8">
      <div className="flex items-center gap-2 mb-3">
        <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex-1">
          {title}
        </h2>
        {canEdit && !adding && (
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-xs gap-1"
            onClick={() => setAdding(true)}
            aria-label={`Add ${title.toLowerCase()} entry`}
          >
            <Plus className="h-3 w-3" aria-hidden="true" />
            Add
          </Button>
        )}
      </div>

      {adding && (
        <div className="mb-3">
          <EntryForm
            onSave={(text) => { onAdd(text); setAdding(false) }}
            onCancel={() => setAdding(false)}
          />
        </div>
      )}

      {filtered.length === 0 && !adding ? (
        <p className="text-xs text-muted-foreground/60 italic py-2">
          No {title.toLowerCase()} yet.{canEdit ? " Click Add to create one." : ""}
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {filtered.map((entry) => (
            <Card key={entry.id} className="overflow-hidden">
              <CardContent className="p-3">
                {editingId === entry.id ? (
                  <EntryForm
                    initialText={entry.text}
                    onSave={(text) => { onUpdate(entry.id, text); setEditingId(null) }}
                    onCancel={() => setEditingId(null)}
                  />
                ) : (
                  <div className="flex items-start gap-2">
                    <p className="text-sm leading-relaxed flex-1">{entry.text}</p>
                    {canEdit && (
                      <div className="flex gap-1 shrink-0">
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-6 w-6"
                          onClick={() => setEditingId(entry.id)}
                          aria-label="Edit entry"
                        >
                          <Pencil className="h-3 w-3" aria-hidden="true" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-6 w-6 text-destructive hover:text-destructive"
                          onClick={() => setDeleteTarget(entry)}
                          aria-label="Delete entry"
                        >
                          <Trash2 className="h-3 w-3" aria-hidden="true" />
                        </Button>
                      </div>
                    )}
                  </div>
                )}
                <p className="text-[10px] text-muted-foreground/60 mt-1.5">
                  {entry.author} · {new Date(entry.createdAt).toLocaleDateString()}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open: boolean) => { if (!open) setDeleteTarget(null) }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete entry?</DialogTitle>
            <DialogDescription>
              This will permanently remove the entry. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleteTarget(null)}>Cancel</Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (deleteTarget) { onDelete(deleteTarget.id); setDeleteTarget(null) }
              }}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────

export function LivingMemoryPage() {
  const { id: projectId } = useParams<{ id: string }>()
  const navigate = useNavigate()

  const { cells, isLoading, isEmpty, isTruncated, fileCount } = useLivingMemory({
    projectId: projectId ?? "",
  })

  const { state: livenessState, label: livenessLabel } = useLiveness(cells.length)

  const { project, loading: projectLoading, patchSettings } = useProject(projectId ?? "")
  const { session } = useFrontierSession()

  const entries = project?.livingMemoryEntries ?? []
  // canEdit mirrors TerminologyPage — patchSettings is blocked internally when
  // offline or below PROJECT_LEAD, so we allow the UI and let the patch report
  // the block. We only hide edit controls while project hasn't loaded.
  const canEdit = !projectLoading && project != null

  const author = session?.username ?? "unknown"

  async function handleAdd(kind: LivingMemoryEntry["kind"], text: string) {
    const next = addEntry(entries, kind, text, author)
    await patchSettings({ livingMemoryEntries: next })
  }

  async function handleUpdate(id: string, text: string) {
    const next = updateEntry(entries, id, text)
    await patchSettings({ livingMemoryEntries: next })
  }

  async function handleDelete(id: string) {
    const next = deleteEntry(entries, id)
    await patchSettings({ livingMemoryEntries: next })
  }

  return (
    <div className="flex flex-col min-h-screen">
      {/* Header */}
      <header className="flex items-center gap-2 px-4 py-3 border-b shrink-0 bg-background/95 backdrop-blur-xs sticky top-0 z-10">
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0"
          onClick={() => navigate(`/project/${projectId}`)}
          aria-label="Back to project"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        </Button>
        <div className="flex-1 min-w-0">
          <h1 className="text-sm font-semibold leading-none">Living Memory</h1>
          <p className="text-xs text-muted-foreground mt-0.5 leading-none">
            Confirmed source&thinsp;&rarr;&thinsp;target pairs
          </p>
        </div>
        {isLoading ? (
          <Skeleton className="h-5 w-20 rounded-full shrink-0" aria-label="Loading count" />
        ) : (
          <Badge variant="secondary" className="shrink-0 tabular-nums">
            {cells.length.toLocaleString()} validated
          </Badge>
        )}
        <span
          aria-label={livenessLabel}
          title={livenessLabel}
          className={[
            "h-2 w-2 shrink-0 rounded-full transition-colors",
            livenessState === "offline" ? "bg-red-500" :
            livenessState === "updating" ? "bg-amber-400 animate-pulse" :
            "bg-emerald-500",
          ].join(" ")}
        />
      </header>

      {/* Truncation warning */}
      {isTruncated && (
        <div
          className="flex items-start gap-2 px-4 py-2.5 text-xs text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/30 border-b border-amber-200/60 dark:border-amber-800/40"
          role="alert"
        >
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
          <span>
            Showing cells from the first {fileCount} files.
            {/* SWARM-TODO(living-mem-server): replace fan-out with a dedicated
                GET /api/v2/projects/:projectId/validated-cells endpoint to
                support projects with >40 files. */}
          </span>
        </div>
      )}

      {/* Body — primary content scrolls with the window, not a nested
          container (see aquilla-specs 09-design-and-ux.md, "one primary
          scroll"). The sticky header stays pinned to the viewport top. */}
      <div className="flex-1">
        <div className="px-4 py-4 max-w-2xl mx-auto">
          {/* Instructions section */}
          <AuthoredEntriesSection
            title="Instructions"
            kind="instruction"
            entries={entries}
            canEdit={canEdit}
            onAdd={(text) => handleAdd("instruction", text)}
            onUpdate={handleUpdate}
            onDelete={handleDelete}
          />

          {/* Standards section */}
          <AuthoredEntriesSection
            title="Standards"
            kind="standard"
            entries={entries}
            canEdit={canEdit}
            onAdd={(text) => handleAdd("standard", text)}
            onUpdate={handleUpdate}
            onDelete={handleDelete}
          />

          {/* Recent Examples (validated cells) */}
          <section aria-label="Recent Examples">
            <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">
              Recent Examples
            </h2>
            {isLoading ? (
              <LivingMemorySkeleton />
            ) : isEmpty ? (
              <LivingMemoryEmpty />
            ) : (
              <CellList cells={cells} />
            )}
          </section>
        </div>
      </div>
    </div>
  )
}
