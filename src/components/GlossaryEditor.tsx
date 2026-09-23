/**
 * GlossaryEditor — the terminology surface, shaped like the translation editor.
 *
 * One row per concept (source left, primary rendering right), grouped by
 * lifecycle: suggested (draft) at top as pending rows, active in the middle,
 * archived (deprecated) hidden behind a toggle. Add term opens a create dialog.
 * Persistence is term.* events through the outbox (see
 * lib/terminology/events-delta); all concept mutations reuse the pure helpers
 * in lib/terminology/store and the delta against the last known termbase is
 * what goes on the wire.
 *
 * The Concept[] model is unchanged, so blots / prompt-injection / violation
 * compilation (which read active concepts) need no changes.
 */
import { useMemo, useState, useCallback, useRef, useEffect } from "react"
import { useNavigate, useParams, useSearchParams } from "react-router-dom"
import { BookOpen, Download, Upload, Sparkles, ChevronDown, ChevronRight, ShieldAlert, Plus, Merge } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Field, FieldLabel } from "@/components/ui/field"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { LoadingPanel } from "@/components/ui/loading-overlay"
import { useProject } from "@/hooks/useProject"
import type { UseProjectSettings } from "@/hooks/useProjectSettings"
import { useProjectCells } from "@/hooks/useProjectCells"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { useConcepts } from "@/hooks/useConcepts"

/** Stable identity so the memo below holds when a workspace project has none. */
const EMPTY_SERVER_CONCEPTS: Concept[] = []
import type { Concept, TermMatchOptions, TermRendering } from "@/lib/terminology/types"
import {
  addConcept,
  updateConcept,
  approveConcept,
  rejectConcept,
  mergeConcepts,
} from "@/lib/terminology/store"
import {
  partitionConcepts,
  setPrimaryRendering,
  canEditTermbase,
  canEditTermCells,
  resolveTermbaseEditFloor,
} from "@/lib/terminology/glossary-view"
import { denialMessage } from "@/lib/permissions/denial"
import { DisabledFieldTooltip } from "@/components/ProjectSettings/DisabledFieldTooltip"
import { extractCandidates } from "@/lib/terminology/candidates"
import { emitConceptDelta } from "@/lib/terminology/events-delta"
import { exportConceptsCsv } from "@/lib/terminology/csv"
import { exportConceptsTbx } from "@/lib/terminology/tbx"
import { importTermbaseFile } from "@/lib/terminology/import-format"
import { GlossaryRow } from "@/components/GlossaryRow"
import { TerminologyTermDetail } from "@/components/TerminologyTermDetail"
import { TerminologyMergeDialog } from "@/components/TerminologyMergeDialog"
import { TerminologyViolationsInbox } from "@/components/TerminologyViolationsInbox"
import { buildFileScopedTokenFetcher } from "@/lib/sync/cqrs-bridge"
import { useT } from "@/lib/i18n/I18nProvider"
import { isAudioCueFile, type ProjectRecord } from "@/lib/parsers/types"

interface GlossaryEditorProps {
  /** Workspace-authoritative files include optimistic imports before the
   * project settings record has caught up. */
  files?: Array<{ id: string; name: string; type: string }>
  /** Workspace-owned project data. Supplying it avoids resolving the same
   * project again when this surface replaces the editor center pane. */
  project?: ProjectRecord | null
  patchSettings?: UseProjectSettings["patch"]
  /**
   * AQU-1340 — concepts-read status for the WORKSPACE-OWNED path. On that path
   * ProjectWorkspace owns the `useConcepts` call and folds only `concepts` onto
   * the record it hands down, so a failed read arrives here indistinguishable
   * from an empty termbase unless the failure is passed alongside it.
   */
  conceptsError?: string | null
  conceptsLoading?: boolean
  refreshConcepts?: () => void | Promise<void>
}

function conceptsEqual(a: Concept[], b: Concept[]): boolean {
  if (a === b) return true
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return false
  }
}

function downloadBlob(content: string, filename: string, mime: string) {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export function GlossaryEditor({
  files: workspaceFiles,
  project: workspaceProject,
  patchSettings: workspacePatchSettings,
  conceptsError: workspaceConceptsError,
  conceptsLoading: workspaceConceptsLoading,
  refreshConcepts: workspaceRefreshConcepts,
}: GlossaryEditorProps = {}) {
  const t = useT()
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const ownedProject = useProject(id!, {
    initialProject: workspaceProject,
    enabled: workspaceProject == null,
    includeSettings: workspacePatchSettings == null,
  })
  const project = workspaceProject ?? ownedProject.project
  const loading = workspaceProject == null && ownedProject.loading
  const { session: frontierSession } = useFrontierSession()
  const importInputRef = useRef<HTMLInputElement>(null)

  // Cells are needed only for candidate mining ("Suggest terms"). Wire a
  // file-scoped token fetcher so useProjectCells can fetch.
  const jwtRef = useRef<string | null>(null)
  useEffect(() => {
    jwtRef.current = frontierSession?.jwt ?? null
  }, [frontierSession?.jwt])

  // AQU-646 stage 2: only the `project?.files` arm needs the audio-cue filter
  // — the workspace passes a list that has already dropped them. Their cells
  // are a near-verbatim transcript of a film's soundtrack, which "Suggest
  // terms" would otherwise mine as if it were translatable text.
  const projectFiles = useMemo(
    () =>
      (workspaceFiles ?? (project?.files ?? []).filter((f) => !isAudioCueFile(f)))
        .map((f) => ({ id: f.id, name: f.name, type: f.type })),
    [project?.files, workspaceFiles],
  )
  const getToken = useMemo(() => {
    if (!project?.id) return async (_fileId: string) => null as string | null
    return buildFileScopedTokenFetcher(() => jwtRef.current, project.id, {
      projectName: project.name ?? undefined,
      gitlabProjectId:
        project.origin?.kind === "git" ? project.origin.gitlabProjectId : undefined,
    })
  }, [project?.id, project?.name, project?.origin])

  const [cellDataRequested, setCellDataRequested] = useState(false)
  const [cellLoadObserved, setCellLoadObserved] = useState(false)
  const {
    files: cellFiles,
    isLoading: cellsLoading,
    revalidate: revalidateCells,
    applyOptimisticTargetEdit,
  } = useProjectCells({
    projectId: id ?? null,
    projectFiles,
    getToken,
    enabled: Boolean(project?.id && projectFiles.length > 0 && cellDataRequested),
  })

  // AQU-1006 follow-up: concepts come from the sync-worker projection, not the
  // retired `project.terminology` settings key.
  //
  // Two paths, mirroring how this component already resolves `project`:
  //   - WORKSPACE-OWNED (`workspaceProject` passed in): its `terminology` is
  //     ALREADY projection-sourced — ProjectWorkspace folds `useConcepts` onto
  //     the record it hands down (see `editorProject`). Reuse it and skip the
  //     fetch, exactly as `ownedProject` is disabled on this path; fetching
  //     again would be the "duplicate project resolve" this path exists to
  //     avoid, and would flash an empty glossary before it landed.
  //   - STANDALONE (routed directly): fetch for ourselves.
  const fetched = useConcepts({
    projectId: id ?? null,
    getToken,
    tokenReady: !!frontierSession?.jwt && workspaceProject == null,
  })
  const serverConcepts = workspaceProject
    ? workspaceProject.terminology ?? EMPTY_SERVER_CONCEPTS
    : fetched.concepts
  // AQU-1340: the hook deliberately fails closed (it sets `error` rather than
  // reporting "no terms"), so the surface must read that status — dropping it
  // turns any read failure into the empty-termbase screen.
  const conceptsError = workspaceProject ? workspaceConceptsError ?? null : fetched.error
  const conceptsLoading = workspaceProject
    ? workspaceConceptsLoading ?? false
    : fetched.isLoading
  const retryConcepts = workspaceProject ? workspaceRefreshConcepts : fetched.refresh
  const conceptsRef = useRef<Concept[]>(serverConcepts)
  const pendingWritesRef = useRef(0)
  const [optimisticConcepts, setOptimisticConcepts] = useState<Concept[] | null>(null)
  const concepts = optimisticConcepts ?? serverConcepts
  useEffect(() => {
    if (pendingWritesRef.current > 0 && !conceptsEqual(serverConcepts, conceptsRef.current)) return
    conceptsRef.current = serverConcepts
    setOptimisticConcepts(null)
  }, [serverConcepts])
  // AQU-822: the floor is the org's configured termbaseEditMinRole (carried on
  // the project record), not a hardcoded project_lead level.
  const canManage = canEditTermbase(project?.syncRole, project?.termbaseEditMinRole)
  // AQU-208: below the floor the termbase controls stay visible but disabled,
  // and the hover names the caller's role and the one that owns the termbase.
  const termbaseDenial = canManage
    ? null
    : denialMessage(
        t,
        resolveTermbaseEditFloor(project?.termbaseEditMinRole),
        project?.syncRole?.level,
      )
  // The drill-down commits through `target.cell.commit`, so it asks the same
  // role-policy question the editor does.
  const canEditCells = canEditTermCells(project?.syncRole)
  // AQU-1340: three states the empty list used to collapse into one.
  //   unknown  — the read failed and we hold no termbase: the error state, and
  //              no whole-termbase writes (an Import here appends to a list the
  //              client never actually read, doubling every term on recovery).
  //   pending  — first read in flight: progress, not "no terms yet".
  //   stale    — a LATER read failed over concepts we already have: keep the
  //              last good termbase visible and say the refresh failed.
  const termbaseUnknown = conceptsError != null && concepts.length === 0
  const termbasePending = conceptsError == null && conceptsLoading && concepts.length === 0
  const termbaseStale = conceptsError != null && concepts.length > 0
  const canWriteTermbase = canManage && !termbaseUnknown
  // The ROLE reason wins when both apply. "Terms cannot be added until the
  // termbase loads" implies waiting will help — which is false for someone
  // below the floor, whose button stays disabled after the read recovers.
  const termbaseWriteDenial =
    termbaseDenial ??
    (termbaseUnknown ? t("terminology.editor.loadFailedDisabledTooltip") : null)

  const { active, suggested, archived } = useMemo(
    () => partitionConcepts(concepts),
    [concepts],
  )

  const [showArchived, setShowArchived] = useState(false)
  const [view, setView] = useState<"glossary" | "violations">("glossary")
  const selectedConceptId = searchParams.get("concept")
  const [suggestRequested, setSuggestRequested] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [mergeOpen, setMergeOpen] = useState(false)
  const [newSource, setNewSource] = useState("")
  const [newRendering, setNewRendering] = useState("")
  const [error, setError] = useState<string | null>(null)
  const allCells = useMemo(
    () => cellFiles.flatMap((file) => file.cells),
    [cellFiles],
  )
  useEffect(() => {
    if (cellDataRequested && cellsLoading) setCellLoadObserved(true)
  }, [cellDataRequested, cellsLoading])
  useEffect(() => {
    setCellLoadObserved(false)
  }, [id, projectFiles])
  const cellDataReady = projectFiles.length === 0 || allCells.length > 0 || (cellLoadObserved && !cellsLoading)
  // AQU-206: the optimistic overlay now lives in useProjectCells, so it is keyed
  // per (file, cell) and survives the outbox row being deleted on sync — the
  // local Record<cellId, patch> this replaced reverted as soon as the write was
  // accepted, snapping a just-fixed occurrence back to its old verdict.
  const detailCells = allCells
  const selectedConcept = useMemo(
    () => concepts.find((concept) => concept.id === selectedConceptId) ?? null,
    [concepts, selectedConceptId],
  )

  // AQU-1006: every mutation is a term.* event through the outbox — never a
  // whole-array PATCH of the settings blob. Callers still hand us the full
  // next array from the store helpers; only the delta goes on the wire.
  // Resolves false when the write was rejected (the banner carries the reason).
  const author = frontierSession?.username ?? ""
  const projectId = project?.id ?? null
  const persist = useCallback(
    async (updated: { terminology?: Concept[] }): Promise<boolean> => {
      if (!projectId) return false
      const prev = conceptsRef.current
      const next = updated.terminology ?? []
      conceptsRef.current = next
      setOptimisticConcepts(next)
      pendingWritesRef.current += 1
      try {
        await emitConceptDelta({ projectId, author, prev, next })
        setError(null)
        return true
      } catch (err) {
        conceptsRef.current = prev
        if (pendingWritesRef.current === 1) setOptimisticConcepts(null)
        setError(err instanceof Error ? err.message : t("terminology.editor.errorBlocked"))
        return false
      } finally {
        pendingWritesRef.current -= 1
      }
    },
    [projectId, author, t],
  )

  // ── Row callbacks (all reuse store.ts helpers over the live project) ────────
  // AQU-1340: the mutation callbacks below are memoized on
  // `[project, canManage, persist]`, so they hold the `guard` from an older
  // render. The live flag is read through a ref (written in an effect, never
  // during render) rather than from that stale closure.
  const termbaseUnknownRef = useRef(termbaseUnknown)
  useEffect(() => {
    termbaseUnknownRef.current = termbaseUnknown
  }, [termbaseUnknown])

  const guard = () => {
    if (!project) return null
    if (!canManage) {
      setError(t("terminology.editor.errorRequiresProjectLead"))
      return null
    }
    // Every write emits a DELTA against the last known termbase. When the read
    // failed we hold no termbase, so that delta is computed against nothing:
    // an import would append its whole file on top of terms still on the
    // server, doubling them all once the read recovers (AQU-1337 leaves no way
    // to merge them back).
    if (termbaseUnknownRef.current) {
      setError(t("terminology.editor.loadFailedDetail"))
      return null
    }
    return { ...project, terminology: conceptsRef.current }
  }

  const onEditSource = useCallback(
    (cid: string, sourceTerm: string) => {
      const p = guard()
      if (p) void persist(updateConcept(p, cid, { sourceTerm }))
    },
    [project, canManage, persist],
  )
  const onEditPrimary = useCallback(
    (cid: string, text: string) => {
      const p = guard()
      if (!p) return
      const concept = (p.terminology ?? []).find((c) => c.id === cid)
      if (!concept) return
      const next = setPrimaryRendering(concept, text)
      void persist(updateConcept(p, cid, { renderings: next.renderings }))
    },
    [project, canManage, persist],
  )
  const onEditRenderings = useCallback(
    (cid: string, update: (current: TermRendering[]) => TermRendering[]) => {
      const p = guard()
      if (!p) return
      const concept = (p.terminology ?? []).find((item) => item.id === cid)
      if (!concept) return
      void persist(updateConcept(p, cid, { renderings: update(concept.renderings) }))
    },
    [project, canManage, persist],
  )
  const onEditNotes = useCallback(
    (cid: string, notes: string) => {
      const p = guard()
      if (p) void persist(updateConcept(p, cid, { notes: notes.trim() || undefined }))
    },
    [project, canManage, persist],
  )
  // AQU-1271: the Forms section on the term detail. Both fields ride the same
  // concept-delta write path as every other row edit, so an exclusion lands as
  // a `term.update` event and survives a reload.
  const onMatchChange = useCallback(
    (cid: string, match: TermMatchOptions | undefined) => {
      const p = guard()
      if (p) void persist(updateConcept(p, cid, { match }))
    },
    [project, canManage, persist],
  )
  const onCaseSensitiveChange = useCallback(
    (cid: string, caseSensitive: boolean) => {
      const p = guard()
      if (p) void persist(updateConcept(p, cid, { caseSensitive }))
    },
    [project, canManage, persist],
  )
  const onArchive = useCallback(
    (cid: string) => {
      const p = guard()
      if (p) void persist(updateConcept(p, cid, { status: "deprecated" }))
    },
    [project, canManage, persist],
  )
  const onRestore = useCallback(
    (cid: string) => {
      const p = guard()
      if (p) void persist(approveConcept(p, cid))
    },
    [project, canManage, persist],
  )
  const onAccept = onRestore // draft → active is the same status flip
  const onDismiss = useCallback(
    (cid: string) => {
      const p = guard()
      if (p) void persist(rejectConcept(p, cid, "delete"))
    },
    [project, canManage, persist],
  )

  const handleAddTerm = useCallback(() => {
    const p = guard()
    if (!p) return
    const source = newSource.trim()
    const rendering = newRendering.trim()
    if (!source || !rendering) {
      setError(t("terminology.editor.errorSourceAndRenderingRequired"))
      return
    }
    const renderings: TermRendering[] = [{ rendering, status: "preferred" }]
    void persist(addConcept(p, { sourceTerm: source, renderings, status: "active" }))
    setError(null)
    setNewSource("")
    setNewRendering("")
    setAddOpen(false)
  }, [project, canManage, persist, newSource, newRendering])

  function handleAddOpenChange(open: boolean) {
    setAddOpen(open)
    if (!open) {
      setNewSource("")
      setNewRendering("")
    }
  }

  const handleSuggest = useCallback(() => {
    if (!guard()) return
    setCellDataRequested(true)
    setSuggestRequested(true)
  }, [project, canManage])

  useEffect(() => {
    if (!suggestRequested || !cellDataReady || !project || !canManage) return
    const corpus = cellFiles.flatMap((f) =>
      (f.cells ?? []).map((c: { original?: string }) => c.original ?? ""),
    )
    const candidates = extractCandidates(corpus, { managed: serverConcepts, termMatching: project.termMatching })
    const existing = new Set(serverConcepts.map((c) => c.sourceTerm.trim().toLowerCase()))
    let working = project
    for (const cand of candidates) {
      if (cand.isManaged || existing.has(cand.term.trim().toLowerCase())) continue
      working = addConcept(working, { sourceTerm: cand.term, renderings: [], status: "draft" })
      existing.add(cand.term.trim().toLowerCase())
    }
    void persist(working)
    setSuggestRequested(false)
  }, [suggestRequested, cellDataReady, project, canManage, persist, cellFiles])

  const handleOpenDetails = useCallback((conceptId: string) => {
    setCellDataRequested(true)
    setSearchParams((current) => {
      const next = new URLSearchParams(current)
      next.set("concept", conceptId)
      return next
    })
  }, [setSearchParams])

  const handleCloseDetails = useCallback(() => {
    setSearchParams((current) => {
      const next = new URLSearchParams(current)
      next.delete("concept")
      return next
    })
  }, [setSearchParams])

  useEffect(() => {
    if (selectedConcept) setCellDataRequested(true)
  }, [selectedConcept])

  useEffect(() => {
    const fromUrl = searchParams.get("concept")
    if (fromUrl) handleOpenDetails(fromUrl)
  }, [searchParams, handleOpenDetails])

  const handlePromoteRendering = useCallback(
    (conceptId: string, target: string) => {
      const p = guard()
      if (!p) return
      const concept = (p.terminology ?? []).find((item) => item.id === conceptId)
      const normalized = target.trim().toLocaleLowerCase()
      if (!concept || !normalized) return
      if (concept.renderings.some((item) => item.rendering.trim().toLocaleLowerCase() === normalized)) return
      void persist(updateConcept(p, conceptId, {
        renderings: [...concept.renderings, { rendering: target.trim(), status: "admitted" }],
      }))
    },
    [project, canManage, persist],
  )

  // AQU-1337: a merge is the survivor's union-merged renderings/notes plus the
  // losers' removal. `persist` diffs that against the last known termbase, so
  // it lands as one `term.update` and one `term.delete` per loser — several
  // single-concept writes, never one whole-termbase write.
  const handleMerge = useCallback(
    async (mergeIds: string[], survivorId: string) => {
      const p = guard()
      // Rejecting keeps the dialog open on its error line instead of closing
      // over a merge that never reached the outbox.
      if (!p || !(await persist(mergeConcepts(p, mergeIds, survivorId)))) {
        throw new Error(t("terminology.mergeDialog.mergeFailed"))
      }
    },
    [project, canManage, persist, t],
  )

  const handleImport = useCallback(
    (file: File) => {
      const p = guard()
      if (!p) return
      const reader = new FileReader()
      reader.onload = () => {
        try {
          const text = String(reader.result ?? "")
          const imported = importTermbaseFile(file.name, text)
          // AQU-684: a file that yields nothing used to persist an unchanged
          // list and look like success — the exact way a FLEx export failed
          // silently. Say so instead.
          if (imported.length === 0) {
            setError(t("terminology.editor.errorImportFailed"))
            return
          }
          void persist({ terminology: [...(p.terminology ?? []), ...imported] })
        } catch (err) {
          setError(err instanceof Error ? err.message : t("terminology.editor.errorImportFailed"))
        }
      }
      reader.readAsText(file)
    },
    [project, canManage, persist],
  )

  if (loading) {
    return <LoadingPanel label={t("terminology.editor.loadingGlossary")} />
  }

  if (selectedConcept) {
    return (
      <TerminologyTermDetail
        concept={selectedConcept}
        cells={detailCells}
        examplesLoading={!cellDataReady}
        canEdit={canEditCells}
        projectId={id!}
        username={frontierSession?.username ?? project?.username ?? "local"}
        onClose={handleCloseDetails}
        onCellCommitted={revalidateCells}
        onOptimisticEdit={applyOptimisticTargetEdit}
        canManageTermbase={canManage}
        onPromoteRendering={handlePromoteRendering}
        // The detail view owns add/status/remove for renderings; it hands us
        // the whole next list, which `persist` turns into one term.* event.
        onRenderingsChange={(conceptId, renderings) =>
          onEditRenderings(conceptId, () => renderings)
        }
        termMatching={project?.termMatching}
        onMatchChange={onMatchChange}
        onCaseSensitiveChange={onCaseSensitiveChange}
        onSetUpAffixes={() => navigate(`/project/${id}/settings/ai`)}
        onJumpToCell={({ cellId, fileId }) => {
          navigate(`/project/${id}/editor/file/${encodeURIComponent(fileId)}?cellId=${encodeURIComponent(cellId)}`)
        }}
      />
    )
  }

  return (
    <div className="flex min-h-screen flex-col bg-background">
      {/* Header / toolbar */}
      <header className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
        <BookOpen className="h-5 w-5 text-muted-foreground" />
        <h1 className="flex-1 text-base font-semibold">{t("nav.sidebarSection.terminology")}</h1>
        <DisabledFieldTooltip disabled={!canWriteTermbase} tooltip={termbaseWriteDenial}>
          <Button
            variant="outline"
            size="sm"
            onClick={handleSuggest}
            disabled={!canWriteTermbase || suggestRequested}
          >
            <Sparkles data-icon="inline-start" />{" "}
            {suggestRequested
              ? t("terminology.editor.findingTerms")
              : t("terminology.editor.suggestTerms")}
          </Button>
        </DisabledFieldTooltip>
        <input
          ref={importInputRef}
          type="file"
          accept=".csv,.tsv,.tbx,.lift,.xml"
          className="hidden"
          disabled={!canWriteTermbase}
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) handleImport(f)
            e.target.value = ""
          }}
        />
        <DisabledFieldTooltip disabled={!canWriteTermbase} tooltip={termbaseWriteDenial}>
          <Button
            variant="outline"
            size="sm"
            disabled={!canWriteTermbase}
            onClick={() => importInputRef.current?.click()}
          >
            <Upload data-icon="inline-start" /> {t("nav.workspaceActions.import")}
          </Button>
        </DisabledFieldTooltip>
        <DisabledFieldTooltip disabled={!canManage} tooltip={termbaseDenial}>
          <Button
            variant="outline"
            disabled={!canManage}
            onClick={() => downloadBlob(exportConceptsCsv(concepts), "glossary.csv", "text/csv")}
          >
            <Download data-icon="inline-start" /> {t("terminology.editor.exportCsv")}
          </Button>
        </DisabledFieldTooltip>
        <DisabledFieldTooltip disabled={!canManage} tooltip={termbaseDenial}>
          <Button
            variant="outline"
            disabled={!canManage}
            onClick={() => downloadBlob(exportConceptsTbx(concepts), "glossary.tbx", "application/xml")}
          >
            <Download data-icon="inline-start" /> {t("terminology.editor.exportTbx")}
          </Button>
        </DisabledFieldTooltip>
        {/* AQU-1337: nothing to merge below two concepts */}
        {concepts.length >= 2 && (
          <DisabledFieldTooltip disabled={!canManage} tooltip={termbaseDenial}>
            <Button
              variant="outline"
              size="sm"
              disabled={!canManage}
              onClick={() => setMergeOpen(true)}
              aria-label={t("terminology.mergeDialog.title")}
              data-testid="merge-duplicates-btn"
            >
              <Merge data-icon="inline-start" /> {t("terminology.page.mergeDuplicatesButton")}
            </Button>
          </DisabledFieldTooltip>
        )}
        <Button
          variant={view === "violations" ? "secondary" : "outline"}
          aria-pressed={view === "violations"}
          onClick={() => {
            setCellDataRequested(true)
            setView((current) => current === "violations" ? "glossary" : "violations")
          }}
        >
          <ShieldAlert data-icon="inline-start" />
          {view === "violations"
            ? t("terminology.editor.backToGlossary")
            : t("terminology.violations.title")}
        </Button>
        {/* i18n-exempt "glossary" is a view token, not copy */}
        {view === "glossary" && (
          <DisabledFieldTooltip disabled={!canWriteTermbase} tooltip={termbaseWriteDenial}>
            <Button
              size="sm"
              disabled={!canWriteTermbase}
              onClick={() => setAddOpen(true)}
              aria-label={t("terminology.editor.addTerm")}
            >
              <Plus data-icon="inline-start" />
              {t("terminology.editor.addTerm")}
            </Button>
          </DisabledFieldTooltip>
        )}
      </header>

      <Dialog open={addOpen} onOpenChange={handleAddOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("terminology.editor.addTerm")}</DialogTitle>
            <DialogDescription>
              {t("terminology.editor.addTermDescription")}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <Field>
              <FieldLabel htmlFor="glossary-new-source">
                {t("terminology.editor.sourceTermLabel")}
              </FieldLabel>
              <Input
                id="glossary-new-source"
                value={newSource}
                placeholder={t("terminology.editor.sourceTermPlaceholder")}
                onChange={(e) => setNewSource(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleAddTerm()}
                autoFocus
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="glossary-new-rendering">
                {t("terminology.editor.renderingLabel")}
              </FieldLabel>
              <Input
                id="glossary-new-rendering"
                value={newRendering}
                placeholder={t("terminology.editor.renderingLabel")}
                onChange={(e) => setNewRendering(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleAddTerm()}
              />
            </Field>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => handleAddOpenChange(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              onClick={handleAddTerm}
              disabled={!newSource.trim() || !newRendering.trim()}
            >
              {t("terminology.editor.addTerm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <TerminologyMergeDialog
        open={mergeOpen}
        onOpenChange={setMergeOpen}
        concepts={concepts}
        onMerge={handleMerge}
      />

      {error && (
        <div className="border-b bg-destructive/10 px-4 py-2 text-xs text-destructive">{error}</div>
      )}

      {/* AQU-1340: a refresh that failed OVER a termbase we already hold. The
          last good terms stay on screen (the hook preserves them) and this is
          non-blocking — writes are still safe against a known termbase. */}
      {termbaseStale && (
        <div
          role="status"
          data-testid="concepts-refresh-stale"
          className="flex items-center justify-between gap-2 border-b bg-amber-50 px-4 py-2 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-300"
        >
          <span>{t("terminology.editor.refreshFailedNotice")}</span>
          <Button variant="ghost" size="sm" onClick={() => void retryConcepts?.()}>
            {t("common.retry")}
          </Button>
        </div>
      )}

      {view === "violations" ? (
        <main className="flex-1 overflow-y-auto p-4">
          {!cellDataReady ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              {t("terminology.editor.checkingTerminology")}
            </p>
          ) : (
            <TerminologyViolationsInbox
              concepts={concepts}
              cells={detailCells}
              termMatching={project?.termMatching}
              onJumpToCell={({ cellId, fileId }) => {
                navigate(`/project/${id}/editor/file/${encodeURIComponent(fileId)}?cellId=${encodeURIComponent(cellId)}`)
              }}
            />
          )}
        </main>
      ) : (
        <>
      {/* Column headers */}
      <div className="flex items-center gap-3 border-b bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground">
        <span className="w-4" />
        <span className="flex-1">{t("editor.column.source")}</span>
        <span className="flex-1">{t("terminology.editor.renderingLabel")}</span>
        <span className="w-16" />
      </div>

      <main className="flex-1 overflow-y-auto">
        {/* Suggested (pending) rows */}
        {suggested.map((c) => (
          <GlossaryRow
            key={c.id}
            concept={c}
            canManage={canManage}
            onEditSource={onEditSource}
            onEditPrimary={onEditPrimary}
            onEditRenderings={onEditRenderings}
            onEditNotes={onEditNotes}
            onOpenDetails={handleOpenDetails}
            onArchive={onArchive}
            onRestore={onRestore}
            onAccept={onAccept}
            onDismiss={onDismiss}
          />
        ))}

        {/* Active rows */}
        {active.map((c) => (
          <GlossaryRow
            key={c.id}
            concept={c}
            canManage={canManage}
            onEditSource={onEditSource}
            onEditPrimary={onEditPrimary}
            onEditRenderings={onEditRenderings}
            onEditNotes={onEditNotes}
            onOpenDetails={handleOpenDetails}
            onArchive={onArchive}
            onRestore={onRestore}
            onAccept={onAccept}
            onDismiss={onDismiss}
          />
        ))}

        {active.length === 0 && suggested.length === 0 && (
          // AQU-1340: "No terms yet" is claimed ONLY when the read succeeded
          // and came back empty. A failed or in-flight read says so instead.
          termbaseUnknown ? (
            <div
              role="alert"
              data-testid="concepts-read-error"
              className="flex flex-col items-center gap-3 px-4 py-10 text-center"
            >
              <p className="text-sm font-medium">{t("terminology.editor.loadFailedTitle")}</p>
              <p className="max-w-md text-sm text-muted-foreground">
                {t("terminology.editor.loadFailedDetail")}
              </p>
              {/* The raw reason is a server/network message, not UI copy — it
                  renders verbatim like the write-failure banner above. */}
              {conceptsError && (
                <p className="max-w-md text-xs text-muted-foreground">{conceptsError}</p>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={() => void retryConcepts?.()}
                data-testid="concepts-read-retry"
              >
                {t("common.retry")}
              </Button>
            </div>
          ) : termbasePending ? (
            <p className="px-4 py-10 text-center text-sm text-muted-foreground" role="status">
              {t("terminology.editor.loadingGlossary")}
            </p>
          ) : (
            <p className="px-4 py-10 text-center text-sm text-muted-foreground">
              {t("terminology.editor.noTermsYet")}
            </p>
          )
        )}

        {/* Archived toggle + rows */}
        {archived.length > 0 && (
          <div className="border-t">
            <button
              type="button"
              className="flex w-full items-center gap-2 px-3 py-2 text-xs text-muted-foreground hover:bg-muted/40"
              onClick={() => setShowArchived((v) => !v)}
            >
              {showArchived ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
              {showArchived
                ? t("terminology.editor.hideArchived")
                : t("terminology.editor.showArchived", { count: archived.length })}
            </button>
            {showArchived &&
              archived.map((c) => (
                <GlossaryRow
                  key={c.id}
                  concept={c}
                  canManage={canManage}
                  onEditSource={onEditSource}
                  onEditPrimary={onEditPrimary}
                  onEditRenderings={onEditRenderings}
                  onEditNotes={onEditNotes}
                  onOpenDetails={handleOpenDetails}
                  onArchive={onArchive}
                  onRestore={onRestore}
                  onAccept={onAccept}
                  onDismiss={onDismiss}
                />
              ))}
          </div>
        )}
      </main>
        </>
      )}
    </div>
  )
}
