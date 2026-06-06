import { useState, useMemo, useCallback, useRef, useEffect } from "react"
import { useParams, useNavigate } from "react-router-dom"
import {
  ArrowLeft,
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
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import type { Concept, TermRendering, RenderingStatus } from "@/lib/terminology/types"
import { addConcept, updateConcept, deleteConcept } from "@/lib/terminology/store"
import { importConceptsCsv, exportConceptsCsv } from "@/lib/terminology/csv"
import { importConceptsTbx, exportConceptsTbx } from "@/lib/terminology/tbx"
import { computeTerminologyStats } from "@/lib/terminology/stats"
import type { CellPair } from "@/lib/terminology/stats"
import { cn } from "@/lib/utils"
import { useProject } from "@/hooks/useProject"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { useProjectCells } from "@/hooks/useProjectCells"
import { buildFileScopedTokenFetcher } from "@/lib/sync/cqrs-bridge"
import { TerminologyTermDetail } from "@/components/TerminologyTermDetail"

// ────────────────────────────────────────────────────────────────────────────
// Rendering status chip helpers
// ────────────────────────────────────────────────────────────────────────────

const statusLabel: Record<RenderingStatus, string> = {
  preferred: "required",
  admitted: "alternate",
  forbidden: "forbidden",
}

function RenderingChip({ rendering }: { rendering: TermRendering }) {
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
      <span className="opacity-60">·{statusLabel[rendering.status]}</span>
    </span>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// Concept status badge
// ────────────────────────────────────────────────────────────────────────────

const conceptStatusLabel: Record<Concept["status"], string> = {
  active: "approved",
  draft: "suggested",
  deprecated: "old",
}

function ConceptStatusBadge({ status }: { status: Concept["status"] }) {
  const variant =
    status === "active"
      ? "default"
      : status === "deprecated"
        ? "destructive"
        : "secondary"
  return (
    <Badge variant={variant} className="text-[10px]">
      {conceptStatusLabel[status]}
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
  return (
    <div className="flex items-center gap-2">
      <Input
        value={rendering.rendering}
        placeholder="rendering"
        aria-label={`Rendering ${index + 1} text`}
        className="flex-1"
        onChange={(e) =>
          onChange(index, { ...rendering, rendering: e.target.value })
        }
      />
      <select
        value={rendering.status}
        aria-label={`Rendering ${index + 1} status`}
        className="h-8 rounded-lg border bg-background px-2 text-xs focus-visible:ring-2 focus-visible:ring-ring"
        onChange={(e) =>
          onChange(index, {
            ...rendering,
            status: e.target.value as RenderingStatus,
          })
        }
      >
        <option value="preferred">required</option>
        <option value="admitted">alternate</option>
        <option value="forbidden">forbidden</option>
      </select>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`Remove rendering ${index + 1}`}
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
          <DialogTitle>{initial ? "Edit concept" : "Add concept"}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-1">
          {/* Source term */}
          <div className="space-y-1.5">
            <Label htmlFor="concept-source-term">Source term</Label>
            <Input
              id="concept-source-term"
              value={sourceTerm}
              onChange={(e) => setSourceTerm(e.target.value)}
              placeholder="e.g. πνεῦμα"
              autoFocus
            />
          </div>

          {/* Renderings */}
          <div className="space-y-1.5">
            <Label>Target renderings</Label>
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
              size="sm"
              onClick={handleAddRendering}
              className="mt-1"
            >
              <Plus className="mr-1 h-3.5 w-3.5" />
              Add rendering
            </Button>
          </div>

          {/* Notes */}
          <div className="space-y-1.5">
            <Label htmlFor="concept-notes">Notes (optional)</Label>
            <Input
              id="concept-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Contextual notes for translators"
            />
          </div>

          {/* Status */}
          <div className="space-y-1.5">
            <Label htmlFor="concept-status">Status</Label>
            <select
              id="concept-status"
              value={status}
              className="h-8 w-full rounded-lg border bg-background px-2 text-sm focus-visible:ring-2 focus-visible:ring-ring"
              onChange={(e) => setStatus(e.target.value as Concept["status"])}
            >
              <option value="draft">suggested</option>
              <option value="active">approved</option>
              <option value="deprecated">old</option>
            </select>
          </div>
        </div>

        {error && (
          <p className="text-sm text-destructive">{error}</p>
        )}

        <DialogFooter showCloseButton>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? "Saving…" : initial ? "Save changes" : "Add concept"}
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
          <DialogTitle>Import termbase</DialogTitle>
        </DialogHeader>

        {/* Format tab strip */}
        <div className="inline-flex rounded-md border p-0.5 text-sm">
          {(["csv", "tbx"] as const).map((fmt) => (
            <button
              key={fmt}
              type="button"
              onClick={() => setTab(fmt)}
              className={cn(
                "rounded px-3 py-1 uppercase transition-colors",
                tab === fmt
                  ? "bg-primary text-primary-foreground"
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
            <p className="text-sm text-muted-foreground">Parsing…</p>
          ) : (
            <>
              <p className="mb-3 text-sm text-muted-foreground">
                Drop a .{tab} file here, or
              </p>
              <Button
                variant="outline"
                size="sm"
                nativeButton={false}
                render={<label className="cursor-pointer" />}
              >
                Choose {tab.toUpperCase()} file
                <input
                  type="file"
                  className="hidden"
                  accept={tab === "csv" ? ".csv,.tsv" : ".tbx,.xml"}
                  onChange={(e) => handleFileInput(e, tab)}
                />
              </Button>
              {tab === "csv" && (
                <p className="mt-2 text-xs text-muted-foreground">
                  Columns: source_lemma · target_lemma · target_status ·
                  definition (optional)
                </p>
              )}
              {tab === "tbx" && (
                <p className="mt-2 text-xs text-muted-foreground">
                  TBX-Basic and TBX-Min dialects supported
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
  return (
    <li
      data-testid="concept-row"
      className="flex items-start gap-3 border-b py-3 last:border-0"
    >
      {/* Source term — click to drill down */}
      <div className="min-w-0 w-36 shrink-0">
        <button
          type="button"
          className="text-sm font-medium hover:underline text-left cursor-pointer"
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
            aria-label={`Edit concept ${concept.sourceTerm}`}
            onClick={() => onEdit(concept)}
          >
            <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Delete concept ${concept.sourceTerm}`}
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
  const stats = useMemo(
    () => computeTerminologyStats(concepts, cells),
    [concepts, cells],
  )

  const activeConcepts = stats.totalConcepts
  const hasData = activeConcepts > 0

  return (
    <div className="rounded-lg border bg-card p-4 shadow-sm">
      <div className="mb-3 flex items-center gap-2">
        <BookOpen className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-semibold">Library Overview</span>
        {!hasData && (
          <span className="text-xs text-muted-foreground">(no active concepts)</span>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {/* Total active concepts */}
        <div className="rounded-md bg-muted/40 px-3 py-2">
          <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            Active concepts
          </p>
          <p className="mt-0.5 text-xl font-bold tabular-nums">{activeConcepts}</p>
        </div>

        {/* % Enforced */}
        <div className="rounded-md bg-muted/40 px-3 py-2">
          <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            Enforced
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
          <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            Infringed
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
          <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            Cells analyzed
          </p>
          <p className="mt-0.5 text-xl font-bold tabular-nums text-muted-foreground">
            {stats.totalCells}
          </p>
        </div>
      </div>

      {/* Top-5 most infringed */}
      {stats.top5Infringed.length > 0 && (
        <div className="mt-3 border-t pt-3">
          <p className="mb-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            Most infringed
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
// contributor = 400 — may edit cells but NOT termbase definitions
// viewer/commenter/reviewer = <400 — read-only throughout
// ────────────────────────────────────────────────────────────────────────────

/** Level at which a user may manage termbase definitions (add/edit/delete concepts, import). */
const TERMBASE_EDIT_LEVEL = 500

/** For local projects with no syncRole, default to full access (owner-equivalent). */
function canEditTermbase(syncRole?: { level: number } | null, hasOrigin?: boolean): boolean {
  if (!hasOrigin) return true // local-only project — no cloud role hierarchy
  if (!syncRole) return true  // no role cached yet — optimistic allow; server will enforce
  return syncRole.level >= TERMBASE_EDIT_LEVEL
}

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
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()

  const { project, loading, patchSettings } = useProject(id!)

  // Derive concepts from the project record — single source of truth
  const concepts = project?.terminology ?? []

  // Role-gating: project_lead+ (level >= 500) may manage termbase definitions.
  const hasOrigin = Boolean(project?.origin)
  const canManageTermbase = canEditTermbase(project?.syncRole, hasOrigin)
  const termbaseGateTip = "Requires Project Lead role or higher to manage termbase definitions."

  // Cell editing in the drill-down is allowed for contributor+ (level >= 400),
  // or always for local (no-origin) projects.
  const canEditCells = !hasOrigin || (project?.syncRole?.level ?? 0) >= 400

  // ── Project-wide cells (derived-on-read source for stats + drill-down) ──────
  const { session: frontierSession } = useFrontierSession()
  const username = frontierSession?.username || project?.username || "local"
  const jwtRef = useRef<string | null>(null)
  useEffect(() => {
    jwtRef.current = frontierSession?.jwt ?? null
  }, [frontierSession?.jwt])

  const projectFiles = useMemo(
    () =>
      (project?.files ?? []).map((f) => ({ id: f.id, name: f.name, type: f.type })),
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
    () => allCells.map((c) => ({ original: c.original, translated: c.translated })),
    [allCells],
  )

  const [addOpen, setAddOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<Concept | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [drillDownConcept, setDrillDownConcept] = useState<Concept | null>(null)

  const handleDrillDown = useCallback((concept: Concept) => {
    setDrillDownConcept(concept)
  }, [])

  // ── Persist helper ─────────────────────────────────────────────────────────

  async function persistConcepts(updatedConcepts: Concept[]) {
    await patchSettings({ terminology: updatedConcepts })
  }

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
    let updated
    if (partial.id) {
      const { id: conceptId, ...patch } = partial
      updated = updateConcept(project, conceptId, patch)
    } else {
      updated = addConcept(project, partial)
    }
    await persistConcepts(updated.terminology ?? [])
  }

  async function handleDelete(conceptId: string) {
    if (!project) return
    try {
      const updated = deleteConcept(project, conceptId)
      await persistConcepts(updated.terminology ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed")
    }
  }

  async function handleImported(imported: Concept[]) {
    if (!project) return
    // Merge by sourceTerm dedup — imported wins on collision
    const map = new Map(concepts.map((c) => [c.sourceTerm, c]))
    for (const c of imported) map.set(c.sourceTerm, c)
    await persistConcepts([...map.values()])
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  if (loading) return <div className="p-8 text-muted-foreground">Loading…</div>

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
      />
    )
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="flex items-center gap-4 border-b px-4 py-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => navigate(`/project/${id}`)}
        >
          <ArrowLeft className="mr-1 h-4 w-4" />
          Back to Editor
        </Button>
        <BookOpen className="h-4 w-4 text-muted-foreground" />
        <h2 className="font-semibold">Terminology</h2>
        <div className="flex-1" />

        {/* Export controls */}
        <div className="flex items-center gap-1">
          <GatedButton
            allowed={canManageTermbase}
            tip={termbaseGateTip}
            variant="outline"
            size="sm"
            onClick={handleExportCsv}
            disabled={concepts.length === 0}
            aria-label="Export CSV"
          >
            <Download className="mr-1 h-3.5 w-3.5" />
            CSV
          </GatedButton>
          <GatedButton
            allowed={canManageTermbase}
            tip={termbaseGateTip}
            variant="outline"
            size="sm"
            onClick={handleExportTbx}
            disabled={concepts.length === 0}
            aria-label="Export TBX"
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
          size="sm"
          onClick={() => setImportOpen(true)}
        >
          <Upload className="mr-1 h-3.5 w-3.5" />
          Import
        </GatedButton>

        {/* Add concept */}
        <GatedButton
          allowed={canManageTermbase}
          tip={termbaseGateTip}
          size="sm"
          onClick={() => setAddOpen(true)}
        >
          <Plus className="mr-1 h-3.5 w-3.5" />
          Add concept
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

        <Card>
          <CardHeader>
            <CardTitle>
              Concepts ({concepts.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            {concepts.length === 0 ? (
              <div className="flex flex-col items-center gap-3 py-12 text-center text-muted-foreground">
                <BookOpen className="h-8 w-8 opacity-40" />
                <p className="text-sm">No concepts yet.</p>
                <p className="text-xs">
                  Add a concept manually or import a CSV / TBX file.
                </p>
                <GatedButton
                  allowed={canManageTermbase}
                  tip={termbaseGateTip}
                  variant="outline"
                  size="sm"
                  onClick={() => setAddOpen(true)}
                >
                  <Plus className="mr-1 h-3.5 w-3.5" />
                  Add first concept
                </GatedButton>
              </div>
            ) : (
              <>
                {/* Column header */}
                <div className="mb-2 hidden items-center gap-3 text-[10px] font-medium uppercase tracking-wide text-muted-foreground md:flex">
                  <span className="w-36 shrink-0">Source term</span>
                  <span className="flex-1">Renderings</span>
                  <span className="w-32 shrink-0">Notes</span>
                  <span className="w-20 shrink-0">Status</span>
                  <span className="w-14 shrink-0" />
                </div>
                <div className="max-h-[60vh] overflow-y-auto">
                  <ul>
                    {concepts.map((concept) => (
                      <ConceptRow
                        key={concept.id}
                        concept={concept}
                        onEdit={setEditTarget}
                        onDelete={handleDelete}
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
    </div>
  )
}
