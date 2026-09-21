import { useState, useMemo, useCallback, useRef, useEffect } from "react"
import { useParams, useNavigate } from "react-router-dom"
import {
  Plus,
  Trash2,
  Pencil,
  Upload,
  Download,
  BookOpen,
} from "lucide-react"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { Button } from "@/components/ui/button"
import { LoadingPanel } from "@/components/ui/loading-overlay"
import { Spinner } from "@/components/ui/spinner"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Field, FieldError, FieldGroup, FieldLabel, OptionalMark } from "@/components/ui/field"
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { Concept, TermRendering, RenderingStatus } from "@/lib/terminology/types"
import { renderingStatusLabelKey } from "@/lib/terminology/types"
import { mergeConcepts } from "@/lib/terminology/store"
import { useConcepts } from "@/hooks/useConcepts"
import { emitTermCreate, emitTermUpdate, emitTermDelete, emitTermApprove, emitTermReject } from "@/lib/sync/events-emit"
import { importConceptsCsv, exportConceptsCsv } from "@/lib/terminology/csv"
import { importConceptsTbx, exportConceptsTbx } from "@/lib/terminology/tbx"
import { humanRoleName } from "@/lib/frontier/roles"
import { canEditTermbase, canEditTermCells, resolveTermbaseEditFloor } from "@/lib/terminology/glossary-view"
import { computeTerminologyStats } from "@/lib/terminology/stats"
import type { CellPair } from "@/lib/terminology/stats"
import { isAudioCueFile } from "@/lib/parsers/types"
import { cn } from "@/lib/utils"
import { useProject } from "@/hooks/useProject"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { useProjectCells } from "@/hooks/useProjectCells"
import { buildFileScopedTokenFetcher } from "@/lib/sync/cqrs-bridge"
import { TerminologyTermDetail } from "@/components/TerminologyTermDetail"
import { CandidateTermsPanel } from "@/components/CandidateTermsPanel"
import { extractCandidates } from "@/lib/terminology/candidates"
import type { CandidateTerm } from "@/lib/terminology/candidates"
import { TerminologyViolationsInbox } from "@/components/TerminologyViolationsInbox"
import { TerminologyReviewQueue } from "@/components/TerminologyReviewQueue"
import { TerminologyMergeDialog } from "@/components/TerminologyMergeDialog"
import { ConfirmActionDialog } from "@/components/ConfirmActionDialog"
import { useI18n } from "@/lib/i18n/I18nProvider"
import type { TFunction } from "@/lib/i18n/I18nProvider"
import type { MessageKey } from "@/lib/i18n/messages/en"

// ────────────────────────────────────────────────────────────────────────────
// Rendering status chip helpers
// ────────────────────────────────────────────────────────────────────────────

const RENDERING_STATUSES: RenderingStatus[] = ["preferred", "admitted", "forbidden"]

/** Options for the per-rendering status `<Select>`, resolved at render time
 *  off the shared `terminology.status.*` vocabulary (see
 *  `renderingStatusLabelKey()` in `@/lib/terminology/types`) — mirrors
 *  `renderingStatusOptions()` in `GlossaryRow.tsx` so the two glossary
 *  surfaces never drift apart. `t()` must never be called at module scope,
 *  so this stays a plain function called from within a component body. */
function renderingStatusOptions(t: TFunction): { value: RenderingStatus; label: string }[] {
  return RENDERING_STATUSES.map((value) => ({ value, label: t(renderingStatusLabelKey(value)) }))
}

function RenderingChip({ rendering }: { rendering: TermRendering }) {
  const { t } = useI18n()
  const chipClass = cn(
    "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium",
    rendering.status === "preferred" &&
      "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400",
    rendering.status === "admitted" &&
      "bg-muted text-muted-foreground",
    rendering.status === "forbidden" &&
      "bg-red-100 text-red-700 line-through dark:bg-red-950 dark:text-red-400",
  )
  return (
    <span className={chipClass}>
      {rendering.rendering}
      <span className="opacity-60">·{t(renderingStatusLabelKey(rendering.status))}</span>
    </span>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// Concept status badge
// ────────────────────────────────────────────────────────────────────────────

const CONCEPT_STATUSES: Concept["status"][] = ["draft", "active", "deprecated"]

/** MessageKey for a concept's review-status label — reuses the
 *  `terminology.common.status*` vocabulary already keyed for
 *  TerminologyTermDetail.tsx rather than minting a duplicate string (see
 *  `no-duplicates.test.ts`). Returns a key, never a translated string, so
 *  it's safe to call from a module-scope table (`CONCEPT_STATUSES` above). */
function conceptStatusLabelKey(status: Concept["status"]): MessageKey {
  switch (status) {
    case "active":
      return "terminology.common.statusApproved"
    case "draft":
      return "terminology.common.statusSuggested"
    case "deprecated":
      return "terminology.common.statusOld"
  }
}

/** Options for the concept-status `<Select>` in ConceptDialog, resolved at
 *  render time — same pattern as `renderingStatusOptions()` above. */
function conceptStatusOptions(t: TFunction): { value: Concept["status"]; label: string }[] {
  return CONCEPT_STATUSES.map((value) => ({ value, label: t(conceptStatusLabelKey(value)) }))
}

function ConceptStatusBadge({ status }: { status: Concept["status"] }) {
  const { t } = useI18n()
  const variant =
    status === "active"
      ? "default"
      : status === "deprecated"
        ? "destructive"
        : "secondary"
  return (
    <Badge variant={variant} className="text-[10px]">
      {t(conceptStatusLabelKey(status))}
    </Badge>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// Rendering row inside the add/edit dialog
// ────────────────────────────────────────────────────────────────────────────

interface RenderingRowProps {
  rendering: TermRendering
  index: number
  onChange: (index: number, next: TermRendering) => void
  onRemove: (index: number) => void
}

function RenderingRow({ rendering, index, onChange, onRemove }: RenderingRowProps) {
  const { t } = useI18n()
  const statusOptions = renderingStatusOptions(t)
  return (
    <div className="flex items-center gap-2">
      <Input
        value={rendering.rendering}
        placeholder={t("terminology.conceptDialog.renderingPlaceholder")}
        aria-label={t("terminology.row.renderingTextAria", { position: index + 1 })}
        className="flex-1"
        onChange={(e) =>
          onChange(index, { ...rendering, rendering: e.target.value })
        }
      />
      <Select
        items={statusOptions}
        value={rendering.status}
        onValueChange={(v) =>
          onChange(index, {
            ...rendering,
            status: (v ?? rendering.status) as RenderingStatus,
          })
        }
      >
        <SelectTrigger
          aria-label={t("terminology.row.renderingStatusAria", { position: index + 1 })}
          className="text-xs"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {statusOptions.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={t("terminology.row.removeRenderingAria", { position: index + 1 })}
        onClick={() => onRemove(index)}
      >
        <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
      </Button>
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// Add / Edit concept dialog
// ────────────────────────────────────────────────────────────────────────────

interface ConceptDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  initial?: Concept | null
  /** Called with the concept payload to add or update — caller owns persistence. */
  onSave: (partial: Omit<Concept, "id" | "createdAt"> & { id?: string }) => Promise<void>
}

function ConceptDialog({ open, onOpenChange, initial, onSave }: ConceptDialogProps) {
  const { t } = useI18n()
  const conceptStatusOpts = conceptStatusOptions(t)
  const [sourceTerm, setSourceTerm] = useState(initial?.sourceTerm ?? "")
  const [renderings, setRenderings] = useState<TermRendering[]>(
    initial?.renderings ?? [{ rendering: "", status: "preferred" }],
  )
  const [notes, setNotes] = useState(initial?.notes ?? "")
  const [status, setStatus] = useState<Concept["status"]>(
    initial?.status ?? "draft",
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function resetState() {
    setSourceTerm(initial?.sourceTerm ?? "")
    setRenderings(
      initial?.renderings ?? [{ rendering: "", status: "preferred" }],
    )
    setNotes(initial?.notes ?? "")
    setStatus(initial?.status ?? "draft")
    setSaving(false)
    setError(null)
  }

  function handleClose() {
    resetState()
    onOpenChange(false)
  }

  function handleChangeRendering(index: number, next: TermRendering) {
    setRenderings((prev) => prev.map((r, i) => (i === index ? next : r)))
  }

  function handleRemoveRendering(index: number) {
    setRenderings((prev) => prev.filter((_, i) => i !== index))
  }

  function handleAddRendering() {
    setRenderings((prev) => [...prev, { rendering: "", status: "admitted" }])
  }

  async function handleSave() {
    setError(null)
    if (!sourceTerm.trim()) {
      setError("Source term is required.")
      return
    }
    const validRenderings = renderings.filter((r) => r.rendering.trim())
    if (validRenderings.length === 0) {
      setError("At least one rendering is required.")
      return
    }
    setSaving(true)
    try {
      await onSave({
        ...(initial ? { id: initial.id } : {}),
        sourceTerm: sourceTerm.trim(),
        renderings: validRenderings,
        notes: notes.trim() || undefined,
        status,
      })
      handleClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed")
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) handleClose() }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{initial ? t("terminology.page.editConceptTitle") : t("terminology.page.addConceptButton")}</DialogTitle>
        </DialogHeader>

        <FieldGroup className="space-y-4 py-1">
          <Field>
            <FieldLabel htmlFor="concept-source-term">{t("terminology.editor.sourceTermLabel")}</FieldLabel>
            <Input
              id="concept-source-term"
              value={sourceTerm}
              onChange={(e) => setSourceTerm(e.target.value)}
              placeholder="e.g. πνεῦμα" // i18n-exempt illustrative source-term example, independent of UI language
              autoFocus
            />
          </Field>

          <Field>
            <FieldLabel>{t("terminology.conceptDialog.targetRenderingsLabel")}</FieldLabel>
            <div className="space-y-2">
              {renderings.map((r, i) => (
                <RenderingRow
                  key={i}
                  rendering={r}
                  index={i}
                  onChange={handleChangeRendering}
                  onRemove={handleRemoveRendering}
                />
              ))}
            </div>
            <Button
              variant="outline"
              onClick={handleAddRendering}
              className="mt-1"
            >
              <Plus className="mr-1 h-3.5 w-3.5" />
              {t("terminology.row.addRendering")}
            </Button>
          </Field>

          <Field>
            <FieldLabel htmlFor="concept-notes">
              {t("terminology.common.notesLabel")} <OptionalMark />
            </FieldLabel>
            <Input
              id="concept-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder={t("terminology.row.notesPlaceholder")}
            />
          </Field>

          <Field>
            <FieldLabel htmlFor="concept-status">{t("terminology.common.statusLabel")}</FieldLabel>
            <Select
              items={conceptStatusOpts}
              value={status}
              onValueChange={(v) =>
                setStatus((v ?? "draft") as Concept["status"])
              }
            >
              <SelectTrigger id="concept-status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {conceptStatusOpts.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
        </FieldGroup>

        {error && (
          <FieldError>{error}</FieldError>
        )}

        <DialogFooter showCloseButton>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? t("common.saving") : initial ? t("common.saveChanges") : t("terminology.page.addConceptButton")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// Import dialog (CSV or TBX)
// ────────────────────────────────────────────────────────────────────────────

interface TermbaseImportDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onImported: (concepts: Concept[]) => void
}

function TermbaseImportDialog({
  open,
  onOpenChange,
  onImported,
}: TermbaseImportDialogProps) {
  const { t } = useI18n()
  const [tab, setTab] = useState<"csv" | "tbx">("csv")
  const [error, setError] = useState<string | null>(null)
  const [parsing, setParsing] = useState(false)

  function handleClose() {
    setError(null)
    setParsing(false)
    onOpenChange(false)
  }

  async function handleFile(file: File, format: "csv" | "tbx") {
    setParsing(true)
    setError(null)
    try {
      const text = await file.text()
      const concepts =
        format === "csv" ? importConceptsCsv(text) : importConceptsTbx(text)
      onImported(concepts)
      handleClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Parse failed")
    } finally {
      setParsing(false)
    }
  }

  function handleFileInput(
    e: React.ChangeEvent<HTMLInputElement>,
    format: "csv" | "tbx",
  ) {
    const file = e.target.files?.[0]
    if (file) handleFile(file, format)
    // Reset input so the same file can be re-selected
    e.target.value = ""
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) handleClose() }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("terminology.importDialog.title")}</DialogTitle>
        </DialogHeader>

        {/* Format tab strip */}
        <div className="inline-flex rounded-md border p-0.5 text-sm">
          {(["csv", "tbx"] as const).map((fmt) => (
            <button
              key={fmt}
              type="button"
              onClick={() => setTab(fmt)}
              className={cn(
                "rounded px-3 py-1 capitalize transition-colors",
                tab === fmt
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {fmt}
            </button>
          ))}
        </div>

        <div
          className={cn(
            "flex flex-col items-center justify-center rounded-lg border-2 border-dashed p-8 transition-colors",
            "border-muted",
          )}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault()
            const file = e.dataTransfer.files[0]
            if (file) handleFile(file, tab)
          }}
        >
          {parsing ? (
            <p className="text-sm text-muted-foreground">{t("terminology.importDialog.parsing")}</p>
          ) : (
            <>
              <p className="mb-3 text-sm text-muted-foreground">
                {t("terminology.importDialog.dropZoneText", { format: tab })}
              </p>
              <Button
                variant="outline"
                nativeButton={false}
                render={<label />}
              >
                {t("terminology.importDialog.chooseFileButton", { format: tab.toUpperCase() })}
                <input
                  type="file"
                  className="hidden"
                  accept={tab === "csv" ? ".csv,.tsv" : ".tbx,.xml"}
                  onChange={(e) => handleFileInput(e, tab)}
                />
              </Button>
              {tab === "csv" && (
                <p className="mt-2 text-xs text-muted-foreground">
                  {t("terminology.importDialog.csvColumnsHint")}
                </p>
              )}
              {/* i18n-exempt "tbx" is an import-format token, not copy */}
              {tab === "tbx" && (
                <p className="mt-2 text-xs text-muted-foreground">
                  {t("terminology.importDialog.tbxDialectsHint")}
                </p>
              )}
            </>
          )}
        </div>

        {error && (
          <p className="text-sm text-destructive">{error}</p>
        )}

        <DialogFooter showCloseButton />
      </DialogContent>
    </Dialog>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// Concept table row
// ────────────────────────────────────────────────────────────────────────────

interface ConceptRowProps {
  concept: Concept
  onEdit: (concept: Concept) => void
  onDelete: (id: string) => void
  onDrillDown: (concept: Concept) => void
  canManage: boolean
}

function ConceptRow({ concept, onEdit, onDelete, onDrillDown, canManage }: ConceptRowProps) {
  const { t } = useI18n()
  return (
    <li
      data-testid="concept-row"
      className="flex items-start gap-3 border-b py-3 last:border-0"
    >
      {/* Source term — click to drill down */}
      <div className="min-w-0 w-36 shrink-0">
        <button
          type="button"
          className="text-sm font-medium hover:underline text-left"
          onClick={() => onDrillDown(concept)}
        >
          {concept.sourceTerm}
        </button>
      </div>

      {/* Renderings */}
      <div className="flex flex-1 min-w-0 flex-wrap gap-1">
        {concept.renderings.map((r, i) => (
          <RenderingChip key={i} rendering={r} />
        ))}
      </div>

      {/* Notes */}
      <div className="hidden w-32 shrink-0 text-xs text-muted-foreground md:block truncate">
        {concept.notes ?? "—"}
      </div>

      {/* Status */}
      <div className="w-20 shrink-0">
        <ConceptStatusBadge status={concept.status} />
      </div>

      {/* Actions */}
      {canManage && (
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("terminology.page.editConceptAria", { term: concept.sourceTerm })}
            onClick={() => onEdit(concept)}
          >
            <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("terminology.page.deleteConceptAria", { term: concept.sourceTerm })}
            onClick={() => onDelete(concept.id)}
          >
            <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
          </Button>
        </div>
      )}
    </li>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// Stats header — derived on read from concepts + cells
// ────────────────────────────────────────────────────────────────────────────

interface LibraryStatsHeaderProps {
  concepts: Concept[]
  /** Cell pairs from the active file (or all files if aggregated). Pass [] when
   *  no cell data is available yet — the header renders a placeholder state. */
  cells: CellPair[]
}

function LibraryStatsHeader({ concepts, cells }: LibraryStatsHeaderProps) {
  const { t } = useI18n()
  const stats = useMemo(
    () => computeTerminologyStats(concepts, cells),
    [concepts, cells],
  )

  const activeConcepts = stats.totalConcepts
  const hasData = activeConcepts > 0

  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="mb-3 flex items-center gap-2">
        <BookOpen className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-semibold">{t("terminology.libraryStats.heading")}</span>
        {!hasData && (
          <span className="text-xs text-muted-foreground">{t("terminology.libraryStats.noActiveConcepts")}</span>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {/* Total active concepts */}
        <div className="rounded-md bg-muted/40 px-3 py-2">
          <p className="text-xs text-muted-foreground">
            {t("terminology.libraryStats.activeConceptsLabel")}
          </p>
          <p className="mt-0.5 text-xl font-bold tabular-nums">{activeConcepts}</p>
        </div>

        {/* % Enforced */}
        <div className="rounded-md bg-muted/40 px-3 py-2">
          <p className="text-xs text-muted-foreground">
            {t("terminology.libraryStats.enforcedLabel")}
          </p>
          <p className={cn(
            "mt-0.5 text-xl font-bold tabular-nums",
            hasData && stats.totalCells > 0
              ? stats.enforcedPct === 100
                ? "text-emerald-600 dark:text-emerald-400"
                : "text-foreground"
              : "text-muted-foreground",
          )}>
            {hasData && stats.totalCells > 0
              ? `${Math.round(stats.enforcedPct)}%`
              : "—"}
          </p>
        </div>

        {/* % Infringed */}
        <div className="rounded-md bg-muted/40 px-3 py-2">
          <p className="text-xs text-muted-foreground">
            {t("terminology.libraryStats.infringedLabel")}
          </p>
          <p className={cn(
            "mt-0.5 text-xl font-bold tabular-nums",
            hasData && stats.totalCells > 0
              ? stats.infringedPct === 0
                ? "text-emerald-600 dark:text-emerald-400"
                : stats.infringedPct > 20
                  ? "text-destructive"
                  : "text-amber-600 dark:text-amber-400"
              : "text-muted-foreground",
          )}>
            {hasData && stats.totalCells > 0
              ? `${Math.round(stats.infringedPct)}%`
              : "—"}
          </p>
        </div>

        {/* Cells analyzed */}
        <div className="rounded-md bg-muted/40 px-3 py-2">
          <p className="text-xs text-muted-foreground">
            {t("terminology.libraryStats.cellsAnalyzedLabel")}
          </p>
          <p className="mt-0.5 text-xl font-bold tabular-nums text-muted-foreground">
            {stats.totalCells}
          </p>
        </div>
      </div>

      {/* Top-5 most infringed */}
      {stats.top5Infringed.length > 0 && (
        <div className="mt-3 border-t pt-3">
          <p className="mb-2 text-xs text-muted-foreground">
            {t("terminology.libraryStats.mostInfringedLabel")}
          </p>
          <div className="flex flex-wrap gap-2">
            {stats.top5Infringed.map((s) => (
              <div
                key={s.conceptId}
                className="flex items-center gap-1.5 rounded bg-destructive/10 px-2 py-0.5 text-xs"
              >
                <span className="font-medium text-foreground">{s.sourceTerm}</span>
                <span className="text-destructive font-semibold">
                  {s.infringed}×
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// Main TerminologyPage
// ────────────────────────────────────────────────────────────────────────────

// ────────────────────────────────────────────────────────────────────────────
// Role-gating helpers
// project_lead = 500, maintainer = 600, owner = 700
// contributor = 400 — may edit cells; may manage termbase definitions only
//   when the org lowered `termbaseEditMinRole` to 400 (AQU-822)
// viewer/commenter/reviewer = <400 — read-only throughout
//
// The gate itself lives in `@/lib/terminology/glossary-view` (shared with
// GlossaryEditor) — this page used to carry a byte-identical private copy,
// which is exactly how the two surfaces would drift apart on a floor change.
// ────────────────────────────────────────────────────────────────────────────

interface GatedButtonProps extends React.ComponentPropsWithoutRef<typeof Button> {
  allowed: boolean
  tip: string
}

/** Wrapper that disables a Button with a tooltip when `allowed` is false. */
function GatedButton({ allowed, tip, children, ...props }: GatedButtonProps) {
  if (allowed) {
    return <Button {...props}>{children}</Button>
  }
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex" />}>
        <Button {...props} disabled aria-disabled="true">
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{tip}</TooltipContent>
    </Tooltip>
  )
}

export function TerminologyPage() {
  const { t } = useI18n()
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()

  const { project, loading } = useProject(id!)

  // Role-gating: AQU-822 — the floor is the org's configured
  // termbaseEditMinRole (project_lead 500 unless the org lowered or raised it),
  // carried on the project record and re-enforced server-side on every write.
  const termbaseEditFloor = resolveTermbaseEditFloor(project?.termbaseEditMinRole)
  const canManageTermbase = canEditTermbase(project?.syncRole, project?.termbaseEditMinRole)
  const termbaseGateTip = `Requires ${humanRoleName(termbaseEditFloor)} role or higher to manage term base definitions.`

  // Cell editing in the drill-down is allowed for contributor+ (level >= 400).
  // AQU-208: asked through the role-policy mirror so this agrees with the
  // editor's own gate on the same `target.cell.commit` event, and with
  // `canManageTermbase` above on how an unknown role is treated.
  const canEditCells = canEditTermCells(project?.syncRole)

  // ── Project-wide cells (derived-on-read source for stats + drill-down) ──────
  const { session: frontierSession } = useFrontierSession()
  const username = frontierSession?.username || project?.username || "local"
  const jwtRef = useRef<string | null>(null)
  useEffect(() => {
    jwtRef.current = frontierSession?.jwt ?? null
  }, [frontierSession?.jwt])

  // AQU-646 stage 2: this page reads `project.files` itself rather than the
  // workspace's already-filtered list, so it needs its own filter. An
  // audio-cue sibling's cells are a near-verbatim transcript of a film's
  // soundtrack — feeding those to candidate extraction would flood the term
  // suggestions with spoken filler from a file that has no terminology of its
  // own and is not translated anywhere.
  const projectFiles = useMemo(
    () =>
      (project?.files ?? [])
        .filter((f) => !isAudioCueFile(f))
        .map((f) => ({ id: f.id, name: f.name, type: f.type })),
    [project?.files],
  )

  const getToken = useMemo(() => {
    if (!project?.id) return async (_fileId: string) => null as string | null
    return buildFileScopedTokenFetcher(() => jwtRef.current, project.id, {
      projectName: project.name ?? undefined,
      gitlabProjectId:
        project.origin?.kind === "git" ? project.origin.gitlabProjectId : undefined,
    })
  }, [project?.id, project?.name, project?.origin])

  // AQU-1006 follow-up: concepts come from the sync-worker projection.
  // `project.terminology` (the settings-blob key) is retired — it could only
  // express "here is the entire termbase", which is why concurrent adds
  // destroyed each other. Declared here rather than at the top of the
  // component because it needs `getToken`, defined just above.
  const { concepts, refresh: refreshConcepts } = useConcepts({
    projectId: id ?? null,
    getToken,
    tokenReady: !!frontierSession?.jwt,
  })

  const cellsEnabled = Boolean(project?.id && projectFiles.length > 0)
  const { files: projectFileCells } = useProjectCells({
    projectId: id ?? null,
    projectFiles,
    getToken,
    enabled: cellsEnabled,
  })

  // Flatten all files' CellData; used directly by the drill-down and mapped to
  // CellPair for the stats header.
  const allCells = useMemo(
    () => projectFileCells.flatMap((f) => f.cells),
    [projectFileCells],
  )
  const cellPairs: CellPair[] = useMemo(
    () => allCells.map((c) => ({ original: c.original, translated: c.translated, medium: c.medium, transcription: c.transcription })),
    [allCells],
  )

  // ── Candidate-term discovery corpus ─────────────────────────────────────────
  // Mined over the loaded source + WIP cell texts (the same cells the stats and
  // drill-down read). This is a coverage cap: candidates are ranked over LOADED
  // cells only, not the entire project history. The G² keyness baseline is the
  // derived rest-of-corpus baseline (no external reference corpus is supplied).
  const candidateCorpus = useMemo(() => {
    const texts: string[] = []
    for (const c of allCells) {
      if (c.original?.trim()) texts.push(c.original)
      if (c.translated?.trim()) texts.push(c.translated)
    }
    return texts
  }, [allCells])

  const [tab, setTab] = useState<"concepts" | "queue" | "candidates" | "violations">("concepts")

  // ── Draft concepts (review queue) ─────────────────────────────────────────
  const draftConcepts = useMemo(() => concepts.filter((c) => c.status === "draft"), [concepts])

  // ── Merge dialog state ────────────────────────────────────────────────────
  const [mergeOpen, setMergeOpen] = useState(false)

  // ── Candidate mining (lazy, off-thread) ─────────────────────────────────────
  // The C-value/NC-value/G² stack is super-linear in corpus size, but mining
  // now runs in a Web Worker off the main thread, so we mine the FULL loaded
  // corpus by default. A high safety ceiling only kicks in for pathologically
  // large corpora (the worker would still finish, but we cap to keep memory and
  // latency bounded); the cap is surfaced in the UI only when actually hit.
  const CANDIDATE_CORPUS_CEILING = 50_000
  const [candidates, setCandidates] = useState<CandidateTerm[]>([])
  const [candidatesLoading, setCandidatesLoading] = useState(false)
  const [candidatesReady, setCandidatesReady] = useState(false)
  const [minedCount, setMinedCount] = useState(0)
  const candidateWorkerRef = useRef<Worker | null>(null)
  const candidateReqRef = useRef(0)

  useEffect(() => {
    return () => {
      candidateWorkerRef.current?.terminate()
      candidateWorkerRef.current = null
    }
  }, [])

  // Recompute when the corpus or managed concepts change *while the tab is
  // active*; otherwise just mark stale so the next activation recomputes.
  useEffect(() => {
    if (tab !== "candidates") {
      setCandidatesReady(false)
      return
    }
    let cancelled = false
    setCandidatesLoading(true)
    const reqId = ++candidateReqRef.current

    void (async () => {
      try {
        const mod = await import("@/lib/terminology/candidates-worker?worker")
        if (cancelled) return
        if (!candidateWorkerRef.current) {
          candidateWorkerRef.current = new mod.default()
        }
        const worker = candidateWorkerRef.current
        worker.onmessage = (e: MessageEvent) => {
          const data = e.data
          if (!data || data.requestId !== String(reqId)) return
          if (data.type === "result") {
            setCandidates(data.candidates)
            setMinedCount(data.minedCount)
            setCandidatesReady(true)
            setCandidatesLoading(false)
          } else if (data.type === "error") {
            setCandidates([])
            setCandidatesReady(true)
            setCandidatesLoading(false)
          }
        }
        worker.postMessage({
          type: "mine",
          requestId: String(reqId),
          corpus: candidateCorpus,
          managed: concepts,
          maxCorpusStrings: CANDIDATE_CORPUS_CEILING,
        })
      } catch {
        // Worker failed to load (e.g. unsupported env): fall back to inline.
        if (cancelled) return
        const out = extractCandidates(candidateCorpus, {
          managed: concepts,
          maxCorpusStrings: CANDIDATE_CORPUS_CEILING,
        })
        setCandidates(out)
        setMinedCount(Math.min(candidateCorpus.length, CANDIDATE_CORPUS_CEILING))
        setCandidatesReady(true)
        setCandidatesLoading(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [tab, candidateCorpus, concepts])
  const [addOpen, setAddOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<Concept | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [drillDownConcept, setDrillDownConcept] = useState<Concept | null>(null)
  // AQU-291: pending delete confirmation state.
  const [pendingDeleteConceptId, setPendingDeleteConceptId] = useState<string | null>(null)
  const pendingDeleteConcept = pendingDeleteConceptId
    ? concepts.find((c) => c.id === pendingDeleteConceptId) ?? null
    : null

  const handleDrillDown = useCallback((concept: Concept) => {
    setDrillDownConcept(concept)
  }, [])

  // ── Persist helper ─────────────────────────────────────────────────────────

  // AQU-1006 follow-up: there is deliberately NO `persistConcepts(array)`
  // helper any more. Writing the whole termbase in one PATCH — rebuilt from
  // this component's snapshot — is exactly what silently destroyed concurrent
  // adds on 2026-09-04. Every mutation below names ONE concept and emits one
  // event. Do not reintroduce a bulk-array write; if you need to write many
  // concepts (an import), emit one event per concept.
  const author = frontierSession?.username || project?.username || "local"

  /**
   * Re-read the projection after a write so the list reflects the server.
   *
   * useCallback, not a bare function: the memoized handlers below depend on
   * it, and a fresh identity per render would either bust their memos or (worse)
   * be silently omitted from their dependency arrays.
   */
  const afterWrite = useCallback(async () => {
    await refreshConcepts()
  }, [refreshConcepts])

  // ── Export helpers ─────────────────────────────────────────────────────────

  function downloadBlob(content: string, filename: string, mime: string) {
    const blob = new Blob([content], { type: mime })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
  }

  function handleExportCsv() {
    try {
      const csv = exportConceptsCsv(concepts)
      downloadBlob(csv, "termbase.csv", "text/csv")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Export failed")
    }
  }

  function handleExportTbx() {
    try {
      const tbx = exportConceptsTbx(concepts)
      downloadBlob(tbx, "termbase.tbx", "application/xml")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Export failed")
    }
  }

  // ── CRUD handlers ─────────────────────────────────────────────────────────

  async function handleSave(
    partial: Omit<Concept, "id" | "createdAt"> & { id?: string },
  ) {
    if (!project) throw new Error("Project not loaded")
    if (partial.id) {
      const { id: conceptId, ...patch } = partial
      await emitTermUpdate({
        projectId: project.id,
        conceptId,
        // Only the keys actually present are sent; the projector leaves every
        // absent column alone, so a concurrent edit to a DIFFERENT field of
        // this same concept survives.
        ...(patch.sourceTerm !== undefined ? { sourceTerm: patch.sourceTerm } : {}),
        ...(patch.renderings !== undefined ? { renderings: patch.renderings } : {}),
        ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
        ...(patch.caseSensitive !== undefined ? { caseSensitive: patch.caseSensitive } : {}),
        author,
      })
    } else {
      await emitTermCreate({
        projectId: project.id,
        conceptId: crypto.randomUUID(),
        sourceTerm: partial.sourceTerm,
        renderings: partial.renderings ?? [],
        status: partial.status ?? "draft",
        ...(partial.notes !== undefined ? { notes: partial.notes } : {}),
        ...(partial.caseSensitive ? { caseSensitive: true } : {}),
        author,
      })
    }
    await afterWrite()
  }

  async function handleDelete(conceptId: string) {
    if (!project) return
    try {
      await emitTermDelete({ projectId: project.id, conceptId, author })
      await afterWrite()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed")
    }
  }

  // Promote a mined candidate into the managed vocabulary as a draft Concept.
  // It crosses into the controlled list with status "draft" (suggested) and no
  // renderings decided yet — the user fills those in via the edit dialog. Opens
  // the edit dialog immediately so the rendering decision is the next step.
  const handlePromoteCandidate = useCallback(
    async (candidate: CandidateTerm) => {
      if (!project) return
      if (!canManageTermbase) {
        setError("Requires Project Lead role or higher to manage term base definitions.")
        return
      }
      // Skip if a concept with this source term already exists.
      const exists = concepts.some(
        (c) => c.sourceTerm.trim().toLowerCase() === candidate.term.trim().toLowerCase(),
      )
      if (exists) return
      try {
        const conceptId = crypto.randomUUID()
        await emitTermCreate({
          projectId: project.id,
          conceptId,
          sourceTerm: candidate.term,
          renderings: [],
          status: "draft",
          author,
        })
        await afterWrite()
        // Open the edit dialog on the concept we just minted. Identified by
        // the id we generated rather than by searching the list for a matching
        // sourceTerm — the search could pick up somebody else's concurrently
        // created draft for the same term.
        setEditTarget({
          id: conceptId,
          sourceTerm: candidate.term,
          renderings: [],
          status: "draft",
          createdAt: new Date().toISOString(),
        })
      } catch (err) {
        setError(err instanceof Error ? err.message : "Promote failed")
      }
    },
    [project, canManageTermbase, concepts, author, afterWrite],
  )

  // Promote a predicted equivalent to an admitted (alternate) rendering on the
  // concept. Crosses the deterministic line; persisted exactly like edits.
  const handlePromoteRendering = useCallback(
    async (conceptId: string, target: string) => {
      if (!project) return
      const concept = concepts.find((c) => c.id === conceptId)
      if (!concept) return
      const trimmed = target.trim()
      if (!trimmed) return
      // Don't duplicate an existing rendering.
      if (
        concept.renderings.some(
          (r) => r.rendering.trim().toLowerCase() === trimmed.toLowerCase(),
        )
      ) {
        return
      }
      const nextRenderings: TermRendering[] = [
        ...concept.renderings,
        { rendering: trimmed, status: "admitted" },
      ]
      try {
        await emitTermUpdate({
          projectId: project.id,
          conceptId,
          renderings: nextRenderings,
          author,
        })
        await afterWrite()
        // Reflect the new rendering in the open drill-down view.
        setDrillDownConcept(
          (prev) =>
            prev && prev.id === conceptId
              ? { ...prev, renderings: nextRenderings }
              : prev,
        )
      } catch (err) {
        setError(err instanceof Error ? err.message : "Promote failed")
      }
    },
    [project, author, afterWrite, concepts],
  )

  // ── Review queue handlers ─────────────────────────────────────────────────

  async function handleApprove(conceptId: string) {
    if (!project) return
    try {
      await emitTermApprove({ projectId: project.id, conceptId, author })
      await afterWrite()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Approve failed")
    }
  }

  async function handleReject(conceptId: string) {
    if (!project) return
    try {
      // Reject = delete (removes draft from list entirely)
      await emitTermReject({ projectId: project.id, conceptId, mode: "delete", author })
      await afterWrite()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Reject failed")
    }
  }

  // AQU-1006 follow-up: replace a concept's rendering list from the detail
  // page — add, remove, or change required / allowed / forbidden. One
  // `term.update` per change; renderings replace wholesale because they have
  // no per-item identity to merge on.
  const handleRenderingsChange = useCallback(
    async (conceptId: string, renderings: TermRendering[]) => {
      if (!project) return
      try {
        await emitTermUpdate({ projectId: project.id, conceptId, renderings, author })
        await afterWrite()
        // Keep the open drill-down in step with what was just written.
        setDrillDownConcept((prev) =>
          prev && prev.id === conceptId ? { ...prev, renderings } : prev,
        )
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not update renderings")
      }
    },
    [project, author, afterWrite],
  )

  // ── Merge handler ─────────────────────────────────────────────────────────

  async function handleMerge(mergeIds: string[], survivorId: string) {
    if (!project) return
    // Merge is expressed as: write the survivor's merged renderings, then
    // tombstone each loser. One event per concept — a merge is several
    // single-concept writes, never one whole-termbase write.
    const merged = mergeConcepts(project ? { ...project, terminology: concepts } : project, mergeIds, survivorId)
    const survivor = (merged.terminology ?? []).find((c) => c.id === survivorId)
    if (survivor) {
      await emitTermUpdate({
        projectId: project.id,
        conceptId: survivorId,
        renderings: survivor.renderings,
        ...(survivor.notes !== undefined ? { notes: survivor.notes } : {}),
        author,
      })
    }
    for (const loserId of mergeIds.filter((cid) => cid !== survivorId)) {
      await emitTermDelete({ projectId: project.id, conceptId: loserId, author })
    }
    await afterWrite()
  }

  async function handleImported(imported: Concept[]) {
    if (!project) return
    // Dedup by sourceTerm, imported wins on collision — but expressed as ONE
    // EVENT PER CONCEPT rather than a single array write. An import is the
    // most tempting place to write the whole termbase at once and the worst
    // place to do it: it is the largest write, so it had the widest window in
    // which to clobber a colleague's concurrent add.
    const byTerm = new Map(concepts.map((c) => [c.sourceTerm, c]))
    for (const c of imported) {
      const existing = byTerm.get(c.sourceTerm)
      if (existing) {
        await emitTermUpdate({
          projectId: project.id,
          conceptId: existing.id,
          renderings: c.renderings,
          ...(c.notes !== undefined ? { notes: c.notes } : {}),
          ...(c.caseSensitive !== undefined ? { caseSensitive: c.caseSensitive } : {}),
          author,
        })
      } else {
        await emitTermCreate({
          projectId: project.id,
          conceptId: c.id || crypto.randomUUID(),
          sourceTerm: c.sourceTerm,
          renderings: c.renderings ?? [],
          status: c.status ?? "draft",
          ...(c.notes !== undefined ? { notes: c.notes } : {}),
          ...(c.caseSensitive ? { caseSensitive: true } : {}),
          author,
        })
      }
    }
    await afterWrite()
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  if (loading) {
    return <LoadingPanel label={t("terminology.loadingLabel")} className="min-h-screen" />
  }

  // Drill-down view: overlay the detail panel when a concept is selected.
  // Cells are the project-wide CellData flattened across all files (derived on
  // read); occurrences + verdicts populate from them.
  if (drillDownConcept) {
    return (
      <TerminologyTermDetail
        concept={drillDownConcept}
        cells={allCells}
        canEdit={canEditCells}
        projectId={id!}
        username={username}
        onClose={() => setDrillDownConcept(null)}
        onCellCommitted={() => {}}
        onOptimisticEdit={() => {}}
        canManageTermbase={canManageTermbase}
        onPromoteRendering={handlePromoteRendering}
        onRenderingsChange={handleRenderingsChange}
      />
    )
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="flex items-center gap-4 border-b px-4 py-2">
        <BookOpen className="h-4 w-4 text-muted-foreground" />
        <h2 className="font-semibold">{t("nav.sidebarSection.terminology")}</h2>
        <div className="flex-1" />

        {/* Export controls */}
        <div className="flex items-center gap-1">
          <GatedButton
            allowed={canManageTermbase}
            tip={termbaseGateTip}
            variant="outline"
            onClick={handleExportCsv}
            disabled={concepts.length === 0}
            aria-label={t("terminology.editor.exportCsv")}
          >
            <Download className="mr-1 h-3.5 w-3.5" />
            CSV
          </GatedButton>
          <GatedButton
            allowed={canManageTermbase}
            tip={termbaseGateTip}
            variant="outline"
            onClick={handleExportTbx}
            disabled={concepts.length === 0}
            aria-label={t("terminology.editor.exportTbx")}
          >
            <Download className="mr-1 h-3.5 w-3.5" />
            TBX
          </GatedButton>
        </div>

        {/* Import */}
        <GatedButton
          allowed={canManageTermbase}
          tip={termbaseGateTip}
          variant="outline"
          onClick={() => setImportOpen(true)}
        >
          <Upload className="mr-1 h-3.5 w-3.5" />
          {t("nav.workspaceActions.import")}
        </GatedButton>

        {/* Add concept */}
        <GatedButton
          allowed={canManageTermbase}
          tip={termbaseGateTip}
          onClick={() => setAddOpen(true)}
        >
          <Plus className="mr-1 h-3.5 w-3.5" />
          {t("terminology.page.addConceptButton")}
        </GatedButton>
      </header>

      {/* Main content */}
      <main className="mx-auto max-w-3xl space-y-4 p-6">
        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}

        {/* Stats header — derived on read, no persistence */}
        <LibraryStatsHeader concepts={concepts} cells={cellPairs} />

        {/* Tab strip: managed Concepts vs review queue vs candidates vs violations */}
        <div className="flex items-center gap-2">
          <div className="inline-flex rounded-md border p-0.5 text-sm">
            {([
              { key: "concepts", label: t("terminology.page.conceptsHeading", { count: concepts.length }) },
              {
                key: "queue",
                label:
                  draftConcepts.length > 0
                    ? t("terminology.page.reviewQueueCountLabel", { count: draftConcepts.length })
                    : t("terminology.page.reviewQueueHeading"),
              },
              {
                key: "candidates",
                label: candidatesReady
                  ? t("terminology.page.candidateTermsCountLabel", { count: candidates.length })
                  : t("terminology.page.candidateTermsHeading"),
              },
              { key: "violations", label: t("terminology.violations.title") },
            ] as const).map((tab_) => (
              <button
                key={tab_.key}
                type="button"
                onClick={() => setTab(tab_.key)}
                className={cn(
                  "rounded px-3 py-1 transition-colors",
                  tab === tab_.key
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {tab_.label}
              </button>
            ))}
          </div>

          {/* Merge button — only show when there are 2+ concepts and user can manage */}
          {concepts.length >= 2 && canManageTermbase && (
            <Button
              variant="outline"
              onClick={() => setMergeOpen(true)}
              aria-label={t("terminology.mergeDialog.title")}
              data-testid="merge-duplicates-btn"
            >
              {t("terminology.page.mergeDuplicatesButton")}
            </Button>
          )}
        </div>

        {tab === "violations" ? (
          // Lazy: the rule-engine scan only runs while this is mounted, i.e.
          // while the Violations tab is active (mirrors the candidate tab).
          <TerminologyViolationsInbox
            concepts={concepts}
            cells={allCells}
            onJumpToCell={() => navigate(`/project/${id}/editor`)}
          />
        ) : tab === "queue" ? (
          <Card>
            <CardHeader>
              <CardTitle>{t("terminology.page.reviewQueueHeading")}</CardTitle>
            </CardHeader>
            <CardContent>
              <TerminologyReviewQueue
                draftConcepts={draftConcepts}
                canManage={canManageTermbase}
                onApprove={handleApprove}
                onReject={handleReject}
              />
            </CardContent>
          </Card>
        ) : tab === "candidates" ? (
          <Card>
            <CardHeader>
              <CardTitle>{t("terminology.page.candidateTermsHeading")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-xs text-muted-foreground">
                {t("terminology.candidates.minedFromSummary", {
                  count: candidatesReady ? minedCount : Math.min(candidateCorpus.length, CANDIDATE_CORPUS_CEILING),
                  note: candidateCorpus.length > CANDIDATE_CORPUS_CEILING
                    ? t("terminology.candidates.corpusScopeCapped", {
                        ceiling: CANDIDATE_CORPUS_CEILING,
                        total: candidateCorpus.length,
                      })
                    : t("terminology.candidates.corpusScopeFull"),
                })}
              </p>
              {candidatesLoading && !candidatesReady ? (
                <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
                  <Spinner className="size-4" />
                  {t("terminology.candidates.miningLabel")}
                </div>
              ) : (
                <CandidateTermsPanel
                  candidates={candidates}
                  onPromote={handlePromoteCandidate}
                />
              )}
            </CardContent>
          </Card>
        ) : (
        <Card>
          <CardHeader>
            <CardTitle>
              {t("terminology.page.conceptsHeading", { count: concepts.length })}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {concepts.length === 0 ? (
              <div className="flex flex-col items-center gap-3 py-12 text-center text-muted-foreground">
                <BookOpen className="h-8 w-8 opacity-40" />
                <p className="text-sm">{t("terminology.page.noConceptsTitle")}</p>
                <p className="text-xs">
                  {t("terminology.page.noConceptsDescription")}
                </p>
                <GatedButton
                  allowed={canManageTermbase}
                  tip={termbaseGateTip}
                  variant="outline"
                  onClick={() => setAddOpen(true)}
                >
                  <Plus className="mr-1 h-3.5 w-3.5" />
                  {t("terminology.page.addFirstConceptButton")}
                </GatedButton>
              </div>
            ) : (
              <>
                {/* Column header */}
                <div className="mb-2 hidden items-center gap-3 text-xs text-muted-foreground md:flex">
                  <span className="w-36 shrink-0">{t("terminology.editor.sourceTermLabel")}</span>
                  <span className="flex-1">{t("terminology.page.renderingsColumnHeader")}</span>
                  <span className="w-32 shrink-0">{t("terminology.common.notesLabel")}</span>
                  <span className="w-20 shrink-0">{t("terminology.common.statusLabel")}</span>
                  <span className="w-14 shrink-0" />
                </div>
                <div className="max-h-[60vh] overflow-y-auto">
                  <ul>
                    {concepts.map((concept) => (
                      <ConceptRow
                        key={concept.id}
                        concept={concept}
                        onEdit={setEditTarget}
                        onDelete={setPendingDeleteConceptId}
                        onDrillDown={handleDrillDown}
                        canManage={canManageTermbase}
                      />
                    ))}
                  </ul>
                </div>
              </>
            )}
          </CardContent>
        </Card>
        )}
      </main>

      {/* Add dialog */}
      <ConceptDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        onSave={handleSave}
      />

      {/* Edit dialog */}
      {editTarget && (
        <ConceptDialog
          open={!!editTarget}
          onOpenChange={(next) => { if (!next) setEditTarget(null) }}
          initial={editTarget}
          onSave={async (partial) => {
            await handleSave(partial)
            setEditTarget(null)
          }}
        />
      )}

      {/* Import dialog */}
      <TermbaseImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        onImported={handleImported}
      />

      {/* Merge duplicates dialog */}
      <TerminologyMergeDialog
        open={mergeOpen}
        onOpenChange={setMergeOpen}
        concepts={concepts}
        onMerge={handleMerge}
      />

      {/* AQU-291: checkbox-confirm before deleting a concept */}
      <ConfirmActionDialog
        open={pendingDeleteConceptId !== null}
        onOpenChange={(v) => { if (!v) setPendingDeleteConceptId(null) }}
        title={t("terminology.page.deleteConceptDialogTitle")}
        description={
          pendingDeleteConcept
            ? t("terminology.page.deleteNamedConcept", { term: pendingDeleteConcept.sourceTerm })
            : t("terminology.page.deleteConcept")
        }
        confirmLabel="Delete concept"
        checkboxLabel="I understand this deletes the concept and all its renderings for everyone in the project."
        variant="destructive"
        onConfirm={() => { if (pendingDeleteConceptId) handleDelete(pendingDeleteConceptId) }}
      />
    </div>
  )
}
