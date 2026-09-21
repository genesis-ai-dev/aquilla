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
import { BookOpen, Download, Upload, Sparkles, ChevronDown, ChevronRight, ShieldAlert, Plus } from "lucide-react"
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
import type { Concept, TermRendering } from "@/lib/terminology/types"
import {
  addConcept,
  updateConcept,
  approveConcept,
  rejectConcept,
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
import { importConceptsCsv, exportConceptsCsv } from "@/lib/terminology/csv"
import { importConceptsTbx, exportConceptsTbx } from "@/lib/terminology/tbx"
import { GlossaryRow } from "@/components/GlossaryRow"
import { TerminologyTermDetail } from "@/components/TerminologyTermDetail"
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
  const { files: cellFiles, isLoading: cellsLoading } = useProjectCells({
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

  const { active, suggested, archived } = useMemo(
    () => partitionConcepts(concepts),
    [concepts],
  )

  const [showArchived, setShowArchived] = useState(false)
  const [view, setView] = useState<"glossary" | "violations">("glossary")
  const selectedConceptId = searchParams.get("concept")
  const [suggestRequested, setSuggestRequested] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [newSource, setNewSource] = useState("")
  const [newRendering, setNewRendering] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [optimisticTargets, setOptimisticTargets] = useState<
    Record<string, { value: string; valueHtml?: string }>
  >({})

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
  const detailCells = useMemo(
    () => allCells.map((cell) => {
      const patch = optimisticTargets[cell.id]
      return patch
        ? { ...cell, translated: patch.value, translatedHtml: patch.valueHtml }
        : cell
    }),
    [allCells, optimisticTargets],
  )
  const selectedConcept = useMemo(
    () => concepts.find((concept) => concept.id === selectedConceptId) ?? null,
    [concepts, selectedConceptId],
  )

  // AQU-1006: every mutation is a term.* event through the outbox — never a
  // whole-array PATCH of the settings blob. Callers still hand us the full
  // next array from the store helpers; only the delta goes on the wire.
  const author = frontierSession?.username ?? ""
  const projectId = project?.id ?? null
  const persist = useCallback(
    async (updated: { terminology?: Concept[] }) => {
      if (!projectId) return
      const prev = conceptsRef.current
      const next = updated.terminology ?? []
      conceptsRef.current = next
      setOptimisticConcepts(next)
      pendingWritesRef.current += 1
      try {
        await emitConceptDelta({ projectId, author, prev, next })
        setError(null)
      } catch (err) {
        conceptsRef.current = prev
        if (pendingWritesRef.current === 1) setOptimisticConcepts(null)
        setError(err instanceof Error ? err.message : t("terminology.editor.errorBlocked"))
      } finally {
        pendingWritesRef.current -= 1
      }
    },
    [projectId, author, t],
  )

  // ── Row callbacks (all reuse store.ts helpers over the live project) ────────
  const guard = () => {
    if (!project) return null
    if (!canManage) {
      setError(t("terminology.editor.errorRequiresProjectLead"))
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
    const candidates = extractCandidates(corpus, { managed: serverConcepts })
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

  const handleImport = useCallback(
    (file: File) => {
      const p = guard()
      if (!p) return
      const reader = new FileReader()
      reader.onload = () => {
        try {
          const text = String(reader.result ?? "")
          const imported = file.name.toLowerCase().endsWith(".tbx")
            ? importConceptsTbx(text)
            : importConceptsCsv(text)
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
        onCellCommitted={() => {}}
        onOptimisticEdit={(cellId, patch) => {
          setOptimisticTargets((current) => ({ ...current, [cellId]: patch }))
        }}
        canManageTermbase={canManage}
        onPromoteRendering={handlePromoteRendering}
        // The detail view owns add/status/remove for renderings; it hands us
        // the whole next list, which `persist` turns into one term.* event.
        onRenderingsChange={(conceptId, renderings) =>
          onEditRenderings(conceptId, () => renderings)
        }
        onJumpToCell={({ cellId, fileId }) => {
          navigate(`/project/${id}/editor/file/${encodeURIComponent(fileId)}?cellId=${encodeURIComponent(cellId)}`)
        }}
      />
    )
  }

  return (
    <div className="flex min-h-screen flex-col bg-background">
      {/* Header / toolbar */}
      <header className="flex items-center gap-2 border-b px-4 py-3">
        <BookOpen className="h-5 w-5 text-muted-foreground" />
        <h1 className="flex-1 text-base font-semibold">{t("nav.sidebarSection.terminology")}</h1>
        <DisabledFieldTooltip disabled={!canManage} tooltip={termbaseDenial}>
          <Button
            variant="outline"
            size="sm"
            onClick={handleSuggest}
            disabled={!canManage || suggestRequested}
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
          accept=".csv,.tsv,.tbx"
          className="hidden"
          disabled={!canManage}
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) handleImport(f)
            e.target.value = ""
          }}
        />
        <DisabledFieldTooltip disabled={!canManage} tooltip={termbaseDenial}>
          <Button
            variant="outline"
            size="sm"
            disabled={!canManage}
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
          <DisabledFieldTooltip disabled={!canManage} tooltip={termbaseDenial}>
            <Button
              size="sm"
              disabled={!canManage}
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

      {error && (
        <div className="border-b bg-destructive/10 px-4 py-2 text-xs text-destructive">{error}</div>
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
          <p className="px-4 py-10 text-center text-sm text-muted-foreground">
            {t("terminology.editor.noTermsYet")}
          </p>
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
