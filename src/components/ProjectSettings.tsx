import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type Dispatch, type ReactNode, type SetStateAction } from "react"
import { SettingMovedNote } from "@/components/settings/SettingMovedNote"
import { settingMovedNotesShowing } from "@/lib/settings/setting-moved"
import { authorNameFor, LOCAL_AUTHOR_NAME_SETTING_ID } from "@/lib/store/local-author-name"
import { notifySmartExtensionsChanged } from "@/lib/tools/smart-extensions-enabled"
import { recordStep } from "@/lib/history/history"
import { Navigate, useLocation, useParams, useNavigate, useSearchParams, type Location } from "react-router-dom"
import {
  isProjectEditorPath,
  projectMemoryPath,
  projectSettingsPath,
  safeReturnPath,
  withSettingsReturn,
} from "@/lib/navigation/org-paths"
import {
  Check, CheckCircle, XCircle, ChevronDown, Save, Sparkles,
  SlidersHorizontal, Link2, BarChart3, ShieldCheck, AudioLines, Plug, FlaskConical,
  Users,
} from "lucide-react"
import { toast } from "@/components/ui/toast"
import { Button } from "@/components/ui/button"
import { LoadingPanel } from "@/components/ui/loading-overlay"
import { ButtonGroup, ButtonGroupSeparator } from "@/components/ui/button-group"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Switch } from "@/components/ui/switch"
import { Input } from "@/components/ui/input"
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
  DialogFooter,
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
import { getProject, updateProject } from "@/lib/store/project-index"
import {
  DEFAULT_APPROVED_EXAMPLE_COUNT,
  DEFAULT_COMPLETION_MAX_TOKENS,
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
import { draftingSettingsFrom } from "@/lib/completion/drafting-settings"
import { MAX_BATCH_COMPLETIONS } from "@/lib/workspace-actions/registry"
import type {
  AudioMediaStrategy,
  CellUnit,
  CompletionProvider,
  CompletionSettings,
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
import type { CellEditingTier, ProjectWideSettings } from "@/lib/sync/project-settings"
import { FLOOR_LABEL } from "@/pages/settings/constants"
import { CELL_EDITING_FLOOR_OPTIONS, cellEditingTierLabel } from "@/components/ProjectSettings/cell-editing-floor-options"
import { OrgDefaultSource, orgBooleanOptionLabel } from "@/components/ProjectSettings/OrgDefaultSource"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { PERMISSION_DOCS_URL } from "@/components/PermissionDeniedAlert"
import { resolveRoleName, ROLE } from "@/lib/frontier/roles"
import { useT, type TFunction } from "@/lib/i18n/I18nProvider"
import type { MessageKey } from "@/lib/i18n/messages/en"
import { renameProject } from "@/lib/sync/cloud-projects"
import { UserError } from "@/lib/errors/user-error"
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

interface Baseline {
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

function buildBaseline(project: ProjectRecord): Baseline {
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

/** Baseline fields whose stored value lives only in the shared settings blob.
 *  Each is written to the blob on Save, so each must be read back from it. */
const BLOB_BACKED_KEYS = [
  // AQU-2259: the team's drafting settings and model choice.
  "provider",
  "endpoint",
  "model",
  "maxTokens",
  "temperature",
  "top_k",
  "contextSize",
  "main_chat_language",
  "fewShotExampleFormat",
  "completionBatchSize",
  "validationBatchSize",
  "validationCount",
  "validationCountAudio",
  "validationRoleFloor",
  "validationNamedUsers",
  "allowSelfValidation",
  "validationRoleFloorAudio",
  "validationNamedUsersAudio",
  "allowSelfValidationAudio",
  "cellEditingFloor",
  "allowTrackEditing",
  "timingLocked",
  "harmonize_min_role",
  "bibleResourcesEnabled",
  "bibleEnrichments",
  "precedingTargetCells",
  "importExcludeFrontMatter",
  "importCellUnit",
  "smartQuotes",
  "termMatching",
] as const satisfies readonly (keyof Baseline)[]
type BlobBackedKey = (typeof BLOB_BACKED_KEYS)[number]

/** The provenance line under the project name. The settings response names
 *  the saver only by id, so without a username it gives the date alone rather
 *  than "Last edited by undefined" (walk 10-02). */
function lastEditedLine(name: string | null, date: string, t: TFunction): string {
  return name
    ? t("projectSettings.shared.lastEdited", { name, date })
    : t("projectSettings.shared.lastEditedOn", { date })
}

function sameSetting(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b)
}

function adoptKey<K extends BlobBackedKey>(target: Baseline, source: Baseline, key: K) {
  target[key] = source[key]
}

function decayEqual(a: DecaySettings | undefined, b: DecaySettings | undefined): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return JSON.stringify(a) === JSON.stringify(b)
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

export function ProjectSettings({ modal = false }: ProjectSettingsProps = {}) {
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
    conflict: sharedConflict,
    dismissConflict,
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

  // Baseline is the last-saved snapshot of every field on the page. The diff
  // between baseline and the form state determines `isDirty` and which writes
  // we actually have to fire on Save.
  const [baseline, setBaseline] = useState<Baseline | null>(null)

  // Draft state — what the user is currently editing. Seeded once from the
  // baseline; never overwritten by background project re-renders (that's what
  // caused the "typed letter flashes then disappears" bug under auto-save).
  const [name, setName] = useState("")
  // AQU-765: inline validation for an empty/whitespace-only rename.
  const [nameError, setNameError] = useState<string | null>(null)
  const [provider, setProvider] = useState<CompletionProvider>("frontier")
  const [endpoint, setEndpoint] = useState("")
  const [apiKey, setApiKey] = useState("")
  const [presetId, setPresetId] = useState<string>("local")
  const [model, setModel] = useState("")
  const [maxTokens, setMaxTokens] = useState(DEFAULT_COMPLETION_MAX_TOKENS)
  const [temperature, setTemperature] = useState(0.3)
  const [topK, setTopK] = useState(DEFAULT_APPROVED_EXAMPLE_COUNT)
  const [contextSize, setContextSize] = useState<ContextSize>("medium")
  const [useOnlyValidatedExamples, setUseOnlyValidatedExamples] = useState(true)
  const [fewShotExampleFormat, setFewShotExampleFormat] = useState<"source-and-target" | "target-only">("source-and-target")
  const [mainChatLanguage, setMainChatLanguage] = useState("")
  const [completionBatchSize, setCompletionBatchSize] = useState(MAX_BATCH_COMPLETIONS)
  const [validationBatchSize, setValidationBatchSize] = useState(0)
  const [autoSyncEnabled, setAutoSyncEnabled] = useState(false)
  const [autoSyncInterval, setAutoSyncInterval] = useState(5)
  const [validationCount, setValidationCount] = useState<number | null>(null)
  const [validationCountAudio, setValidationCountAudio] = useState<number | null>(null)
  const [validationRoleFloor, setValidationRoleFloor] = useState<"reviewer" | "project_lead" | "maintainer">("reviewer")
  const [validationNamedUsers, setValidationNamedUsers] = useState<string[]>([])
  const [allowSelfValidation, setAllowSelfValidation] = useState(true)
  const [validationRoleFloorAudio, setValidationRoleFloorAudio] = useState<"reviewer" | "project_lead" | "maintainer" | null>(null)
  const [validationNamedUsersAudio, setValidationNamedUsersAudio] = useState<string[]>([])
  // AQU-1768: null = follow the organization's default.
  const [allowSelfValidationAudio, setAllowSelfValidationAudio] = useState<boolean | null>(null)
  const [cellEditingFloor, setCellEditingFloor] = useState<CellEditingTier | null>(null)
  const [allowTrackEditing, setAllowTrackEditing] = useState<boolean | null>(null)
  const [timingLocked, setTimingLocked] = useState<boolean | null>(null)
  // AQU-1768: the value in force for each — the project's own, else the
  // organization's default, else the built-in one. What the disabled control
  // shows while the project follows the organization, and where "Set for this
  // project" starts from.
  const effectiveTimingLocked = resolveTimingLocked({ timingLocked: timingLocked ?? orgMediaDefaults.timingLocked })
  // AQU-2214: the built-in default is ON — the project's own choice first, then
  // the organization's, then on.
  const effectiveAllowTrackEditing = allowTrackEditing ?? orgMediaDefaults.allowTrackEditing ?? true
  const effectiveCellEditingFloor: CellEditingTier = cellEditingFloor ?? orgMediaDefaults.cellEditingFloor ?? "none"
  // AQU-186: harmonize_min_role — project_lead floor, configurable up to maintainer.
  const [harmonizeMinRole, setHarmonizeMinRole] = useState<"project_lead" | "maintainer">("project_lead")
  // AQU-460: EXPLICIT persisted value only — `undefined` means no explicit
  // choice yet. The switch displays the DERIVED effective value (see render);
  // this state only ever holds what will be persisted on Save.
  const [bibleResourcesEnabled, setBibleResourcesEnabled] = useState<boolean | undefined>(undefined)
  // AQU-1686: explicit enrichment choices — same "persist only what was
  // chosen" contract as the switch above.
  const [bibleEnrichments, setBibleEnrichments] = useState<BibleEnrichmentSettings>({})
  const [decaySettings, setDecaySettings] = useState<DecaySettings | undefined>(undefined)
  const [audioMediaStrategy, setAudioMediaStrategy] = useState<AudioMediaStrategy>("lazy")
  const [precedingTargetCells, setPrecedingTargetCells] = useState(DEFAULT_DRAFT_CONTEXT.precedingTargetCells)
  // AQU-634: per-project USFM front-matter opt-out.
  const [importExcludeFrontMatter, setImportExcludeFrontMatter] = useState(false)
  // AQU-1720: paragraph-vs-sentence cell unit for docx/txt/md imports.
  const [importCellUnit, setImportCellUnit] = useState<CellUnit>("sentence")
  const [smartQuotes, setSmartQuotes] = useState(false)
  // AQU-1271: project-wide affix inventory for terminology prefix/suffix matching.
  const [termMatching, setTermMatching] = useState<TermMatchingSettings>({ prefixes: [], suffixes: [] })
  // Pre-merge round: the Media timeline's timing mode moved OUT of Project
  // Settings — it is FILE-level now (file.timing.set), controlled from the
  // timeline toolbar with the same maintainer floor.

  // Per-device user-scoped key — not part of the project record, not server-
  // synced, no race with the project save flow. Kept on its own immediate-save
  // path so the deferred-save bar isn't responsible for cross-project state.
  const completionUserKey = useUserApiKey("completion") ?? ""
  const geminiUserKey = useUserApiKey("gemini-tts") ?? ""

  // Gemini TTS API key — stored in ttsSettings.apiKey (project-level).
  const [geminiApiKey, setGeminiApiKey] = useState("")
  // AQU-2263: which key drafts and voices use right now — from what is SAVED
  // (the baseline), the Preferences override and this browser's own keys.
  const providerOverride = useUserProviderOverride()
  const completionInUse = completionKeyInUse({
    settings: baseline ? { provider: baseline.provider, endpoint: baseline.endpoint, apiKey: baseline.apiKey } : undefined,
    override: providerOverride,
    personalKey: completionUserKey,
  })
  const geminiInUse = geminiKeyInUse({
    projectKey: baseline?.geminiApiKey,
    personalKey: geminiUserKey,
    orgHasKey: Boolean(orgSettingsForProject.orgProviderKeys?.["gemini-tts"]),
  })

  const [models, setModels] = useState<string[]>([])
  const [connecting, setConnecting] = useState(false)
  const [connectionError, setConnectionError] = useState<string | null>(null)
  const [connected, setConnected] = useState(false)
  const lastModelFetchKeyRef = useRef<string | null>(null)

  const seededRef = useRef(false)
  // Snapshot of the first seed. Late blob adoption compares against this, not
  // against a baseline a save may already have replaced (AQU-1744).
  const seedBaselineRef = useRef<Baseline | null>(null)

  const applyBaseline = useCallback((b: Baseline) => {
    setName(b.name)
    setProvider(b.provider)
    setEndpoint(b.endpoint)
    setApiKey(b.apiKey)
    setPresetId(presetIdForEndpoint(b.endpoint))
    setModel(b.model)
    setMaxTokens(b.maxTokens)
    setTemperature(b.temperature)
    setTopK(b.top_k)
    setContextSize(b.contextSize)
    setUseOnlyValidatedExamples(true)
    setFewShotExampleFormat(b.fewShotExampleFormat)
    setMainChatLanguage(b.main_chat_language)
    setCompletionBatchSize(b.completionBatchSize)
    setValidationBatchSize(b.validationBatchSize)
    setAutoSyncEnabled(b.autoSyncEnabled)
    setAutoSyncInterval(b.autoSyncInterval)
    setValidationCount(b.validationCount)
    setValidationCountAudio(b.validationCountAudio)
    setValidationRoleFloor(b.validationRoleFloor)
    setValidationNamedUsers(b.validationNamedUsers)
    setAllowSelfValidation(b.allowSelfValidation)
    setValidationRoleFloorAudio(b.validationRoleFloorAudio)
    setValidationNamedUsersAudio(b.validationNamedUsersAudio)
    setAllowSelfValidationAudio(b.allowSelfValidationAudio)
    setCellEditingFloor(b.cellEditingFloor)
    setAllowTrackEditing(b.allowTrackEditing)
    setTimingLocked(b.timingLocked)
    setHarmonizeMinRole(b.harmonize_min_role)
    setBibleResourcesEnabled(b.bibleResourcesEnabled)
    setBibleEnrichments(b.bibleEnrichments)
    setDecaySettings(b.decaySettings)
    setAudioMediaStrategy(b.audioMediaStrategy)
    setGeminiApiKey(b.geminiApiKey)
    setPrecedingTargetCells(b.precedingTargetCells)
    setImportExcludeFrontMatter(b.importExcludeFrontMatter)
    setImportCellUnit(b.importCellUnit)
    setSmartQuotes(b.smartQuotes)
    setTermMatching(b.termMatching)
  }, [])

  // Seed once when the project first loads. We intentionally don't reseed on
  // every `project` identity change — background sync writes to IDB shouldn't
  // wipe the user's in-progress edits. After save/discard we reseed manually.
  //
  // `project` here has NO shared settings (`includeSettings: false` above), so
  // when this page's own settings GET has already landed, seed from the record
  // with the blob overlaid. Otherwise the shared-settings effect below settles
  // the shared fields once the GET lands.
  useEffect(() => {
    if (!project || seededRef.current) return
    const b = buildBaseline(
      sharedSettingsFetched ? overlaySettings(project, sharedSettingsBlob ?? {}) : project,
    )
    seedBaselineRef.current = b
    setBaseline(b)
    applyBaseline(b)
    seededRef.current = true
  }, [project, applyBaseline, sharedSettingsFetched, sharedSettingsBlob])

  // Settings that live ONLY in the shared settings blob never reach `project`
  // on this page: it passes `includeSettings: false` to `useProject` (it owns
  // the editable settings hook above, and a second overlay request would be a
  // duplicate GET), so `project` is `minimalProjectRecord` and the seed above
  // shows each of these at its default. A saved value then read back wrong
  // after every reload — languages blank (AQU-1115), Bible resources on for a
  // project that turned them off (AQU-460), switches off that the server has
  // on — and a user could "re-enable" something already enabled.
  //
  // Once this page's own settings GET has resolved, rebuild the baseline
  // through the same overlay the rest of the app reads with, and adopt it for
  // these keys. Once only, matching the "seed once" contract above.
  //
  // Adoption is against the original seed, not the baseline in this closure.
  // A field the user has already moved off that seed keeps their edit; the
  // baseline still moves when it is still the seed, so settling an untouched
  // field never reads as an edit. A successful save moves the saved keys off
  // the seed on both sides. Comparing to the closed-over baseline instead
  // treated that saved value as the thing to replace, so a GET that landed
  // after the save snapped the draft and the baseline back to the stale blob
  // (AQU-1744). `hasFetched` fails closed (stays false on a failed GET), so a
  // settings outage leaves the seeded values rather than blanking anything.
  const blobResyncedRef = useRef(false)
  useEffect(() => {
    if (!project || !baseline || !sharedSettingsFetched) return
    if (blobResyncedRef.current) return
    const seed = seedBaselineRef.current
    if (!seed) return
    blobResyncedRef.current = true
    if (!sharedSettingsBlob) return
    const hydrated = buildBaseline(overlaySettings(project, sharedSettingsBlob))
    const changed = BLOB_BACKED_KEYS.filter((key) => !sameSetting(hydrated[key], seed[key]))
    if (changed.length === 0) return
    const draftSetters: { [K in BlobBackedKey]: Dispatch<SetStateAction<Baseline[K]>> } = {
      provider: setProvider,
      endpoint: setEndpoint,
      model: setModel,
      maxTokens: setMaxTokens,
      temperature: setTemperature,
      top_k: setTopK,
      contextSize: setContextSize,
      main_chat_language: setMainChatLanguage,
      fewShotExampleFormat: setFewShotExampleFormat,
      completionBatchSize: setCompletionBatchSize,
      validationBatchSize: setValidationBatchSize,
      validationCount: setValidationCount,
      validationCountAudio: setValidationCountAudio,
      validationRoleFloor: setValidationRoleFloor,
      validationNamedUsers: setValidationNamedUsers,
      allowSelfValidation: setAllowSelfValidation,
      validationRoleFloorAudio: setValidationRoleFloorAudio,
      validationNamedUsersAudio: setValidationNamedUsersAudio,
      allowSelfValidationAudio: setAllowSelfValidationAudio,
      cellEditingFloor: setCellEditingFloor,
      allowTrackEditing: setAllowTrackEditing,
      timingLocked: setTimingLocked,
      harmonize_min_role: setHarmonizeMinRole,
      bibleResourcesEnabled: setBibleResourcesEnabled,
      bibleEnrichments: setBibleEnrichments,
      precedingTargetCells: setPrecedingTargetCells,
      importExcludeFrontMatter: setImportExcludeFrontMatter,
      importCellUnit: setImportCellUnit,
      smartQuotes: setSmartQuotes,
      termMatching: setTermMatching,
    }
    setBaseline((prev) => {
      if (!prev) return prev
      let moved = false
      const next = { ...prev }
      for (const key of changed) {
        // A save may already have replaced this key. Leave it: `prev` can be
        // the saved baseline even when this effect closed over the seed.
        if (!sameSetting(prev[key], seed[key])) continue
        adoptKey(next, hydrated, key)
        moved = true
      }
      return moved ? next : prev
    })
    const adoptDraft = <K extends BlobBackedKey>(key: K) => {
      const setter = draftSetters[key] as Dispatch<SetStateAction<Baseline[K]>>
      setter((prev) => (sameSetting(prev, seed[key]) ? hydrated[key] : prev))
    }
    for (const key of changed) adoptDraft(key)
    // The preset picker follows the endpoint, as it does when the page seeds.
    if (changed.includes("endpoint")) {
      setPresetId((prev) =>
        sameSetting(prev, presetIdForEndpoint(seed.endpoint)) ? presetIdForEndpoint(hydrated.endpoint) : prev,
      )
    }
  }, [project, baseline, sharedSettingsFetched, sharedSettingsBlob])

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
      if (list.length > 0 && !model) setModel(list[0])
      // Connect (and the auto-probe after a key/endpoint pause) is the moment
      // the user believes BYOK is ready. Persist this DEVICE's part at once —
      // the project's AI key and the "chooser answered" flag — so the
      // workspace sparkle gate stops asking. AQU-2259: the provider, endpoint
      // and model are the team's settings now, so they wait for "Save
      // changes" like every other shared field, rather than changing what
      // everyone drafts with because someone pressed Connect.
      if (id && provider === "custom" && apiKey.trim()) {
        const latest = (await getProject(id)) ?? project ?? undefined
        if (latest) {
          const nextCompletion = buildCompletionSettings(latest.completionSettings, {
            apiKey: apiKey.trim(),
          })
          await updateProject({
            ...latest,
            completionSettings: nextCompletion,
            aiProviderChosen: true,
          })
          setBaseline((prev) => (prev ? { ...prev, apiKey } : prev))
        }
      }
    } catch (err) {
      if (lastModelFetchKeyRef.current !== fetchKey) return
      setModels([])
      setConnected(false)
      setConnectionError(err instanceof Error ? err.message : "Connection failed")
    } finally {
      if (lastModelFetchKeyRef.current === fetchKey) setConnecting(false)
    }
  }, [apiKey, effectiveCompletionApiKey, endpoint, id, model, project, provider])

  const isDirty = useMemo(() => {
    if (!baseline) return false
    return (
      name !== baseline.name ||
      provider !== baseline.provider ||
      endpoint !== baseline.endpoint ||
      apiKey !== baseline.apiKey ||
      model !== baseline.model ||
      maxTokens !== baseline.maxTokens ||
      temperature !== baseline.temperature ||
      topK !== baseline.top_k ||
      contextSize !== baseline.contextSize ||
      useOnlyValidatedExamples !== baseline.useOnlyValidatedExamples ||
      fewShotExampleFormat !== baseline.fewShotExampleFormat ||
      mainChatLanguage !== baseline.main_chat_language ||
      completionBatchSize !== baseline.completionBatchSize ||
      validationBatchSize !== baseline.validationBatchSize ||
      autoSyncEnabled !== baseline.autoSyncEnabled ||
      autoSyncInterval !== baseline.autoSyncInterval ||
      validationCount !== baseline.validationCount ||
      validationCountAudio !== baseline.validationCountAudio ||
      validationRoleFloor !== baseline.validationRoleFloor ||
      JSON.stringify(validationNamedUsers) !== JSON.stringify(baseline.validationNamedUsers) ||
      allowSelfValidation !== baseline.allowSelfValidation ||
      validationRoleFloorAudio !== baseline.validationRoleFloorAudio ||
      JSON.stringify(validationNamedUsersAudio) !== JSON.stringify(baseline.validationNamedUsersAudio) ||
      allowSelfValidationAudio !== baseline.allowSelfValidationAudio ||
      cellEditingFloor !== baseline.cellEditingFloor ||
      allowTrackEditing !== baseline.allowTrackEditing ||
      timingLocked !== baseline.timingLocked ||
      harmonizeMinRole !== baseline.harmonize_min_role ||
      bibleResourcesEnabled !== baseline.bibleResourcesEnabled ||
      !sameSetting(bibleEnrichments, baseline.bibleEnrichments) ||
      audioMediaStrategy !== baseline.audioMediaStrategy ||
      !decayEqual(decaySettings, baseline.decaySettings) ||
      geminiApiKey !== baseline.geminiApiKey ||
      precedingTargetCells !== baseline.precedingTargetCells ||
      importExcludeFrontMatter !== baseline.importExcludeFrontMatter ||
      importCellUnit !== baseline.importCellUnit ||
      smartQuotes !== baseline.smartQuotes ||
      JSON.stringify(termMatching) !== JSON.stringify(baseline.termMatching)
    )
  }, [
    baseline, name, provider, endpoint, apiKey,
    model, maxTokens, temperature,
    topK, contextSize, useOnlyValidatedExamples, fewShotExampleFormat, mainChatLanguage,
    completionBatchSize, validationBatchSize,
    autoSyncEnabled, autoSyncInterval, validationCount, validationCountAudio,
    validationRoleFloor, validationNamedUsers, allowSelfValidation, cellEditingFloor,
    validationRoleFloorAudio, validationNamedUsersAudio, allowSelfValidationAudio,
    allowTrackEditing,
    timingLocked,
    harmonizeMinRole, bibleResourcesEnabled, bibleEnrichments, audioMediaStrategy, decaySettings, geminiApiKey,
    precedingTargetCells, importExcludeFrontMatter, importCellUnit, smartQuotes, termMatching,
  ])

  // Warn before browser-level navigation (back button, tab close, reload).
  useEffect(() => {
    if (!isDirty) return
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ""
    }
    window.addEventListener("beforeunload", handler)
    return () => window.removeEventListener("beforeunload", handler)
  }, [isDirty])

  const [discardOpen, setDiscardOpen] = useState(false)
  const [closeAfterDiscard, setCloseAfterDiscard] = useState(false)
  const [pendingHistoryDelta, setPendingHistoryDelta] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  // AQU-408: success message reflects the actual delta saved (a brief
  // enumeration of which fields changed), not a generic "Saved". Auto-dismisses
  // after a few seconds. The modal/page itself stays open on save — only an
  // explicit "Save and close" leaves it.
  const [savedMessage, setSavedMessage] = useState<string | null>(null)
  const savedMessageTimerRef = useRef<number | null>(null)
  useEffect(() => () => {
    if (savedMessageTimerRef.current != null) window.clearTimeout(savedMessageTimerRef.current)
  }, [])

  // Pending in-app navigation target. Set when the user clicks something that
  // would leave the page while dirty; cleared when they confirm discard (we
  // navigate) or cancel (we drop the target). The app uses classic
  // BrowserRouter, so useBlocker isn't available — instead every nav button
  // on this page routes through requestNavigate.
  const [pendingNav, setPendingNav] = useState<string | null>(null)
  const requestNavigate = useCallback((target: string) => {
    if (isDirty) {
      setPendingNav(target)
      setDiscardOpen(true)
    } else {
      navigate(target)
    }
  }, [isDirty, navigate])

  const closeSettings = useCallback(() => {
    if (isDirty) {
      setCloseAfterDiscard(true)
      setDiscardOpen(true)
      return
    }
    if (modal) navigate(-modalDepth)
    else navigate(editorPath)
  }, [editorPath, isDirty, modal, modalDepth, navigate])

  const requestHistoryNavigation = useCallback((delta: number) => {
    if (isDirty) {
      setPendingHistoryDelta(delta)
      setDiscardOpen(true)
      return
    }
    navigate(delta)
  }, [isDirty, navigate])

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
    setEndpoint(endpointForPresetChange(nextPresetId, endpoint))
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

  // ── Save orchestration ─────────────────────────────────────────────
  // Order matters: local IDB writes first (cheap, can't fail meaningfully),
  // then the shared/server PATCH (the only one that can 409). If the PATCH
  // fails we leave local writes in place — they're idempotent and not the
  // source of truth for shared fields anyway.
  const handleSave = useCallback(async (): Promise<boolean> => {
    if (!id || !baseline) return false
    setSaving(true)
    setSaveError(null)
    setSavedMessage(null)
    setNameError(null)
    // AQU-408: track which fields actually changed so the success message can
    // reflect the real delta saved, instead of a generic "Saved" that implies
    // everything on the page was written.
    const changedFieldLabels: string[] = []
    try {
      // AQU-2259: the drafting settings (the AI Instructions card), the model
      // choice and the Health penalty are the team's settings, so they go to
      // the shared settings below. Only the project's AI key stays on this
      // device, where it always lived.
      const completionUpdates: Partial<CompletionSettings> = {}
      if (apiKey !== baseline.apiKey) { completionUpdates.apiKey = apiKey || undefined; changedFieldLabels.push(t("projectSettings.field.apiKey")) }
      let draftingChanged = false
      const noteDrafting = (changed: boolean, label: string) => {
        if (!changed) return
        draftingChanged = true
        changedFieldLabels.push(label)
      }
      noteDrafting(provider !== baseline.provider, t("projectSettings.field.aiProvider"))
      noteDrafting(endpoint.trim() !== baseline.endpoint, t("projectSettings.field.endpoint"))
      noteDrafting(model !== baseline.model, t("projectSettings.field.model"))
      noteDrafting(maxTokens !== baseline.maxTokens, t("projectSettings.field.maxTokens"))
      noteDrafting(temperature !== baseline.temperature, t("projectSettings.field.temperature"))
      noteDrafting(topK !== baseline.top_k, t("projectSettings.field.examplesRetrieved"))
      noteDrafting(contextSize !== baseline.contextSize, t("projectSettings.field.contextWindow"))
      noteDrafting(useOnlyValidatedExamples !== baseline.useOnlyValidatedExamples, t("projectSettings.field.validatedExamplesOnly"))
      noteDrafting(fewShotExampleFormat !== baseline.fewShotExampleFormat, t("projectSettings.field.referenceExampleFormat"))
      noteDrafting(mainChatLanguage !== baseline.main_chat_language, t("projectSettings.field.assistedLanguage"))
      noteDrafting(completionBatchSize !== baseline.completionBatchSize, t("projectSettings.field.completionBatchSize"))
      noteDrafting(validationBatchSize !== baseline.validationBatchSize, t("projectSettings.field.validationBatchSize"))

      const localUpdates: Partial<ProjectRecord> = {}
      // AQU-765: rename. Trim first so a whitespace-only entry is rejected
      // (visible validation) rather than persisted. For a synced project the
      // server's `projects.name` is the source of truth every surface reads
      // (org list, breadcrumbs, portfolio, search), so push the rename there
      // before mirroring it into the local IDB record below. Local projects
      // skip the server call — their IDB record IS the source of truth.
      const trimmedName = name.trim()
      if (trimmedName !== baseline.name) {
        if (!trimmedName) {
          setNameError(t("projectSettings.save.nameRequired"))
          return false
        }
        if (isCloudProject) {
          const jwt = getJwt()
          if (!jwt) {
            setSaveError(t("projectSettings.save.signedOutRenameError"))
            return false
          }
          try {
            await renameProject(jwt, id, trimmedName)
          } catch (err) {
            if (err instanceof UserError && err.status === 403) {
              setSaveError(t("projectSettings.permission.onlyRoleCanModify", {
                role: resolveRoleName(t, ROLE.MAINTAINER, { plural: true }),
              }))
            } else {
              setSaveError(err instanceof Error ? err.message : t("projectSettings.save.renameFailedGeneric"))
            }
            return false
          }
        }
        localUpdates.name = trimmedName
        changedFieldLabels.push(t("projectSettings.field.projectName"))
      }
      if (!decayEqual(decaySettings, baseline.decaySettings)) { localUpdates.decaySettings = decaySettings; changedFieldLabels.push(t("projectSettings.field.decaySettings")) }
      if (audioMediaStrategy !== baseline.audioMediaStrategy) { localUpdates.audioMediaStrategy = audioMediaStrategy; changedFieldLabels.push(t("projectSettings.field.audioMediaStrategy")) }
      // geminiApiKey handled below after `latest` is fetched, so voices/castAssignments are preserved.
      if (
        autoSyncEnabled !== baseline.autoSyncEnabled ||
        autoSyncInterval !== baseline.autoSyncInterval
      ) {
        localUpdates.syncSettings = {
          autoSync: { enabled: autoSyncEnabled, intervalMinutes: Math.max(1, autoSyncInterval) },
        }
        changedFieldLabels.push(t("projectSettings.field.autoSync"))
      }

      const geminiKeyChanged = geminiApiKey !== baseline.geminiApiKey
      if (geminiKeyChanged) changedFieldLabels.push(t("projectSettings.field.voiceApiKey"))
      const hasLocalWork =
        Object.keys(localUpdates).length > 0 || Object.keys(completionUpdates).length > 0 || geminiKeyChanged
        || draftingChanged
      if (hasLocalWork) {
        const latest = (await getProject(id)) ?? project ?? undefined
        if (!latest) throw new Error("Project not found")
        const nextCompletion = Object.keys(completionUpdates).length
          ? buildCompletionSettings(latest.completionSettings, completionUpdates)
          : latest.completionSettings
        // Merge geminiApiKey into ttsSettings so voices/castAssignments are preserved.
        const nextTtsSettings = geminiKeyChanged
          ? { ...latest.ttsSettings, apiKey: geminiApiKey || undefined }
          : latest.ttsSettings
        await updateProject({
          ...latest,
          ...localUpdates,
          completionSettings: nextCompletion,
          ttsSettings: nextTtsSettings,
          ...(Object.keys(completionUpdates).length > 0 || draftingChanged ? { aiProviderChosen: true } : {}),
        })
      }

      const sharedUpdates: ProjectWideSettings = {}
      // AQU-2259: the whole drafting value, not only the changed fields — the
      // key is replaced as one object, so a partial one would reset the rest.
      if (draftingChanged) {
        sharedUpdates.draftingSettings = draftingSettingsFrom({
          provider,
          endpoint: endpoint.trim(),
          model,
          maxTokens,
          temperature,
          top_k: topK,
          contextSize,
          useOnlyValidatedExamples,
          main_chat_language: mainChatLanguage,
          fewShotExampleFormat,
          completionBatchSize,
          validationBatchSize,
        })
      }
      // AQU-1771: null → undefined, which the merged blob drops: the project
      // goes back to the organization's default.
      if (validationCount !== baseline.validationCount) { sharedUpdates.validationCount = validationCount ?? undefined; changedFieldLabels.push(t("projectSettings.field.validationCount")) }
      if (validationCountAudio !== baseline.validationCountAudio) {
        sharedUpdates.validationCountAudio = validationCountAudio ?? undefined
        changedFieldLabels.push(t("projectSettings.field.audioValidationCount"))
      }
      if (validationRoleFloor !== baseline.validationRoleFloor) { sharedUpdates.validationRoleFloor = validationRoleFloor; changedFieldLabels.push(t("projectSettings.field.validationRoleFloor")) }
      if (JSON.stringify(validationNamedUsers) !== JSON.stringify(baseline.validationNamedUsers)) {
        sharedUpdates.validationNamedUsers = validationNamedUsers
        changedFieldLabels.push(t("projectSettings.field.namedValidators"))
      }
      if (allowSelfValidation !== baseline.allowSelfValidation) { sharedUpdates.allowSelfValidation = allowSelfValidation; changedFieldLabels.push(t("projectSettings.field.selfValidation")) }
      // AQU-1768: null → undefined, which the merged blob drops: the project
      // goes back to the organization's default, as the counts above do.
      if (validationRoleFloorAudio !== baseline.validationRoleFloorAudio) { sharedUpdates.validationRoleFloorAudio = validationRoleFloorAudio ?? undefined; changedFieldLabels.push(t("projectSettings.field.audioValidationRoleFloor")) }
      if (JSON.stringify(validationNamedUsersAudio) !== JSON.stringify(baseline.validationNamedUsersAudio)) { sharedUpdates.validationNamedUsersAudio = validationNamedUsersAudio; changedFieldLabels.push(t("projectSettings.field.namedAudioValidators")) }
      if (allowSelfValidationAudio !== baseline.allowSelfValidationAudio) { sharedUpdates.allowSelfValidationAudio = allowSelfValidationAudio ?? undefined; changedFieldLabels.push(t("projectSettings.field.selfValidationAudio")) }
      if (cellEditingFloor !== baseline.cellEditingFloor) { sharedUpdates.cellEditingFloor = cellEditingFloor ?? undefined; changedFieldLabels.push(t("projectSettings.field.cellEditingFloor")) }
      if (allowTrackEditing !== baseline.allowTrackEditing) { sharedUpdates.allowTrackEditing = allowTrackEditing ?? undefined; changedFieldLabels.push(t("projectSettings.field.trackEditing")) }
      if (timingLocked !== baseline.timingLocked) { sharedUpdates.timingLocked = timingLocked ?? undefined; changedFieldLabels.push(t("projectSettings.field.timingLock")) }
      if (harmonizeMinRole !== baseline.harmonize_min_role) { sharedUpdates.harmonize_min_role = harmonizeMinRole; changedFieldLabels.push(t("projectSettings.field.harmonizeMinRole")) }
      if (bibleResourcesEnabled !== baseline.bibleResourcesEnabled) { sharedUpdates.bibleResourcesEnabled = bibleResourcesEnabled; changedFieldLabels.push(t(isBibleDataExperimentOn(project) ? "projectSettings.field.bibleData" : "projectSettings.field.bibleResources")) }
      if (!sameSetting(bibleEnrichments, baseline.bibleEnrichments)) { sharedUpdates.bibleEnrichments = bibleEnrichments; changedFieldLabels.push(t("projectSettings.field.bibleEnrichments")) }
      if (importExcludeFrontMatter !== baseline.importExcludeFrontMatter) { sharedUpdates.importExcludeFrontMatter = importExcludeFrontMatter; changedFieldLabels.push(t("projectSettings.field.usfmFrontMatter")) }
      if (importCellUnit !== baseline.importCellUnit) { sharedUpdates.importCellUnit = importCellUnit; changedFieldLabels.push(t("projectSettings.field.importCellUnit")) }
      if (smartQuotes !== baseline.smartQuotes) { sharedUpdates.smartQuotes = smartQuotes; changedFieldLabels.push(t("projectSettings.field.smartQuotes")) }
      if (precedingTargetCells !== baseline.precedingTargetCells) {
        sharedUpdates.draftContext = { precedingTargetCells }
        changedFieldLabels.push(t("projectSettings.field.draftContext"))
      }
      if (JSON.stringify(termMatching) !== JSON.stringify(baseline.termMatching)) {
        sharedUpdates.termMatching = termMatching
        changedFieldLabels.push(t("projectSettings.field.termMatching"))
      }

      if (Object.keys(sharedUpdates).length > 0) {
        // AQU-1767 phase 2: the save is one history step. What each setting held
        // before is the server's blob as this page last read it.
        const beforeBlob = (sharedSettingsBlob ?? {}) as Record<string, unknown>
        const out = await patchShared(sharedUpdates)
        if (out.kind === "ok") {
          recordStep({
            kind: "settings.project",
            data: {
              changes: Object.entries(sharedUpdates).map(([key, after]) => ({ key, before: beforeBlob[key] ?? null, after })),
            },
            labelKey: "editor.history.stepSettings",
            labelParams: { count: Object.keys(sharedUpdates).length },
          }, id ? { projectId: id, username: authorNameFor(session?.username, project?.username) } : undefined)
        }
        if (out.kind === "conflict") {
          toast.add({
            type: "warning",
            title: t("projectSettings.save.conflictToast", {
              username: settingsEditorName(out.latest.updatedBy) ?? t("projectSettings.save.conflictFallbackUsername"),
            }),
          })
          setSaveError(t("projectSettings.save.conflictError"))
          return false
        }
        if (out.kind === "blocked") {
          if (out.reason === "offline") {
            setSaveError(t("projectSettings.save.offlineError"))
          } else {
            setSaveError(t("projectSettings.permission.onlyRoleCanModify", {
              role: resolveRoleName(t, ROLE.MAINTAINER, { plural: true }),
            }))
          }
          return false
        }
        if (out.kind === "error") {
          setSaveError(out.message || t("projectSettings.save.sharedSettingsFailedGeneric"))
          return false
        }
      }

      // Re-baseline from current form state. Reading IDB here was racy —
      // `patchShared` mirrors shared fields to IDB via a fire-and-forget write
      // that hasn't necessarily flushed yet, so the read would return stale
      // values and `applyBaseline` would wipe what the user just saved. We
      // wrote the values; we know what they are.
      // AQU-765: re-baseline (and reflect in the input) with the trimmed name
      // we actually persisted, so the canonical value doesn't read back dirty.
      if (trimmedName !== name) setName(trimmedName)
      // Built from this callback's closure — the draft at click time, not a
      // settings GET that resolved while the PATCH was in flight. That GET
      // may already have moved untouched blob keys onto the baseline and the
      // draft. Replacing the baseline wholesale would put those keys back to
      // the seed and leave the form dirty (AQU-1744).
      const newBaseline: Baseline = {
        name: trimmedName,
        provider,
        endpoint: endpoint.trim(),
        apiKey,
        model,
        maxTokens,
        temperature,
        top_k: topK,
        contextSize,
        useOnlyValidatedExamples,
        fewShotExampleFormat,
        main_chat_language: mainChatLanguage,
        completionBatchSize,
        validationBatchSize,
        autoSyncEnabled,
        autoSyncInterval: Math.max(1, autoSyncInterval),
        validationCount,
        validationCountAudio,
        validationRoleFloor,
        validationNamedUsers,
        allowSelfValidation,
        validationRoleFloorAudio,
        validationNamedUsersAudio,
        allowSelfValidationAudio,
        cellEditingFloor,
        allowTrackEditing,
        timingLocked,
        harmonize_min_role: harmonizeMinRole,
        bibleResourcesEnabled,
        bibleEnrichments,
        decaySettings,
        audioMediaStrategy,
        geminiApiKey,
        precedingTargetCells,
        importExcludeFrontMatter,
        importCellUnit,
        smartQuotes,
        termMatching,
      }
      setBaseline((prev) => {
        const next: Baseline = { ...newBaseline }
        if (!prev) return next
        for (const key of BLOB_BACKED_KEYS) {
          if (sameSetting(newBaseline[key], baseline[key]) && !sameSetting(prev[key], newBaseline[key])) {
            adoptKey(next, prev, key)
          }
        }
        return next
      })
      // Refresh `useProject` in the background so other components see the
      // updated IDB record. We don't await it — the form is already correct.
      refresh()

      // AQU-408 acceptance criterion: the success message reflects the actual
      // delta saved (a brief enumeration of which fields changed), and the
      // page/modal stays open afterward — callers decide separately whether
      // to also navigate away (see handleSaveAndClose).
      const message =
        changedFieldLabels.length === 0
          ? t("projectSettings.save.noChanges")
          : changedFieldLabels.length <= 3
            ? t("projectSettings.save.savedShort", { list: changedFieldLabels.join(", ") })
            : t("projectSettings.save.savedMany", {
                count: changedFieldLabels.length,
                list: changedFieldLabels.slice(0, 3).join(", "),
                more: changedFieldLabels.length - 3,
              })
      setSavedMessage(message)
      if (savedMessageTimerRef.current != null) window.clearTimeout(savedMessageTimerRef.current)
      savedMessageTimerRef.current = window.setTimeout(() => setSavedMessage(null), 4000)
      return true
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err))
      return false
    } finally {
      setSaving(false)
    }
  }, [
    id, baseline, name, provider, endpoint, apiKey,
    model, maxTokens, temperature,
    topK, contextSize, useOnlyValidatedExamples, fewShotExampleFormat, mainChatLanguage,
    completionBatchSize, validationBatchSize,
    autoSyncEnabled, autoSyncInterval, validationCount, validationCountAudio,
    validationRoleFloor, validationNamedUsers, allowSelfValidation, harmonizeMinRole,
    // AQU-490. The note directly below is about exactly this list: handleSave
    // closes over these, so a field missing here is a field whose change the
    // save silently never sees.
    validationRoleFloorAudio, validationNamedUsersAudio, allowSelfValidationAudio,
    // AQU-1068. Its predecessor `allowLineCreation` was missing from this list
    // too, and the bug is invisible until you try it: handleSave closes over a
    // stale value, the diff below sees no change, `sharedUpdates` comes out
    // empty and NO REQUEST IS SENT AT ALL. The button reacts, the header keeps
    // saying "Unsaved changes", and nothing in the console complains. The unit
    // test does not catch it either — an unrelated re-render refreshes the
    // closure in happy-dom — so exhaustive-deps is the only guard, and it is a
    // warning among hundreds. `timingLocked` had the same hole: the timing
    // LOCK, the one safeguard AQU-646 added, could silently fail to save.
    // `allowTrackEditing` arrived with PR #474 carrying the same hole, and the
    // merge that brought it here is where it became visible — dev's own
    // handleSave list never named it either.
    cellEditingFloor, timingLocked, allowTrackEditing,
    bibleResourcesEnabled, bibleEnrichments, audioMediaStrategy, decaySettings, geminiApiKey, patchShared, refresh, applyBaseline, project,
    precedingTargetCells, importExcludeFrontMatter, importCellUnit, smartQuotes, termMatching, getJwt, isCloudProject, t,
  ])

  const handleSaveAndClose = useCallback(async () => {
    const ok = await handleSave()
    // `saveError` from the render closure is stale (set inside handleSave
    // during this same tick); rely on the returned boolean instead.
    if (!ok) return
    if (modal) navigate(-modalDepth)
    else navigate(editorPath)
  }, [handleSave, navigate, editorPath, modal, modalDepth])

  const handleDiscardConfirm = useCallback(() => {
    if (baseline) applyBaseline(baseline)
    setDiscardOpen(false)
    if (closeAfterDiscard) {
      setCloseAfterDiscard(false)
      setPendingNav(null)
      if (modal) navigate(-modalDepth)
      else navigate(editorPath)
      return
    }
    if (pendingHistoryDelta != null) {
      setPendingHistoryDelta(null)
      setPendingNav(null)
      navigate(pendingHistoryDelta)
      return
    }
    const target = pendingNav ?? editorPath
    setPendingNav(null)
    navigate(target)
  }, [baseline, applyBaseline, closeAfterDiscard, pendingHistoryDelta, pendingNav, navigate, editorPath, modal, modalDepth])

  const handleDiscardCancel = useCallback(() => {
    setDiscardOpen(false)
    setCloseAfterDiscard(false)
    setPendingHistoryDelta(null)
    setPendingNav(null)
  }, [])

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
    { id: "section-link-source", label: t("projectSettings.section.linkSource"), keywords: ["source", "link", "linked", "upstream", "attach", "share source", "mirror"], visible: !hasSourceLink },
    { id: "section-source-link", label: t("projectSettings.section.sourceLink"), keywords: ["source", "linked", "upstream", "detach"], visible: hasSourceLink },
    { id: "section-inherited-settings", label: t("projectSettings.section.inheritedSettings"), keywords: ["inherit", "copy", "brief", "knowledge", "workflow", "detach", "upstream"], visible: hasSourceLink },
    { id: "section-upstream-changes", label: t("projectSettings.section.upstreamChanges"), keywords: ["upstream", "changes", "repin", "review", "mirror", "stale"], visible: hasLiveSourceLink },
    { id: "section-dcs-upstream", label: t("projectSettings.section.dcsUpstream"), keywords: ["door43", "dcs", "unfoldingword", "upstream", "check for updates", "import changes", "release"], visible: hasDcsUpstream },
    { id: "section-project-info", label: t("projectSettings.section.projectInfo"), keywords: ["name", "source language", "target language", "smart quotes", "curly quotes", "quotation marks", "typography"] },
    // AQU-1688: the Language profile for checks lives here too, while this
    // device has the Bible data experiment on (AQU-1685).
    {
      id: "section-languages",
      label: t("projectSettings.section.languages"),
      keywords: [
        "languages", "target lanes", "lane", "target language", "dialect",
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
      : { id: "section-bible-resources", label: t("projectSettings.section.bibleResources"), keywords: ["bible resources", "aquifer", "bibletranslation", "reference", "scholarly", "translation notes"] },
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
    { id: "section-ai-instructions", label: t("projectSettings.section.aiInstructions"), keywords: ["ai", "llm", "instructions", "batch size", "completions batch", "validation batch", "batch validate", "top_k", "examples", "context window", "assistant language", "few shot"] },
    { id: "section-draft-context", label: t("projectSettings.section.draftContext"), keywords: ["draft context", "preceding cells", "left context", "paragraph drafting", "context budget"] },
    { id: "section-advanced-llm", label: t("projectSettings.section.advancedLlm"), keywords: ["provider", "endpoint", "api key", "model", "temperature", "max tokens", "health penalty", "frontier", "openai", "custom"] },
    { id: "section-voice", label: t("projectSettings.section.voice"), keywords: ["tts", "voice studio", "audio", "gemini", "api key", "tts key"] },
    { id: "section-local-models", label: t("projectSettings.section.localModels"), keywords: ["whisper", "mms", "transcription", "model", "download", "offline", "local ai"] },
    { id: "section-validation", label: t("projectSettings.section.validation"), keywords: ["validation count", "approvals", "audio validation"] },
    { id: "section-decay", label: t("projectSettings.decay.summary"), keywords: ["health", "decay", "decay threshold", "half life", "retrieval support", "max hops", "attention threshold"] },
    { id: "section-audio-media", label: t("projectSettings.section.audioMedia"), keywords: ["audio loading", "media", "audio media", "lazy", "eager", "stream"] },
    { id: "section-timeline", label: t("editor.timeline.title"), keywords: ["timeline", "add line", "create cell", "silence", "dubbing", "lines", "track", "tracks", "multi-track", "folder", "colour", "color"] },
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
      description: t(bibleDataExperiment
        ? "projectSettings.group.generalDescriptionBibleData"
        : "projectSettings.group.generalDescription"),
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

  const headerActions = (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {isDirty ? (
        <ButtonGroup>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? (
              <Spinner data-icon="inline-start" aria-hidden="true" />
            ) : (
              <Save data-icon="inline-start" />
            )}
            {t("common.saveChanges")}
          </Button>
          <ButtonGroupSeparator />
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                // "icon", not "icon-sm": the group lines its halves up, so the
                // arrow must be as tall as "Save changes" beside it.
                <Button
                  size="icon"
                  disabled={saving}
                  aria-label={t("projectSettings.moreSaveOptionsAriaLabel")}
                >
                  <ChevronDown />
                </Button>
              }
            />
            <DropdownMenuContent align="end" className="min-w-56">
              <DropdownMenuGroup>
                <DropdownMenuItem onClick={handleSaveAndClose}>
                  {t("projectSettings.saveAndClose")}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setDiscardOpen(true)}>
                  {t("projectSettings.closeWithoutSaving")}
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </ButtonGroup>
      ) : null}
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        {isDirty && !saving && <span>{t("projectSettings.unsavedChanges")}</span>}
        {!isDirty && savedMessage && (
          <span
            role="status"
            className="flex items-center gap-1 text-green-600 dark:text-green-400"
          >
            <Check className="size-3.5" /> {savedMessage}
          </span>
        )}
        {saveError && <span className="text-destructive">{saveError}</span>}
      </div>
    </div>
  )

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

        {sharedConflict && (
          <div
            role="alert"
            className="flex items-start justify-between gap-3 rounded border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100"
          >
            <span>{t("projectSettings.settingsChangedElsewhere")}</span>
            <button
              type="button"
              aria-label={t("projectSettings.dismissConflictAriaLabel")}
              onClick={dismissConflict}
              className="shrink-0 text-amber-700 hover:text-amber-900 dark:text-amber-400 dark:hover:text-amber-200"
            >
              ✕
            </button>
          </div>
        )}
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
              canEdit={canEditShared}
              locked={sharedDisabledTooltip}
              onPatch={patchShared}
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
                    <Input
                      id="pname"
                      value={name}
                      onChange={(e) => {
                        setName(e.target.value)
                        if (nameError) setNameError(null)
                      }}
                      disabled={!canRenameProject || saving}
                      aria-invalid={nameError ? true : undefined}
                      aria-label={t("projectSettings.info.titleLabel")}
                      className="w-56 bg-background"
                    />
                  </DisabledFieldTooltip>
                }
              />
              {nameError ? (
                <p role="alert" className="px-4 pb-2 text-xs text-destructive">
                  {nameError}
                </p>
              ) : null}
              <SettingsRow
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
                      onCheckedChange={(checked) => setSmartQuotes(checked)}
                      disabled={!canEditShared}
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
            canEdit={canEditShared}
            disabledTooltip={sharedDisabledTooltip ?? null}
            patch={patchShared}
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
            canEdit={canEditShared}
            disabledTooltip={sharedDisabledTooltip ?? null}
            username={session?.username ?? ""}
            patch={patchShared}
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
                      disabled={!canEditShared}
                      onChange={(inherit) => setCellEditingFloor(inherit ? null : effectiveCellEditingFloor)}
                    />
                    <Select
                      items={CELL_EDITING_FLOOR_OPTIONS.map((o) => ({
                        value: o.value,
                        label: (o.level != null ? FLOOR_LABEL[o.level] : undefined) ?? t(o.labelKey),
                      }))}
                      disabled={!canEditShared}
                      value={effectiveCellEditingFloor}
                      onValueChange={(value) =>
                        setCellEditingFloor((value ?? effectiveCellEditingFloor) as CellEditingTier)
                      }
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
              onSwitchChange={setBibleResourcesEnabled}
              enrichments={bibleEnrichments}
              onEnrichmentChange={(enrichment, checked) =>
                setBibleEnrichments((prev) => ({ ...prev, [enrichment]: checked }))
              }
              hasScriptureFiles={projectHasScriptureFiles(project?.files)}
              canEdit={canEditShared}
              lockedTooltip={sharedDisabledTooltip ?? null}
              // The project-wide opt-in, or the legacy device-local flag that
              // useProject overlays onto the record (AQU-1246).
              autopilotOn={isAutopilotVisible({
                autopilotEnabled: sharedSettingsBlob.autopilotEnabled,
                experimentalFlags: project?.experimentalFlags,
              })}
              // Through requestNavigate, so unsaved edits get the discard prompt.
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
                label={<label htmlFor="import-exclude-front-matter">{t("projectSettings.import.excludeFrontMatterLabel")}</label>}
                description={t("projectSettings.import.excludeFrontMatterDescription")}
                control={
                  <DisabledFieldTooltip disabled={!canEditShared} tooltip={sharedDisabledTooltip ?? null}>
                    <Switch
                      id="import-exclude-front-matter"
                      checked={importExcludeFrontMatter}
                      onCheckedChange={(checked) => setImportExcludeFrontMatter(checked)}
                      disabled={!canEditShared}
                      aria-label={t("projectSettings.import.excludeFrontMatterLabel")}
                    />
                  </DisabledFieldTooltip>
                }
              />
              {/* AQU-1720: a dubbing project generates one voice clip per cell,
                  so the cell has to be able to BE the paragraph. */}
              <SettingsRow
                label={<label htmlFor="import-cell-unit">{t("projectSettings.import.cellUnitLabel")}</label>}
                description={t("projectSettings.import.cellUnitDescription")}
                control={
                  <DisabledFieldTooltip disabled={!canEditShared} tooltip={sharedDisabledTooltip ?? null}>
                    <Select
                      items={IMPORT_CELL_UNIT_OPTIONS.map((o) => ({ value: o.value, label: t(o.labelKey) }))}
                      disabled={!canEditShared}
                      value={importCellUnit}
                      onValueChange={(value) => setImportCellUnit((value ?? importCellUnit) as CellUnit)}
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
              canEdit={canEditShared}
              disabledTooltip={sharedDisabledTooltip ?? undefined}
              onPatch={patchShared}
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
                      ? t("projectSettings.hint.custom")
                      : t("projectSettings.hint.default")
                  }
                />
              </NavList>
            ) : null}
            <SettingsGroup label={t("projectSettings.section.aiInstructions")} description={sharedLockedLine}>
              <SettingsRow
                label={<label htmlFor="top-k">{t("projectSettings.ai.topKLabel")}</label>}
                description={t("projectSettings.ai.topKDescription", { defaultCount: DEFAULT_APPROVED_EXAMPLE_COUNT })}
                control={
                  <Input
                    id="top-k"
                    disabled={!canEditShared}
                    type="number"
                    min={1}
                    max={20}
                    value={topK}
                    onChange={(e) => setTopK(Math.max(1, Math.min(20, Number(e.target.value))))}
                    aria-label={t("projectSettings.ai.topKLabel")}
                    className="w-24 bg-background"
                  />
                }
              />
              <SettingsRow
                label={<label htmlFor="completion-batch-size">{t("projectSettings.ai.completionBatchSizeLabel")}</label>}
                description={t("projectSettings.ai.completionBatchSizeDescription", { defaultSize: MAX_BATCH_COMPLETIONS })}
                control={

                  <Input
                    id="completion-batch-size"
                    disabled={!canEditShared}
                    type="number"
                    min={1}
                    max={50}
                    value={completionBatchSize}
                    onChange={(e) =>
                      setCompletionBatchSize(Math.max(1, Math.min(50, Number(e.target.value) || 1)))
                    }
                    aria-label={t("projectSettings.ai.completionBatchSizeLabel")}
                    className="w-24 bg-background"
                  />
                }
              />
              <SettingsRow
                label={<label htmlFor="validation-batch-size">{t("projectSettings.ai.validationBatchSizeLabel")}</label>}
                description={withStyledTerms(
                  t("projectSettings.ai.validationBatchSizeHelp", {
                    zeroNote: t("projectSettings.ai.validationBatchSizeZeroNote"),
                  }),
                  [{ text: t("projectSettings.ai.validationBatchSizeZeroNote"), as: "strong" }],
                )}
                control={
                  <Input
                    id="validation-batch-size"
                    disabled={!canEditShared}
                    type="number"
                    min={0}
                    max={500}
                    value={validationBatchSize}
                    onChange={(e) =>
                      setValidationBatchSize(Math.max(0, Math.min(500, Number(e.target.value) || 0)))
                    }
                    aria-label={t("projectSettings.ai.validationBatchSizeLabel")}
                    className="w-24 bg-background"
                  />
                }
              />
              <SettingsRow
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
                    onValueChange={(value) => setContextSize(value as ContextSize)}
                    disabled={!canEditShared}
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
                label={<label htmlFor="main-chat-language">{t("projectSettings.ai.assistantLanguageLabel")}</label>}
                description={t("projectSettings.ai.assistantLanguageDescription")}
                control={
                  <Input
                    id="main-chat-language"
                    disabled={!canEditShared}
                    value={mainChatLanguage}
                    onChange={(e) => setMainChatLanguage(e.target.value)}
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
                label={<label htmlFor="few-shot-example-format">{t("projectSettings.ai.referenceExampleFormatLabel")}</label>}
                description={t("projectSettings.ai.referenceExampleFormatDescription")}
                control={
                  <Select
                    items={{
                      "source-and-target": t("projectSettings.ai.referenceExampleFormatSourceAndTarget"),
                      "target-only": t("projectSettings.ai.referenceExampleFormatTargetOnly"),
                    }}
                    value={fewShotExampleFormat}
                    onValueChange={(value) => setFewShotExampleFormat(value as "source-and-target" | "target-only")}
                    disabled={!canEditShared}
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
                label={<label htmlFor="preceding-target-cells">{t("projectSettings.draftContext.precedingCellsLabel")}</label>}
                description={t("projectSettings.draftContext.precedingCellsDescription", {
                  defaultCount: DEFAULT_DRAFT_CONTEXT.precedingTargetCells,
                })}
                control={
                  <Input
                    id="preceding-target-cells"
                    type="number"
                    min={0}
                    max={10}
                    value={precedingTargetCells}
                    onChange={(e) =>
                      setPrecedingTargetCells(
                        Math.max(0, Math.min(10, Number(e.target.value))),
                      )
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
                label={t("projectSettings.advancedLlm.providerLabel")}
                description={<KeyInUseLine purpose="completion" kind={completionInUse} testId="completion-key-in-use" />}
                block
              >
                <RadioGroup
                  name="provider"
                  value={provider}
                  onValueChange={(value) => setProvider(value as CompletionProvider)}
                  disabled={!canEditShared}
                  className="flex flex-col gap-2"
                >
                  <label className="flex items-start gap-2 text-sm">
                    <RadioGroupItem value="frontier" className="mt-1" />
                    <span>
                      {withStyledTerms(
                        t("projectSettings.advancedLlm.providerFrontier", {
                          name: t("projectSettings.advancedLlm.providerFrontierName"),
                          domain: "api.frontierrnd.com",
                        }),
                        [
                          { text: t("projectSettings.advancedLlm.providerFrontierName"), as: "strong" },
                          { text: "api.frontierrnd.com", as: "code" },
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
                        disabled={!canEditShared}
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
                      <Input
                        id="ep"
                        value={endpoint}
                        onChange={(e) => {
                          setEndpoint(e.target.value)
                          setPresetId(presetIdForEndpoint(e.target.value))
                          setConnected(false)
                          setConnectionError(null)
                          setModels([])
                          lastModelFetchKeyRef.current = null
                        }}
                        placeholder="http://localhost:8000"
                        disabled={!canEditShared}
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
                      onProjectKeyChange={setApiKey}
                      onUserKeyChange={(v) => setUserApiKey("completion", v)}
                      help="Sent as Authorization: Bearer <key>. Stored locally in your browser; never uploaded to Frontier."
                    />
                  </SettingsRow>
                  {models.length > 0 && (
                    <SettingsRow
                      label={<label htmlFor="mdl">{t("projectSettings.advancedLlm.modelLabel")}</label>}
                      control={
                        <Select value={model} onValueChange={(value) => setModel(value ?? "")} disabled={!canEditShared}>
                          <SelectTrigger id="mdl" aria-label={t("projectSettings.advancedLlm.modelLabel")} className="w-56 bg-background">
                            <SelectValue />
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
                      label={<label htmlFor="mdl-manual">{t("projectSettings.advancedLlm.modelManualLabel")}</label>}
                      description={withStyledTerms(
                        t("projectSettings.advancedLlm.modelManualHelp", { modelsPath: "/models" }),
                        [{ text: "/models", as: "code" }],
                      )}
                      control={
                        <Input
                          id="mdl-manual"
                    disabled={!canEditShared}
                          value={model}
                          onChange={(e) => setModel(e.target.value)}
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
                    <Input
                      id="mdl-frontier"
                    disabled={!canEditShared}
                      value={model}
                      onChange={(e) => setModel(e.target.value)}
                      placeholder={t("projectSettings.advancedLlm.modelOverridePlaceholder")}
                      aria-label={t("projectSettings.advancedLlm.modelOverrideName")}
                      className="w-56 bg-background"
                    />
                  }
                />
              )}

              <SettingsRow
                label={<label htmlFor="mt">{t("projectSettings.advancedLlm.maxTokensLabel")}</label>}
                control={
                  <Input
                    id="mt"
                    disabled={!canEditShared}
                    type="number"
                    value={maxTokens}
                    onChange={(e) => setMaxTokens(Number(e.target.value))}
                    aria-label={t("projectSettings.advancedLlm.maxTokensLabel")}
                    className="w-24 bg-background"
                  />
                }
              />
              <SettingsRow
                label={t("projectSettings.advancedLlm.temperatureLabel", { value: temperature })}
                control={
                  <div className="w-40">
                    <Slider
                      min={0}
                      max={1}
                      step={0.05}
                      value={[temperature]}
                      onValueChange={(next) => setTemperature(Array.isArray(next) ? next[0] : next)}
                      disabled={!canEditShared}
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
                label={t("projectSettings.voice.leadsManageLabel")}
                description={t("projectSettings.voice.leadsManageDescription")}
                control={
                  <DisabledFieldTooltip disabled={!canEditShared} tooltip={sharedDisabledTooltip ?? null}>
                    <Switch
                      checked={sharedSettingsBlob.projectLeadsManageVoices === true}
                      onCheckedChange={(checked) => { void patchShared({ projectLeadsManageVoices: checked }) }}
                      disabled={!canEditShared}
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
              >
                <ApiKeyField
                  label={t("projectSettings.voice.geminiKeyLabel")}
                  placeholder={t("projectSettings.voice.geminiKeyPlaceholder")}
                  projectKey={geminiApiKey}
                  userKey={geminiUserKey}
                  onProjectKeyChange={setGeminiApiKey}
                  onUserKeyChange={(v) => setUserApiKey("gemini-tts", v)}
                  help={t("projectSettings.voice.geminiKeyHelp")}
                />
              </SettingsRow>
              <SettingsRow
                label={t("projectSettings.voice.studioLabel")}
                description={t("projectSettings.voice.libraryNote")}
                control={
                  <Button variant="outline" onClick={() => {
                    try { window.localStorage.setItem(`aquilla:editorLens:${id}`, "audio") } catch { /* ignore */ }
                    requestNavigate(`/project/${id}/editor`)
                  }}>
                    {t("projectSettings.voice.openStudioButton")}
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
              disabled={!canEditShared}
              disabledTooltip={sharedDisabledTooltip ?? undefined}
              // AQU-1083: the last row of the validation card. Passed as a
              // node rather than props because it patches the shared blob
              // directly — see the component's own note for why it must not
              // ride this page's draft/baseline state.
              structuralCellsRow={
                <StructuralCellsProjectSection
                  value={sharedSettingsBlob?.countStructuralCells}
                  orgDefault={orgCountStructuralCells ?? true}
                  disabled={!canEditCountStructural}
                  disabledTooltip={structuralDisabledTooltip ?? undefined}
                  onPatch={patchShared}
                />
              }
              // AQU-1391: same slot treatment, same card — validation is the
              // gesture that triggers propagation.
              repetitionPropagationRow={
                <RepetitionPropagationProjectSection
                  value={sharedSettingsBlob?.autoPropagateRepetitions}
                  orgDefault={orgAutoPropagateRepetitions}
                  disabled={!canEditShared}
                  disabledTooltip={sharedDisabledTooltip ?? undefined}
                  onPatch={patchShared}
                />
              }
              onChange={(u) => {
                if (u.validationCount !== undefined) setValidationCount(u.validationCount)
                if (u.validationCountAudio !== undefined) setValidationCountAudio(u.validationCountAudio)
                if (u.validationRoleFloor !== undefined) setValidationRoleFloor(u.validationRoleFloor)
                if (u.validationNamedUsers !== undefined) setValidationNamedUsers(u.validationNamedUsers)
                if (u.allowSelfValidation !== undefined) setAllowSelfValidation(u.allowSelfValidation)
                if (u.validationRoleFloorAudio !== undefined) setValidationRoleFloorAudio(u.validationRoleFloorAudio)
                if (u.validationNamedUsersAudio !== undefined) setValidationNamedUsersAudio(u.validationNamedUsersAudio)
                if (u.allowSelfValidationAudio !== undefined) setAllowSelfValidationAudio(u.allowSelfValidationAudio)
              }}
            />
            {/* AQU-186: Harmonization settings — harmonize_min_role floor. */}
            <SettingsGroup label={t("projectSettings.harmonization.title")} locked={sharedDisabledTooltip}>
              <SettingsRow
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
                      disabled={!canEditShared}
                      value={harmonizeMinRole}
                      onValueChange={(value) => setHarmonizeMinRole(value as "project_lead" | "maintainer")}
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
              onChange={setDecaySettings}
            />
          </div>
        )}

        {searchGroupLabel("section-audio-media")}
        {sectionsToRender.some((s) => s.id === "section-audio-media") && (
          <div id="section-audio-media">
            <AudioMediaStrategySection
              value={audioMediaStrategy}
              onChange={setAudioMediaStrategy}
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
                  disabled={!canEditShared || timingLocked == null}
                  onCheckedChange={(checked) => setTimingLocked(checked)}
                />
                <label htmlFor="timing-locked" className="min-w-0 flex-1 text-sm">
                  {t("projectSettings.timeline.lockLabel")}
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t("projectSettings.timeline.lockHint")}
                  </p>
                </label>
                <OrgDefaultSource
                  id="timing-locked-source"
                  settingLabel={t("projectSettings.timeline.lockLabel")}
                  inherited={timingLocked == null}
                  orgOptionLabel={orgBooleanOptionLabel(t, orgMediaDefaults.timingLocked ?? true)}
                  disabled={!canEditShared}
                  onChange={(inherit) => setTimingLocked(inherit ? null : effectiveTimingLocked)}
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
                  disabled={!canEditShared || allowTrackEditing == null}
                  onCheckedChange={(checked) => setAllowTrackEditing(checked)}
                />
                <label htmlFor="allow-track-editing" className="min-w-0 flex-1 text-sm">
                  {t("projectSettings.timeline.trackEditingLabel")}
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t("projectSettings.timeline.trackEditingHint")}
                  </p>
                </label>
                <OrgDefaultSource
                  id="allow-track-editing-source"
                  settingLabel={t("projectSettings.timeline.trackEditingLabel")}
                  inherited={allowTrackEditing == null}
                  orgOptionLabel={orgBooleanOptionLabel(t, orgMediaDefaults.allowTrackEditing ?? true)}
                  disabled={!canEditShared}
                  onChange={(inherit) => setAllowTrackEditing(inherit ? null : effectiveAllowTrackEditing)}
                />
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
                label={<label htmlFor="auto-sync">{t("projectSettings.gitSync.autoSyncSwitch")}</label>}
                description={t("projectSettings.gitSync.intervalNote")}
                control={
                  <div className="flex items-center gap-2">
                    <Switch
                      id="auto-sync"
                      checked={autoSyncEnabled}
                      onCheckedChange={(checked) => setAutoSyncEnabled(checked)}
                      aria-label={t("projectSettings.gitSync.autoSyncSwitch")}
                    />
                    <Input
                      type="number"
                      min={1}
                      max={60}
                      className="h-8 w-20 bg-background"
                      value={autoSyncInterval}
                      onChange={(e) => setAutoSyncInterval(Math.max(1, Number(e.target.value) || 1))}
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
            <TermMatchingSection value={termMatching} onChange={setTermMatching} disabled={!canEditShared} locked={sharedDisabledTooltip} />
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
            // shared settings blob. It saves immediately rather than joining
            // the deferred Save bar — it is one switch with no dependent
            // fields, and its role floor (project_lead) is lower than the bar's
            // (maintainer), so folding it in would lock leads out of the one
            // control they are allowed to touch.
            autopilotEnabled={sharedSettingsBlob.autopilotEnabled}
            roleLevel={project?.syncRole?.level ?? null}
            onSetAutopilotEnabled={(enabled) => { void patchShared({ autopilotEnabled: enabled }) }}
            // AQU-1937: the per-project Smart Extensions switch (Maintainer+,
            // the ordinary settings floor; the server refuses lower roles).
            smartExtensionsEnabled={sharedSettingsBlob.smartExtensionsEnabled}
            onSetSmartExtensionsEnabled={(enabled) => {
              void Promise.resolve(patchShared({ smartExtensionsEnabled: enabled })).then(() => notifySmartExtensionsChanged(id))
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
      <Dialog open={discardOpen} onOpenChange={(open) => (open ? setDiscardOpen(true) : handleDiscardCancel())}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("projectSettings.discardDialogTitle")}</DialogTitle>
            <DialogDescription>
              {t("projectSettings.discardDialogDescription")}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={handleDiscardCancel}>{t("projectSettings.keepEditing")}</Button>
            <Button variant="destructive" onClick={handleDiscardConfirm}>{t("common.discard")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
