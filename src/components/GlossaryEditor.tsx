/**
 * GlossaryEditor — the terminology surface, shaped like the translation editor.
 *
 * One row per concept (source left, primary rendering right), grouped by
 * lifecycle: suggested (draft) at top as pending rows, active in the middle,
 * archived (deprecated) hidden behind a toggle. A persistent append row adds
 * new terms. Persistence is patchSettings({ terminology }); all concept
 * mutations reuse the pure helpers in lib/terminology/store.
 *
 * The Concept[] model is unchanged, so blots / prompt-injection / violation
 * compilation (which read active concepts) need no changes.
 */
import { useMemo, useState, useCallback, useRef, useEffect } from "react"
import { useParams } from "react-router-dom"
import { BookOpen, Download, Upload, Sparkles, ChevronDown, ChevronRight } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useProject } from "@/hooks/useProject"
import { useProjectCells } from "@/hooks/useProjectCells"
import { useFrontierSession } from "@/hooks/useFrontierSession"
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
} from "@/lib/terminology/glossary-view"
import { extractCandidates } from "@/lib/terminology/candidates"
import { importConceptsCsv, exportConceptsCsv } from "@/lib/terminology/csv"
import { importConceptsTbx, exportConceptsTbx } from "@/lib/terminology/tbx"
import { GlossaryRow } from "@/components/GlossaryRow"
import { buildFileScopedTokenFetcher } from "@/lib/sync/cqrs-bridge"

function downloadBlob(content: string, filename: string, mime: string) {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export function GlossaryEditor() {
  const { id } = useParams<{ id: string }>()
  const { project, loading, patchSettings } = useProject(id!)
  const { session: frontierSession } = useFrontierSession()

  // Cells are needed only for candidate mining ("Suggest terms"). Wire the
  // token fetcher exactly like TerminologyPage so useProjectCells can fetch.
  const jwtRef = useRef<string | null>(null)
  useEffect(() => {
    jwtRef.current = frontierSession?.jwt ?? null
  }, [frontierSession?.jwt])

  const projectFiles = useMemo(
    () => (project?.files ?? []).map((f) => ({ id: f.id, name: f.name, type: f.type })),
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

  const { files: cellFiles } = useProjectCells({
    projectId: id ?? null,
    projectFiles,
    getToken,
    enabled: Boolean(project?.id && projectFiles.length > 0),
  })

  const concepts = useMemo(() => project?.terminology ?? [], [project])
  const hasOrigin = Boolean(project?.origin)
  const canManage = canEditTermbase(project?.syncRole, hasOrigin)

  const { active, suggested, archived } = useMemo(
    () => partitionConcepts(concepts),
    [concepts],
  )

  const [showArchived, setShowArchived] = useState(false)
  const [newSource, setNewSource] = useState("")
  const [newRendering, setNewRendering] = useState("")
  const [error, setError] = useState<string | null>(null)

  const persist = useCallback(
    async (updated: { terminology?: Concept[] }) => {
      await patchSettings({ terminology: updated.terminology ?? [] })
    },
    [patchSettings],
  )

  // ── Row callbacks (all reuse store.ts helpers over the live project) ────────
  const guard = () => {
    if (!project) return null
    if (!canManage) {
      setError("Requires Project Lead role or higher to manage the glossary.")
      return null
    }
    return project
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
    (cid: string, renderings: TermRendering[]) => {
      const p = guard()
      if (p) void persist(updateConcept(p, cid, { renderings }))
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
    if (!source) return
    const renderings: TermRendering[] = newRendering.trim()
      ? [{ rendering: newRendering.trim(), status: "preferred" }]
      : []
    void persist(addConcept(p, { sourceTerm: source, renderings, status: "active" }))
    setNewSource("")
    setNewRendering("")
  }, [project, canManage, persist, newSource, newRendering])

  const handleSuggest = useCallback(() => {
    const p = guard()
    if (!p) return
    const corpus = cellFiles.flatMap((f) =>
      (f.cells ?? []).map((c: { original?: string }) => c.original ?? ""),
    )
    const candidates = extractCandidates(corpus, { managed: p.terminology ?? [] })
    const existing = new Set((p.terminology ?? []).map((c) => c.sourceTerm.trim().toLowerCase()))
    let working = p
    for (const cand of candidates) {
      if (cand.isManaged || existing.has(cand.term.trim().toLowerCase())) continue
      working = addConcept(working, { sourceTerm: cand.term, renderings: [], status: "draft" })
      existing.add(cand.term.trim().toLowerCase())
    }
    void persist(working)
  }, [project, canManage, persist, cellFiles])

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
          setError(err instanceof Error ? err.message : "Import failed")
        }
      }
      reader.readAsText(file)
    },
    [project, canManage, persist],
  )

  if (loading) {
    return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Loading glossary…</div>
  }

  return (
    <div className="flex min-h-screen flex-col bg-background">
      {/* Header / toolbar */}
      <header className="flex items-center gap-2 border-b px-4 py-3">
        <BookOpen className="h-5 w-5 text-muted-foreground" />
        <h1 className="flex-1 text-base font-semibold">Glossary</h1>
        {canManage && (
          <>
            <Button variant="outline" size="sm" onClick={handleSuggest}>
              <Sparkles className="mr-1 h-4 w-4" /> Suggest terms
            </Button>
            <label className="inline-flex">
              <input
                type="file"
                accept=".csv,.tbx"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f) handleImport(f)
                  e.target.value = ""
                }}
              />
              <Button variant="outline" size="sm" render={<span />}>
                <Upload className="mr-1 h-4 w-4" /> Import
              </Button>
            </label>
            <Button
              variant="outline"
              size="sm"
              onClick={() => downloadBlob(exportConceptsCsv(concepts), "glossary.csv", "text/csv")}
            >
              <Download className="mr-1 h-4 w-4" /> Export CSV
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => downloadBlob(exportConceptsTbx(concepts), "glossary.tbx", "application/xml")}
            >
              <Download className="mr-1 h-4 w-4" /> Export TBX
            </Button>
          </>
        )}
      </header>

      {error && (
        <div className="border-b bg-destructive/10 px-4 py-2 text-xs text-destructive">{error}</div>
      )}

      {/* Column headers */}
      <div className="flex items-center gap-3 border-b bg-muted/40 px-3 py-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        <span className="w-4" />
        <span className="flex-1">Source</span>
        <span className="flex-1">Rendering</span>
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
            onArchive={onArchive}
            onRestore={onRestore}
            onAccept={onAccept}
            onDismiss={onDismiss}
          />
        ))}

        {active.length === 0 && suggested.length === 0 && (
          <p className="px-4 py-10 text-center text-sm text-muted-foreground">
            No terms yet. Add one below, or use “Suggest terms”.
          </p>
        )}

        {/* Append row */}
        {canManage && (
          <div className="flex items-center gap-3 border-t bg-muted/20 px-3 py-2">
            <span className="w-4" />
            <Input
              value={newSource}
              placeholder="New source term…"
              className="h-8 flex-1 text-sm"
              onChange={(e) => setNewSource(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleAddTerm()}
            />
            <Input
              value={newRendering}
              placeholder="rendering"
              className="h-8 flex-1 text-sm"
              onChange={(e) => setNewRendering(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleAddTerm()}
            />
            <Button variant="ghost" size="sm" onClick={handleAddTerm} aria-label="Add term">
              Add
            </Button>
          </div>
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
              {showArchived ? "Hide archived" : `Show archived (${archived.length})`}
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
                  onArchive={onArchive}
                  onRestore={onRestore}
                  onAccept={onAccept}
                  onDismiss={onDismiss}
                />
              ))}
          </div>
        )}
      </main>
    </div>
  )
}
