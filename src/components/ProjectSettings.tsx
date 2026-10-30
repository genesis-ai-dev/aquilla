import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from "react"
import { SettingMovedNote } from "@/components/settings/SettingMovedNote"
import { settingMovedNotesShowing } from "@/lib/settings/setting-moved"
import { authorNameFor, LOCAL_AUTHOR_NAME_SETTING_ID } from "@/lib/store/local-author-name"
import { notifySmartExtensionsChanged } from "@/lib/tools/smart-extensions-enabled"
import { Navigate, useLocation, useParams, useNavigate, useSearchParams, type Location } from "react-router-dom"
import {
  isProjectEditorPath,
  projectMemoryPath,
  projectSettingsPath,
  safeReturnPath,
  withSettingsReturn,
} from "@/lib/navigation/org-paths"
import {
  CheckCircle, XCircle, Sparkles,
  SlidersHorizontal, Link2, BarChart3, ShieldCheck, AudioLines, Plug, FlaskConical,
  Users,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { filmAndSourcesShown } from "@/lib/media/film-and-sources"
import { LoadingPanel } from "@/components/ui/loading-overlay"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Switch } from "@/components/ui/switch"
import { OptionalMark } from "@/components/ui/field"
import { Slider } from "@/components/ui/slider"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { DisabledFieldTooltip, PermissionLockHint } from "./ProjectSettings/DisabledFieldTooltip"
import {
  InheritedFieldNote,
  InheritedSettingsSection,
  useUpstreamProjectName,
} from "./ProjectSettings/InheritedSettingsChoice"
import { parseInheritedFromLink, type InheritFieldId } from "@/lib/sync/inherited-settings"
import { PrivilegedMembersDialog } from "./ProjectSettings/PrivilegedMembersDialog"
import { AppShell } from "@/components/AppShell"
import { OrgSidebar } from "@/components/org/OrgSidebar"
import { OrgBreadcrumb } from "@/components/org/OrgBreadcrumb"
import { Page, PageHeader, SettingsGroup, SettingsRow } from "@/components/ui/page"
import { useProject } from "@/hooks/useProject"
import { useProjectSettings } from "@/hooks/useProjectSettings"
import { overlaySettings } from "@/hooks/project-settings-overlay"
import { patchProject } from "@/lib/store/project-index"
import { SaveStatus, SaveStatusProvider } from "@/lib/settings/save-status"
import type { CommitInfo } from "@/lib/settings/useCommitOnPause"
import { CommitNumberInput, CommitTextInput } from "@/components/settings/CommitInput"
import { useSettingsCommit } from "@/components/ProjectSettings/useSettingsCommit"
import { useSettingsStepKinds, type DeviceSettingKey } from "@/components/ProjectSettings/useSettingsStepKinds"
import {
  DEVICE_SETTING_LABELS,
  DRAFTING_FIELD_LABELS,
  sharedSettingLabel,
  type DraftingField,
} from "@/components/ProjectSettings/setting-labels"
import { HistoryControls } from "@/components/history/HistoryControls"
import { isSettingsStep } from "@/lib/history/settings-steps"
import { useHistoryReporter } from "@/components/history/useHistoryReporter"
import { holdHistoryScope } from "@/lib/history/history"
import { httpHistoryRemote } from "@/lib/history/history-remote"
import { useHistoryShortcuts } from "@/lib/history/useHistory"
import {
  DEFAULT_APPROVED_EXAMPLE_COUNT,
  fetchModels,
  normalizeCompletionMaxTokens,
  resolveProvider,
} from "@/lib/completion/completion-service"
import {
  CUSTOM_PRESETS,
  endpointForPresetChange,
  presetIdForEndpoint,
  presetLabel,
} from "@/lib/completion/provider-presets"
import { buildCompletionSettings, DEFAULT_SYSTEM_PROMPT } from "@/hooks/useCompletionSettings"
import { MAX_BATCH_COMPLETIONS } from "@/lib/workspace-actions/registry"
import type {
  AudioMediaStrategy,
  CellUnit,
  CompletionProvider,
  ContextSize,
  DecaySettings,
  ProjectRecord,
} from "@/lib/parsers/types"
import {
  AUDIO_MEDIA_STRATEGY_LABELS,
  projectHasScriptureFiles,
} from "@/lib/parsers/types"
import { isAutopilotVisible } from "@/lib/features/flags"
import { isBibleDataExperimentOn } from "@/lib/bible-data/experiment"
import type { BibleEnrichmentSettings } from "../../db/shared/bible-enrichments"
import type { MediaDefaults } from "../../db/shared/media-setting-defaults"
import { BibleDataSection } from "./ProjectSettings/BibleDataSection"
import { LanguageProfileSection } from "./ProjectSettings/LanguageProfileSection"
import { ProjectDecisionsSection } from "./ProjectSettings/ProjectDecisionsSection"
import {
  resolveTimingLocked,
  createProjectLane,
  renameProjectLane,
  setProjectLaneArchived,
  setProjectLaneDelivers,
  fetchLaneLastChange,
  settingsEditorName,
  type LaneLastChangeResult,
} from "@/lib/sync/project-settings"
import { DEFAULT_DRAFT_CONTEXT } from "@/lib/completion/draft-context"
import { RepetitionPropagationProjectSection } from "./ProjectSettings/RepetitionPropagationProjectSection"
import { StructuralCellsProjectSection } from "./ProjectSettings/StructuralCellsProjectSection"
import { ValidationSettingsSection } from "./ProjectSettings/ValidationSettingsSection"
import { TermMatchingSection } from "./ProjectSettings/TermMatchingSection"
import type { TermMatchingSettings } from "@/lib/terminology/types"
import { DecaySettingsSection } from "./ProjectSettings/DecaySettingsSection"
import { AudioMediaStrategySection } from "./ProjectSettings/AudioMediaStrategySection"
import { TermbaseSharingSection } from "./ProjectSettings/TermbaseSharingSection"
import { MondayIntegrationSection } from "./ProjectSettings/MondayIntegrationSection"
import { AirtableIntegrationSection } from "./ProjectSettings/AirtableIntegrationSection"
import { SourceLinkSection } from "./ProjectSettings/SourceLinkSection"
import { LinkSourceSection } from "./ProjectSettings/LinkSourceSection"
import { ExperimentalFlagsSection } from "./ProjectSettings/ExperimentalFlagsSection"
import { LanguagesSection, type LaneDeliversOutcome } from "./ProjectSettings/LanguagesSection"
import type { LaneDelivers } from "@/lib/lanes/lane-delivers"
import { MembersSection } from "./ProjectSettings/MembersSection"
import { ProjectVisibilitySection } from "./ProjectSettings/ProjectVisibilitySection"
import { KeyInUseLine } from "@/components/settings/KeyInUseLine"
import { completionKeyInUse, geminiKeyInUse } from "@/lib/settings/key-in-use"
import { useUserProviderOverride } from "@/lib/store/user-provider-override"
import { BRIEF_ICON, LIVING_MEMORY_ICON } from "./LivingMemoryButton"
import { briefStatus } from "@/lib/brief/brief"
import { DcsUpstreamPanel } from "@/components/dcs/DcsUpstreamPanel"
import { readCursor } from "@/lib/dcs/cursor"
import { UpstreamChangesPanel } from "./linked/UpstreamChangesPanel"
import { buildFileScopedTokenFetcher } from "@/lib/sync/cqrs-bridge"
import { useOrg } from "@/hooks/useOrg"
import { useOrgSettings } from "@/hooks/useOrgSettings"
import { resolveProjectPolicy } from "@/lib/sync/project-org-policy"
import { useActiveOrgOptional } from "@/context/OrgContext"
import { ApiKeyField } from "./ApiKeyField"
import { SettingsNav, type SettingsSection } from "./ProjectSettings/SettingsNav"
import { BackLink, NavList, NavRow } from "@/components/ui/nav-list"
import { readValidationCount, readValidationCountAudio } from "@/lib/progress/read-validation-count"
import { setUserApiKey, useUserApiKey } from "@/lib/store/user-api-keys"
import type { CellEditingTier } from "@/lib/sync/project-settings"
import { FLOOR_LABEL } from "@/pages/settings/constants"
import { CELL_EDITING_FLOOR_OPTIONS, cellEditingTierLabel } from "@/components/ProjectSettings/cell-editing-floor-options"
import { OrgDefaultSource, orgBooleanOptionLabel } from "@/components/ProjectSettings/OrgDefaultSource"
import { InfoReveal, InfoToggle, useInfoOpen } from "@/components/ui/info-tip"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { PERMISSION_DOCS_URL } from "@/components/PermissionDeniedAlert"
import { resolveRoleName, ROLE } from "@/lib/frontier/roles"
import { useT, type TFunction } from "@/lib/i18n/I18nProvider"
import type { MessageKey } from "@/lib/i18n/messages/en"
import { usePostEditMetrics } from "@/lib/metrics/use-post-edit-metrics"
import { PostEditMetricsSection } from "@/components/metrics/PostEditMetricsSection"

/**
 * =============================================================================
 * TERMBASE SHARING — HIDDEN FROM PROJECT SETTINGS (intentional, 2026-06-11)
 * =============================================================================
 *
 * The Term Base Sharing section (publish/subscribe across org projects) is
 * implemented but not ready to expose in the UI yet. Keep the code — flip this
 * flag to `true` when we want it back in settings nav + main content.
 *
 * Smoke coverage has to be written, not un-skipped: the three specs this note
 * used to name (project-settings-termbase-sharing, -publish-toggle,
 * termbase-subscribe-unsubscribe) are not in e2e/specs/projects/, and no
 * termbase sharing spec exists anywhere under e2e/ today.
 *
 * Backend routes + TermbaseSharingSection.tsx remain live; only settings UI
 * entry points are gated here.
 * =============================================================================
 */
const SHOW_TERMBASE_SHARING_IN_SETTINGS = false

/** AQU-1768: an org with no media defaults, as one stable value. */
const NO_ORG_MEDIA_DEFAULTS: MediaDefaults = Object.freeze({})


/**
 * AQU-1720: what one cell is when a docx/txt/md file is imported. A dubbing
 * project generates one voice clip per cell, so a cell cut at a comma is an
 * unusable clip — "paragraph" makes the transcript paragraph the cell.
 */
const IMPORT_CELL_UNIT_OPTIONS: readonly {
  value: CellUnit
  labelKey: MessageKey
}[] = [
  { value: "sentence", labelKey: "projectSettings.import.cellUnitOptionSentence" },
  { value: "paragraph", labelKey: "projectSettings.import.cellUnitOptionParagraph" },
]

/**
 * Re-wraps already-known literal substrings of a translated sentence in inline
 * styling — `t()` only ever returns a plain string, so a template whose English
 * source embeds a `<code>`/`<strong>` fragment (a domain name, a translated
 * sub-label) needs its rendered result split back apart at those exact
 * substrings to restore the styling. Each `term` is inserted into the
 * translated string verbatim (as literal data or as an already-translated
 * value), so splitting on it survives localization.
 */
function withStyledTerms(
  text: string,
  terms: { text: string; as: "code" | "strong" | "mono" }[],
): ReactNode {
  const nonEmpty = terms.filter((term) => term.text.length > 0)
  if (nonEmpty.length === 0) return text
  const pattern = new RegExp(
    `(${nonEmpty.map((term) => term.text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`,
    "g",
  )
  return text.split(pattern).map((part, i) => {
    const match = nonEmpty.find((term) => term.text === part)
    if (!match) return part
    if (match.as === "code") {
      return <code key={i} className="rounded bg-muted px-1">{part}</code>
    }
    if (match.as === "mono") {
      return <span key={i} className="font-mono">{part}</span>
    }
    return <strong key={i}>{part}</strong>
  })
}

/** Every setting on the page, as saved: what the controls show (AQU-2262). */
interface SavedSettings {
  name: string
  provider: CompletionProvider
  endpoint: string
  apiKey: string
  model: string
  maxTokens: number
  temperature: number
  top_k: number
  contextSize: ContextSize
  useOnlyValidatedExamples: boolean
  main_chat_language: string
  fewShotExampleFormat: "source-and-target" | "target-only"
  completionBatchSize: number
  validationBatchSize: number
  autoSyncEnabled: boolean
  autoSyncInterval: number
  /** AQU-1771: the project's own numbers; null = take the organization's default. */
  validationCount: number | null
  validationCountAudio: number | null
  validationRoleFloor: "reviewer" | "project_lead" | "maintainer"
  validationNamedUsers: string[]
  allowSelfValidation: boolean
  // AQU-490: the audio policy. Separate keys, never fallbacks for the text
  // ones.
  // AQU-1768: these five are the project's OWN values; null = it follows the
  // organization's default (then each setting's built-in default).
  validationRoleFloorAudio: "reviewer" | "project_lead" | "maintainer" | null
  validationNamedUsersAudio: string[]
  allowSelfValidationAudio: boolean | null
  /** AQU-646: may people add lines into the timeline's silences? */
  cellEditingFloor: CellEditingTier | null
  /** AQU-646 stage 2: may this project's timelines be restructured? */
  allowTrackEditing: boolean | null
  /** AQU-1758: Film and Sources in the media view; null = the project's kind decides. */
  filmAndSources: boolean | null
  timingLocked: boolean | null
  harmonize_min_role: "project_lead" | "maintainer"
  /** AQU-460: EXPLICIT persisted value only. `undefined` = no explicit choice
   *  yet — the effective (displayed) state is derived via
   *  `resolveBibleResourcesEnabled`, not defaulted here. */
  bibleResourcesEnabled: boolean | undefined
  /** AQU-1686: EXPLICIT enrichment choices only; a missing id shows its default. */
  bibleEnrichments: BibleEnrichmentSettings
  decaySettings: DecaySettings | undefined
  audioMediaStrategy: AudioMediaStrategy
  geminiApiKey: string
  precedingTargetCells: number
  /** AQU-634: when true, USFM imports exclude book-name/title/TOC + intro-block
   *  front matter. Absent/false imports front matter (the default). */
  importExcludeFrontMatter: boolean
  /** AQU-1720: what one imported cell is for docx/txt/md uploads. */
  importCellUnit: CellUnit
  /** Curly quotes as you type in the cell editor. Absent/false is off. */
  smartQuotes: boolean
  termMatching: TermMatchingSettings
}

function readSavedSettings(project: ProjectRecord): SavedSettings {
  return {
    name: project.name,
    provider: project.completionSettings ? resolveProvider(project.completionSettings) : "frontier",
    endpoint: project.completionSettings?.endpoint ?? "",
    apiKey: project.completionSettings?.apiKey ?? "",
    model: project.completionSettings?.model ?? "",
    // Normalized so the field shows what drafting will actually send — legacy
    // default snapshots (512/4096) are upgraded to the current default.
    maxTokens: normalizeCompletionMaxTokens(project.completionSettings?.maxTokens),
    temperature: project.completionSettings?.temperature ?? 0.3,
    top_k: project.completionSettings?.top_k ?? DEFAULT_APPROVED_EXAMPLE_COUNT,
    contextSize: project.completionSettings?.contextSize ?? "medium",
    useOnlyValidatedExamples: true,
    main_chat_language: project.completionSettings?.main_chat_language ?? "",
    fewShotExampleFormat: project.completionSettings?.fewShotExampleFormat ?? "source-and-target",
    completionBatchSize: project.completionSettings?.completionBatchSize ?? MAX_BATCH_COMPLETIONS,
    // 0 = validate all eligible cells (default, unchanged behavior).
    validationBatchSize: project.completionSettings?.validationBatchSize ?? 0,
    autoSyncEnabled: project.syncSettings?.autoSync.enabled ?? false,
    autoSyncInterval: project.syncSettings?.autoSync.intervalMinutes ?? 5,
    // AQU-1771: `project` here carries only the project's own blob (this page
    // passes includeSettings: false, and overlays without org defaults), so
    // an absent value means "Organization default", not 1.
    validationCount: project.validationCount == null ? null : readValidationCount(project),
    validationCountAudio: project.validationCountAudio == null ? null : readValidationCountAudio(project),
    validationRoleFloor: project.validationRoleFloor ?? "reviewer",
    validationNamedUsers: project.validationNamedUsers ?? [],
    allowSelfValidation: project.allowSelfValidation ?? true,
    // AQU-1768: absent = "Organization default", not the built-in value. The
    // built-ins (reviewer, self-validation on, cell editing nobody, track
    // editing off, timing LOCKED) now apply only when the organization sets
    // none either; the controls below resolve them for display.
    validationRoleFloorAudio: project.validationRoleFloorAudio ?? null,
    validationNamedUsersAudio: project.validationNamedUsersAudio ?? [],
    allowSelfValidationAudio: typeof project.allowSelfValidationAudio === "boolean" ? project.allowSelfValidationAudio : null,
    cellEditingFloor: project.cellEditingFloor ?? null,
    allowTrackEditing: typeof project.allowTrackEditing === "boolean" ? project.allowTrackEditing : null,
    filmAndSources: typeof project.filmAndSources === "boolean" ? project.filmAndSources : null,
    timingLocked: typeof project.timingLocked === "boolean" ? project.timingLocked : null,
    harmonize_min_role: project.harmonize_min_role ?? "project_lead",
    // AQU-460: preserve "unset" — do NOT default to false here, that would
    // make an unset scripture project look explicitly off in the diff/baseline.
    bibleResourcesEnabled: project.bibleResourcesEnabled,
    // AQU-1686: explicit choices only — never fill in the defaults, or Save
    // would pin today's defaults onto the project.
    bibleEnrichments: project.bibleEnrichments ?? {},
    decaySettings: project.decaySettings,
    audioMediaStrategy: project.audioMediaStrategy ?? "lazy",
    geminiApiKey: project.ttsSettings?.apiKey ?? "",
    precedingTargetCells: project.draftContext?.precedingTargetCells ?? DEFAULT_DRAFT_CONTEXT.precedingTargetCells,
    importExcludeFrontMatter: project.importExcludeFrontMatter ?? false,
    importCellUnit: project.importCellUnit ?? "sentence",
    smartQuotes: project.smartQuotes ?? false,
    termMatching: project.termMatching ?? { prefixes: [], suffixes: [] },
  }
}

/** The provenance line under the project name. The settings response names
 *  the saver only by id, so without a username it gives the date alone rather
 *  than "Last edited by undefined" (walk 10-02). */
function lastEditedLine(name: string | null, date: string, t: TFunction): string {
  return name
    ? t("projectSettings.shared.lastEdited", { name, date })
    : t("projectSettings.shared.lastEditedOn", { date })
}

interface ProjectSettingsProps {
  modal?: boolean
}

/**
 * AQU-2031: the `?focus=` vocabulary a caller may deep-link to on a settings
 * pane, mapped to the element scrolled into view. `block` is per target: a card
 * goes to the top of the pane, a single field inside a card only moves far
 * enough to be on screen (so a short project does not scroll at all).
 */
/** The headings the settings index lists its rows under, in order. */
const HUB_ORDER = ["project", "aiMedia", "quality", "integrations"] as const
type SettingsHub = (typeof HUB_ORDER)[number]

const SETTINGS_FOCUS_TARGETS: Record<string, { elementId: string; block: ScrollLogicalPosition }> = {
  languages: { elementId: "section-languages", block: "start" },
  "add-lane": { elementId: "add-lane-field", block: "nearest" },
}

/**
 * AQU-2262: every setting saves the moment it changes, says so quietly beside
 * itself, and is one step in the app's Undo. The status of each setting lives
 * in a provider around the page.
 */
export function ProjectSettings(props: ProjectSettingsProps = {}) {
  return (
    <SaveStatusProvider>
      <ProjectSettingsPage {...props} />
    </SaveStatusProvider>
  )
}

function ProjectSettingsPage({ modal = false }: ProjectSettingsProps) {
  const t = useT()
  const { id, section: sectionParam } = useParams<{ id: string; section?: string }>()
  const navigate = useNavigate()
  const location = useLocation()
  const [searchParams] = useSearchParams()
  const modalState = location.state as {
    backgroundLocation?: Location
    projectSettingsModalDepth?: number
    projectSnapshot?: ProjectRecord
  } | null
  const backgroundLocation = modal ? modalState?.backgroundLocation : undefined
  const modalDepth = modal ? (modalState?.projectSettingsModalDepth ?? 1) : 0
  const nextModalState = backgroundLocation
    ? { backgroundLocation, projectSettingsModalDepth: modalDepth + 1 }
    : undefined
  const { project, loading, refresh } = useProject(id!, {
    initialProject: modal ? modalState?.projectSnapshot : undefined,
    // This page owns the editable settings hook below. Asking useProject for
    // its read-only overlay as well creates a second settings request.
    includeSettings: false,
  })

  // Workspace handoff (`?return=…`) — only accept same-origin relative paths.
  // The Editor breadcrumb is only for this handoff (settings opened from /editor).
  const returnTo = safeReturnPath(searchParams.get("return"))
  const fromEditor = Boolean(id && returnTo && isProjectEditorPath(returnTo, id))
  const editorPath = fromEditor && returnTo ? returnTo : `/project/${id}/editor`
  const settingsHref = (section?: string) =>
    withSettingsReturn(projectSettingsPath(id!, section), fromEditor ? returnTo : null)

  // Declared ahead of useProjectSettings so the hydration event can carry the
  // viewer's org role (AQU-1274). No conditional return sits between these
  // calls, so hook order is unchanged.
  const activeOrg = useActiveOrgOptional()
  const roleTelemetry = useMemo(
    () => ({
      orgRole: activeOrg?.activeOrg?.role?.level ?? null,
      resolvedRole: project?.syncRole?.level ?? null,
      resolvedFrom: project?.syncRole?.source ?? null,
    }),
    [
      activeOrg?.activeOrg?.role?.level,
      project?.syncRole?.level,
      project?.syncRole?.source,
    ],
  )

  const {
    canEdit: canEditShared,
    reasonCannotEdit,
    canEditLanguages,
    reasonCannotEditLanguages,
    canEditCountStructural,
    reasonCannotEditCountStructural,
    languageEditFloor,
    patch: patchShared,
    version: sharedVersion,
    updatedAt: sharedUpdatedAt,
    updatedBy: sharedUpdatedBy,
    hasFetched: sharedSettingsFetched,
    settings: sharedSettingsBlob,
    lanes: sharedLanes,
    refreshAfterWrite: refreshSharedSettingsAfterWrite,
    // AQU-1083: what "Organization default" currently resolves to, from the
    // same response as the value it is the fallback for.
    orgCountStructuralCells,
    // AQU-1771: what "Organization default" means for the two counts.
    orgValidationCount,
    orgValidationCountAudio,
    // AQU-1771: the rest of the org policy, carried for this project.
    orgPolicy: carriedOrgPolicy,
    visibilityFloors: carriedVisibilityFloors,
    // AQU-1768: what "Organization default" means for the media settings.
    // Defaulted for callers (and test doubles) that predate the field.
    orgMediaDefaults = NO_ORG_MEDIA_DEFAULTS,
  } = useProjectSettings(id ?? null, project?.syncRole?.level ?? null, {
    // AQU-1086: the org's language-edit floor rides on the project record, so
    // the language fields below can be enabled for a project lead when the org
    // opted in — without loosening the maintainer floor on anything else.
    languageEditMinRole: project?.languageEditMinRole,
    roleTelemetry,
  })

  const inheritedConfig = useMemo(
    () => parseInheritedFromLink(sharedSettingsBlob?.inheritedFromLink),
    [sharedSettingsBlob],
  )
  const inheritedUpstreamName = useUpstreamProjectName(project?.sourceProjectId ?? null)
  const detachInherited = useCallback(
    (field: InheritFieldId) => {
      if (!inheritedConfig) return
      void patchShared({
        inheritedFromLink: {
          ...inheritedConfig,
          receive: { ...inheritedConfig.receive, [field]: false },
          detached: { ...inheritedConfig.detached, [field]: true },
        },
      })
    },
    [inheritedConfig, patchShared],
  )

  // Org context for the termbase-sharing section. The user's org; the section's
  // server calls re-validate org-membership / org-ownership, so a mismatch just
  // yields graceful empty/403 states.
  const { org } = useOrg()
  const { session } = useFrontierSession()
  const isCloudProject = !!(project?.syncRole)
  // AQU-485: Members is a privacy-gated settings pane. Hide it entirely for
  // callers below rosterViewMinRole — no "Roster hidden" disclosure, no nav
  // row. Local (unsynced) projects have no org floor, so the pane stays.
  //
  // AQU-1771: the floor is the one THIS project enforces — its org's, or its
  // own when stricter — and comes with the project's settings, so a member
  // outside the org gets the org's real values rather than built-in defaults.
  const rosterOrgId = project?.orgId ?? activeOrg?.activeOrgId ?? null
  const orgSettingsForProject = useOrgSettings(
    rosterOrgId,
    activeOrg?.activeOrg?.role?.level,
    project?.syncRole?.level ?? null,
  )
  const projectPolicy = resolveProjectPolicy({
    orgPolicy: carriedOrgPolicy,
    visibilityFloors: carriedVisibilityFloors,
    projectSettings: sharedSettingsBlob,
    org: orgSettingsForProject,
    roleLevel: project?.syncRole?.level ?? null,
    // A synced project's own stricter floor arrives with its settings.
    projectSettingsFetched: !isCloudProject || sharedSettingsFetched,
  })
  const orgAutoPropagateRepetitions = projectPolicy.autoPropagateRepetitions
  const canViewRoster =
    projectPolicy.ready
    && (project?.syncRole?.level ?? 0) >= projectPolicy.rosterViewMinRole.effective
  const canSeeMembers = !isCloudProject || canViewRoster
  const [privilegedOpen, setPrivilegedOpen] = useState(false)
  // project.files is a fresh array each render; key on the file ids. The key is
  // computed here because a dependency list entry has to be a simple expression
  // (react-hooks/use-memo).
  const metricsFilesKey = (project?.files ?? []).map((f) => f.id).join(",")
  const metricsFiles = useMemo(
    () => (project?.files ?? []).map((f) => ({ id: f.id, name: f.name })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [metricsFilesKey],
  )
  const getJwt = useCallback(() => session?.jwt ?? null, [session?.jwt])

  // AQU-1816: the lane-row endpoints write around `patchShared`, which is the
  // only path that told the page behind this modal (overview, workspace) that
  // the settings row moved — so a lane added here stayed invisible behind the
  // dialog until a reload (the AQU-1570 shape, for lanes). Every lane write
  // below re-reads through `refreshSharedSettingsAfterWrite`, which broadcasts
  // first and then refreshes this instance.
  //
  // AQU-1592: the languages screen sends the identity fields the user touched —
  // the language, or a nullable name/code override. A null clears an override
  // rather than writing a derived value back.
  const renameLane = useCallback(async (
    laneId: string,
    edit: { name?: string | null; language?: string; code?: string | null },
  ) => {
    const jwt = session?.jwt
    if (!jwt || !id) return "invalid" as const
    const result = await renameProjectLane(jwt, id, laneId, edit)
    if (result.kind === "ok") {
      await refreshSharedSettingsAfterWrite()
      return "ok" as const
    }
    if (result.kind === "duplicate") return "duplicate" as const
    if (result.kind === "malformed_code") return "malformed_code" as const
    return "invalid" as const
  }, [session?.jwt, id, refreshSharedSettingsAfterWrite])

  const createLane = useCallback(async (
    input: {
      name: string
      language: string
      code?: string | null
      /** AQU-1784: the section already warned about the duplicate inline. */
      allowDuplicateName?: boolean
      /** Media redesign: the add form's Delivers choice. */
      delivers?: LaneDelivers
    },
  ) => {
    const jwt = session?.jwt
    if (!jwt || !id) return "invalid" as const
    const result = await createProjectLane(jwt, id, input)
    if (result.kind === "ok") {
      await refreshSharedSettingsAfterWrite()
      return "ok" as const
    }
    if (result.kind === "duplicate") return "duplicate" as const
    if (result.kind === "malformed_code") return "malformed_code" as const
    return "invalid" as const
  }, [session?.jwt, id, refreshSharedSettingsAfterWrite])

  // Media redesign slice 1: the "Delivers" choice on one language row.
  const setLaneDelivers = useCallback(async (laneId: string, delivers: LaneDelivers): Promise<LaneDeliversOutcome> => {
    const jwt = session?.jwt
    if (!jwt || !id) return "error"
    const result = await setProjectLaneDelivers(jwt, id, laneId, delivers)
    if (result.kind === "forbidden") return "forbidden"
    if (result.kind !== "ok") {
      return typeof navigator !== "undefined" && navigator.onLine === false ? "offline" : "error"
    }
    await refreshSharedSettingsAfterWrite()
    return "ok"
  }, [session?.jwt, id, refreshSharedSettingsAfterWrite])

  const setLaneArchived = useCallback(async (laneId: string, archived: boolean) => {
    const jwt = session?.jwt
    if (!jwt || !id) return false
    const result = await setProjectLaneArchived(jwt, id, laneId, archived)
    if (result.kind !== "ok") return false
    await refreshSharedSettingsAfterWrite()
    return true
  }, [session?.jwt, id, refreshSharedSettingsAfterWrite])

  // AQU-1464: the archive confirmation asks when the lane was last translated in.
  // No session or project id means we genuinely cannot answer — report that as an
  // error so the dialog says "unavailable" instead of implying the lane is idle.
  const loadLaneLastChange = useCallback(
    async (laneId: string): Promise<LaneLastChangeResult> => {
      const jwt = session?.jwt
      if (!jwt || !id) return { kind: "error", message: "no session" }
      return fetchLaneLastChange(jwt, id, laneId)
    },
    [session?.jwt, id],
  )
  const {
    metrics: postEditMetrics,
    isLoading: metricsLoading,
    isError: metricsError,
    revalidate: revalidateMetrics,
  } = usePostEditMetrics({
    projectId: isCloudProject ? (id ?? null) : null,
    files: metricsFiles,
    getJwt,
    enabled: isCloudProject && !!id,
  })

  // AQU-478: file-scoped sync-token minter for the Upstream-changes panel
  // (mirrors ProjectWorkspace's getTokenForFile — per-file JWTs, cached).
  const getTokenForUpstreamPanel = useMemo(
    () => buildFileScopedTokenFetcher(getJwt, id ?? "", {}),
    [getJwt, id],
  )

  // Server enforces MAINTAINER (600) for settings writes. AQU-2260: a card
  // locked as a whole says so once under its heading; a single locked control
  // says so beneath it — never on hover.
  const privilegedRole = resolveRoleName(t, ROLE.MAINTAINER, { plural: true })
  const roleLockHint = (
    <PermissionLockHint
      role={privilegedRole}
      onView={id ? () => setPrivilegedOpen(true) : undefined}
      href={id ? undefined : PERMISSION_DOCS_URL}
      linkLabel={
        id
          ? t("projectSettings.permission.viewPrivilegedMembers", {
              role: privilegedRole,
            })
          : t("error.permissionDenied.learnMore")
      }
    />
  )
  const sharedDisabledTooltip =
    reasonCannotEdit === "offline" ? t("projectSettings.permission.reconnectToEdit")
    : reasonCannotEdit === "role" ? roleLockHint
    : null
  // AQU-2259: the AI cards are shared now, so a locked one says why once, at
  // its top, rather than on a hover over each of its fourteen controls.
  const sharedLockedLine = canEditShared ? null
    : reasonCannotEdit === "offline" ? t("projectSettings.permission.reconnectToEdit")
    : t("projectSettings.permission.onlyRoleCanModify", { role: privilegedRole })

  // AQU-1086: the language fields sit behind the org's configurable
  // languageEditMinRole, so their lock hint must name the role the user
  // actually needs (Project lead when the org lowered the floor, Maintainer by
  // default) rather than a hardcoded Maintainer — the AQU-427 convention.
  const languagePrivilegedRole = resolveRoleName(t, languageEditFloor, { plural: true })
  const languageRoleLockHint = (
    <PermissionLockHint
      role={languagePrivilegedRole}
      onView={id ? () => setPrivilegedOpen(true) : undefined}
      href={id ? undefined : PERMISSION_DOCS_URL}
      linkLabel={
        id
          ? t("projectSettings.permission.viewPrivilegedMembers", {
              role: languagePrivilegedRole,
            })
          : t("error.permissionDenied.learnMore")
      }
    />
  )
  const languageDisabledTooltip =
    reasonCannotEditLanguages === "offline" ? t("projectSettings.permission.reconnectToEdit")
    : reasonCannotEditLanguages === "role" ? languageRoleLockHint
    : null

  // AQU-1912: "Count headings" is a project-lead setting (AQU-1083), so its
  // lock hint names Project leads, not the page-wide Maintainer floor.
  const structuralPrivilegedRole = resolveRoleName(t, ROLE.PROJECT_LEAD, { plural: true })
  const structuralRoleLockHint = (
    <PermissionLockHint
      role={structuralPrivilegedRole}
      onView={id ? () => setPrivilegedOpen(true) : undefined}
      href={id ? undefined : PERMISSION_DOCS_URL}
      linkLabel={
        id
          ? t("projectSettings.permission.viewPrivilegedMembers", {
              role: structuralPrivilegedRole,
            })
          : t("error.permissionDenied.learnMore")
      }
    />
  )
  const structuralDisabledTooltip =
    reasonCannotEditCountStructural === "offline" ? t("projectSettings.permission.reconnectToEdit")
    : reasonCannotEditCountStructural === "role" ? structuralRoleLockHint
    : null

  // AQU-765: renaming a synced project now persists to the server rename
  // endpoint (maintainer+). Local (unsynced) projects keep their name editable
  // — their IDB record is the source of truth. For a cloud project below the
  // maintainer floor the field is disabled with an explanatory tooltip (the
  // AQU-427 convention), not left editable to write a silent local-only no-op.
  const projectRoleLevel = project?.syncRole?.level ?? null
  const canRenameProject =
    !isCloudProject || (projectRoleLevel != null && projectRoleLevel >= ROLE.MAINTAINER)
  const renameDisabledTooltip = canRenameProject ? null : roleLockHint

  // AQU-2262: no draft and no Save bar. Every control shows the SAVED value
  // and saves the moment it changes (a typing field when you pause or leave
  // it). The shared settings come from this page's settings hook, optimistic
  // overlay included, laid over this browser's copy of the project, which
  // holds the settings kept on this device. Before this page's settings GET
  // lands, the shared values shown are defaults, so nothing changes from them.
  const showsShared = sharedSettingsFetched || !isCloudProject
  const live = useMemo(
    () => readSavedSettings(
      project
        ? (showsShared ? overlaySettings(project, sharedSettingsBlob ?? {}) : project)
        : ({ name: "" } as ProjectRecord),
    ),
    [project, showsShared, sharedSettingsBlob],
  )
  const canChangeShared = canEditShared && showsShared
  const {
    name, provider, endpoint, apiKey, model, maxTokens, temperature,
    top_k: topK, contextSize, fewShotExampleFormat,
    main_chat_language: mainChatLanguage, completionBatchSize, validationBatchSize,
    autoSyncEnabled, autoSyncInterval, validationCount, validationCountAudio,
    validationRoleFloor, validationNamedUsers, allowSelfValidation,
    validationRoleFloorAudio, validationNamedUsersAudio, allowSelfValidationAudio,
    cellEditingFloor, allowTrackEditing, filmAndSources, timingLocked, harmonize_min_role: harmonizeMinRole,
    bibleResourcesEnabled, bibleEnrichments, decaySettings, audioMediaStrategy, geminiApiKey,
    precedingTargetCells, importExcludeFrontMatter, importCellUnit, smartQuotes, termMatching,
  } = live
  // Sam, Oct 28: an (i) opens its explanation beneath the setting's title.
  const [filmInfoOpen, toggleFilmInfo] = useInfoOpen()
  // AQU-1768: the value in force for each — the project's own, else the
  // organization's default, else the built-in one. What the disabled control
  // shows while the project follows the organization, and where "Set for this
  // project" starts from.
  const effectiveTimingLocked = resolveTimingLocked({ timingLocked: timingLocked ?? orgMediaDefaults.timingLocked })
  // AQU-2214: the built-in default is ON — the project's own choice first, then
  // the organization's, then on.
  const effectiveAllowTrackEditing = allowTrackEditing ?? orgMediaDefaults.allowTrackEditing ?? true
  const effectiveCellEditingFloor: CellEditingTier = cellEditingFloor ?? orgMediaDefaults.cellEditingFloor ?? "none"
  // Pre-merge round: the Media timeline's timing mode moved OUT of Project
  // Settings — it is FILE-level now (file.timing.set), controlled from the
  // timeline toolbar with the same maintainer floor.

  // ── Saving as you change ─────────────────────────────────────────────
  // Each change is one Undo step in the person's history for this project
  // ("Change: <setting>"), and says how it went beside the setting.
  const historyUser = authorNameFor(session?.username, project?.username)
  const commit = useSettingsCommit({
    projectId: id ?? null,
    project: project ?? null,
    onRenamed: refresh,
    username: historyUser,
    isCloudProject,
    settings: sharedSettingsBlob ?? {},
    patch: patchShared,
    getJwt,
    t,
  })
  const setShared = (key: string, value: unknown) =>
    void commit.shared(key, sharedSettingLabel(key), [{ key, value }])
  const setDrafting = (field: DraftingField, value: unknown, typed?: CommitInfo<unknown>) => {
    void commit.shared(`draftingSettings.${field}`, DRAFTING_FIELD_LABELS[field], [{ key: "draftingSettings", field, value }], typed)
    // The workspace's "pick a provider" prompt stops asking once the team's
    // drafting settings were set here, as a Save used to tell it.
    if (id) void patchProject(id, (p) => (p.aiProviderChosen ? p : { ...p, aiProviderChosen: true }))
  }
  const setDevice = (key: DeviceSettingKey, value: unknown, typed?: CommitInfo<unknown>) =>
    void commit.device(key, DEVICE_SETTING_LABELS[key], key, value, typed)
  const setSyncSettings = (enabled: boolean, intervalMinutes: number, typed?: CommitInfo<unknown>) =>
    setDevice("syncSettings", { autoSync: { enabled, intervalMinutes: Math.max(1, intervalMinutes) } }, typed)
  // The temperature while its slider is dragged; it saves when let go.
  const [draggedTemperature, setDraggedTemperature] = useState<number | null>(null)

  // The history: this page records steps, and when it is open on its own (no
  // workspace behind it) it hosts the project's history, so Undo, the History
  // panel and Cmd/Ctrl+Z work here. Over the workspace this changes nothing.
  const historyJwtRef = useRef<string | null>(null)
  historyJwtRef.current = session?.jwt ?? null
  useEffect(() => {
    if (!id) return
    return holdHistoryScope(id, historyUser, () => httpHistoryRemote(() => historyJwtRef.current))
  }, [id, historyUser])
  useSettingsStepKinds(id ?? null, { project, onRenamed: refresh })
  const reportHistory = useHistoryReporter()
  useHistoryShortcuts(reportHistory)

  // Per-device user-scoped key — not part of the project record, not server-
  // synced, no race with the project save flow.
  const completionUserKey = useUserApiKey("completion") ?? ""
  const geminiUserKey = useUserApiKey("gemini-tts") ?? ""

  // AQU-2263: which key drafts and voices use right now — from what is SAVED,
  // the Preferences override and this browser's own keys.
  const providerOverride = useUserProviderOverride()
  const completionInUse = completionKeyInUse({
    settings: { provider, endpoint, apiKey },
    override: providerOverride,
    personalKey: completionUserKey,
  })
  const geminiInUse = geminiKeyInUse({
    projectKey: geminiApiKey,
    personalKey: geminiUserKey,
    orgHasKey: Boolean(orgSettingsForProject.orgProviderKeys?.["gemini-tts"]),
  })

  // The project's AI keys stay on this device and are never an Undo step:
  // every step is saved to the server, and a key never leaves the browser.
  const saveCompletionKey = (next: string) => {
    if (next === apiKey) return
    void commit.secret("apiKey", (p) => ({
      ...p,
      completionSettings: buildCompletionSettings(p.completionSettings, { apiKey: next || undefined }),
      aiProviderChosen: true,
    }))
  }
  const saveGeminiKey = (next: string) => {
    if (next === geminiApiKey) return
    void commit.secret("geminiApiKey", (p) => ({ ...p, ttsSettings: { ...p.ttsSettings, apiKey: next || undefined } }))
  }

  const [presetId, setPresetId] = useState<string>(() => presetIdForEndpoint(endpoint))
  const [models, setModels] = useState<string[]>([])
  const [connecting, setConnecting] = useState(false)
  const [connectionError, setConnectionError] = useState<string | null>(null)
  const [connected, setConnected] = useState(false)
  const lastModelFetchKeyRef = useRef<string | null>(null)
  // A new endpoint (typed here, or saved by someone else) is not connected yet,
  // and the preset picker follows it.
  const seenEndpointRef = useRef(endpoint)
  useEffect(() => {
    if (seenEndpointRef.current === endpoint) return
    seenEndpointRef.current = endpoint
    setPresetId(presetIdForEndpoint(endpoint))
    setConnected(false)
    setConnectionError(null)
    setModels([])
    lastModelFetchKeyRef.current = null
  }, [endpoint])

  const effectiveCompletionApiKey = apiKey.trim() || completionUserKey.trim()

  const loadModels = useCallback(async (opts: { force?: boolean } = {}) => {
    const trimmedEndpoint = endpoint.trim()
    if (!trimmedEndpoint) return
    const fetchKey = `${trimmedEndpoint}::${effectiveCompletionApiKey ? "auth" : "no-auth"}`
    if (!opts.force && lastModelFetchKeyRef.current === fetchKey) return
    lastModelFetchKeyRef.current = fetchKey
    setConnecting(true)
    setConnectionError(null)
    try {
      const list = await fetchModels(trimmedEndpoint, effectiveCompletionApiKey || undefined)
      if (lastModelFetchKeyRef.current !== fetchKey) return
      setModels(list)
      setConnected(true)
      // Connect is the moment the person believes BYOK is ready: the
      // workspace's "pick a provider" prompt stops asking. AQU-2259: the
      // provider, endpoint and model are the team's settings, so Connect never
      // changes them — the model is picked from the list, which saves it.
      if (id && provider === "custom" && apiKey.trim()) {
        await patchProject(id, (p) => (p.aiProviderChosen ? p : { ...p, aiProviderChosen: true }))
      }
    } catch (err) {
      if (lastModelFetchKeyRef.current !== fetchKey) return
      setModels([])
      setConnected(false)
      setConnectionError(err instanceof Error ? err.message : "Connection failed")
    } finally {
      if (lastModelFetchKeyRef.current === fetchKey) setConnecting(false)
    }
  }, [apiKey, effectiveCompletionApiKey, endpoint, id, provider])

  // Nothing waits to be saved, so leaving needs no "discard changes?" prompt.
  // A typing field being edited saves as it loses focus.
  const requestNavigate = navigate
  const closeSettings = useCallback(() => {
    if (modal) navigate(-modalDepth)
    else navigate(editorPath)
  }, [editorPath, modal, modalDepth, navigate])
  const requestHistoryNavigation = useCallback((delta: number) => navigate(delta), [navigate])

  const preset = CUSTOM_PRESETS.find((p) => p.id === presetId) ?? CUSTOM_PRESETS[0]

  async function handleConnect() {
    if (!endpoint.trim()) {
      setConnectionError("Endpoint URL is required")
      return
    }
    await loadModels({ force: true })
  }

  function handlePresetChange(nextPresetId: string) {
    setPresetId(nextPresetId)
    const preset = CUSTOM_PRESETS.find((p) => p.id === nextPresetId)
    if (!preset) return
    const nextEndpoint = endpointForPresetChange(nextPresetId, endpoint)
    if (nextEndpoint !== endpoint) {
      // The picker keeps what was picked ("Other…" with an empty endpoint).
      seenEndpointRef.current = nextEndpoint
      setDrafting("endpoint", nextEndpoint)
    }
    setConnected(false)
    setConnectionError(null)
    setModels([])
    lastModelFetchKeyRef.current = null
  }

  useEffect(() => {
    if (provider !== "custom") return
    if (!endpoint.trim()) return
    if (preset.requiresKey && !effectiveCompletionApiKey) return
    const timer = window.setTimeout(() => void loadModels(), 350)
    return () => window.clearTimeout(timer)
  }, [effectiveCompletionApiKey, endpoint, loadModels, preset.requiresKey, provider])

  // ── Settings sections definition ──────────────────────────────────────────
  const hasGitOrigin = project?.origin?.kind === "git"
  const hasSourceLink = typeof project?.sourceProjectId === "string" && !!project.sourceProjectId

  // AQU-478: only meaningful for a LIVE link (a clone never drifts from its
  // upstream — see the mirror-sync short-circuit in stale-source-route.ts).
  const hasLiveSourceLink = hasSourceLink && project?.sourceLinkMode !== "clone"

  // DCS importer: a self-contained adapter project (pinned to a Door43 release
  // via project_settings.dcsUpstream) is not a downstream link, so it never
  // shows SourceLinkSection. Surface the Door43 upstream panel directly here.
  // Rendered only when NOT a downstream link — a downstream that also carries a
  // dcsUpstream cursor already gets the panel embedded in SourceLinkSection, so
  // this guard prevents a double mount.
  const hasDcsUpstream = !hasSourceLink && !!readCursor((sharedSettingsBlob ?? {}) as Record<string, unknown>)

  // AQU-1685: the card is "Bible data", with its enrichment rows, only while
  // this device has the Bible data experiment on; otherwise it is the old
  // "Bible resources" card, findable by its old keywords.
  const bibleDataExperiment = isBibleDataExperimentOn(project)

  const ALL_SECTIONS: SettingsSection[] = [
    // AQU-1525: the counterpart of section-source-link — exactly one of the two
    // is ever visible, keyed off whether this project already has an upstream.
    { id: "section-link-source", label: t("projectSettings.section.sourceLink"), keywords: ["source", "link", "linked", "upstream", "attach", "share source", "mirror"], visible: !hasSourceLink },
    { id: "section-source-link", label: t("projectSettings.section.sourceLink"), keywords: ["source", "linked", "upstream", "detach"], visible: hasSourceLink },
    { id: "section-inherited-settings", label: t("projectSettings.inherit.title", { upstream: inheritedUpstreamName ?? project?.sourceProjectId ?? "" }), keywords: ["settings from", "inherited settings", "inherit", "copy", "brief", "knowledge", "workflow", "detach", "upstream"], visible: hasSourceLink },
    { id: "section-upstream-changes", label: t("projectSettings.section.upstreamChanges"), keywords: ["upstream", "changes", "repin", "review", "mirror", "stale"], visible: hasLiveSourceLink },
    { id: "section-dcs-upstream", label: t("projectSettings.section.dcsUpstream"), keywords: ["door43", "dcs", "unfoldingword", "upstream", "check for updates", "import changes", "release"], visible: hasDcsUpstream },
    { id: "section-project-info", label: t("projectSettings.section.projectInfo"), keywords: ["name", "source language", "target language", "smart quotes", "curly quotes", "quotation marks", "typography"] },
    // AQU-1688: the Language profile for checks lives here too, while this
    // device has the Bible data experiment on (AQU-1685).
    {
      id: "section-languages",
      label: t("projectSettings.section.languages"),
      keywords: [
        "languages", "language lanes", "language lane", "target lanes", "lane", "target language", "dialect",
        ...(bibleDataExperiment ? ["language profile", "quotation marks", "quote marks", "bible data checks"] : []),
      ],
    },
    // AQU-1686: "translation notes" stays. It used to mislead (this card did
    // not control the Translation Notes sidebar, and still does not), but the
    // card now holds the Translation helps enrichment, which shows
    // unfoldingWord's Translation Notes. "bible resources" keeps the old name
    // findable.
    bibleDataExperiment
      ? {
          id: "section-bible-resources",
          label: t("bibleData.card.title"),
          keywords: [
            "bible data", "bible resources", "aquifer", "bibletranslation", "reference", "scholarly",
            "enrichments", "voices", "who's who", "passage structure", "original language", "greek",
            "hebrew", "translation helps", "translation notes", "translation questions", "key terms",
            "places", "maps", "checks", "macula", "opentext", "acai", "unfoldingword", "data sources", "license",
          ],
        }
      : { id: "section-bible-resources", label: t("bibleData.card.title"), keywords: ["bible resources", "aquifer", "bibletranslation", "reference", "scholarly", "translation notes"] },
    { id: "section-import", label: t("projectSettings.section.import"), keywords: ["import", "usfm", "front matter", "book title", "book name", "introduction", "toc", "running header", "paratext", "door43"] },
    // AQU-2259: only the "this setting moved" note is left here, until it expires.
    { id: "section-user", label: t("projectSettings.section.user"), keywords: ["username", "author"], visible: settingMovedNotesShowing() },
    { id: "section-members", label: t("projectSettings.section.members"), keywords: ["members", "invite", "invite link", "link", "join", "share", "access", "role", "roster", "collaborator", "member list", "progress", "visibility", "who can see"], visible: canSeeMembers },
    // AQU-1068: a permission, so it lives with the roles rather than in the
    // Timeline card it grew out of — it governs ordinary text files now, not
    // just the timeline's silences.
    { id: "section-cell-editing", label: t("projectSettings.cellEditing.sectionTitle"), keywords: ["add cell", "remove cell", "insert", "delete", "structure", "verse", "line", "row", "restructure", "permission", "role"] },
    // AQU-1672: the brief gates Autopilot starts (AQU-827) but had no entry of
    // its own anywhere in settings — it was reachable only by opening Living
    // Memory's Instructions pane and clicking the breadcrumb back up to the
    // index. Its own section id gives it a row in the AI & completion pane AND
    // makes a search for "brief" land on it.
    { id: "section-brief", label: t("autopilot.readiness.brief.label"), keywords: ["brief", "translation brief", "skopos", "purpose", "audience", "register", "literalness", "style guide", "living memory"] },
    { id: "section-ai-instructions", label: t("projectSettings.section.aiInstructions"), keywords: ["ai", "llm", "instructions", "batch size", "completions batch", "validation batch", "batch validate", "top_k", "examples", "context window", "assistant language", "few shot", "ai drafting", "drafting", "ai instructions"] },
    { id: "section-draft-context", label: t("projectSettings.section.draftContext"), keywords: ["draft context", "preceding cells", "left context", "paragraph drafting", "context budget"] },
    { id: "section-advanced-llm", label: t("projectSettings.section.advancedLlm"), keywords: ["provider", "endpoint", "api key", "model", "ai model", "advanced", "llm", "temperature", "max tokens", "health penalty", "frontier", "openai", "custom"] },
    // AQU-1758: the Voice Studio is the Voices tab now; its old name still finds it.
    { id: "section-voice", label: t("projectSettings.section.voice"), keywords: ["tts", "voices", "cast", "voice studio", "audio", "gemini", "api key", "tts key"] },
    { id: "section-local-models", label: t("projectSettings.section.localModels"), keywords: ["whisper", "mms", "transcription", "model", "download", "offline", "local ai", "local models", "on-device"] },
    { id: "section-validation", label: t("projectSettings.section.validation"), keywords: ["validation count", "approvals", "audio validation"] },
    { id: "section-decay", label: t("projectSettings.decay.summary"), keywords: ["health", "decay", "decay threshold", "half life", "retrieval support", "max hops", "attention threshold"] },
    { id: "section-audio-media", label: t("projectSettings.section.audioMedia"), keywords: ["audio loading", "media", "audio media", "lazy", "eager", "stream"] },
    { id: "section-timeline", label: t("editor.timeline.title"), keywords: ["timeline", "add line", "create cell", "silence", "dubbing", "lines", "track", "tracks", "multi-track", "folder", "colour", "color", "film", "video", "sources"] },
    { id: "section-git-sync", label: t("projectSettings.section.gitSync"), keywords: ["git", "sync", "auto sync", "interval", "branch", "clone"], visible: hasGitOrigin },
    // AQU-1272: the affix inventory and fold defaults live in this section, so
    // the words a user searches for them by have to reach it.
    { id: "section-terminology", label: t("projectSettings.section.terminology"), keywords: ["terminology", "termbase", "glossary", "concepts", "matching", "prefix", "prefixes", "suffix", "suffixes", "affix", "affixes", "marks", "vowel points", "forms"] },
    { id: "section-termbase-sharing", label: t("projectSettings.section.termbaseSharing"), keywords: ["term base", "termbase", "publish", "subscribe", "org", "shared", "glossary"], visible: SHOW_TERMBASE_SHARING_IN_SETTINGS },
    { id: "section-ai-metrics", label: t("projectSettings.section.aiMetrics"), keywords: ["post-edit", "edit distance", "ai metrics", "magnitude", "levenshtein", "ned", "biblica"] },
    // Monday.com board sync — cloud (synced) projects only: the link lives on
    // the server against the project's org connection.
    { id: "section-monday", label: t("projectSettings.section.monday"), keywords: ["monday", "integration", "board", "push", "progress sync", "project management"], visible: isCloudProject },
    // AQU-804: Airtable table sync, the same shape (and the same cloud-only rule).
    { id: "section-airtable", label: t("projectSettings.section.airtable"), keywords: ["airtable", "integration", "table", "base", "push", "progress sync", "episodes", "project management"], visible: isCloudProject },
    { id: "section-experimental", label: t("projectSettings.section.experimental"), keywords: ["experimental", "flags", "beta", "preview", "contextual", "contextual drafting"] },
  ]

  // ── Search filter ──────────────────────────────────────────────────────────
  // AQU-522: the settings search is deep-linkable via `?q=<term>` so callers can
  // point a user straight at a buried section. The Gemini/TTS key lives in the
  // Voice section far down the page; "open audio setup" affordances navigate to
  // `…/settings?q=gemini`, which filters to the Voice card so the key entry is
  // visible immediately with nothing to hunt for or scroll past. Seeded once on
  // mount; the box stays user-editable/clearable afterward.
  const [searchQuery, setSearchQuery] = useState(() => searchParams.get("q") ?? "")
  const lowerQuery = searchQuery.trim().toLowerCase()

  // AQU-2031: `?focus=<target>` is the pane-mode counterpart of `?q=`. A caller
  // that wants one card reachable in one click deep-links to the card's GROUP
  // page (`…/settings/general?focus=languages`) and the card is scrolled into
  // view here. Unlike `?q=`, the page stays a pane — no search box, the group's
  // own title, only the group's cards — so the person does not land on what
  // looks like a search they never ran.
  const focusTarget = searchParams.get("focus")
  useEffect(() => {
    if (!focusTarget || loading) return
    const target = SETTINGS_FOCUS_TARGETS[focusTarget]
    if (!target) return
    document.getElementById(target.elementId)?.scrollIntoView?.({ block: target.block })
  }, [focusTarget, loading])
  const visibleSections = lowerQuery
    ? ALL_SECTIONS.filter(
        (s) =>
          s.visible !== false &&
          (s.label.toLowerCase().includes(lowerQuery) ||
            s.keywords?.some((k) => k.toLowerCase().includes(lowerQuery))),
      )
    : ALL_SECTIONS.filter((s) => s.visible !== false)

  // AQU-501: sub-menu IA — group the flat section list into labeled panes so
  // picking a sub-section shows only that pane, matching the org Settings
  // index → detail pattern. Pane identity lives in `/settings/:section`.
  // The settings index groups those panes into labeled NavLists (like org
  // settings / Preferences) with short right-aligned hints.
  const SETTINGS_GROUPS: {
    id: string
    label: string
    description: string
    icon: ComponentType<{ className?: string }>
    sectionIds: string[]
    /** Roster / DataTable panes use Page `wide` (max-w-6xl); form panes stay default. */
    wide?: boolean
    /** Which heading the settings index lists it under (HUB_LABEL). */
    hub: SettingsHub
    /** Omit from the settings index (still deep-linkable as a pane). */
    hideFromIndex?: boolean
    /** Parent group id when this is a nested detail pane (breadcrumb trail). */
    parentId?: string
  }[] = [
    {
      id: "general",
      label: t("common.general"),
      description: t("projectSettings.group.generalDescription"),
      icon: SlidersHorizontal,
      hub: "project",
      sectionIds: ["section-project-info", "section-languages", "section-cell-editing", "section-bible-resources", "section-import", "section-user"],
    },
    {
      id: "members",
      label: t("projectSettings.group.membersLabel"),
      description: t("projectSettings.group.membersDescription"),
      icon: Users,
      hub: "project",
      wide: true,
      sectionIds: ["section-members"],
    },
    {
      id: "source-sync",
      label: t("projectSettings.group.sourceSyncLabel"),
      description: t("projectSettings.group.sourceSyncDescription"),
      icon: Link2,
      hub: "project",
      sectionIds: [
        "section-link-source",
        "section-source-link",
        "section-inherited-settings",
        "section-upstream-changes",
        "section-dcs-upstream",
        "section-git-sync",
      ],
    },
    {
      id: "ai",
      label: t("projectSettings.group.aiLabel"),
      description: t("projectSettings.group.aiDescription"),
      icon: Sparkles,
      hub: "aiMedia",
      // The system prompt (and the rest of Living Memory) lives on the
      // standalone /project/:id/memory surface; this pane keeps a cross-link
      // NavRow to memory/instructions instead of a nested settings page.
      sectionIds: [
        "section-brief",
        "section-ai-instructions", "section-draft-context", "section-advanced-llm",
        "section-voice", "section-local-models", "section-terminology", "section-termbase-sharing",
      ],
    },
    {
      id: "validation",
      label: t("projectSettings.group.validationLabel"),
      description: t("projectSettings.group.validationDescription"),
      icon: ShieldCheck,
      hub: "quality",
      sectionIds: ["section-validation", "section-decay"],
    },
    {
      id: "audio-media",
      label: t("projectSettings.group.audioMediaLabel"),
      description: t("projectSettings.group.audioMediaDescription"),
      icon: AudioLines,
      hub: "aiMedia",
      sectionIds: ["section-audio-media", "section-timeline"],
    },
    {
      id: "metrics",
      label: t("projectSettings.group.metricsLabel"),
      description: t("projectSettings.group.metricsDescription"),
      icon: BarChart3,
      hub: "aiMedia",
      sectionIds: ["section-ai-metrics"],
    },
    {
      id: "integrations",
      label: t("projectSettings.group.integrationsLabel"),
      description: t("projectSettings.group.integrationsDescription"),
      icon: Plug,
      hub: "integrations",
      sectionIds: ["section-monday", "section-airtable"],
    },
    {
      id: "experimental",
      label: t("projectSettings.section.experimental"),
      description: t("projectSettings.group.experimentalDescription"),
      icon: FlaskConical,
      hub: "integrations",
      sectionIds: ["section-experimental"],
    },
  ]

  const HUB_LABEL: Record<SettingsHub, string> = {
    project: t("projectSettings.hub.project"),
    aiMedia: t("projectSettings.hub.aiMedia"),
    quality: t("projectSettings.hub.quality"),
    integrations: t("projectSettings.group.integrationsLabel"),
  }

  const visibleSectionIdSet = new Set(visibleSections.map((s) => s.id))
  const visibleGroups = SETTINGS_GROUPS
    .map((g) => ({ ...g, sectionIds: g.sectionIds.filter((id) => visibleSectionIdSet.has(id)) }))
    .filter((g) => g.sectionIds.length > 0)
  // Index lists only hub-level entries; a `hideFromIndex` pane stays
  // deep-linkable but is opened from a parent pane NavRow.
  const indexGroups = visibleGroups.filter((g) => !g.hideFromIndex)

  // AQU-2030: the back link, title, and save controls stay pinned at the top of
  // the pane while the form scrolls under them. Measuring the pinned block lets
  // the scroll port reserve that much `scroll-padding-top`, so tabbing to a
  // field below the fold scrolls it clear of the header instead of under it.
  const pinnedHeaderRef = useRef<HTMLDivElement | null>(null)
  const [pinnedHeaderHeight, setPinnedHeaderHeight] = useState(0)
  useEffect(() => {
    const el = pinnedHeaderRef.current
    if (!el) return
    const measure = () => setPinnedHeaderHeight(el.getBoundingClientRect().height)
    measure()
    if (typeof ResizeObserver === "undefined") return
    // The block grows and shrinks as the save controls appear with the dirty
    // state, so re-measure rather than reading it once on mount.
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [loading])

  // Living Memory extraction: `memory`, `rules`, and `system-prompt` moved out
  // of settings onto the standalone /project/:id/memory surface. Old section
  // ids redirect (replace) instead of falling back to the index so deep links
  // keep working — the server-sent `settings/memory` readiness href, and
  // RuleDrawer's `settings/rules?ruleId=…` — with query params carried along.
  // Returning here, before either shell renders, covers both the routed page
  // and the route-modal dialog.
  const movedSectionRedirects: Record<string, string> = id
    ? {
        memory: projectMemoryPath(id),
        rules: projectMemoryPath(id, "quality"),
        "system-prompt": projectMemoryPath(id, "instructions"),
      }
    : {}
  const movedSectionTarget = sectionParam ? movedSectionRedirects[sectionParam] : undefined
  if (movedSectionTarget) {
    return <Navigate to={`${movedSectionTarget}${location.search}`} replace />
  }

  // Navigation between the index and a pane uses `/settings/:section` —
  // deep-linkable and back-button friendly.
  const activeGroupId = sectionParam ?? null
  const activeGroup = visibleGroups.find((g) => g.id === activeGroupId) ?? null
  // An unknown/stale group id (e.g. its only section just became invisible)
  // falls back to the index instead of rendering an empty pane.
  const showIndex = !activeGroup || lowerQuery.length > 0

  // While searching, show matches across every group (the old flat-filter
  // behavior) rather than confining results to whichever pane is open.
  const sectionsToRender = lowerQuery
    ? visibleSections
    : activeGroup
      ? visibleSections.filter((s) => activeGroup.sectionIds.includes(s.id))
      : []

  // Search-only: place each main-section label above the first matching card
  // in that group (same labels as the index NavList). Non-search panes stay
  // flat — the PageHeader already names the active group.
  const searchGroupHeaderBefore = (() => {
    if (!lowerQuery) return new Map<string, string>()
    const shown = new Set(sectionsToRender.map((s) => s.id))
    // DOM render order of section cards (must stay in sync with JSX below).
    const renderOrder = [
      "section-link-source",
      "section-source-link",
      "section-upstream-changes",
      "section-dcs-upstream",
      "section-project-info",
      "section-languages",
      "section-bible-resources",
      "section-import",
      "section-user",
      "section-members",
      "section-ai-instructions",
      "section-draft-context",
      "section-advanced-llm",
      "section-voice",
      "section-local-models",
      "section-validation",
      "section-decay",
      "section-audio-media",
      "section-timeline",
      "section-git-sync",
      "section-terminology",
      "section-termbase-sharing",
      "section-monday",
      "section-airtable",
      "section-ai-metrics",
    ]
    const headers = new Map<string, string>()
    const claimedGroups = new Set<string>()
    for (const sectionId of renderOrder) {
      if (!shown.has(sectionId)) continue
      const group = visibleGroups.find((g) => g.sectionIds.includes(sectionId))
      if (!group || claimedGroups.has(group.id)) continue
      claimedGroups.add(group.id)
      // Nested panes that are hidden from the index still show their own title
      // rather than the parent hub name in search.
      headers.set(sectionId, group.label)
    }
    return headers
  })()

  const searchGroupLabel = (sectionId: string) => {
    const label = searchGroupHeaderBefore.get(sectionId)
    if (!label) return null
    return (
      <p className="px-1 font-heading text-lg font-semibold tracking-tight text-foreground">
        {label}
      </p>
    )
  }

  const pageTitle = lowerQuery || !activeGroup
    ? t("projectSettings.pageTitle")
    : activeGroup.label
  const pageDescription = lowerQuery || !activeGroup
    ? t("projectSettings.pageDescription")
    : activeGroup.description
  // Table panes (Members roster) need the wider content well; form panes stay
  // intentional/narrow. Search flattens across groups → keep default width.
  const pageSize = activeGroup?.wide && !lowerQuery ? "wide" : "default"
  const modalWidthClass = pageSize === "wide"
    ? "max-w-[min(72rem,calc(100%-2rem))] sm:max-w-[min(72rem,calc(100%-2rem))]"
    : "max-w-[min(42rem,calc(100%-2rem))] sm:max-w-[min(42rem,calc(100%-2rem))]"

  // Hints for index NavRows — short current-value summaries (org / Preferences pattern).
  const groupHints: Record<string, string> = {
    general: name.trim() || t("projectSettings.hint.untitled"),
    members: t("projectSettings.hint.rolesInvites"),
    "source-sync": hasSourceLink
      ? t("projectSettings.hint.linked")
      : hasGitOrigin ? t("projectSettings.hint.git") : t("common.none"),
    ai: provider === "frontier"
      ? t("projectSettings.advancedLlm.providerFrontierName")
      : t("projectSettings.hint.custom"),
    validation: resolveRoleName(t, validationRoleFloor),
    "audio-media": t(AUDIO_MEDIA_STRATEGY_LABELS[audioMediaStrategy].nameKey),
    metrics: t("projectSettings.hint.postEdit"),
    integrations: t("projectSettings.hint.integrations"),
  }

  // AQU-2262: where the Save bar was. Settings save as you change them; this
  // is the app's Undo, the same history the editor and Cmd/Ctrl+Z use. Its
  // buttons and History panel act only on settings steps (Sam, Oct 30);
  // Cmd/Ctrl+Z stays the project's newest step, whatever it changed.
  const headerActions = <HistoryControls onResult={reportHistory} match={isSettingsStep} />

  const onSettingsPane = Boolean(activeGroup && !lowerQuery)
  const showSearch = !onSettingsPane
  const breadcrumbParent =
    onSettingsPane && activeGroup?.parentId
      ? visibleGroups.find((g) => g.id === activeGroup.parentId) ?? null
      : null
  const breadcrumb = (
    <OrgBreadcrumb
      section={project?.name ?? "Project"}
      sectionTo={id ? `/projects/${id}` : undefined}
      orgId={project?.orgId}
      trail={[
        ...(fromEditor
          ? [{ label: t("projectSettings.breadcrumbEditor"), onClick: () => requestNavigate(editorPath) }]
          : []),
        onSettingsPane
          ? { label: t("projectSettings.backLinkLabel"), to: settingsHref() }
          : { label: t("projectSettings.backLinkLabel") },
        ...(breadcrumbParent
          ? [{ label: breadcrumbParent.label, to: settingsHref(breadcrumbParent.id) }]
          : []),
        ...(onSettingsPane && activeGroup ? [{ label: activeGroup.label }] : []),
      ]}
    />
  )

  if (loading) {
    const loadingContent = (
      <Page size={pageSize}>
        <LoadingPanel label={t("projectSettings.loadingLabel")} />
      </Page>
    )
    if (modal) {
      return (
        <Dialog open onOpenChange={(open) => { if (!open) closeSettings() }}>
          <DialogContent
            className={`h-[min(90dvh,56rem)] gap-0 p-0 ${modalWidthClass}`}
            data-testid="project-settings-dialog"
          >
            <DialogHeader className="sr-only">
              <DialogTitle>{pageTitle}</DialogTitle>
              <DialogDescription>{pageDescription}</DialogDescription>
            </DialogHeader>
            <DialogBody className="m-0 p-0">{loadingContent}</DialogBody>
          </DialogContent>
        </Dialog>
      )
    }
    return (
      <AppShell
        sidebar={<OrgSidebar />}
        header={breadcrumb}
        statusBar={null}
        main={loadingContent}
      />
    )
  }

  // Living Memory cross-link hint (Custom vs Default): the prompt itself is
  // edited on memory/instructions now, so read the saved value straight off
  // the project record — the same source the removed form baseline used.
  const savedSystemPrompt = project?.completionSettings?.systemPrompt || DEFAULT_SYSTEM_PROMPT

  // AQU-1672: the brief's derived status, as the row's right-aligned hint —
  // same three strings the Living Memory index shows, so the two surfaces can
  // never disagree about whether a brief exists. Read from the editable
  // settings hook first (it carries this page's optimistic overlay) and fall
  // back to the project record before that GET resolves, like the panes above.
  const briefHint = (() => {
    const brief = sharedSettingsBlob?.translationBrief ?? project?.translationBrief
    switch (briefStatus(brief)) {
      case "none":
        return t("terminology.livingMemory.section.brief.statusNone")
      case "draft":
        return t("terminology.livingMemory.section.brief.statusDraft")
      case "complete":
        return t("terminology.livingMemory.section.brief.statusComplete")
    }
  })()

  const settingsContent = (
    <Page
      size={pageSize}
      style={pinnedHeaderHeight ? { scrollPaddingTop: `${pinnedHeaderHeight}px` } : undefined}
    >
          {/*
            AQU-2030: the pinned block. `-mt-6 pt-6` and `pb-4` are an opaque
            bleed above and below the header — they keep an unscrolled pane
            laid out exactly as before (the content stack's `mt-8` + this
            `pb-4` restore the `gap-12` rhythm) while giving the pinned band
            breathing room once form content slides underneath it. The
            background is opaque, not translucent, so nothing shows through:
            `bg-popover` matches DialogContent in the modal, `bg-background`
            the AppShell card on the full-page route.
          */}
          <div
            ref={pinnedHeaderRef}
            data-slot="project-settings-pinned-header"
            className={`sticky top-0 z-20 -mt-6 pt-6 pb-4 ${modal ? "bg-popover" : "bg-background"}`}
          >
            {modal && onSettingsPane ? (
              <BackLink
                className="mb-6"
                label={breadcrumbParent?.label ?? t("editor.navTitle.projectSettings")}
                onClick={() => requestHistoryNavigation(-1)}
              />
            ) : null}
            <PageHeader
              title={pageTitle}
              description={pageDescription}
              actions={headerActions}
              inset={pageSize !== "wide"}
              className="mb-0"
            />
          </div>
          <div className="mt-8 flex flex-col gap-12">

            {/* Search lives on the index only (detail panes match org settings). */}
            {showSearch && (
              <SettingsNav onSearch={setSearchQuery} searchQuery={searchQuery} />
            )}

            {showIndex && !lowerQuery ? (
              <div className="flex flex-col gap-12">
                {HUB_ORDER.map((hub) => {
                  const rows = indexGroups.filter((g) => g.hub === hub)
                  if (rows.length === 0) return null
                  return (
                    <NavList key={hub} label={HUB_LABEL[hub]}>
                      {rows.map((g) => (
                        <NavRow
                          key={g.id}
                          to={settingsHref(g.id)}
                          state={nextModalState}
                          icon={g.icon}
                          title={g.label}
                          hint={groupHints[g.id] ?? g.description}
                        />
                      ))}
                    </NavList>
                  )
                })}
              </div>
            ) : null}

            {showIndex && lowerQuery && sectionsToRender.length === 0 ? (
              <p className="px-2 py-1.5 text-sm text-muted-foreground">{t("projectSettings.noMatchingSettings")}</p>
            ) : null}

        {searchGroupLabel("section-link-source")}
        {!hasSourceLink && sectionsToRender.some((s) => s.id === "section-link-source") && (
          <LinkSourceSection
            projectId={id!}
            onLinked={refresh}
            roleLevel={project?.syncRole?.level ?? null}
          />
        )}
        {searchGroupLabel("section-source-link")}
        {hasSourceLink && project?.sourceProjectId && sectionsToRender.some((s) => s.id === "section-source-link") && (
          <SourceLinkSection
            projectId={id!}
            sourceProjectId={project.sourceProjectId}
            sourceLinkMode={project.sourceLinkMode}
            sourceLinkConsumes={project.sourceLinkConsumes}
            sourceLinkGate={project.sourceLinkGate}
            sourceLinkCursor={project.sourceLinkCursor}
            sourceLinkFileIds={project.sourceLinkFileIds}
            sourceLinkUpstreamFileCount={project.sourceLinkUpstreamFileCount}
            onDetached={refresh}
            onSynced={refresh}
            onFilesAdded={refresh}
            roleLevel={project?.syncRole?.level ?? null}
          />
        )}
        {searchGroupLabel("section-inherited-settings")}
        {hasSourceLink && project?.sourceProjectId && sectionsToRender.some((s) => s.id === "section-inherited-settings") && (
          <div id="section-inherited-settings">
            <InheritedSettingsSection
              sourceProjectId={project.sourceProjectId}
              settings={sharedSettingsBlob}
              canEdit={canChangeShared}
              locked={sharedDisabledTooltip}
              onPatch={commit.recordedPatch()}
            />
          </div>
        )}
        {searchGroupLabel("section-upstream-changes")}
        {hasLiveSourceLink && sectionsToRender.some((s) => s.id === "section-upstream-changes") && (
          <UpstreamChangesPanel
            projectId={id!}
            files={project?.files ?? []}
            getToken={getTokenForUpstreamPanel}
            roleLevel={project?.syncRole?.level ?? null}
            username={session?.username ?? "local"}
          />
        )}
        {searchGroupLabel("section-dcs-upstream")}
        {hasDcsUpstream && sectionsToRender.some((s) => s.id === "section-dcs-upstream") && (
          <DcsUpstreamPanel projectId={id!} roleLevel={project?.syncRole?.level ?? null} />
        )}
        {searchGroupLabel("section-project-info")}
        {sectionsToRender.some((s) => s.id === "section-project-info") && (
          <div id="section-project-info">
            <SettingsGroup label={t("projectSettings.section.projectInfo")} locked={!canRenameProject ? sharedDisabledTooltip : null}>
              <SettingsRow
                saveId="name"
                label={<label htmlFor="pname">{t("projectSettings.info.titleLabel")}</label>}
                description={
                  sharedUpdatedAt && sharedVersion != null && sharedVersion > 0
                    ? lastEditedLine(
                        settingsEditorName(sharedUpdatedBy),
                        new Date(sharedUpdatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }),
                        t,
                      )
                    : t("projectSettings.shared.nameHint")
                }
                control={
                  <DisabledFieldTooltip
                    disabled={!canRenameProject}
                    tooltip={renameDisabledTooltip}
                  >
                    {/* AQU-2262: saves when you leave it or pause; an empty
                        name is never saved, the old one comes back. */}
                    <CommitTextInput
                      id="pname"
                      required
                      value={name}
                      onCommit={(next, info) => void commit.name(next, info)}
                      disabled={!canRenameProject}
                      aria-label={t("projectSettings.info.titleLabel")}
                      className="w-56 bg-background"
                    />
                  </DisabledFieldTooltip>
                }
              />
              <SettingsRow
                saveId="smartQuotes"
                label={<label htmlFor="smart-quotes">{t("projectSettings.info.smartQuotesLabel")}</label>}
                description={
                  <>
                    {t("projectSettings.info.smartQuotesDescription")}
                    <InheritedFieldNote
                      field="smartQuotes"
                      upstreamName={inheritedUpstreamName}
                      config={inheritedConfig}
                      canEdit={canEditShared}
                      onDetach={detachInherited}
                    />
                  </>
                }
                control={
                  <DisabledFieldTooltip disabled={!canEditShared} tooltip={sharedDisabledTooltip ?? null}>
                    <Switch
                      id="smart-quotes"
                      checked={smartQuotes}
                      onCheckedChange={(checked) => setShared("smartQuotes", checked)}
                      disabled={!canChangeShared}
                      aria-label={t("projectSettings.info.smartQuotesLabel")}
                    />
                  </DisabledFieldTooltip>
                }
              />
            </SettingsGroup>
          </div>
        )}

        {searchGroupLabel("section-languages")}
        {sectionsToRender.some((s) => s.id === "section-languages") && (
          <LanguagesSection
            defaultTargetLanguage={sharedSettingsBlob?.targetLanguage ?? project?.targetLanguage ?? ""}
            targetLanes={sharedSettingsBlob?.targetLanes ?? []}
            archivedLanes={sharedSettingsBlob?.archivedLanes ?? []}
            canEdit={canEditLanguages}
            disabledTooltip={languageDisabledTooltip}
            patch={patchShared}
            laneRecords={isCloudProject ? sharedLanes ?? undefined : undefined}
            onRenameLane={isCloudProject ? renameLane : undefined}
            onCreateLane={isCloudProject ? createLane : undefined}
            onSetLaneArchived={isCloudProject ? setLaneArchived : undefined}
            onSetLaneDelivers={isCloudProject ? setLaneDelivers : undefined}
            onLoadLaneLastChange={isCloudProject ? loadLaneLastChange : undefined}
            startAdding={focusTarget === "add-lane"}
          />
        )}
        {/* AQU-1688: facts about the target language that Bible data checks
            need. Only with the Bible data experiment on (AQU-1685): without
            it there are no Bible data checks to configure. */}
        {bibleDataExperiment && sectionsToRender.some((s) => s.id === "section-languages") && (
          <LanguageProfileSection
            value={sharedSettingsBlob?.languageProfile}
            targetLanguage={sharedSettingsBlob?.targetLanguage ?? project?.targetLanguage ?? ""}
            canEdit={canChangeShared}
            disabledTooltip={sharedDisabledTooltip ?? null}
            patch={commit.recordedPatch()}
          />
        )}
        {/* AQU-1691: the decision log, the team's answers to Autopilot's
            questions. Only with the Bible data experiment on (AQU-1685): the
            questions that record a decision are Bible data questions
            (AQU-1690), so without the experiment the card has nothing to
            show. Autopilot follows the stored decisions either way. */}
        {bibleDataExperiment && sectionsToRender.some((s) => s.id === "section-languages") && (
          <ProjectDecisionsSection
            value={sharedSettingsBlob?.projectFacts}
            canEdit={canChangeShared}
            disabledTooltip={sharedDisabledTooltip ?? null}
            username={session?.username ?? ""}
            patch={commit.recordedPatch({ ownErrors: "all" })}
          />
        )}

        {searchGroupLabel("section-cell-editing")}
        {sectionsToRender.some((s) => s.id === "section-cell-editing") && (
          <div id="section-cell-editing">
            {/* AQU-1068. One setting answers WHO; the file's own nature answers
                WHERE — a text file takes a cell anywhere, a subtitle file only
                in a gap — so nothing here mentions timings or media. */}
            <SettingsGroup label={t("projectSettings.cellEditing.sectionTitle")} locked={sharedDisabledTooltip}>
              <SettingsRow
                saveId="cellEditingFloor"
                label={<label htmlFor="cell-editing-floor">{t("projectSettings.cellEditing.label")}</label>}
                description={t("projectSettings.cellEditing.description")}
                control={
                  <DisabledFieldTooltip disabled={!canEditShared} tooltip={sharedDisabledTooltip ?? null}>
                    <div className="flex flex-wrap items-center justify-end gap-2">
                    {/* AQU-1768: follow the organization's tier, or set one here. */}
                    <OrgDefaultSource
                      id="cell-editing-floor-source"
                      settingLabel={t("projectSettings.cellEditing.label")}
                      inherited={cellEditingFloor == null}
                      orgOptionLabel={t("projectSettings.mediaDefaults.orgValue", {
                        value: cellEditingTierLabel(t, orgMediaDefaults.cellEditingFloor ?? "none"),
                      })}
                      disabled={!canChangeShared}
                      onChange={(inherit) => setShared("cellEditingFloor", inherit ? undefined : effectiveCellEditingFloor)}
                    />
                    <Select
                      items={CELL_EDITING_FLOOR_OPTIONS.map((o) => ({
                        value: o.value,
                        label: (o.level != null ? FLOOR_LABEL[o.level] : undefined) ?? t(o.labelKey),
                      }))}
                      disabled={!canChangeShared}
                      value={effectiveCellEditingFloor}
                      onValueChange={(value) => {
                        if (value && value !== effectiveCellEditingFloor) setShared("cellEditingFloor", value as CellEditingTier)
                      }}
                    >
                      <SelectTrigger
                        id="cell-editing-floor"
                        data-testid="settings-cell-editing-floor"
                        aria-label={t("projectSettings.cellEditing.label")}
                        className="w-64 bg-background"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          {CELL_EDITING_FLOOR_OPTIONS.map((o) => (
                            <SelectItem key={o.value} value={o.value}>{t(o.labelKey)}</SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                    </div>
                  </DisabledFieldTooltip>
                }
              />
            </SettingsGroup>
          </div>
        )}

        {searchGroupLabel("section-bible-resources")}
        {sectionsToRender.some((s) => s.id === "section-bible-resources") && (
          <div id="section-bible-resources">
            <BibleDataSection
              switchValue={bibleResourcesEnabled}
              onSwitchChange={(checked) => setShared("bibleResourcesEnabled", checked)}
              enrichments={bibleEnrichments}
              onEnrichmentChange={(enrichment, checked) =>
                void commit.shared(`bibleEnrichments.${enrichment}`, sharedSettingLabel("bibleEnrichments"), [
                  { key: "bibleEnrichments", field: enrichment, value: checked },
                ])
              }
              hasScriptureFiles={projectHasScriptureFiles(project?.files)}
              canEdit={canChangeShared}
              lockedTooltip={sharedDisabledTooltip ?? null}
              // The project-wide opt-in, or the legacy device-local flag that
              // useProject overlays onto the record (AQU-1246).
              autopilotOn={isAutopilotVisible({
                autopilotEnabled: sharedSettingsBlob.autopilotEnabled,
                experimentalFlags: project?.experimentalFlags,
              })}
              onOpenBuiltinChecks={id ? () => requestNavigate(projectMemoryPath(id, "quality")) : undefined}
              experimentOn={bibleDataExperiment}
            />
          </div>
        )}

        {searchGroupLabel("section-import")}
        {sectionsToRender.some((s) => s.id === "section-import") && (
          <div id="section-import">
            <SettingsGroup label={t("projectSettings.section.import")} locked={sharedDisabledTooltip}>
              <SettingsRow
                saveId="importExcludeFrontMatter"
                label={<label htmlFor="import-exclude-front-matter">{t("projectSettings.import.excludeFrontMatterLabel")}</label>}
                description={t("projectSettings.import.excludeFrontMatterDescription")}
                control={
                  <DisabledFieldTooltip disabled={!canEditShared} tooltip={sharedDisabledTooltip ?? null}>
                    <Switch
                      id="import-exclude-front-matter"
                      checked={importExcludeFrontMatter}
                      onCheckedChange={(checked) => setShared("importExcludeFrontMatter", checked)}
                      disabled={!canChangeShared}
                      aria-label={t("projectSettings.import.excludeFrontMatterLabel")}
                    />
                  </DisabledFieldTooltip>
                }
              />
              {/* AQU-1720: a dubbing project generates one voice clip per cell,
                  so the cell has to be able to BE the paragraph. */}
              <SettingsRow
                saveId="importCellUnit"
                label={<label htmlFor="import-cell-unit">{t("projectSettings.import.cellUnitLabel")}</label>}
                description={t("projectSettings.import.cellUnitDescription")}
                control={
                  <DisabledFieldTooltip disabled={!canEditShared} tooltip={sharedDisabledTooltip ?? null}>
                    <Select
                      items={IMPORT_CELL_UNIT_OPTIONS.map((o) => ({ value: o.value, label: t(o.labelKey) }))}
                      disabled={!canChangeShared}
                      value={importCellUnit}
                      onValueChange={(value) => {
                        if (value && value !== importCellUnit) setShared("importCellUnit", value as CellUnit)
                      }}
                    >
                      <SelectTrigger
                        id="import-cell-unit"
                        data-testid="settings-import-cell-unit"
                        aria-label={t("projectSettings.import.cellUnitLabel")}
                        className="w-64 bg-background"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          {IMPORT_CELL_UNIT_OPTIONS.map((o) => (
                            <SelectItem key={o.value} value={o.value}>{t(o.labelKey)}</SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </DisabledFieldTooltip>
                }
              />
            </SettingsGroup>
          </div>
        )}

        {searchGroupLabel("section-user")}
        {sectionsToRender.some((s) => s.id === "section-user") && (
          <div id="section-user">
            <SettingsGroup label={t("projectSettings.section.user")}>
              {/* AQU-2259: a person's own setting, so it lives in Preferences now. */}
              <SettingMovedNote
                to="/preferences"
                target={LOCAL_AUTHOR_NAME_SETTING_ID}
                where={[t("nav.account.preferences"), t("common.general")]}
                onNavigate={requestNavigate}
              />
            </SettingsGroup>
          </div>
        )}

        {searchGroupLabel("section-members")}
        {id && sectionsToRender.some((s) => s.id === "section-members") && (
          <MembersSection projectId={id} />
        )}
        {/* AQU-2263: who sees the member list and each member's progress. The
            organization's policy, which a project may only make stricter; a
            second home beside the dashboard's badges, which stay. */}
        {id && isCloudProject && projectPolicy.ready && sectionsToRender.some((s) => s.id === "section-members") && (
          <div id="section-member-visibility">
            <ProjectVisibilitySection
              roster={projectPolicy.rosterViewMinRole}
              progress={projectPolicy.memberProgressViewMinRole}
              roleLevel={project?.syncRole?.level ?? 0}
              canEdit={canChangeShared}
              disabledTooltip={sharedDisabledTooltip ?? undefined}
              onPatch={commit.recordedPatch({ ownErrors: "all" })}
            />
          </div>
        )}

        {/* AQU-1672: a direct, first-class entry to the translation brief.
            Unlike the Living Memory cross-link below it, this row renders while
            searching too — a search for "brief" has to produce the path to the
            brief, not an empty result. Same deliberate omission of a modal
            `state`: this is a real navigation out of settings. */}
        {searchGroupLabel("section-brief")}
        {id && sectionsToRender.some((s) => s.id === "section-brief") && (
          <div id="section-brief" className="flex flex-col gap-12">
            <NavList>
              <NavRow
                to={projectMemoryPath(id, "brief")}
                icon={BRIEF_ICON}
                title={t("autopilot.readiness.brief.label")}
                description={t("terminology.livingMemory.section.brief.description")}
                hint={briefHint}
              />
            </NavList>
          </div>
        )}

        {searchGroupLabel("section-ai-instructions")}
        {sectionsToRender.some((s) => s.id === "section-ai-instructions") && (
          <div id="section-ai-instructions" className="flex flex-col gap-12">
            {/* Cross-link: the system prompt is edited on the Living Memory
                surface (memory/instructions). A real navigation out of
                settings — deliberately no modal `state` (unlike sibling
                NavRows), so the route-modal doesn't try to stack it. */}
            {!lowerQuery && id ? (
              <NavList>
                <NavRow
                  to={projectMemoryPath(id, "instructions")}
                  icon={LIVING_MEMORY_ICON}
                  title={t("terminology.livingMemory.title")}
                  description={t("projectSettings.systemPrompt.navDescription")}
                  hint={
                    savedSystemPrompt.trim() && savedSystemPrompt !== DEFAULT_SYSTEM_PROMPT
                      ? t("terminology.livingMemory.prompt.customBadge")
                      : t("terminology.livingMemory.prompt.defaultBadge")
                  }
                />
              </NavList>
            ) : null}
            <SettingsGroup label={t("projectSettings.section.aiInstructions")} description={sharedLockedLine}>
              <SettingsRow
                saveId="draftingSettings.top_k"
                label={<label htmlFor="top-k">{t("projectSettings.ai.topKLabel")}</label>}
                description={t("projectSettings.ai.topKDescription", { defaultCount: DEFAULT_APPROVED_EXAMPLE_COUNT })}
                control={
                  <CommitNumberInput
                    id="top-k"
                    disabled={!canChangeShared}
                    min={1}
                    max={20}
                    value={topK}
                    onCommit={(next, info) => setDrafting("top_k", next, info)}
                    aria-label={t("projectSettings.ai.topKLabel")}
                    className="w-24 bg-background"
                  />
                }
              />
              <SettingsRow
                saveId="draftingSettings.completionBatchSize"
                label={<label htmlFor="completion-batch-size">{t("projectSettings.ai.completionBatchSizeLabel")}</label>}
                description={t("projectSettings.ai.completionBatchSizeDescription", { defaultSize: MAX_BATCH_COMPLETIONS })}
                control={
                  <CommitNumberInput
                    id="completion-batch-size"
                    disabled={!canChangeShared}
                    min={1}
                    max={50}
                    value={completionBatchSize}
                    onCommit={(next, info) => setDrafting("completionBatchSize", next, info)}
                    aria-label={t("projectSettings.ai.completionBatchSizeLabel")}
                    className="w-24 bg-background"
                  />
                }
              />
              <SettingsRow
                saveId="draftingSettings.validationBatchSize"
                label={<label htmlFor="validation-batch-size">{t("projectSettings.ai.validationBatchSizeLabel")}</label>}
                description={withStyledTerms(
                  t("projectSettings.ai.validationBatchSizeHelp", {
                    zeroNote: t("projectSettings.ai.validationBatchSizeZeroNote"),
                  }),
                  [{ text: t("projectSettings.ai.validationBatchSizeZeroNote"), as: "strong" }],
                )}
                control={
                  <CommitNumberInput
                    id="validation-batch-size"
                    disabled={!canChangeShared}
                    min={0}
                    max={500}
                    value={validationBatchSize}
                    onCommit={(next, info) => setDrafting("validationBatchSize", next, info)}
                    aria-label={t("projectSettings.ai.validationBatchSizeLabel")}
                    className="w-24 bg-background"
                  />
                }
              />
              <SettingsRow
                saveId="draftingSettings.contextSize"
                label={<label htmlFor="context-size">{t("projectSettings.ai.contextWindowLabel")}</label>}
                description={t("projectSettings.ai.contextWindowDescription")}
                control={
                  <Select
                    items={{
                      small: t("projectSettings.ai.contextWindowSmall"),
                      medium: t("projectSettings.ai.contextWindowMedium"),
                      large: t("projectSettings.ai.contextWindowLarge"),
                    }}
                    value={contextSize}
                    onValueChange={(value) => {
                      if (value && value !== contextSize) setDrafting("contextSize", value as ContextSize)
                    }}
                    disabled={!canChangeShared}
                  >
                    <SelectTrigger id="context-size" aria-label={t("projectSettings.ai.contextWindowLabel")} className="w-56 bg-background">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value="small">{t("projectSettings.ai.contextWindowSmall")}</SelectItem>
                        <SelectItem value="medium">{t("projectSettings.ai.contextWindowMedium")}</SelectItem>
                        <SelectItem value="large">{t("projectSettings.ai.contextWindowLarge")}</SelectItem>
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                }
              />
              <SettingsRow
                saveId="draftingSettings.main_chat_language"
                label={<label htmlFor="main-chat-language">{t("projectSettings.ai.assistantLanguageLabel")}</label>}
                description={t("projectSettings.ai.assistantLanguageDescription")}
                control={
                  <CommitTextInput
                    id="main-chat-language"
                    disabled={!canChangeShared}
                    value={mainChatLanguage}
                    onCommit={(next, info) => setDrafting("main_chat_language", next, info)}
                    placeholder={t("projectSettings.ai.assistantLanguagePlaceholder")}
                    aria-label={t("projectSettings.ai.assistantLanguageLabel")}
                    className="w-56 bg-background"
                  />
                }
              />
              <SettingsRow
                label={<label htmlFor="validated-only">{t("projectSettings.ai.approvedExamplesOnlyLabel")}</label>}
                description={t("projectSettings.ai.approvedExamplesOnlyDescription")}
                control={
                  <Switch
                    id="validated-only"
                    checked
                    disabled
                    aria-label={t("projectSettings.ai.approvedExamplesOnlyLabel")}
                  />
                }
              />
              <SettingsRow
                saveId="draftingSettings.fewShotExampleFormat"
                label={<label htmlFor="few-shot-example-format">{t("projectSettings.ai.referenceExampleFormatLabel")}</label>}
                description={t("projectSettings.ai.referenceExampleFormatDescription")}
                control={
                  <Select
                    items={{
                      "source-and-target": t("projectSettings.ai.referenceExampleFormatSourceAndTarget"),
                      "target-only": t("projectSettings.ai.referenceExampleFormatTargetOnly"),
                    }}
                    value={fewShotExampleFormat}
                    onValueChange={(value) => {
                      if (value && value !== fewShotExampleFormat) setDrafting("fewShotExampleFormat", value)
                    }}
                    disabled={!canChangeShared}
                  >
                    <SelectTrigger id="few-shot-example-format" aria-label={t("projectSettings.ai.referenceExampleFormatLabel")} className="w-56 bg-background">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value="source-and-target">{t("projectSettings.ai.referenceExampleFormatSourceAndTarget")}</SelectItem>
                        <SelectItem value="target-only">{t("projectSettings.ai.referenceExampleFormatTargetOnly")}</SelectItem>
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                }
              />
            </SettingsGroup>
          </div>
        )}

        {searchGroupLabel("section-draft-context")}
        {sectionsToRender.some((s) => s.id === "section-draft-context") && (
          <div id="section-draft-context">
            <SettingsGroup label={t("projectSettings.section.draftContext")}>
              <SettingsRow
                saveId="draftContext"
                label={<label htmlFor="preceding-target-cells">{t("projectSettings.draftContext.precedingCellsLabel")}</label>}
                description={t("projectSettings.draftContext.precedingCellsDescription", {
                  defaultCount: DEFAULT_DRAFT_CONTEXT.precedingTargetCells,
                })}
                control={
                  <CommitNumberInput
                    id="preceding-target-cells"
                    disabled={!canChangeShared}
                    min={0}
                    max={10}
                    value={precedingTargetCells}
                    onCommit={(next, info) =>
                      void commit.shared("draftContext", sharedSettingLabel("draftContext"), [
                        { key: "draftContext", field: "precedingTargetCells", value: next },
                      ], info)
                    }
                    aria-label={t("projectSettings.draftContext.precedingCellsLabel")}
                    className="w-24 bg-background"
                  />
                }
              />
            </SettingsGroup>
          </div>
        )}

        {searchGroupLabel("section-advanced-llm")}
        {sectionsToRender.some((s) => s.id === "section-advanced-llm") && (
          <div id="section-advanced-llm">
            <SettingsGroup
              description={sharedLockedLine}
              label={
                <span className="inline-flex w-full items-center justify-between gap-4 pr-4">
                  <span>{t("projectSettings.advancedLlm.summary")}</span>
                  <span className="text-xs font-normal text-muted-foreground">
                    {provider === "frontier"
                      ? t("projectSettings.advancedLlm.frontierDefaultStatus")
                      : t("projectSettings.advancedLlm.customEndpointStatus", {
                          endpoint: endpoint || t("projectSettings.advancedLlm.notSet"),
                        })}
                  </span>
                </span>
              }
            >
              <SettingsRow
                saveId="draftingSettings.provider"
                label={t("projectSettings.advancedLlm.providerLabel")}
                description={<KeyInUseLine purpose="completion" kind={completionInUse} testId="completion-key-in-use" />}
                block
              >
                <RadioGroup
                  name="provider"
                  value={provider}
                  onValueChange={(value) => {
                    if (value && value !== provider) setDrafting("provider", value as CompletionProvider)
                  }}
                  disabled={!canChangeShared}
                  className="flex flex-col gap-2"
                >
                  <label className="flex items-start gap-2 text-sm">
                    <RadioGroupItem value="frontier" className="mt-1" />
                    <span>
                      {withStyledTerms(
                        t("projectSettings.advancedLlm.providerFrontier", {
                          name: t("projectSettings.advancedLlm.providerFrontierName"),
                        }),
                        [
                          { text: t("projectSettings.advancedLlm.providerFrontierName"), as: "strong" },
                        ],
                      )}
                    </span>
                  </label>
                  <label className="flex items-start gap-2 text-sm">
                    <RadioGroupItem value="custom" className="mt-1" />
                    <span>
                      {withStyledTerms(
                        t("projectSettings.advancedLlm.providerCustom", {
                          name: t("projectSettings.advancedLlm.providerCustomName"),
                        }),
                        [{ text: t("projectSettings.advancedLlm.providerCustomName"), as: "strong" }],
                      )}
                    </span>
                  </label>
                </RadioGroup>
              </SettingsRow>

              {/* i18n-exempt "custom" is a completion-provider token, not copy */}
              {provider === "custom" && (
                <>
                  <SettingsRow
                    label={<label htmlFor="preset">{t("projectSettings.advancedLlm.presetLabel")}</label>}
                    control={
                      <Select
                        items={CUSTOM_PRESETS.map((p) => ({ value: p.id, label: presetLabel(t, p) }))}
                        value={presetId}
                        onValueChange={(value) => handlePresetChange(value ?? "")}
                        disabled={!canChangeShared}
                      >
                        <SelectTrigger id="preset" aria-label={t("projectSettings.advancedLlm.presetLabel")} className="w-56 bg-background">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            {CUSTOM_PRESETS.map((p) => (
                              <SelectItem key={p.id} value={p.id}>{presetLabel(t, p)}</SelectItem>
                            ))}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                    }
                  />
                  <SettingsRow
                    saveId="draftingSettings.endpoint"
                    label={<label htmlFor="ep">{t("projectSettings.advancedLlm.endpointLabel")}</label>}
                    description={withStyledTerms(
                      t("projectSettings.advancedLlm.endpointHelp", {
                        v1Path: "/v1",
                        chatCompletionsPath: "/chat/completions",
                      }),
                      [
                        { text: "/v1", as: "code" },
                        { text: "/chat/completions", as: "code" },
                      ],
                    )}
                    block
                  >
                    <div className="flex gap-2">
                      <CommitTextInput
                        id="ep"
                        value={endpoint}
                        onCommit={(next, info) => setDrafting("endpoint", next, info)}
                        placeholder="http://localhost:8000"
                        disabled={!canChangeShared}
                        className="flex-1 bg-background"
                        aria-label={t("projectSettings.advancedLlm.endpointLabel")}
                      />
                      <Button onClick={handleConnect} disabled={connecting}>
                        {connecting ? <Spinner /> : t("projectSettings.advancedLlm.connectButton")}
                      </Button>
                    </div>
                    {connected && <p className="mt-1 flex items-center gap-1 text-xs text-green-600"><CheckCircle className="h-3 w-3" /> {t("projectSettings.advancedLlm.connectedStatus", { count: models.length })}</p>}
                    {connectionError && <p className="mt-1 flex items-center gap-1 text-xs text-destructive"><XCircle className="h-3 w-3" /> {connectionError}</p>}
                  </SettingsRow>
                  <SettingsRow
                    label={
                      preset.requiresKey ? (
                        t("projectSettings.field.apiKeyRequired")
                      ) : (
                        <>
                          {t("projectSettings.field.apiKey")} <OptionalMark />
                        </>
                      )
                    }
                    description={t("projectSettings.deviceOnly")}
                    block
                    saveId="apiKey"
                  >
                    <ApiKeyField
                      label={
                        preset.requiresKey ? (
                          t("projectSettings.field.apiKeyRequired")
                        ) : (
                          <>
                            {t("projectSettings.field.apiKey")} <OptionalMark />
                          </>
                        )
                      }
                      placeholder={preset.keyHint ?? (preset.requiresKey ? t("projectSettings.field.apiKeyPlaceholder") : t("projectSettings.field.apiKeyNoAuth"))}
                      projectKey={apiKey}
                      userKey={completionUserKey}
                      onProjectKeyChange={saveCompletionKey}
                      onUserKeyChange={(v) => setUserApiKey("completion", v)}
                      help="Sent as Authorization: Bearer <key>. Stored locally in your browser; never uploaded to Aquilla."
                    />
                  </SettingsRow>
                  {models.length > 0 && (
                    <SettingsRow
                      saveId="draftingSettings.model"
                      label={<label htmlFor="mdl">{t("projectSettings.advancedLlm.modelLabel")}</label>}
                      control={
                        <Select
                          value={model}
                          onValueChange={(value) => {
                            if (value != null && value !== model) setDrafting("model", value)
                          }}
                          disabled={!canChangeShared}
                        >
                          <SelectTrigger id="mdl" aria-label={t("projectSettings.advancedLlm.modelLabel")} className="w-56 bg-background">
                            <SelectValue placeholder={t("projectSettings.advancedLlm.modelPlaceholder")} />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectGroup>
                              {models.map((m) => <SelectItem key={m} value={m}>{m}</SelectItem>)}
                            </SelectGroup>
                          </SelectContent>
                        </Select>
                      }
                    />
                  )}
                  {models.length === 0 && (
                    <SettingsRow
                      saveId="draftingSettings.model"
                      label={<label htmlFor="mdl-manual">{t("projectSettings.advancedLlm.modelManualLabel")}</label>}
                      description={withStyledTerms(
                        t("projectSettings.advancedLlm.modelManualHelp", { modelsPath: "/models" }),
                        [{ text: "/models", as: "code" }],
                      )}
                      control={
                        <CommitTextInput
                          id="mdl-manual"
                          disabled={!canChangeShared}
                          value={model}
                          onCommit={(next, info) => setDrafting("model", next, info)}
                          placeholder={presetId === "openrouter" ? "anthropic/claude-3.5-sonnet" : t("projectSettings.advancedLlm.modelPlaceholder")}
                          aria-label={t("projectSettings.advancedLlm.modelManualLabel")}
                          className="w-56 bg-background"
                        />
                      }
                    />
                  )}
                </>
              )}

              {/* i18n-exempt "frontier" is a completion-provider token, not copy */}
              {provider === "frontier" && (
                <SettingsRow
                  saveId="draftingSettings.model"
                  label={
                    <label htmlFor="mdl-frontier">
                      {t("projectSettings.advancedLlm.modelOverrideName")} <OptionalMark />
                    </label>
                  }
                  description={withStyledTerms(
                    t("projectSettings.advancedLlm.modelOverrideHelp", { example: "anthropic/claude-3.5-sonnet" }),
                    [{ text: "anthropic/claude-3.5-sonnet", as: "code" }],
                  )}
                  control={
                    <CommitTextInput
                      id="mdl-frontier"
                      disabled={!canChangeShared}
                      value={model}
                      onCommit={(next, info) => setDrafting("model", next, info)}
                      placeholder={t("projectSettings.advancedLlm.modelOverridePlaceholder")}
                      aria-label={t("projectSettings.advancedLlm.modelOverrideName")}
                      className="w-56 bg-background"
                    />
                  }
                />
              )}

              <SettingsRow
                saveId="draftingSettings.maxTokens"
                label={<label htmlFor="mt">{t("projectSettings.advancedLlm.maxTokensLabel")}</label>}
                control={
                  <CommitNumberInput
                    id="mt"
                    disabled={!canChangeShared}
                    min={1}
                    max={1_000_000}
                    value={maxTokens}
                    onCommit={(next, info) => setDrafting("maxTokens", next, info)}
                    aria-label={t("projectSettings.advancedLlm.maxTokensLabel")}
                    className="w-24 bg-background"
                  />
                }
              />
              <SettingsRow
                saveId="draftingSettings.temperature"
                label={t("projectSettings.advancedLlm.temperatureLabel", { value: draggedTemperature ?? temperature })}
                control={
                  <div className="w-40">
                    {/* AQU-2262: saves when let go, not at every step of a drag. */}
                    <Slider
                      min={0}
                      max={1}
                      step={0.05}
                      value={[draggedTemperature ?? temperature]}
                      onValueChange={(next) => setDraggedTemperature(Array.isArray(next) ? next[0] : next)}
                      onValueCommitted={(next) => {
                        const value = Array.isArray(next) ? next[0] : next
                        setDraggedTemperature(null)
                        if (value !== temperature) setDrafting("temperature", value)
                      }}
                      aria-label={t("projectSettings.advancedLlm.temperatureName")}
                      disabled={!canChangeShared}
                    />
                  </div>
                }
              />
            </SettingsGroup>
          </div>
        )}

        {searchGroupLabel("section-voice")}
        {sectionsToRender.some((s) => s.id === "section-voice") && (
          <div id="section-voice">
            <SettingsGroup label={t("projectSettings.section.voice")}>
              <SettingsRow
                saveId="projectLeadsManageVoices"
                label={t("projectSettings.voice.leadsManageLabel")}
                description={t("projectSettings.voice.leadsManageDescription")}
                control={
                  <DisabledFieldTooltip disabled={!canEditShared} tooltip={sharedDisabledTooltip ?? null}>
                    <Switch
                      checked={sharedSettingsBlob.projectLeadsManageVoices === true}
                      onCheckedChange={(checked) => setShared("projectLeadsManageVoices", checked)}
                      disabled={!canChangeShared}
                      aria-label={t("projectSettings.voice.leadsManageLabel")}
                    />
                  </DisabledFieldTooltip>
                }
              />
              <SettingsRow
                label={t("projectSettings.voice.geminiTtsLabel")}
                description={
                  <>
                    {t("projectSettings.voice.geminiKeyHelp")}
                    <span className="mt-1 block">{t("projectSettings.deviceOnly")}</span>
                    <KeyInUseLine purpose="gemini" kind={geminiInUse} testId="gemini-key-in-use" />
                  </>
                }
                block
                saveId="geminiApiKey"
              >
                <ApiKeyField
                  label={t("projectSettings.voice.geminiKeyLabel")}
                  placeholder={t("projectSettings.voice.geminiKeyPlaceholder")}
                  projectKey={geminiApiKey}
                  userKey={geminiUserKey}
                  onProjectKeyChange={saveGeminiKey}
                  onUserKeyChange={(v) => setUserApiKey("gemini-tts", v)}
                  help={t("projectSettings.voice.geminiKeyHelp")}
                />
              </SettingsRow>
              <SettingsRow
                label={t("common.voices")}
                description={t("projectSettings.voice.voicesNote")}
                control={
                  // AQU-1758: Media, with the Voices tab open (the /voice route).
                  <Button variant="outline" onClick={() => requestNavigate(`/project/${id}/voice`)}>
                    {t("projectSettings.voice.openVoicesButton")}
                  </Button>
                }
              />
            </SettingsGroup>
          </div>
        )}

        {searchGroupLabel("section-local-models")}
        {sectionsToRender.some((s) => s.id === "section-local-models") && (
          <div id="section-local-models">
            <SettingsGroup label={t("projectSettings.section.localModels")}>
              <SettingsRow
                label={t("projectSettings.localModels.onDeviceLabel")}
                description={t("projectSettings.localModels.description")}
                control={
                  <Button
                    variant="outline"
                    // The hosted model picker says which models know this
                    // project's language, so it needs to know the project.
                    onClick={() => requestNavigate(project ? `/preferences/local-models?project=${encodeURIComponent(project.id)}` : "/preferences")}
                  >
                    {t("projectSettings.localModels.manageButton")}
                  </Button>
                }
              />
            </SettingsGroup>
          </div>
        )}

        {searchGroupLabel("section-validation")}
        {sectionsToRender.some((s) => s.id === "section-validation") && (
          <div id="section-validation" className="flex flex-col gap-12">
            <ValidationSettingsSection
              projectId={id}
              notice={
                <InheritedFieldNote
                  field="workflowPolicy"
                  upstreamName={inheritedUpstreamName}
                  config={inheritedConfig}
                  canEdit={canEditShared}
                  onDetach={detachInherited}
                />
              }
              validationCount={validationCount}
              validationCountAudio={validationCountAudio}
              orgValidationCount={orgValidationCount}
              orgValidationCountAudio={orgValidationCountAudio}
              validationRoleFloor={validationRoleFloor}
              validationNamedUsers={validationNamedUsers}
              allowSelfValidation={allowSelfValidation}
              validationRoleFloorAudio={validationRoleFloorAudio}
              validationNamedUsersAudio={validationNamedUsersAudio}
              allowSelfValidationAudio={allowSelfValidationAudio}
              orgValidationRoleFloorAudio={orgMediaDefaults.validationRoleFloorAudio ?? null}
              orgAllowSelfValidationAudio={orgMediaDefaults.allowSelfValidationAudio ?? null}
              disabled={!canChangeShared}
              disabledTooltip={sharedDisabledTooltip ?? undefined}
              // AQU-1083: the last row of the validation card. Passed as a
              // node rather than props because it patches the shared blob
              // directly, with its own role floor (Project lead).
              structuralCellsRow={
                <StructuralCellsProjectSection
                  value={sharedSettingsBlob?.countStructuralCells}
                  orgDefault={orgCountStructuralCells ?? true}
                  disabled={!canEditCountStructural}
                  disabledTooltip={structuralDisabledTooltip ?? undefined}
                  onPatch={commit.recordedPatch({ ownErrors: "failures" })}
                />
              }
              // AQU-1391: same slot treatment, same card — validation is the
              // gesture that triggers propagation.
              repetitionPropagationRow={
                <RepetitionPropagationProjectSection
                  value={sharedSettingsBlob?.autoPropagateRepetitions}
                  orgDefault={orgAutoPropagateRepetitions}
                  disabled={!canChangeShared}
                  disabledTooltip={sharedDisabledTooltip ?? undefined}
                  onPatch={commit.recordedPatch({ ownErrors: "failures" })}
                />
              }
              // AQU-2262: each change saves at once (a count when you leave
              // it or pause). A null goes back to the organization's default.
              onChange={(u, typed) => {
                for (const [key, value] of Object.entries(u)) {
                  if (value === undefined) continue
                  void commit.shared(key, sharedSettingLabel(key), [{ key, value: value ?? undefined }], typed)
                }
              }}
            />
            {/* AQU-186: Harmonization settings — harmonize_min_role floor. */}
            <SettingsGroup label={t("projectSettings.harmonization.title")} locked={sharedDisabledTooltip}>
              <SettingsRow
                saveId="harmonize_min_role"
                label={<label htmlFor="harmonize-min-role">{t("projectSettings.harmonization.minRoleLabel")}</label>}
                description={t("projectSettings.harmonization.description")}
                control={
                  <DisabledFieldTooltip disabled={!canEditShared} tooltip={sharedDisabledTooltip ?? null}>
                    <Select
                      items={{
                        project_lead: t("projectSettings.harmonization.defaultRoleSuffix", {
                          role: resolveRoleName(t, "project_lead"),
                        }),
                        maintainer: resolveRoleName(t, "maintainer"),
                      }}
                      disabled={!canChangeShared}
                      value={harmonizeMinRole}
                      onValueChange={(value) => {
                        if (value && value !== harmonizeMinRole) setShared("harmonize_min_role", value)
                      }}
                    >
                      <SelectTrigger id="harmonize-min-role" aria-label={t("projectSettings.harmonization.minRoleLabel")} className="w-56 bg-background">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          <SelectItem value="project_lead">
                            {t("projectSettings.harmonization.defaultRoleSuffix", {
                              role: resolveRoleName(t, "project_lead"),
                            })}
                          </SelectItem>
                          <SelectItem value="maintainer">{resolveRoleName(t, "maintainer")}</SelectItem>
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </DisabledFieldTooltip>
                }
              />
            </SettingsGroup>
          </div>
        )}

        {searchGroupLabel("section-decay")}
        {sectionsToRender.some((s) => s.id === "section-decay") && (
          <div id="section-decay">
            <DecaySettingsSection
              settings={decaySettings}
              onChange={(next, typed) => setDevice("decaySettings", next, typed)}
            />
          </div>
        )}

        {searchGroupLabel("section-audio-media")}
        {sectionsToRender.some((s) => s.id === "section-audio-media") && (
          <div id="section-audio-media">
            <AudioMediaStrategySection
              value={audioMediaStrategy}
              onChange={(next) => setDevice("audioMediaStrategy", next)}
            />
          </div>
        )}

        {searchGroupLabel("section-timeline")}
        {sectionsToRender.some((s) => s.id === "section-timeline") && (
          <Card id="section-timeline">
            <CardHeader><CardTitle>{t("editor.timeline.title")}</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              {/* AQU-646. FIRST in the card because it constrains everything
                  below it — the pencil under it is moot while nothing moves. */}
              <div className="flex flex-wrap items-start gap-2">
                {/* AQU-1768: while the project follows the organization the
                    box shows the organization's choice and cannot be ticked. */}
                <Checkbox
                  id="timing-locked"
                  data-testid="settings-timing-locked"
                  checked={effectiveTimingLocked}
                  disabled={!canChangeShared || timingLocked == null}
                  onCheckedChange={(checked) => setShared("timingLocked", checked)}
                />
                <label htmlFor="timing-locked" className="min-w-0 flex-1 text-sm">
                  {t("projectSettings.timeline.lockLabel")}
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t("projectSettings.timeline.lockHint")}
                  </p>
                </label>
                <SaveStatus id="timingLocked" className="max-w-56 text-right" />
                <OrgDefaultSource
                  id="timing-locked-source"
                  settingLabel={t("projectSettings.timeline.lockLabel")}
                  inherited={timingLocked == null}
                  orgOptionLabel={orgBooleanOptionLabel(t, orgMediaDefaults.timingLocked ?? true)}
                  disabled={!canChangeShared}
                  onChange={(inherit) => setShared("timingLocked", inherit ? undefined : effectiveTimingLocked)}
                />
              </div>
              {/* AQU-646 stage 2. LAST in the card, because it is the wider
                  claim of the two: the lock above constrains what may move on
                  a timeline, this one decides whether the timeline's own rows
                  may be added to, grouped and recoloured at all. ON by default
                  since AQU-2214, and enforced on the server as well — the UI
                  withholding a button is not a permission. */}
              <div className="flex flex-wrap items-start gap-2">
                <Checkbox
                  id="allow-track-editing"
                  data-testid="settings-allow-track-editing"
                  checked={effectiveAllowTrackEditing}
                  disabled={!canChangeShared || allowTrackEditing == null}
                  onCheckedChange={(checked) => setShared("allowTrackEditing", checked)}
                />
                <label htmlFor="allow-track-editing" className="min-w-0 flex-1 text-sm">
                  {t("projectSettings.timeline.trackEditingLabel")}
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t("projectSettings.timeline.trackEditingHint")}
                  </p>
                </label>
                <SaveStatus id="allowTrackEditing" className="max-w-56 text-right" />
                <OrgDefaultSource
                  id="allow-track-editing-source"
                  settingLabel={t("projectSettings.timeline.trackEditingLabel")}
                  inherited={allowTrackEditing == null}
                  orgOptionLabel={orgBooleanOptionLabel(t, orgMediaDefaults.allowTrackEditing ?? true)}
                  disabled={!canChangeShared}
                  onChange={(inherit) => setShared("allowTrackEditing", inherit ? undefined : effectiveAllowTrackEditing)}
                />
              </div>
              {/* AQU-1758 (Sam's decision 7): the media view's dubbing tools —
                  the Film button and the timeline's Sources menu — together.
                  Unset, a project of books and documents hides them and any
                  other shows them. Not a permission: nothing on the server
                  reads it. The long explanation sits behind the (i).
                  AQU-2262: it saves as it is ticked, one Undo step, and Undo
                  puts "unset" back, so the project's kind decides again. */}
              <div className="flex flex-wrap items-start gap-2">
                <Checkbox
                  id="film-and-sources"
                  data-testid="settings-film-and-sources"
                  checked={filmAndSourcesShown(filmAndSources, project?.files)}
                  disabled={!canChangeShared}
                  onCheckedChange={(checked) => setShared("filmAndSources", checked)}
                />
                <span className="flex min-w-0 flex-1 flex-col text-sm">
                  <span className="flex items-center gap-1">
                    <label htmlFor="film-and-sources">{t("projectSettings.timeline.filmAndSourcesLabel")}</label>
                    <InfoToggle
                      open={filmInfoOpen}
                      onToggle={toggleFilmInfo}
                      label={t("projectSettings.timeline.filmAndSourcesInfoAria")}
                      controls="settings-film-and-sources-explanation"
                      testId="settings-film-and-sources-info"
                    />
                  </span>
                  <InfoReveal open={filmInfoOpen} id="settings-film-and-sources-explanation">
                    <span className="block text-xs text-muted-foreground">{t("projectSettings.timeline.filmAndSourcesInfo")}</span>
                  </InfoReveal>
                </span>
                <SaveStatus id="filmAndSources" className="max-w-56 text-right" />
              </div>
            </CardContent>
          </Card>
        )}

        {searchGroupLabel("section-git-sync")}
        {/* i18n-exempt "git" is a project-origin kind, not copy */}
        {project?.origin?.kind === "git" && sectionsToRender.some((s) => s.id === "section-git-sync") && (
          <div id="section-git-sync">
            <SettingsGroup label={t("projectSettings.section.gitSync")} description={t("projectSettings.deviceOnly")}>
              <SettingsRow
                label={withStyledTerms(
                  t("projectSettings.gitSync.originLabel", {
                    url: project.origin.cloneUrl,
                    branch: project.origin.branch,
                  }),
                  [
                    { text: project.origin.cloneUrl, as: "mono" },
                    { text: project.origin.branch, as: "mono" },
                  ],
                )}
              />
              <SettingsRow
                saveId="syncSettings"
                label={<label htmlFor="auto-sync">{t("projectSettings.gitSync.autoSyncSwitch")}</label>}
                description={t("projectSettings.gitSync.intervalNote")}
                control={
                  <div className="flex items-center gap-2">
                    <Switch
                      id="auto-sync"
                      checked={autoSyncEnabled}
                      onCheckedChange={(checked) => setSyncSettings(checked, autoSyncInterval)}
                      aria-label={t("projectSettings.gitSync.autoSyncSwitch")}
                    />
                    <CommitNumberInput
                      min={1}
                      max={60}
                      className="h-8 w-20 bg-background"
                      value={autoSyncInterval}
                      onCommit={(next, info) => setSyncSettings(autoSyncEnabled, next, info)}
                      aria-label={t("projectSettings.gitSync.autoSyncIntervalAriaLabel")}
                    />
                    <span className="text-sm text-muted-foreground">{t("projectSettings.gitSync.minutesAbbrev")}</span>
                  </div>
                }
              />
            </SettingsGroup>
          </div>
        )}
        {searchGroupLabel("section-terminology")}
        {sectionsToRender.some((s) => s.id === "section-terminology") && (
          <div id="section-terminology">
            <SettingsGroup label={t("projectSettings.section.terminology")}>
              <SettingsRow
                label={t("projectSettings.terminology.title")}
                description={t("projectSettings.terminology.description")}
                control={
                  <Button variant="outline" onClick={() => requestNavigate(`/project/${id}/terminology`)}>
                    {t("projectSettings.terminology.openButton")}
                  </Button>
                }
              />
            </SettingsGroup>
            <TermMatchingSection
              value={termMatching}
              onChange={(next, typed) =>
                void commit.shared("termMatching", sharedSettingLabel("termMatching"), [{ key: "termMatching", value: next }], typed)
              }
              disabled={!canChangeShared}
              locked={sharedDisabledTooltip}
            />
          </div>
        )}
        {searchGroupLabel("section-termbase-sharing")}
        {id && SHOW_TERMBASE_SHARING_IN_SETTINGS && sectionsToRender.some((s) => s.id === "section-termbase-sharing") && (
          <TermbaseSharingSection
            projectId={id}
            orgId={org?.id ?? null}
            roleLevel={project?.syncRole?.level ?? null}
          />
        )}

        {searchGroupLabel("section-monday")}
        {id && sectionsToRender.some((s) => s.id === "section-monday") && (
          <MondayIntegrationSection
            projectId={id}
            orgId={project?.orgId ?? null}
            roleLevel={project?.syncRole?.level ?? null}
          />
        )}

        {searchGroupLabel("section-airtable")}
        {id && sectionsToRender.some((s) => s.id === "section-airtable") && (
          <AirtableIntegrationSection
            projectId={id}
            orgId={project?.orgId ?? null}
            roleLevel={project?.syncRole?.level ?? null}
          />
        )}

        {searchGroupLabel("section-ai-metrics")}
        {sectionsToRender.some((s) => s.id === "section-ai-metrics") && (
          <PostEditMetricsSection
            metrics={postEditMetrics}
            isLoading={metricsLoading}
            isError={metricsError}
            isCloudProject={isCloudProject}
            onRevalidate={revalidateMetrics}
          />
        )}

        {sectionsToRender.some((s) => s.id === "section-experimental") && id && (
          <ExperimentalFlagsSection
            projectId={id}
            serverProject={project ?? undefined}
            // AQU-1246: the Autopilot opt-in is a project-wide synced setting,
            // not a device-local flag, so it reads from and writes through the
            // shared settings blob. Its role floor (project_lead) is lower
            // than the rest of the page's (maintainer); the patch picks the
            // floor from the keys it carries.
            autopilotEnabled={sharedSettingsBlob.autopilotEnabled}
            roleLevel={project?.syncRole?.level ?? null}
            onSetAutopilotEnabled={(enabled) => { void commit.recordedPatch()({ autopilotEnabled: enabled }) }}
            // AQU-1937: the per-project Smart Extensions switch (Maintainer+,
            // the ordinary settings floor; the server refuses lower roles).
            smartExtensionsEnabled={sharedSettingsBlob.smartExtensionsEnabled}
            onSetSmartExtensionsEnabled={(enabled) => {
              void commit.recordedPatch()({ smartExtensionsEnabled: enabled }).then(() => notifySmartExtensionsChanged(id))
            }}
          />
        )}
          </div>
    </Page>
  )

  const shell = modal ? (
    <Dialog open onOpenChange={(open) => { if (!open) closeSettings() }}>
      <DialogContent
        className={`h-[min(90dvh,56rem)] gap-0 p-0 ${modalWidthClass}`}
        data-testid="project-settings-dialog"
      >
        <DialogHeader className="sr-only">
          <DialogTitle>{pageTitle}</DialogTitle>
          <DialogDescription>{pageDescription}</DialogDescription>
        </DialogHeader>
        <DialogBody className="m-0 p-0">{settingsContent}</DialogBody>
      </DialogContent>
    </Dialog>
  ) : (
    <AppShell
      sidebar={<OrgSidebar />}
      header={breadcrumb}
      statusBar={null}
      main={settingsContent}
    />
  )

  // Dialogs / toasts portal above the shell; keep them as siblings so they
  // aren't clipped by the Page scroll container.
  return (
    <>
      {shell}
      <PrivilegedMembersDialog
        open={privilegedOpen}
        onOpenChange={setPrivilegedOpen}
        projectId={id ?? null}
        roleLabel={privilegedRole}
      />

    </>
  )
}

/** Route-modal presentation used by in-app project-settings entry points.
 * Direct settings URLs retain the full-page fallback. */
export function ProjectSettingsDialog() {
  return <ProjectSettings modal />
}
