/**
 * LivingMemoryPage — settings-style index → detail surface for the project's
 * living memory, mounted by ProjectWorkspace as an overlay at
 * `/project/:id/memory` and `/project/:id/memory/:section` (the same
 * index → pane pattern as ProjectSettings/Preferences). Four sections —
 *   instructions | quality | knowledge | examples
 * (see LIVING_MEMORY_SECTIONS) — each an icon NavRow on the index that opens a
 * focused pane. An unknown `:section` falls back to the index; the retired
 * `brief` section redirects to `instructions` (AQU-2342: the brief interview
 * now writes INTO the instructions).
 *
 * Edit access is gated at MAINTAINER (600) via useProjectSettings.canEdit;
 * below-floor users see read-only affordances with a tooltip naming the
 * required role (AQU-255 pattern). The knowledge pane's manage affordances use
 * the PROJECT_LEAD (500) floor instead. ONE useProjectSettings instance lives
 * at page level and flows down — panes must not fetch their own (see the
 * optimistic-overlay note below).
 */

import { useCallback, useMemo } from "react"
import { overlaySettings } from "@/hooks/project-settings-overlay"
import type { ComponentType } from "react"
import { Navigate, useParams, useNavigate, useLocation } from "react-router-dom"
import { useI18n, useT } from "@/lib/i18n/I18nProvider"
import { formatCount } from "@/lib/i18n/format"
import {
  AlertTriangle,
  BookCheck,
  BookOpen,
  LibraryBig,
  ShieldCheck,
  Sparkles,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { NoteOnClick } from "@/components/ui/info-note"
import { BackLink, NavList, NavRow } from "@/components/ui/nav-list"
import { LIVING_MEMORY_ICON } from "@/components/LivingMemoryButton"
import { useLivingMemory } from "@/hooks/useLivingMemory"
import { useLiveness } from "@/hooks/useLiveness"
import { useProject } from "@/hooks/useProject"
import { useProjectSettings, type UseProjectSettings } from "@/hooks/useProjectSettings"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import type { MessageKey } from "@/lib/i18n/messages/en"
import { KnowledgeBaseSurface } from "@/components/knowledge/KnowledgeBaseSurface"
import {
  InheritedFieldNote,
  useUpstreamProjectName,
} from "@/components/ProjectSettings/InheritedSettingsChoice"
import { parseInheritedFromLink, type InheritFieldId } from "@/lib/sync/inherited-settings"
import { RulesSettingsSection } from "@/components/ProjectSettings/RulesSection"
import { projectTranslationInstructions } from "@/lib/instructions/project-instructions"
import {
  editorReturnFromLocation,
  projectMemoryPath,
  withEditorReturn,
} from "@/lib/navigation/org-paths"
import { ROLE } from "@/lib/frontier/roles"
import { RecentExamplesSection } from "@/components/living-memory/ExamplesSection"
import { InstructionsPane } from "@/components/living-memory/InstructionsPane"
import { QualityStyleRules } from "@/components/living-memory/QualityStyleRules"
import type { RefineSegment } from "@/components/living-memory/RefineApplicabilityDialog"
import { cellCoordinates } from "@/lib/rules/applicability"
import { resolveFileGenre } from "@/lib/rules/file-genre"
import { bookGenre } from "@/lib/scripture/book-genres"
import { fetchAllFileCells } from "@/lib/sync/cells-read"
import { buildFileScopedTokenFetcher } from "@/lib/sync/cqrs-bridge"
import type { ProjectRecord } from "@/lib/parsers/types"

// Pure entry helpers live in living-memory/entries.ts; re-exported so existing
// imports (LivingMemoryPage.test.ts, agent harness) keep resolving.
export { addEntry, updateEntry, deleteEntry } from "@/components/living-memory/entries"

// ── Section vocabulary (shared with nav/route wiring) ──────────────────────

export type LivingMemorySectionId =
  | "instructions"
  | "quality"
  | "knowledge"
  | "examples"

export interface LivingMemorySectionDef {
  id: LivingMemorySectionId
  icon: ComponentType<{ className?: string }>
  titleKey: MessageKey
  descriptionKey: MessageKey
}

export const LIVING_MEMORY_SECTIONS: readonly LivingMemorySectionDef[] = [
  {
    id: "instructions",
    icon: Sparkles,
    // Same key the pane's heading renders — one "Instructions" string.
    titleKey: "terminology.livingMemory.instructionsTitle",
    descriptionKey: "terminology.livingMemory.section.instructions.description",
  },
  {
    id: "quality",
    icon: ShieldCheck,
    titleKey: "terminology.livingMemory.section.quality.title",
    descriptionKey: "terminology.livingMemory.section.quality.description",
  },
  {
    id: "knowledge",
    icon: LibraryBig,
    titleKey: "knowledgeBase.title",
    descriptionKey: "knowledgeBase.description",
  },
  {
    id: "examples",
    icon: BookCheck,
    titleKey: "terminology.livingMemory.section.examples.title",
    descriptionKey: "terminology.livingMemory.recentExamplesDescription",
  },
]

/** Panes whose content brings its own visible heading/description render no
 *  extra chrome paragraph (instructions: InstructionsPane's heading;
 *  knowledge: KnowledgeBaseSurface's Section title; examples: the Recent
 *  Examples block) — a duplicate heading would break exact-text locators. */
const PANES_WITH_CHROME_DESCRIPTION: readonly LivingMemorySectionId[] = ["quality"]

/** Retired section ids and the pane that replaced them (bookmarks, old links). */
const RETIRED_SECTION_REDIRECTS: Readonly<Record<string, LivingMemorySectionId>> = {
  brief: "instructions",
}

// ── Page ──────────────────────────────────────────────────────────────────

interface LivingMemoryPageProps {
  /** The workspace already owns the authoritative project record. Reusing it
   * keeps this known shell mounted while query-backed pane content hydrates. */
  project?: ProjectRecord | null
  refreshProject?: () => void
  projectSettings?: UseProjectSettings
  /** AQU-1509: the editor's active lane, shared with the Rules section. */
  activeLane?: string
  onActiveLaneChange?: (lane: string) => void
}

export function LivingMemoryPage({
  project: workspaceProject,
  refreshProject: workspaceRefreshProject,
  projectSettings: workspaceProjectSettings,
  activeLane,
  onActiveLaneChange,
}: LivingMemoryPageProps = {}) {
  const { locale } = useI18n()
  const t = useT()
  const { id: projectId, section } = useParams<{ id: string; section?: string }>()
  const navigate = useNavigate()
  const location = useLocation()

  const ownedProject = useProject(projectId ?? "", {
    initialProject: workspaceProject,
    enabled: workspaceProject == null,
    // This page owns the editable settings instance immediately below.
    includeSettings: false,
  })
  const project = workspaceProject ?? ownedProject.project
  const projectLoading = workspaceProject == null && ownedProject.loading
  const refreshProject = workspaceRefreshProject ?? ownedProject.refresh

  // Unknown/missing section → the index (mirrors the ProjectSettings fallback).
  const activeSection = section
    ? LIVING_MEMORY_SECTIONS.find((candidate) => candidate.id === section) ?? null
    : null
  // The full validated-cell corpus is an expensive all-files query. Only the
  // Examples pane consumes it; every other pane renders from project/settings.
  const validatedExamplesEnabled = activeSection?.id === "examples"
  // AQU-2001: read the corpus in the lane this page is viewing. An omitted
  // lane selects the legacy default lane, which holds no target rows on a
  // project translated into a named lane — the Examples pane then showed its
  // empty state however many cells the team had validated.
  const { cells, isLoading, isEmpty, error: cellsError } = useLivingMemory({
    projectId: projectId ?? "",
    project,
    enabled: validatedExamplesEnabled,
    lane: activeLane ?? "",
  })

  const { state: livenessState, label: livenessLabel } = useLiveness(cells.length)

  // Role-aware edit gate: mirrors the AQU-255 pattern — get roleLevel from
  // syncRole, pass to useProjectSettings which enforces MAINTAINER (600) floor.
  const roleLevel = project?.syncRole?.level ?? null
  const ownedProjectSettings = useProjectSettings(
    workspaceProjectSettings ? null : (projectId ?? null),
    roleLevel,
  )
  const {
    settings,
    canEdit,
    reasonCannotEdit,
    patch: patchSettings,
  } = workspaceProjectSettings ?? ownedProjectSettings

  const { session } = useFrontierSession()

  // While the project hasn't loaded yet, canEdit is false (roleLevel is null).
  // This correctly shows read-only affordances before the role is known.
  const entriesReady = !projectLoading && project != null

  const author = session?.username ?? "unknown"

  const brief = settings.translationBrief ?? project?.translationBrief
  const inheritedConfig = useMemo(
    () => parseInheritedFromLink(settings?.inheritedFromLink),
    [settings],
  )
  const inheritedUpstreamName = useUpstreamProjectName(project?.sourceProjectId ?? null)
  const detachInherited = useCallback(
    (field: InheritFieldId) => {
      if (!inheritedConfig) return
      void patchSettings({
        inheritedFromLink: {
          ...inheritedConfig,
          receive: { ...inheritedConfig.receive, [field]: false },
          detached: { ...inheritedConfig.detached, [field]: true },
        },
      })
    },
    [inheritedConfig, patchSettings],
  )
  const inheritedNote = (field: InheritFieldId) => (
    <InheritedFieldNote
      field={field}
      upstreamName={inheritedUpstreamName}
      config={inheritedConfig}
      canEdit={canEdit}
      onDetach={detachInherited}
    />
  )
  // completionSettings comes from the overlaid project record (device-local
  // apiKey + server-side voice profiles merged in overlayDeviceLocalSettings /
  // overlaySettings). Undefined while the record hydrates, and for a project
  // that never customized AI — the brief pane resolves both to the Frontier
  // platform default rather than reading them as "no provider" (AQU-1671).
  // AQU-2259: a standalone visit's record carries no shared settings, so lay
  // the team's drafting settings over it here (a no-op on the workspace's
  // record, which already has them).
  const completionSettings = useMemo(
    () => (project ? overlaySettings(project, settings).completionSettings : undefined),
    [project, settings],
  )
  const projectWithDrafting = useMemo(
    () => (project && completionSettings !== project.completionSettings ? { ...project, completionSettings } : project),
    [project, completionSettings],
  )

  // AQU-2342: the ONE instructions text every AI draft reads — stored, else
  // migrated on read from the old sources. Resolved from THIS hook instance's
  // settings laid over the record: it carries the optimistic overlay for the
  // pane's own saves (a separate instance would not learn of them until a
  // refetch). Falls back to the bare record before the settings GET resolves.
  const resolvedInstructions = useMemo(
    () => (project ? projectTranslationInstructions(overlaySettings(project, settings)) : ""),
    [project, settings],
  )

  // ── Index-row hints: short current-value summaries (settings pattern) ────
  const sectionHint = (id: LivingMemorySectionId): string | undefined => {
    switch (id) {
      case "instructions":
        return resolvedInstructions
          ? undefined
          : t("terminology.livingMemory.instructions.notWritten")
      case "quality":
        // Reuses the rules check-drawer's "{count} rules" plural — same string.
        return t("rules.checkDrawer.scopeRules", {
          count: formatCount(settings.rules?.length ?? 0, locale),
        })
      case "knowledge":
        return settings.knowledgeBaseEnabled
          ? t("terminology.livingMemory.section.knowledge.hintOn")
          : t("terminology.livingMemory.section.knowledge.hintOff")
      case "examples":
        return !validatedExamplesEnabled || isLoading
          ? undefined
          : t("terminology.livingMemory.validatedCount", {
              count: formatCount(cells.length, locale),
            })
    }
  }

  const statusAndActions = (
    <>
      {/* AQU-2260: a coloured mark, so its state opens on click, not hover. */}
      <NoteOnClick note={livenessLabel} label={livenessLabel} className="shrink-0 p-1">
        <span
          aria-hidden
          className={[
            "h-2 w-2 shrink-0 rounded-full transition-colors",
            livenessState === "offline"
              ? "bg-red-500"
              : livenessState === "updating"
                ? "bg-amber-400 animate-pulse"
                : "bg-emerald-500",
          ].join(" ")}
        />
      </NoteOnClick>
      {validatedExamplesEnabled ? (
        isLoading ? (
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
        )
      ) : null}
      <div className="flex-1" />
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          if (!projectId) return
          navigate(withEditorReturn(
            `/project/${projectId}/terminology`,
            editorReturnFromLocation(location.pathname, location.search, projectId),
          ))
        }}
        aria-label={t("terminology.livingMemory.goToTerminologyAria")}
      >
        <BookOpen data-icon="inline-start" />
        {t("nav.sidebarSection.terminology")}
      </Button>
    </>
  )

  const pid = projectId ?? ""

  // Pane bodies keyed off the section id here (not inline in JSX) — the
  // MAINTAINER-gated pieces share the page-level settings instance via props.
  // AQU-934 phase 3c: source segments for AI applicability refinement. Reading
  // cells is the page's job, not the section's. Coordinates come from the SAME
  // `cellCoordinates` the resolver uses, so a proposal cannot address a cell
  // differently from the rule that will later match it.
  const jwtForCells = session?.jwt
  const loadSegments = useCallback(
    async (fileId: string | null, signal: AbortSignal): Promise<readonly RefineSegment[]> => {
      if (!projectId || !jwtForCells) return []
      const files = (project?.files ?? []).filter((file) => fileId == null || file.id === fileId)
      if (files.length === 0) return []
      const getToken = buildFileScopedTokenFetcher(() => jwtForCells, projectId)
      const segments: RefineSegment[] = []
      for (const file of files) {
        if (signal.aborted) break
        const token = await getToken(file.id)
        if (!token) continue
        const rows = await fetchAllFileCells(projectId, file.id, token, "source")
        const genre = resolveFileGenre(file.id, file.bookCode, settings.fileGenres)
        for (const row of rows) {
          const text = row.value.trim()
          if (!text) continue
          segments.push({
            id: row.cellId,
            text,
            ...(row.canonicalRef ? { ref: row.canonicalRef } : {}),
            coords: cellCoordinates(
              { id: row.cellId, ...(row.canonicalRef ? { globalReferences: [row.canonicalRef] } : {}) },
              {
                fileId: file.id,
                ...(file.bookCode ? { bookCode: file.bookCode } : {}),
                ...(genre ? { genre } : {}),
              },
              bookGenre,
            ),
          })
        }
      }
      return segments
    },
    [projectId, jwtForCells, project?.files, settings.fileGenres],
  )

  const paneBody = (id: LivingMemorySectionId) => {
    switch (id) {
      case "instructions":
        return (
          <>
            {inheritedNote("translationBrief")}
            <InstructionsPane
              // Remount once the record lands so the field seeds from it.
              key={entriesReady ? "ready" : "loading"}
              resolved={resolvedInstructions}
              canEdit={entriesReady && canEdit}
              reasonCannotEdit={entriesReady ? reasonCannotEdit : "role"}
              patch={patchSettings}
              brief={brief}
              author={author}
              completionSettings={completionSettings}
              session={session ?? null}
            />
          </>
        )
      case "quality":
        return (
          <>
            {projectId ? (
              <section aria-label={t("nav.sidebarSection.rules")}>
                {/* "Rules" doesn't collide with RulesSurface's own card
                    titles ("Project Rules (n)" / "Org Rules (n)"). */}
                <h2 className="text-xs font-semibold text-muted-foreground mb-3">
                  {t("nav.sidebarSection.rules")}
                </h2>
                <RulesSettingsSection
                  projectId={projectId}
                  project={projectWithDrafting}
                  refreshProject={refreshProject}
                  patchSettings={patchSettings}
                  roleLevel={roleLevel}
                  activeLane={activeLane}
                  onActiveLaneChange={onActiveLaneChange}
                />
              </section>
            ) : null}
            {projectId ? (
              <QualityStyleRules
                projectId={projectId}
                roleLevel={entriesReady ? roleLevel : null}
                completionSettings={completionSettings}
                session={session ?? null}
                files={project?.files ?? []}
                fileGenres={settings.fileGenres}
                canEditSettings={entriesReady && canEdit}
                reasonCannotEditSettings={entriesReady ? reasonCannotEdit : "role"}
                patchFileGenres={patchSettings}
                loadSegments={loadSegments}
              />
            ) : null}
          </>
        )
      case "knowledge":
        return projectId ? (
          <>
          {inheritedNote("knowledgeDocs")}
          <KnowledgeBaseSurface
            scope={{ kind: "project", id: projectId }}
            jwt={session?.jwt ?? null}
            canManage={entriesReady && roleLevel != null && roleLevel >= ROLE.PROJECT_LEAD}
            drafting={{
              checked: settings.knowledgeBaseEnabled ?? false,
              disabled: !(entriesReady && canEdit),
              onCheckedChange: async (checked) => {
                await patchSettings({ knowledgeBaseEnabled: checked })
              },
            }}
          />
          </>
        ) : null
      case "examples":
        return (
          <RecentExamplesSection cells={cells} isLoading={isLoading} isEmpty={isEmpty} />
        )
    }
  }

  const retiredTarget = section ? RETIRED_SECTION_REDIRECTS[section] : undefined
  if (retiredTarget && projectId) {
    return <Navigate to={projectMemoryPath(projectId, retiredTarget) + location.search} replace />
  }

  return (
    <div className="flex h-full flex-col bg-background">
      <header className="flex shrink-0 items-center gap-2 border-b px-4 py-3">
        <LIVING_MEMORY_ICON className="h-5 w-5 text-muted-foreground" aria-hidden />
        <h1 className="text-base font-semibold">{t("terminology.livingMemory.title")}</h1>
        {statusAndActions}
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
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-6">
          {activeSection === null ? (
            <>
              <p className="text-xs text-muted-foreground leading-relaxed">
                {t("terminology.livingMemory.introText")}
              </p>

              {/* location.search is preserved so the `?return=` editor handoff
                  survives the index → pane hop (same as settings panes). */}
              <NavList>
                {LIVING_MEMORY_SECTIONS.map((s) => (
                  <NavRow
                    key={s.id}
                    to={projectMemoryPath(pid, s.id) + location.search}
                    icon={s.icon}
                    title={t(s.titleKey)}
                    description={t(s.descriptionKey)}
                    hint={sectionHint(s.id)}
                  />
                ))}
              </NavList>
            </>
          ) : (
            <>
              <div className="flex flex-col gap-2">
                <BackLink
                  to={projectMemoryPath(pid) + location.search}
                  label={t("terminology.livingMemory.title")}
                />
                {PANES_WITH_CHROME_DESCRIPTION.includes(activeSection.id) && (
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    {t(activeSection.descriptionKey)}
                  </p>
                )}
              </div>

              {paneBody(activeSection.id)}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
