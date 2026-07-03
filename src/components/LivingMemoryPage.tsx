/**
 * LivingMemoryPage — shows three sections:
 *   1. Instructions  — authored guidance entries (kind="instruction")
 *   2. Standards     — authored standards entries  (kind="standard")
 *   3. Recent Examples — validated source→target pairs (read-only)
 *
 * Edit access is gated at MAINTAINER (600) via useProjectSettings.canEdit.
 * Below-floor users see read-only affordances with a tooltip naming the
 * required role, mirroring the FRO-255 pattern in useProjectSettings.
 *
 * Layout: FRO-254 renders this page inside the ProjectWorkspace shell
 * (centerSurface === "memory"), so this component owns only the content
 * area — no full-page header, no back button.
 */

import React, { useMemo, useState } from "react"
import { useParams, useNavigate } from "react-router-dom"
import { BookOpen, Users, AlertTriangle, Plus, Pencil, Trash2, Lock, ExternalLink, Brain } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import { Textarea } from "@/components/ui/textarea"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  AppTooltip,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { useLivingMemory } from "@/hooks/useLivingMemory"
import type { LivingMemoryCell } from "@/hooks/useLivingMemory"
import { useLiveness } from "@/hooks/useLiveness"
import { useProject } from "@/hooks/useProject"
import { useProjectSettings } from "@/hooks/useProjectSettings"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import type { LivingMemoryEntry } from "@/lib/parsers/types"
import { BriefSection } from "@/components/brief/BriefSection"
import { BriefBuilder } from "@/components/brief/BriefBuilder"
import { emptyBrief, isL1Stale } from "@/lib/brief/brief"
import { useTranslationBrief } from "@/hooks/useTranslationBrief"
import { generateL1Summary, extractBriefFromDocument, draftField } from "@/lib/brief/brief-generator"
import { checkInputSize } from "@/lib/rules/rule-extractor"

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

// ── Empty state for Recent Examples ───────────────────────────────────────

function RecentExamplesEmpty() {
  return (
    <Empty
      className="border-0 py-12"
      role="status"
      aria-label="No validated translations"
    >
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <BookOpen />
        </EmptyMedia>
        <EmptyTitle className="text-foreground/70">No validated translations yet</EmptyTitle>
        <EmptyDescription className="max-w-xs text-xs leading-relaxed">
          When translators and reviewers reach the required validation threshold on a cell, that
          source&thinsp;&rarr;&thinsp;target pair appears here. The AI draws on these pairs in
          every subsequent draft.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
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
    <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mt-6 mb-2 px-0.5 first:mt-0 flex items-center gap-2">
      <span className="flex-1 truncate">{fileName}</span>
    </h3>
  )
}

// ── Grouped cell list ──────────────────────────────────────────────────────

function CellList({ cells }: { cells: LivingMemoryCell[] }) {
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
      <Textarea
        value={text}
        onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setText(e.target.value)}
        placeholder="Enter text…"
        className="min-h-[72px] resize-none"
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

// ── Role-lock icon with tooltip ────────────────────────────────────────────

function RoleLockTooltip({ reason }: { reason: "offline" | "role" | null }) {
  if (reason === null) return null
  const message =
    reason === "offline"
      ? "You are offline. Reconnect to edit."
      : "Editing requires Maintainer role (600) or above."
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            aria-label={message}
            className="inline-flex items-center text-muted-foreground/50"
          />
        }
      >
        <Lock className="h-3 w-3" aria-hidden="true" />
      </TooltipTrigger>
      <TooltipContent side="left" className="max-w-[200px] text-xs">
        {message}
      </TooltipContent>
    </Tooltip>
  )
}

// ── Authored entries section ───────────────────────────────────────────────

interface AuthoredEntriesSectionProps {
  title: string
  description: string
  placeholder: string
  example: string
  kind: LivingMemoryEntry["kind"]
  entries: LivingMemoryEntry[]
  canEdit: boolean
  reasonCannotEdit: "offline" | "role" | null
  onAdd: (text: string) => void
  onUpdate: (id: string, text: string) => void
  onDelete: (id: string) => void
}

function AuthoredEntriesSection({
  title,
  description,
  placeholder,
  example,
  kind,
  entries,
  canEdit,
  reasonCannotEdit,
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
      <div className="flex items-center gap-2 mb-1">
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
        {!canEdit && <RoleLockTooltip reason={reasonCannotEdit} />}
      </div>

      <p className="text-xs text-muted-foreground mb-3 leading-relaxed">{description}</p>

      {adding && (
        <div className="mb-3">
          <EntryForm
            onSave={(text) => { onAdd(text); setAdding(false) }}
            onCancel={() => setAdding(false)}
          />
        </div>
      )}

      {filtered.length === 0 && !adding ? (
        <div className="rounded-lg border border-dashed border-border/60 px-4 py-5 flex flex-col gap-1.5">
          <p className="text-xs text-muted-foreground/60 italic">{placeholder}</p>
          <p className="text-xs text-muted-foreground/50">
            <span className="font-medium not-italic text-muted-foreground/70">Example: </span>
            {example}
          </p>
        </div>
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
// FRO-254: rendered inside ProjectWorkspace's AppShell (centerSurface===
// "memory") in a h-full overflow-y-auto wrapper. No full-page header or
// back-button chrome here — the shell owns that. Content scrolls naturally.

export function LivingMemoryPage() {
  const { id: projectId } = useParams<{ id: string }>()
  const navigate = useNavigate()

  const { cells, isLoading, isEmpty, isTruncated, fileCount } = useLivingMemory({
    projectId: projectId ?? "",
  })

  const { state: livenessState, label: livenessLabel } = useLiveness(cells.length)

  const { project, loading: projectLoading } = useProject(projectId ?? "")

  // Role-aware edit gate: mirrors the FRO-255 pattern — get roleLevel from
  // syncRole, pass to useProjectSettings which enforces MAINTAINER (600) floor.
  const roleLevel = project?.syncRole?.level ?? null
  const { settings, canEdit, reasonCannotEdit, patch: patchSettings } = useProjectSettings(
    projectId ?? null,
    roleLevel,
  )

  const { session } = useFrontierSession()

  // While the project hasn't loaded yet, canEdit is false (roleLevel is null).
  // This correctly shows read-only affordances before the role is known.
  const entriesReady = !projectLoading && project != null
  // Render from THIS hook instance's settings — it carries the optimistic
  // overlay for patches made here. useProject reads through its own separate
  // useProjectSettings instance, which never learns of our patch until a
  // refetch, so a just-saved entry wouldn't render (same class as the
  // file-rename overlay fix). Fall back to the project record before the
  // settings GET resolves.
  const entries = settings.livingMemoryEntries ?? project?.livingMemoryEntries ?? []

  const author = session?.username ?? "unknown"

  // Translation Brief wiring
  const brief = settings.translationBrief ?? project?.translationBrief
  const stale = brief ? isL1Stale(brief) : false
  const [builderOpen, setBuilderOpen] = useState(false)
  // completionSettings comes from the overlaid project record (device-local apiKey +
  // server-side voice profiles merged in overlayDeviceLocalSettings / overlaySettings).
  // SWARM-TODO: verify orchestrator: if project?.completionSettings is undefined (no
  // LLM configured), generation buttons will fail at call time with an informative error.
  const completionSettings = project?.completionSettings
  const [generating, setGenerating] = useState(false)
  const { save: saveBrief, attachL1 } = useTranslationBrief({
    brief,
    author,
    patch: patchSettings,
  })

  async function handleGenerate() {
    // Edit gate (defense-in-depth; the server + patch() also enforce MAINTAINER).
    if (!(entriesReady && canEdit)) return
    // No brief yet, or no LLM configured → fall back to opening the builder.
    if (!brief || !completionSettings) {
      setBuilderOpen(true)
      return
    }
    // Lock the section's edit/generate affordances while the LLM call is in
    // flight so a concurrent open-and-save can't clobber the brief object we
    // re-persist in attachL1 (adversarial review: races lens, finding 2).
    setGenerating(true)
    try {
      const l1 = await generateL1Summary(brief, completionSettings, session ?? null)
      await attachL1(brief, l1, completionSettings.model)
    } finally {
      setGenerating(false)
    }
  }

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
    <div className="flex flex-col">
      {/* Page header — purpose + liveness (no back button: shell owns nav) */}
      <div className="px-4 pt-4 pb-3 max-w-2xl mx-auto w-full">
        <div className="flex items-start gap-3 mb-3">
          <div className="rounded-xl bg-muted/60 p-2 shrink-0 mt-0.5">
            <Brain className="h-5 w-5 text-muted-foreground/80" aria-hidden="true" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <h1 className="text-sm font-semibold leading-none">Living Memory</h1>
              <AppTooltip content={livenessLabel}>
                <span
                  aria-label={livenessLabel}
                  className={[
                    "h-2 w-2 shrink-0 rounded-full transition-colors",
                    livenessState === "offline"
                      ? "bg-red-500"
                      : livenessState === "updating"
                        ? "bg-amber-400 animate-pulse"
                        : "bg-emerald-500",
                  ].join(" ")}
                />
              </AppTooltip>
              {isLoading ? (
                <Skeleton className="h-4 w-20 rounded-full" aria-label="Loading count" />
              ) : (
                <Badge variant="secondary" className="text-[10px] tabular-nums">
                  {cells.length.toLocaleString()} validated
                </Badge>
              )}
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed">
              Your team's encoded voice and standards — the project context the AI draws on
              for every new draft. It grows with each validation, correction, and instruction
              your team adds.
            </p>
          </div>
        </div>

        {/* Cross-link to Terminology */}
        <div className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-muted/40 border border-border/50 text-xs text-muted-foreground">
          <ExternalLink className="h-3 w-3 shrink-0" aria-hidden="true" />
          <span>
            <strong className="font-medium text-foreground/70">Terminology</strong> captures
            your project's key terms and preferred renderings.{" "}
          </span>
          <button
            onClick={() => navigate(`/project/${projectId}/terminology`)}
            className="underline text-foreground/60 hover:text-foreground transition-colors shrink-0"
            aria-label="Go to Terminology page"
          >
            Open Terminology
          </button>
        </div>
      </div>

      {/* Translation Brief section */}
      <BriefSection
        brief={brief}
        canEdit={entriesReady && canEdit}
        stale={stale}
        busy={generating}
        onEdit={() => setBuilderOpen(true)}
        onGenerate={handleGenerate}
      />

      {/* Translation Brief builder dialog */}
      {builderOpen && (
        <BriefBuilder
          open={builderOpen}
          brief={brief ?? emptyBrief(author)}
          canEdit={entriesReady && canEdit}
          onClose={() => setBuilderOpen(false)}
          onSaveDraft={async (draft) => {
            const prev = brief ?? emptyBrief(author)
            return saveBrief(prev, draft)
          }}
          onGenerateL1={async (draft) => {
            if (!completionSettings) return
            const prev = brief ?? emptyBrief(author)
            const saved = await saveBrief(prev, draft)
            const l1 = await generateL1Summary(saved, completionSettings, session ?? null)
            await attachL1(saved, l1, completionSettings.model)
          }}
          onHelpDraft={completionSettings
            ? (fieldId, draft) => draftField(fieldId, draft, completionSettings, session ?? null)
            : undefined
          }
          onExtractDocument={completionSettings
            ? async (text) => {
                const chk = checkInputSize(text)
                if (!chk.ok) throw new Error(chk.message)
                return extractBriefFromDocument(text, completionSettings, session ?? null)
              }
            : undefined
          }
        />
      )}

      {/* Truncation warning */}
      {isTruncated && (
        <div
          className="flex items-start gap-2 px-4 py-2.5 text-xs text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/30 border-y border-amber-200/60 dark:border-amber-800/40"
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

      {/* Body — content in a max-width column */}
      <div className="flex-1 px-4 py-4 max-w-2xl mx-auto w-full">

        {/* Instructions section */}
        <AuthoredEntriesSection
          title="Instructions"
          description="Tell the AI what this project is about — audience, tone, formality, special handling. These appear in every draft prompt."
          placeholder="No instructions yet."
          example={`"Translate into formal Swahili for an adult literacy audience. Avoid theological jargon unless the source uses it."`}
          kind="instruction"
          entries={entries}
          canEdit={entriesReady && canEdit}
          reasonCannotEdit={entriesReady ? reasonCannotEdit : "role"}
          onAdd={(text) => handleAdd("instruction", text)}
          onUpdate={handleUpdate}
          onDelete={handleDelete}
        />

        {/* Standards section */}
        <AuthoredEntriesSection
          title="Standards"
          description="Project-wide quality rules the AI checks its drafts against. Capture decisions your team keeps revisiting."
          placeholder="No standards yet."
          example={`"Always preserve proper nouns untranslated. Numbers in source must appear as numerals in target."`}
          kind="standard"
          entries={entries}
          canEdit={entriesReady && canEdit}
          reasonCannotEdit={entriesReady ? reasonCannotEdit : "role"}
          onAdd={(text) => handleAdd("standard", text)}
          onUpdate={handleUpdate}
          onDelete={handleDelete}
        />

        {/* Recent Examples */}
        <section aria-label="Recent Examples" className="mb-8">
          <div className="flex items-center gap-2 mb-1">
            <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              Recent Examples
            </h2>
          </div>
          <p className="text-xs text-muted-foreground mb-3 leading-relaxed">
            Human-validated source&thinsp;&rarr;&thinsp;target pairs the AI uses as in-context
            examples. These are the translations your team has agreed on.
          </p>
          {isLoading ? (
            <LivingMemorySkeleton />
          ) : isEmpty ? (
            <RecentExamplesEmpty />
          ) : (
            <CellList cells={cells} />
          )}
        </section>
      </div>
    </div>
  )
}
