/**
 * LivingMemoryPage — shows three sections:
 *   1. Instructions  — authored guidance entries (kind="instruction")
 *   2. Standards     — authored standards entries  (kind="standard")
 *   3. Recent Examples — validated source→target pairs (read-only)
 *
 * Edit access is gated at MAINTAINER (600) via useProjectSettings.canEdit.
 * Below-floor users see read-only affordances with a tooltip naming the
 * required role, mirroring the AQU-255 pattern in useProjectSettings.
 *
 * Layout: AQU-254 renders this page inside the ProjectWorkspace shell
 * (centerSurface === "memory"). Matches Rules/Glossary: in-main toolbar
 * + scrollable max-width body — no full-page header, no back button.
 */

import React, { useMemo, useState } from "react"
import { useParams, useNavigate } from "react-router-dom"
import { useI18n, useT } from "@/lib/i18n/I18nProvider"
import { formatDate, formatCount } from "@/lib/i18n/format"
import { BookOpen, Users, AlertTriangle, Plus, Pencil, Trash2, Lock, Brain } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { EmptyState } from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import { LoadingTemplate } from "@/components/ui/loading-overlay"
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
  const t = useT()
  return (
    <LoadingTemplate
      label={t("terminology.livingMemory.loadingValidatedTranslations")}
      className="min-h-96"
      templateClassName="min-h-96"
    >
      <div className="flex flex-col gap-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Card key={i} className="overflow-hidden">
            <CardContent className="flex flex-col gap-2 p-3">
              <Skeleton className="h-2.5 w-20" />
              <Skeleton className="h-3.5 w-full" />
              <Skeleton className="h-4 w-3/4" />
            </CardContent>
          </Card>
        ))}
      </div>
    </LoadingTemplate>
  )
}

// ── Empty state for Recent Examples ───────────────────────────────────────

function RecentExamplesEmpty() {
  const t = useT()
  return (
    <EmptyState
      variant="inline"
      className="py-12"
      role="status"
      aria-label={t("terminology.livingMemory.noValidatedTranslationsAria")}
      icon={BookOpen}
      title={t("terminology.livingMemory.noValidatedTranslationsTitle")}
      titleClassName="text-foreground/70"
      description={t("terminology.livingMemory.noValidatedTranslationsDescription")}
      descriptionClassName="max-w-xs text-xs leading-relaxed"
    />
  )
}

// ── Single validated cell card ─────────────────────────────────────────────

function ValidatedCellCard({ cell }: { cell: LivingMemoryCell }) {
  const t = useT()
  return (
    <Card className="overflow-hidden transition-colors hover:bg-muted/50">
      <CardContent className="p-3 flex flex-col gap-1.5">
        {/* Reference label */}
        {cell.group && (
          <span
            className="text-[10px] font-mono text-muted-foreground/80 leading-none tracking-wide"
            aria-label={t("terminology.livingMemory.referenceAria", { reference: cell.group })}
          >
            {cell.group}
          </span>
        )}

        {/* Source text */}
        <p
          className="text-xs text-muted-foreground leading-relaxed"
          lang="und"
          aria-label={t("editor.source.textAria")}
        >
          {cell.original || <em className="opacity-50 not-italic">—</em>}
        </p>

        {/* Divider */}
        <div className="h-px bg-border/50 -mx-0.5" role="separator" aria-hidden="true" />

        {/* Target text */}
        <p
          className="text-sm leading-relaxed font-medium"
          aria-label={t("terminology.livingMemory.translationAria")}
        >
          {cell.translated || <em className="text-muted-foreground opacity-50 not-italic">—</em>}
        </p>

        {/* Validators */}
        {cell.activeValidators.length > 0 && (
          <div
            className="flex flex-wrap items-center gap-1 pt-0.5"
            aria-label={t("terminology.livingMemory.validatedByAria", {
              validators: cell.activeValidators.join(", "),
            })}
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
    <h3 className="text-xs font-semibold text-muted-foreground mt-6 mb-2 px-0.5 first:mt-0 flex items-center gap-2">
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

// ── Entry form (used in add dialog + inline edit) ───────────────────────────

interface EntryFormProps {
  initialText?: string
  onSave: (text: string) => void
  onCancel: () => void
}

function EntryForm({ initialText = "", onSave, onCancel }: EntryFormProps) {
  const t = useT()
  const [text, setText] = useState(initialText)
  return (
    <div className="flex flex-col gap-2">
      <Textarea
        value={text}
        onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setText(e.target.value)}
        placeholder={t("terminology.livingMemory.enterTextPlaceholder")}
        className="min-h-[72px] resize-none"
        autoFocus
      />
      <div className="flex gap-2 justify-end">
        <Button size="sm" variant="ghost" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
        <Button
          size="sm"
          onClick={() => { if (text.trim()) onSave(text) }}
          disabled={!text.trim()}
        >
          {t("common.save")}
        </Button>
      </div>
    </div>
  )
}

// ── Role-lock icon with tooltip ────────────────────────────────────────────

function RoleLockTooltip({ reason }: { reason: "offline" | "role" | null }) {
  const t = useT()
  if (reason === null) return null
  const message =
    reason === "offline"
      ? t("terminology.livingMemory.offlineTooltip")
      : t("terminology.livingMemory.maintainerRequiredTooltip")
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
  const { locale } = useI18n()
  const t = useT()
  const [adding, setAdding] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<LivingMemoryEntry | null>(null)

  const filtered = entries.filter((e) => e.kind === kind)
  // `title` arrives already translated (the two call sites pass
  // t("terminology.livingMemory.instructionsTitle") / standardsTitle); this
  // section only ever lower-cases it for the {section} placeholder below.
  const sectionLower = title.toLowerCase()

  return (
    <section aria-label={title}>
      <div className="flex items-center gap-2 mb-1">
        <h2 className="text-xs font-semibold text-muted-foreground flex-1">
          {title}
        </h2>
        {canEdit && (
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-xs gap-1"
            onClick={() => setAdding(true)}
            aria-label={t("terminology.livingMemory.addEntryAria", { section: sectionLower })}
          >
            <Plus className="h-3 w-3" aria-hidden="true" />
            {t("common.add")}
          </Button>
        )}
        {!canEdit && <RoleLockTooltip reason={reasonCannotEdit} />}
      </div>

      <p className="text-xs text-muted-foreground mb-3 leading-relaxed">{description}</p>

      <Dialog
        open={adding}
        onOpenChange={(open: boolean) => { if (!open) setAdding(false) }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t("terminology.livingMemory.addEntryAria", { section: sectionLower })}
            </DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <EntryForm
            onSave={(text) => { onAdd(text); setAdding(false) }}
            onCancel={() => setAdding(false)}
          />
        </DialogContent>
      </Dialog>

      {filtered.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border/60 px-4 py-5 flex flex-col gap-1.5">
          <p className="text-xs text-muted-foreground/60 italic">{placeholder}</p>
          <p className="text-xs text-muted-foreground/50">
            <span className="font-medium not-italic text-muted-foreground/70">
              {t("terminology.livingMemory.exampleLabel")}{" "}
            </span>
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
                          aria-label={t("terminology.livingMemory.editEntryAria")}
                        >
                          <Pencil className="h-3 w-3" aria-hidden="true" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-6 w-6 text-destructive hover:text-destructive"
                          onClick={() => setDeleteTarget(entry)}
                          aria-label={t("terminology.livingMemory.deleteEntryAria")}
                        >
                          <Trash2 className="h-3 w-3" aria-hidden="true" />
                        </Button>
                      </div>
                    )}
                  </div>
                )}
                <p className="text-[10px] text-muted-foreground/60 mt-1.5">
                  {entry.author} · {formatDate(entry.createdAt, locale, {})}
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
            <DialogTitle>{t("terminology.livingMemory.deleteEntryConfirmTitle")}</DialogTitle>
            <DialogDescription>
              {t("terminology.livingMemory.deleteEntryConfirmDescription")}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleteTarget(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (deleteTarget) { onDelete(deleteTarget.id); setDeleteTarget(null) }
              }}
            >
              {t("common.delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────
// AQU-254: rendered inside ProjectWorkspace's AppShell (centerSurface===
// "memory"). Layout matches Rules/Glossary: in-main toolbar + scrollable
// body. No back-button chrome — the shell owns nav.

export function LivingMemoryPage() {
  const { locale } = useI18n()
  const t = useT()
  const { id: projectId } = useParams<{ id: string }>()
  const navigate = useNavigate()

  const { cells, isLoading, isEmpty, error: cellsError } = useLivingMemory({
    projectId: projectId ?? "",
  })

  const { state: livenessState, label: livenessLabel } = useLiveness(cells.length)

  const { project, loading: projectLoading } = useProject(projectId ?? "")

  // Role-aware edit gate: mirrors the AQU-255 pattern — get roleLevel from
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
    <div className="flex h-full flex-col bg-background">
      {/* In-main toolbar — matches Rules/Glossary */}
      <header className="flex shrink-0 items-center gap-2 border-b px-4 py-3">
        <Brain className="h-5 w-5 text-muted-foreground" aria-hidden />
        <h1 className="text-base font-semibold">{t("terminology.livingMemory.title")}</h1>
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
          <Skeleton
            className="h-4 w-20 rounded-md"
            aria-label={t("terminology.livingMemory.loadingCountAria")}
          />
        ) : (
          <Badge variant="secondary" className="text-[10px] tabular-nums">
            {t("terminology.livingMemory.validatedCount", {
              count: formatCount(cells.length, locale),
            })}
          </Badge>
        )}
        <div className="flex-1" />
        <Button
          variant="outline"
          size="sm"
          onClick={() => navigate(`/project/${projectId}/terminology`)}
          aria-label={t("terminology.livingMemory.goToTerminologyAria")}
        >
          <BookOpen data-icon="inline-start" />
          {t("nav.sidebarSection.terminology")}
        </Button>
      </header>

      {cellsError && (
        <div
          className="flex shrink-0 items-start gap-2 border-b border-destructive/30 bg-destructive/5 px-4 py-2.5 text-xs text-destructive"
          role="alert"
        >
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
          <span>
            {t("terminology.livingMemory.loadErrorPrefix", { message: cellsError.message })}
          </span>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-2xl flex-col gap-6 p-6">
          <p className="text-xs text-muted-foreground leading-relaxed">
            {t("terminology.livingMemory.introText")}
          </p>

          <BriefSection
            brief={brief}
            canEdit={entriesReady && canEdit}
            stale={stale}
            busy={generating}
            onEdit={() => setBuilderOpen(true)}
            onGenerate={handleGenerate}
          />

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

          <AuthoredEntriesSection
            title={t("terminology.livingMemory.instructionsTitle")}
            description={t("terminology.livingMemory.instructionsDescription")}
            placeholder={t("terminology.livingMemory.instructionsPlaceholder")}
            example={t("terminology.livingMemory.instructionsExample")}
            kind="instruction"
            entries={entries}
            canEdit={entriesReady && canEdit}
            reasonCannotEdit={entriesReady ? reasonCannotEdit : "role"}
            onAdd={(text) => handleAdd("instruction", text)}
            onUpdate={handleUpdate}
            onDelete={handleDelete}
          />

          <AuthoredEntriesSection
            title={t("terminology.livingMemory.standardsTitle")}
            description={t("terminology.livingMemory.standardsDescription")}
            placeholder={t("terminology.livingMemory.standardsPlaceholder")}
            example={t("terminology.livingMemory.standardsExample")}
            kind="standard"
            entries={entries}
            canEdit={entriesReady && canEdit}
            reasonCannotEdit={entriesReady ? reasonCannotEdit : "role"}
            onAdd={(text) => handleAdd("standard", text)}
            onUpdate={handleUpdate}
            onDelete={handleDelete}
          />

          <section aria-label={t("terminology.livingMemory.recentExamplesTitle")}>
            <div className="flex items-center gap-2 mb-1">
              <h2 className="text-xs font-semibold text-muted-foreground">
                {t("terminology.livingMemory.recentExamplesTitle")}
              </h2>
            </div>
            <p className="text-xs text-muted-foreground mb-3 leading-relaxed">
              {t("terminology.livingMemory.recentExamplesDescription")}
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
    </div>
  )
}
