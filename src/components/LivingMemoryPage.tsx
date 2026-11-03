/**
 * LivingMemoryPage — settings-style index → detail surface for the project's
 * living memory, mounted by ProjectWorkspace as an overlay at
 * `/project/:id/memory` and `/project/:id/memory/:section` (the same
 * index → pane pattern as ProjectSettings/Preferences). Five sections —
 *   brief | instructions | quality | knowledge | examples
 * (see LIVING_MEMORY_SECTIONS) — each an icon NavRow on the index that opens a
 * focused pane. An unknown `:section` falls back to the index.
 *
 * Edit access is gated at MAINTAINER (600) via useProjectSettings.canEdit;
 * below-floor users see read-only affordances with a tooltip naming the
 * required role (AQU-255 pattern). The knowledge pane's manage affordances use
 * the PROJECT_LEAD (500) floor instead. ONE useProjectSettings instance lives
 * at page level and flows down — panes must not fetch their own (see the
 * optimistic-overlay note below).
 */

import { useCallback, useMemo, useState } from "react"
import { overlaySettings } from "@/hooks/project-settings-overlay"
import type { ComponentType } from "react"
import { useParams, useNavigate, useLocation } from "react-router-dom"
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
import { BRIEF_ICON, LIVING_MEMORY_ICON } from "@/components/LivingMemoryButton"
import { useLivingMemory } from "@/hooks/useLivingMemory"
import { useLiveness } from "@/hooks/useLiveness"
import { useProject } from "@/hooks/useProject"
import { useProjectSettings, type UseProjectSettings } from "@/hooks/useProjectSettings"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import type { LivingMemoryEntry } from "@/lib/parsers/types"
import type { MessageKey } from "@/lib/i18n/messages/en"
import { KnowledgeBaseSurface } from "@/components/knowledge/KnowledgeBaseSurface"
import {
  InheritedFieldNote,
  useUpstreamProjectName,
} from "@/components/ProjectSettings/InheritedSettingsChoice"
import { parseInheritedFromLink, type InheritFieldId } from "@/lib/sync/inherited-settings"
import { RulesSettingsSection } from "@/components/ProjectSettings/RulesSection"
import {
  LaneListNote,
  LaneOverrideControl,
  LivingMemoryLanePicker,
  type MemoryLaneOption,
} from "@/components/living-memory/LaneMemorySection"
import {
  customizeSectionPatch,
  laneOwnsSection,
  laneSectionValue,
  laneSectionWritePatch,
  revertSectionPatch,
} from "@/lib/living-memory/lane-sections"
import { resolveLaneEntries, targetLaneIdForTag } from "../../db/shared/lane-memory"
import { extraRegistryLanes } from "@/lib/lanes/registry-lanes"
import { switcherLaneTags } from "@/lib/lanes/switcher-lanes"
import { laneDisplayName } from "@/lib/lanes/lane-display"
import type { TranslationBrief } from "@/lib/brief/types"
import { briefStatus } from "@/lib/brief/brief"
import { DEFAULT_SYSTEM_PROMPT } from "@/lib/completion/completion-service"
import {
  editorReturnFromLocation,
  projectMemoryPath,
  withEditorReturn,
} from "@/lib/navigation/org-paths"
import { ROLE } from "@/lib/frontier/roles"
import { addEntry, updateEntry, deleteEntry } from "@/components/living-memory/entries"
import { AuthoredEntriesSection } from "@/components/living-memory/AuthoredEntriesSection"
import { RecentExamplesSection } from "@/components/living-memory/ExamplesSection"
import { BriefPane } from "@/components/living-memory/BriefPane"
import { PredictionPromptSection } from "@/components/living-memory/PredictionPromptSection"
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
  | "brief"
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
    id: "brief",
    icon: BRIEF_ICON,
    titleKey: "terminology.livingMemory.section.brief.title",
    descriptionKey: "terminology.livingMemory.section.brief.description",
  },
  {
    id: "instructions",
    icon: Sparkles,
    // Same key the pane's section heading renders — one "Instructions" string.
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
 *  extra chrome paragraph (knowledge: KnowledgeBaseSurface's Section title;
 *  examples: the Recent Examples block) — a duplicate heading would break
 *  exact-text locators. */
const PANES_WITH_CHROME_DESCRIPTION: readonly LivingMemorySectionId[] = [
  "brief",
  "instructions",
  "quality",
]

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
  // ── The lane this page is viewing (AQU-2348) ────────────────────────────
  //
  // The picker chooses a lane by its legacy TAG, because that is the key the
  // editor and the Rules section already share through `activeLane` — one
  // "current lane" across the workspace, not three. Lane MEMORY, though, is
  // keyed by `lanes.id` (AQU-1240), so the tag is mapped through
  // `targetLaneIdForTag` exactly once, here.
  //
  // `viewLaneId` is `undefined` for the project-wide view, and `undefined` is
  // what every resolver already means by "no lane": a single-lane project, a
  // project whose lane rows have not arrived, and a legacy project whose
  // default lane carries only the `''` tag all read project-wide values, with
  // no picker and no lane chrome. That is criterion #1's "the page is
  // unchanged" and criterion #12's legacy project, and it is why this feature
  // needs no migration to open an existing project.
  const laneRows = (project?.lanes ?? []).filter((lane) => lane.role === "target")
  const laneOptions: MemoryLaneOption[] = useMemo(() => {
    if (!project) return []
    const fallback = [...new Set(extraRegistryLanes(project.targetLanes, project.targetLanguage))]
    if (!fallback.includes("")) fallback.unshift("")
    const rows = (project.lanes ?? []).filter((lane) => lane.role === "target")
    const archived = new Set(rows.filter((lane) => lane.archivedAt).map((lane) => lane.legacyTag ?? ""))
    const defaultRow = rows.find((lane) => (lane.legacyTag ?? "") === "")
    const labels = Object.fromEntries(rows.map((lane) => [lane.legacyTag ?? "", laneDisplayName(lane)]))
    return switcherLaneTags(rows, fallback).map((tag) => ({
      tag,
      label:
        labels[tag] ||
        (tag === ""
          ? (defaultRow ? laneDisplayName(defaultRow) : project.targetLanguage) ||
            t("rules.editor.lane.defaultLane")
          : tag),
      archived: archived.has(tag),
    }))
  }, [project, t])

  const [localLane, setLocalLane] = useState("")
  const requestedLane = activeLane ?? localLane
  const viewLane = laneOptions.some((o) => o.tag === requestedLane)
    ? requestedLane
    : (laneOptions[0]?.tag ?? "")
  const setViewLane = onActiveLaneChange ?? setLocalLane
  // One lane means no lane scope at all — not "lane 1 of 1". Keeping the
  // picker hidden AND the id undefined is what makes a single-lane project
  // byte-identical to before this feature.
  const laneScoped = laneOptions.length > 1
  const viewLaneId = laneScoped ? targetLaneIdForTag(viewLane, laneRows) : undefined
  const viewLaneLabel = laneOptions.find((o) => o.tag === viewLane)?.label ?? viewLane
  // A lane row the picker offers but `lanes` has no id for cannot carry lane
  // memory, so its chrome would be a control that silently does nothing.
  const laneChrome = laneScoped && viewLaneId !== undefined
  // laneId → display name, for the rows that name their OWNING lane (style
  // rules). Keyed by id rather than by tag because that is what a row stores.
  const laneLabelById = useMemo(() => {
    const rows = (project?.lanes ?? []).filter((lane) => lane.role === "target")
    return Object.fromEntries(rows.map((lane) => [lane.id, laneDisplayName(lane)]))
  }, [project?.lanes])
  const laneScope = useMemo(
    () =>
      laneChrome && viewLaneId !== undefined
        ? { viewLaneId, laneLabel: (id: string) => laneLabelById[id] ?? id }
        : undefined,
    [laneChrome, viewLaneId, laneLabelById],
  )

  // AQU-2001: read the corpus in the lane this page is viewing. An omitted
  // lane selects the legacy default lane, which holds no target rows on a
  // project translated into a named lane — the Examples pane then showed its
  // empty state however many cells the team had validated.
  const { cells, isLoading, isEmpty, error: cellsError } = useLivingMemory({
    projectId: projectId ?? "",
    project,
    enabled: validatedExamplesEnabled,
    // AQU-2348: a standalone visit has no `activeLane`, so the Examples pane
    // used to read the default lane's corpus however the page's own picker was
    // set. It now follows that local choice.
    //
    // The workspace's `activeLane` is still passed through VERBATIM when it
    // has one, deliberately NOT narrowed to `viewLane`: `viewLane` validates
    // against the project record's lane list, which is empty while the record
    // hydrates, and falling back to the default lane there would re-introduce
    // exactly the empty Examples pane AQU-2001 fixed.
    lane: activeLane ?? viewLane,
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
  // Render from THIS hook instance's settings — it carries the optimistic
  // overlay for patches made here. useProject reads through its own separate
  // useProjectSettings instance, which never learns of our patch until a
  // refetch, so a just-saved entry wouldn't render (same class as the
  // file-rename overlay fix). Fall back to the project record before the
  // settings GET resolves.
  // The project's WHOLE entry list — every lane's — is what the mutators work
  // on, because an entry is addressed by id and a lane-owned one must still be
  // editable and deletable from the lane that owns it.
  // Memoized because `?? []` mints a fresh array on a project with no entries,
  // which would re-run the lane resolution below on every render.
  const allEntries = useMemo(
    () => settings.livingMemoryEntries ?? project?.livingMemoryEntries ?? [],
    [settings.livingMemoryEntries, project?.livingMemoryEntries],
  )
  // What the viewed lane actually sees: the project's entries PLUS this lane's
  // own, never another lane's (the union rule — entries are a list, so a lane
  // adds to the project's standards rather than replacing them).
  const entries = useMemo(
    () => resolveLaneEntries(allEntries, viewLaneId),
    [allEntries, viewLaneId],
  )

  const author = session?.username ?? "unknown"

  // Override-with-fallback: this lane's brief when it owns one, else the
  // project's.
  const briefCustomized = laneOwnsSection(settings, viewLaneId, "brief")
  // The project record is the pre-settings-GET fallback it always was — but
  // ONLY while the lane is inheriting. A lane that deliberately owns "no
  // brief" must not fall through to the project's: an empty lane value means
  // "this lane has none", not "inherit", or the badge would read "Customized"
  // over the project's own text.
  const brief = briefCustomized
    ? laneSectionValue(settings, viewLaneId, "brief")
    : laneSectionValue(settings, viewLaneId, "brief") ?? project?.translationBrief
  const promptCustomized = laneOwnsSection(settings, viewLaneId, "systemPrompt")
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

  // Every mutator writes the WHOLE list back (the key is replaced wholesale),
  // so they must start from `allEntries` — starting from the lane-resolved
  // view would drop every other lane's entries on the first edit.
  async function handleAdd(kind: LivingMemoryEntry["kind"], text: string) {
    const next = addEntry(allEntries, kind, text, author, viewLaneId)
    await patchSettings({ livingMemoryEntries: next })
  }

  async function handleUpdate(id: string, text: string) {
    const next = updateEntry(allEntries, id, text)
    await patchSettings({ livingMemoryEntries: next })
  }

  async function handleDelete(id: string) {
    const next = deleteEntry(allEntries, id)
    await patchSettings({ livingMemoryEntries: next })
  }

  // ── Lane-aware writes and the customize / revert actions ────────────────
  //
  // BriefPane and PredictionPromptSection are unchanged: they keep patching
  // `translationBrief` / `systemPrompt` and the destination is rewritten here.
  // An edit made in a lane that OWNS the section must never land on the
  // project's value — that leak is exactly what criterion #3 forbids — and an
  // edit in a lane that inherits is still a project-wide edit, because the
  // lane is showing the project's value and the user is editing what they see.
  const patchBrief = useCallback(
    (partial: { translationBrief: TranslationBrief }) =>
      patchSettings(laneSectionWritePatch(settings, viewLaneId, "brief", partial.translationBrief)),
    [patchSettings, settings, viewLaneId],
  )
  const patchPrompt = useCallback(
    (partial: Parameters<typeof patchSettings>[0]) => {
      if (typeof partial.systemPrompt !== "string") return patchSettings(partial)
      return patchSettings(
        laneSectionWritePatch(settings, viewLaneId, "systemPrompt", partial.systemPrompt),
      )
    },
    [patchSettings, settings, viewLaneId],
  )
  const laneOverrideNote = (section: "brief" | "systemPrompt") =>
    laneChrome && viewLaneId !== undefined ? (
      <LaneOverrideControl
        laneLabel={viewLaneLabel}
        customized={section === "brief" ? briefCustomized : promptCustomized}
        canEdit={entriesReady && canEdit}
        reasonCannotEdit={entriesReady ? reasonCannotEdit : "role"}
        onCustomize={() => {
          void patchSettings(customizeSectionPatch(settings, viewLaneId, section))
        }}
        onRevert={() => {
          void patchSettings(revertSectionPatch(settings, viewLaneId, section))
        }}
      />
    ) : null
  const laneListNote = () => (laneChrome ? <LaneListNote laneLabel={viewLaneLabel} /> : null)

  // ── Index-row hints: short current-value summaries (settings pattern) ────
  // The index hint reflects the lane being viewed, so "Custom prompt" names
  // the prompt that lane would actually send.
  const storedPrompt = laneSectionValue(settings, viewLaneId, "systemPrompt") ?? ""
  const promptIsCustom =
    Boolean(storedPrompt.trim()) && storedPrompt !== DEFAULT_SYSTEM_PROMPT

  const sectionHint = (id: LivingMemorySectionId): string | undefined => {
    switch (id) {
      case "brief": {
        const status = briefStatus(brief)
        return status === "none"
          ? t("terminology.livingMemory.section.brief.statusNone")
          : status === "draft"
            ? t("terminology.livingMemory.section.brief.statusDraft")
            : t("terminology.livingMemory.section.brief.statusComplete")
      }
      case "instructions": {
        const count = entries.filter((e) => e.kind === "instruction").length
        const parts = [
          t("terminology.livingMemory.section.instructions.entryCount", {
            count: formatCount(count, locale),
          }),
        ]
        if (promptIsCustom) {
          parts.push(t("terminology.livingMemory.section.instructions.customPromptHint"))
        }
        return parts.join(" · ")
      }
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
      case "brief":
        return (
          <>
          {inheritedNote("translationBrief")}
          {laneOverrideNote("brief")}
          <BriefPane
            brief={brief}
            canEdit={entriesReady && canEdit}
            author={author}
            completionSettings={completionSettings}
            session={session ?? null}
            patch={patchBrief}
          />
          </>
        )
      case "instructions":
        return (
          <>
            {inheritedNote("livingMemory")}
            {laneListNote()}
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
            {inheritedNote("systemPrompt")}
            {laneOverrideNote("systemPrompt")}
            <PredictionPromptSection
              stored={storedPrompt || undefined}
              canEdit={entriesReady && canEdit}
              reasonCannotEdit={entriesReady ? reasonCannotEdit : "role"}
              patch={patchPrompt}
            />
          </>
        )
      case "quality":
        return (
          <>
            {laneListNote()}
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
                {...(viewLaneId !== undefined ? { laneId: viewLaneId } : {})}
                {...(laneScope ? { laneScope } : {})}
              />
            ) : null}
          </>
        )
      case "knowledge":
        return projectId ? (
          <>
          {inheritedNote("knowledgeDocs")}
          {laneListNote()}
          <KnowledgeBaseSurface
            scope={{ kind: "project", id: projectId }}
            jwt={session?.jwt ?? null}
            {...(viewLaneId !== undefined ? { laneId: viewLaneId } : {})}
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
          {/* AQU-2348: the lane picker sits above BOTH the index and every
              pane, so a maintainer can never edit one lane's memory while
              believing they are looking at another's. Renders nothing on a
              single-lane project. */}
          <LivingMemoryLanePicker
            options={laneOptions}
            value={viewLane}
            onValueChange={setViewLane}
            sharedWithEditor={onActiveLaneChange != null}
          />
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
