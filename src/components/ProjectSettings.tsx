import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from "react"
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
import { LanguageComboboxInput } from "@/components/LanguageComboboxInput"
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
import { PrivilegedMembersDialog } from "./ProjectSettings/PrivilegedMembersDialog"
import { AppShell } from "@/components/AppShell"
import { OrgSidebar } from "@/components/org/OrgSidebar"
import { OrgBreadcrumb } from "@/components/org/OrgBreadcrumb"
import { Page, PageHeader, SettingsGroup, SettingsRow } from "@/components/ui/page"
import { useProject } from "@/hooks/useProject"
import { useProjectSettings } from "@/hooks/useProjectSettings"
import { getProject, updateProject } from "@/lib/store/project-index"
import {
  DEFAULT_APPROVED_EXAMPLE_COUNT,
  DEFAULT_COMPLETION_MAX_TOKENS,
  fetchModels,
  normalizeCompletionMaxTokens,
  resolveProvider,
} from "@/lib/completion/completion-service"
import { buildCompletionSettings, DEFAULT_SYSTEM_PROMPT } from "@/hooks/useCompletionSettings"
import { MAX_BATCH_COMPLETIONS } from "@/lib/workspace-actions/registry"
import type {
  AudioMediaStrategy,
  CompletionProvider,
  CompletionSettings,
  ContextSize,
  DecaySettings,
  ProjectRecord,
} from "@/lib/parsers/types"
import {
  AUDIO_MEDIA_STRATEGY_LABELS,
  projectHasScriptureFiles,
  resolveBibleResourcesEnabled,
} from "@/lib/parsers/types"
import { resolveTimingLocked } from "@/lib/sync/project-settings"
import { DEFAULT_DRAFT_CONTEXT } from "@/lib/completion/draft-context"
import { ValidationSettingsSection } from "./ProjectSettings/ValidationSettingsSection"
import { DecaySettingsSection } from "./ProjectSettings/DecaySettingsSection"
import { AudioMediaStrategySection } from "./ProjectSettings/AudioMediaStrategySection"
import { TermbaseSharingSection } from "./ProjectSettings/TermbaseSharingSection"
import { MondayIntegrationSection } from "./ProjectSettings/MondayIntegrationSection"
import { SourceLinkSection } from "./ProjectSettings/SourceLinkSection"
import { ExperimentalFlagsSection } from "./ProjectSettings/ExperimentalFlagsSection"
import { LanguagesSection } from "./ProjectSettings/LanguagesSection"
import { MembersSection } from "./ProjectSettings/MembersSection"
import { LIVING_MEMORY_ICON } from "./LivingMemoryButton"
import { DcsUpstreamPanel } from "@/components/dcs/DcsUpstreamPanel"
import { readCursor } from "@/lib/dcs/cursor"
import { UpstreamChangesPanel } from "./linked/UpstreamChangesPanel"
import { buildFileScopedTokenFetcher } from "@/lib/sync/cqrs-bridge"
import { useOrg } from "@/hooks/useOrg"
import { useOrgSettings } from "@/hooks/useOrgSettings"
import { useActiveOrgOptional } from "@/context/OrgContext"
import { ApiKeyField } from "./ApiKeyField"
import { SettingsNav, type SettingsSection } from "./ProjectSettings/SettingsNav"
import { BackLink, NavList, NavRow } from "@/components/ui/nav-list"
import { readValidationCount, readValidationCountAudio } from "@/lib/progress/read-validation-count"
import { setUserApiKey, useUserApiKey } from "@/lib/store/user-api-keys"
import type { CellEditingTier, ProjectWideSettings } from "@/lib/sync/project-settings"
import { FLOOR_LABEL } from "@/pages/settings/constants"
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
 * Also re-enable the skipped smoke specs:
 *   - e2e/specs/projects/project-settings-termbase-sharing.smoke.spec.ts
 *   - e2e/specs/projects/project-settings-termbase-publish-toggle.smoke.spec.ts
 *   - e2e/specs/projects/termbase-subscribe-unsubscribe.smoke.spec.ts
 *
 * Backend routes + TermbaseSharingSection.tsx remain live; only settings UI
 * entry points are gated here.
 * =============================================================================
 */
const SHOW_TERMBASE_SHARING_IN_SETTINGS = false

/**
 * AQU-1068: the cell-editing tiers, in the order they are offered.
 *
 * The reset default leads, matching every other floor control on this page;
 * the rest climb the ladder, matching RosterProgressSection and
 * TermbaseEditSection.
 *
 * The labels used to be DESCRIPTIVE — "Maintainers and project leads", "Anyone
 * who can edit" — on the theory that they said who is admitted more plainly
 * than a bare rank. Matthew's review overruled that (Sam approved, 2026-09-08):
 * an admin who has just set someone's role on the Members panel should not have
 * to work out which bespoke phrase covers that rank, so this is the standard
 * ladder, spelled the standard way, and only "No one" — which is not a role —
 * keeps a phrase of its own.
 *
 * `level` is what makes the two-tier labelling work, exactly as in
 * RosterProgressSection: FLOOR_LABEL supplies the short word for the closed
 * trigger and the message key the fuller row in the open list. "No one" has no
 * level and therefore no FLOOR_LABEL entry, so it shows its row text in both.
 */
const CELL_EDITING_FLOOR_OPTIONS: readonly {
  value: CellEditingTier
  /** Ladder level this tier admits, or null for "none" — which is a refusal,
   *  not a rank, and so has no place on the ladder. */
  level: number | null
  labelKey: MessageKey
}[] = [
  { value: "none", level: null, labelKey: "projectSettings.cellEditing.optionNone" },
  { value: "commenter", level: ROLE.COMMENTER, labelKey: "projectSettings.cellEditing.optionCommenter" },
  { value: "reviewer", level: ROLE.REVIEWER, labelKey: "projectSettings.cellEditing.optionReviewer" },
  { value: "contributor", level: ROLE.CONTRIBUTOR, labelKey: "projectSettings.cellEditing.optionContributor" },
  { value: "project_lead", level: ROLE.PROJECT_LEAD, labelKey: "projectSettings.cellEditing.optionProjectLead" },
  { value: "maintainer", level: ROLE.MAINTAINER, labelKey: "projectSettings.cellEditing.optionMaintainer" },
]

// Well-known OpenAI-compatible providers. Exactly one of `label`/`labelKey` is
// set per entry: `labelKey` for the two real English descriptions ("Local /
// self-hosted…", "Other…"), translated at render via presetLabel() below.
// The rest are brand names — i18n-exempt, left untranslated in every locale
// like any other product/company name (OpenRouter and OpenAI are already in
// ATOMIC_TERMS; Groq/Together AI/Mistral/DeepSeek aren't yet, but are the
// same kind of string).
const CUSTOM_PRESETS: { id: string; label?: string; labelKey?: MessageKey; endpoint: string; requiresKey: boolean; keyHint?: string }[] = [
  { id: "local", labelKey: "projectSettings.advancedLlm.presetLocalLabel", endpoint: "http://localhost:8000", requiresKey: false },
  { id: "openrouter", label: "OpenRouter", endpoint: "https://openrouter.ai/api/v1", requiresKey: true, keyHint: "sk-or-..." },
  { id: "openai", label: "OpenAI", endpoint: "https://api.openai.com/v1", requiresKey: true, keyHint: "sk-..." },
  { id: "groq", label: "Groq", endpoint: "https://api.groq.com/openai/v1", requiresKey: true, keyHint: "gsk_..." },
  { id: "together", label: "Together AI", endpoint: "https://api.together.xyz/v1", requiresKey: true },
  { id: "mistral", label: "Mistral", endpoint: "https://api.mistral.ai/v1", requiresKey: true },
  { id: "deepseek", label: "DeepSeek", endpoint: "https://api.deepseek.com/v1", requiresKey: true },
  { id: "custom", labelKey: "projectSettings.advancedLlm.presetCustomLabel", endpoint: "", requiresKey: false },
]

/** Resolves a CUSTOM_PRESETS entry's display label: translated when `labelKey`
 * is set, else the literal (untranslated brand name). */
function presetLabel(t: TFunction, preset: { label?: string; labelKey?: MessageKey }): string {
  return preset.labelKey ? t(preset.labelKey) : (preset.label ?? "")
}

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

function presetIdForEndpoint(endpoint: string): string {
  const trimmed = endpoint.trim().replace(/\/+$/, "").toLowerCase()
  if (!trimmed) return "local"
  for (const p of CUSTOM_PRESETS) {
    if (!p.endpoint) continue
    const base = p.endpoint.toLowerCase()
    if (trimmed === base || trimmed.startsWith(base)) return p.id
  }
  return "custom"
}

interface Baseline {
  name: string
  sourceLanguage: string
  targetLanguage: string
  username: string
  provider: CompletionProvider
  endpoint: string
  apiKey: string
  model: string
  maxTokens: number
  temperature: number
  llmHealthPenalty: number
  top_k: number
  contextSize: ContextSize
  useOnlyValidatedExamples: boolean
  main_chat_language: string
  fewShotExampleFormat: "source-and-target" | "target-only"
  completionBatchSize: number
  validationBatchSize: number
  autoSyncEnabled: boolean
  autoSyncInterval: number
  validationCount: number
  validationCountAudio: number
  validationRoleFloor: "reviewer" | "project_lead" | "maintainer"
  validationNamedUsers: string[]
  allowSelfValidation: boolean
  /** AQU-646: may people add lines into the timeline's silences? */
  cellEditingFloor: CellEditingTier
  /** AQU-646 stage 2: may this project's timelines be restructured? */
  allowTrackEditing: boolean
  timingLocked: boolean
  harmonize_min_role: "project_lead" | "maintainer"
  /** AQU-460: EXPLICIT persisted value only. `undefined` = no explicit choice
   *  yet — the effective (displayed) state is derived via
   *  `resolveBibleResourcesEnabled`, not defaulted here. */
  bibleResourcesEnabled: boolean | undefined
  decaySettings: DecaySettings | undefined
  audioMediaStrategy: AudioMediaStrategy
  geminiApiKey: string
  precedingTargetCells: number
  /** AQU-634: when true, USFM imports exclude book-name/title/TOC + intro-block
   *  front matter. Absent/false imports front matter (the default). */
  importExcludeFrontMatter: boolean
}

function buildBaseline(project: ProjectRecord): Baseline {
  return {
    name: project.name,
    sourceLanguage: project.sourceLanguage,
    targetLanguage: project.targetLanguage,
    username: project.username || "local",
    provider: project.completionSettings ? resolveProvider(project.completionSettings) : "frontier",
    endpoint: project.completionSettings?.endpoint ?? "",
    apiKey: project.completionSettings?.apiKey ?? "",
    model: project.completionSettings?.model ?? "",
    // Normalized so the field shows what drafting will actually send — legacy
    // default snapshots (512/4096) are upgraded to the current default.
    maxTokens: normalizeCompletionMaxTokens(project.completionSettings?.maxTokens),
    temperature: project.completionSettings?.temperature ?? 0.3,
    llmHealthPenalty: project.completionSettings?.llmHealthPenalty ?? 0.1,
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
    validationCount: readValidationCount(project),
    validationCountAudio: readValidationCountAudio(project),
    validationRoleFloor: project.validationRoleFloor ?? "reviewer",
    validationNamedUsers: project.validationNamedUsers ?? [],
    allowSelfValidation: project.allowSelfValidation ?? true,
    // Off unless a project has said otherwise: the affordance is speculative
    // and underdeveloped, so absent must read as off, not as unset.
    cellEditingFloor: project.cellEditingFloor ?? "none",
    // Off unless a project has said otherwise. Multi-track is capability for
    // clients who want it, and a project that never turns it on should not be
    // able to tell it was built.
    allowTrackEditing: project.allowTrackEditing ?? false,
    // AQU-646: absent means LOCKED, so the box starts ticked on every project
    // that predates the setting. See resolveTimingLocked.
    timingLocked: resolveTimingLocked(project),
    harmonize_min_role: project.harmonize_min_role ?? "project_lead",
    // AQU-460: preserve "unset" — do NOT default to false here, that would
    // make an unset scripture project look explicitly off in the diff/baseline.
    bibleResourcesEnabled: project.bibleResourcesEnabled,
    decaySettings: project.decaySettings,
    audioMediaStrategy: project.audioMediaStrategy ?? "lazy",
    geminiApiKey: project.ttsSettings?.apiKey ?? "",
    precedingTargetCells: project.draftContext?.precedingTargetCells ?? DEFAULT_DRAFT_CONTEXT.precedingTargetCells,
    importExcludeFrontMatter: project.importExcludeFrontMatter ?? false,
  }
}

function decayEqual(a: DecaySettings | undefined, b: DecaySettings | undefined): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return JSON.stringify(a) === JSON.stringify(b)
}

interface ProjectSettingsProps {
  modal?: boolean
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
    languageEditFloor,
    patch: patchShared,
    version: sharedVersion,
    updatedAt: sharedUpdatedAt,
    updatedBy: sharedUpdatedBy,
    conflict: sharedConflict,
    dismissConflict,
    hasFetched: sharedSettingsFetched,
    settings: sharedSettingsBlob,
  } = useProjectSettings(id ?? null, project?.syncRole?.level ?? null, {
    // AQU-1086: the org's language-edit floor rides on the project record, so
    // the language fields below can be enabled for a project lead when the org
    // opted in — without loosening the maintainer floor on anything else.
    languageEditMinRole: project?.languageEditMinRole,
    roleTelemetry,
  })

  // Org context for the termbase-sharing section. The user's org; the section's
  // server calls re-validate org-membership / org-ownership, so a mismatch just
  // yields graceful empty/403 states.
  const { org } = useOrg()
  const { session } = useFrontierSession()
  const isCloudProject = !!(project?.syncRole)
  // AQU-485: Members is a privacy-gated settings pane. Hide it entirely for
  // callers below rosterViewMinRole — no "Roster hidden" disclosure, no nav
  // row. Local (unsynced) projects have no org floor, so the pane stays.
  const rosterOrgId = project?.orgId ?? activeOrg?.activeOrgId ?? null
  const { canViewRoster } = useOrgSettings(
    rosterOrgId,
    activeOrg?.activeOrg?.role?.level,
    project?.syncRole?.level ?? null,
  )
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

  // Server enforces MAINTAINER (600) for settings writes. Explain the lock on
  // the control itself (GitHub-style hint), not with a page-level banner.
  const privilegedRole = resolveRoleName(t, ROLE.MAINTAINER, { plural: true })
  const roleLockHint = (
    <PermissionLockHint
      title={t("projectSettings.permission.onlyRoleCanModify", {
        role: privilegedRole,
      })}
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

  // AQU-1086: the language fields sit behind the org's configurable
  // languageEditMinRole, so their lock hint must name the role the user
  // actually needs (Project lead when the org lowered the floor, Maintainer by
  // default) rather than a hardcoded Maintainer — the AQU-427 convention.
  const languagePrivilegedRole = resolveRoleName(t, languageEditFloor, { plural: true })
  const languageRoleLockHint = (
    <PermissionLockHint
      title={t("projectSettings.permission.onlyRoleCanModify", {
        role: languagePrivilegedRole,
      })}
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
  const [sourceLanguage, setSourceLanguage] = useState("")
  const [targetLanguage, setTargetLanguage] = useState("")
  const [username, setUsername] = useState("")
  const [provider, setProvider] = useState<CompletionProvider>("frontier")
  const [endpoint, setEndpoint] = useState("")
  const [apiKey, setApiKey] = useState("")
  const [presetId, setPresetId] = useState<string>("local")
  const [model, setModel] = useState("")
  const [maxTokens, setMaxTokens] = useState(DEFAULT_COMPLETION_MAX_TOKENS)
  const [temperature, setTemperature] = useState(0.3)
  const [llmHealthPenalty, setLlmHealthPenalty] = useState(0.1)
  const [topK, setTopK] = useState(DEFAULT_APPROVED_EXAMPLE_COUNT)
  const [contextSize, setContextSize] = useState<ContextSize>("medium")
  const [useOnlyValidatedExamples, setUseOnlyValidatedExamples] = useState(true)
  const [fewShotExampleFormat, setFewShotExampleFormat] = useState<"source-and-target" | "target-only">("source-and-target")
  const [mainChatLanguage, setMainChatLanguage] = useState("")
  const [completionBatchSize, setCompletionBatchSize] = useState(MAX_BATCH_COMPLETIONS)
  const [validationBatchSize, setValidationBatchSize] = useState(0)
  const [autoSyncEnabled, setAutoSyncEnabled] = useState(false)
  const [autoSyncInterval, setAutoSyncInterval] = useState(5)
  const [validationCount, setValidationCount] = useState(1)
  const [validationCountAudio, setValidationCountAudio] = useState(1)
  const [validationRoleFloor, setValidationRoleFloor] = useState<"reviewer" | "project_lead" | "maintainer">("reviewer")
  const [validationNamedUsers, setValidationNamedUsers] = useState<string[]>([])
  const [allowSelfValidation, setAllowSelfValidation] = useState(true)
  const [cellEditingFloor, setCellEditingFloor] = useState<CellEditingTier>("none")
  const [allowTrackEditing, setAllowTrackEditing] = useState(false)
  const [timingLocked, setTimingLocked] = useState(true)
  // AQU-186: harmonize_min_role — project_lead floor, configurable up to maintainer.
  const [harmonizeMinRole, setHarmonizeMinRole] = useState<"project_lead" | "maintainer">("project_lead")
  // AQU-460: EXPLICIT persisted value only — `undefined` means no explicit
  // choice yet. The switch displays the DERIVED effective value (see render);
  // this state only ever holds what will be persisted on Save.
  const [bibleResourcesEnabled, setBibleResourcesEnabled] = useState<boolean | undefined>(undefined)
  const [decaySettings, setDecaySettings] = useState<DecaySettings | undefined>(undefined)
  const [audioMediaStrategy, setAudioMediaStrategy] = useState<AudioMediaStrategy>("lazy")
  const [precedingTargetCells, setPrecedingTargetCells] = useState(DEFAULT_DRAFT_CONTEXT.precedingTargetCells)
  // AQU-634: per-project USFM front-matter opt-out.
  const [importExcludeFrontMatter, setImportExcludeFrontMatter] = useState(false)
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

  const [models, setModels] = useState<string[]>([])
  const [connecting, setConnecting] = useState(false)
  const [connectionError, setConnectionError] = useState<string | null>(null)
  const [connected, setConnected] = useState(false)
  const lastModelFetchKeyRef = useRef<string | null>(null)

  const seededRef = useRef(false)

  const applyBaseline = useCallback((b: Baseline) => {
    setName(b.name)
    setSourceLanguage(b.sourceLanguage)
    setTargetLanguage(b.targetLanguage)
    setUsername(b.username)
    setProvider(b.provider)
    setEndpoint(b.endpoint)
    setApiKey(b.apiKey)
    setPresetId(presetIdForEndpoint(b.endpoint))
    setModel(b.model)
    setMaxTokens(b.maxTokens)
    setTemperature(b.temperature)
    setLlmHealthPenalty(b.llmHealthPenalty)
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
    setCellEditingFloor(b.cellEditingFloor)
    setAllowTrackEditing(b.allowTrackEditing)
    setTimingLocked(b.timingLocked)
    setHarmonizeMinRole(b.harmonize_min_role)
    setBibleResourcesEnabled(b.bibleResourcesEnabled)
    setDecaySettings(b.decaySettings)
    setAudioMediaStrategy(b.audioMediaStrategy)
    setGeminiApiKey(b.geminiApiKey)
    setPrecedingTargetCells(b.precedingTargetCells)
    setImportExcludeFrontMatter(b.importExcludeFrontMatter)
  }, [])

  // Seed once when the project first loads. We intentionally don't reseed on
  // every `project` identity change — background sync writes to IDB shouldn't
  // wipe the user's in-progress edits. After save/discard we reseed manually.
  useEffect(() => {
    if (!project || seededRef.current) return
    const b = buildBaseline(project)
    setBaseline(b)
    applyBaseline(b)
    seededRef.current = true
  }, [project, applyBaseline])

  // AQU-460 display-race fix: `project.bibleResourcesEnabled` hydrates in two
  // async phases — `useProject`'s minimal record resolves first WITHOUT the
  // field (undefined), then its own `useProjectSettings` GET fills it in. If
  // the baseline seed above (which runs on first non-null `project`) lands
  // during that undefined window, it locks in `undefined`, and the Switch
  // paints `resolveBibleResourcesEnabled(undefined, hasScriptureFiles)` —
  // wrongly `true` for a scripture project whose server value is really
  // `false`. Once THIS component's own settings hook confirms a fetch has
  // resolved (`sharedSettingsFetched`), re-sync the seeded value to whatever
  // `project.bibleResourcesEnabled` now holds — but only if the user hasn't
  // already touched the switch (don't clobber an in-progress edit), and only
  // once (matches the "seed once" contract above).
  const bibleResourcesResyncedRef = useRef(false)
  useEffect(() => {
    if (!project || !baseline || !sharedSettingsFetched) return
    if (bibleResourcesResyncedRef.current) return
    bibleResourcesResyncedRef.current = true
    if (project.bibleResourcesEnabled === baseline.bibleResourcesEnabled) return
    setBaseline((prev) => (prev ? { ...prev, bibleResourcesEnabled: project.bibleResourcesEnabled } : prev))
    // Only overwrite the draft value if the user hasn't diverged from the
    // (possibly-stale) baseline yet — otherwise we'd stomp an in-progress toggle.
    setBibleResourcesEnabled((prev) => (prev === baseline.bibleResourcesEnabled ? project.bibleResourcesEnabled : prev))
  }, [project, baseline, sharedSettingsFetched])

  // AQU-1115: the Source/Target Language fields rendered permanently EMPTY on a
  // project that has both set. Same two-phase shape as the AQU-460 race above,
  // but worse: this page passes `includeSettings: false` to `useProject` (it
  // owns the editable settings hook below, and a second overlay request would
  // be a duplicate GET), so `project` here is `minimalProjectRecord`, which
  // hardcodes `sourceLanguage: ""` / `targetLanguage: ""` — the languages live
  // ONLY in the shared settings blob and never reach `project` at all. The
  // baseline seed therefore didn't just *race* the real values, it could never
  // see them, so the fields stayed blank forever. (The Languages card below
  // looked right because it reads `sharedSettingsBlob` directly — that
  // discrepancy is exactly what the bug report describes.)
  //
  // Once this page's own settings GET has resolved, re-sync both fields from
  // the blob. `hasFetched` fails closed (stays false on a failed GET), so a
  // settings outage leaves the previous behavior rather than blanking anything.
  const languagesResyncedRef = useRef(false)
  useEffect(() => {
    if (!baseline || !sharedSettingsFetched) return
    if (languagesResyncedRef.current) return
    languagesResyncedRef.current = true
    // Absent stays absent — a project with a genuinely empty language must show
    // an empty field, never an invented default. A free-text label that isn't
    // in the language catalog rides through verbatim.
    const nextSource = sharedSettingsBlob?.sourceLanguage ?? baseline.sourceLanguage
    const nextTarget = sharedSettingsBlob?.targetLanguage ?? baseline.targetLanguage
    if (nextSource === baseline.sourceLanguage && nextTarget === baseline.targetLanguage) return
    setBaseline((prev) => (prev ? { ...prev, sourceLanguage: nextSource, targetLanguage: nextTarget } : prev))
    // Only adopt the hydrated value where the user hasn't already typed over the
    // (blank) seed — otherwise this would stomp an in-progress edit. Settling to
    // the true server value must also not read as a user edit, which is why the
    // baseline moves with it.
    setSourceLanguage((prev) => (prev === baseline.sourceLanguage ? nextSource : prev))
    setTargetLanguage((prev) => (prev === baseline.targetLanguage ? nextTarget : prev))
  }, [baseline, sharedSettingsFetched, sharedSettingsBlob])

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
      const chosenModel = model || list[0] || ""
      if (list.length > 0 && !model) setModel(list[0])
      // Connect (and the auto-probe after a key/endpoint pause) is the moment
      // the user believes BYOK is ready. Persist immediately so the workspace
      // sparkle gate sees Custom OpenRouter without a second "Save changes".
      if (id && provider === "custom") {
        const latest = (await getProject(id)) ?? project ?? undefined
        if (latest) {
          const nextCompletion = buildCompletionSettings(latest.completionSettings, {
            provider: "custom",
            endpoint: trimmedEndpoint,
            ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
            model: chosenModel,
          })
          await updateProject({
            ...latest,
            completionSettings: nextCompletion,
            aiProviderChosen: true,
          })
          setBaseline((prev) =>
            prev
              ? {
                  ...prev,
                  provider: "custom",
                  endpoint: trimmedEndpoint,
                  apiKey,
                  model: chosenModel,
                }
              : prev,
          )
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
      sourceLanguage !== baseline.sourceLanguage ||
      targetLanguage !== baseline.targetLanguage ||
      username !== baseline.username ||
      provider !== baseline.provider ||
      endpoint !== baseline.endpoint ||
      apiKey !== baseline.apiKey ||
      model !== baseline.model ||
      maxTokens !== baseline.maxTokens ||
      temperature !== baseline.temperature ||
      llmHealthPenalty !== baseline.llmHealthPenalty ||
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
      cellEditingFloor !== baseline.cellEditingFloor ||
      allowTrackEditing !== baseline.allowTrackEditing ||
      timingLocked !== baseline.timingLocked ||
      harmonizeMinRole !== baseline.harmonize_min_role ||
      bibleResourcesEnabled !== baseline.bibleResourcesEnabled ||
      audioMediaStrategy !== baseline.audioMediaStrategy ||
      !decayEqual(decaySettings, baseline.decaySettings) ||
      geminiApiKey !== baseline.geminiApiKey ||
      precedingTargetCells !== baseline.precedingTargetCells ||
      importExcludeFrontMatter !== baseline.importExcludeFrontMatter
    )
  }, [
    baseline, name, sourceLanguage, targetLanguage, username, provider, endpoint, apiKey,
    model, maxTokens, temperature, llmHealthPenalty,
    topK, contextSize, useOnlyValidatedExamples, fewShotExampleFormat, mainChatLanguage,
    completionBatchSize, validationBatchSize,
    autoSyncEnabled, autoSyncInterval, validationCount, validationCountAudio,
    validationRoleFloor, validationNamedUsers, allowSelfValidation, cellEditingFloor,
    allowTrackEditing,
    timingLocked,
    harmonizeMinRole, bibleResourcesEnabled, audioMediaStrategy, decaySettings, geminiApiKey,
    precedingTargetCells, importExcludeFrontMatter,
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
    const nextEndpoint = preset.id === "custom" ? endpoint : preset.endpoint
    setEndpoint(nextEndpoint)
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
      const completionUpdates: Partial<CompletionSettings> = {}
      if (provider !== baseline.provider) { completionUpdates.provider = provider; changedFieldLabels.push("AI provider") }
      if (endpoint.trim() !== baseline.endpoint) { completionUpdates.endpoint = endpoint.trim(); changedFieldLabels.push("endpoint") }
      if (apiKey !== baseline.apiKey) { completionUpdates.apiKey = apiKey || undefined; changedFieldLabels.push("API key") }
      if (model !== baseline.model) { completionUpdates.model = model; changedFieldLabels.push("model") }
      if (maxTokens !== baseline.maxTokens) { completionUpdates.maxTokens = maxTokens; changedFieldLabels.push("max tokens") }
      if (temperature !== baseline.temperature) { completionUpdates.temperature = temperature; changedFieldLabels.push("temperature") }
      if (llmHealthPenalty !== baseline.llmHealthPenalty) { completionUpdates.llmHealthPenalty = llmHealthPenalty; changedFieldLabels.push("health penalty") }
      if (topK !== baseline.top_k) { completionUpdates.top_k = topK; changedFieldLabels.push("examples retrieved") }
      if (contextSize !== baseline.contextSize) { completionUpdates.contextSize = contextSize; changedFieldLabels.push("context window") }
      if (useOnlyValidatedExamples !== baseline.useOnlyValidatedExamples) { completionUpdates.useOnlyValidatedExamples = useOnlyValidatedExamples; changedFieldLabels.push("validated examples only") }
      if (fewShotExampleFormat !== baseline.fewShotExampleFormat) { completionUpdates.fewShotExampleFormat = fewShotExampleFormat; changedFieldLabels.push("reference example format") }
      if (mainChatLanguage !== baseline.main_chat_language) { completionUpdates.main_chat_language = mainChatLanguage || undefined; changedFieldLabels.push("assisted language") }
      if (completionBatchSize !== baseline.completionBatchSize) { completionUpdates.completionBatchSize = completionBatchSize; changedFieldLabels.push("AI completions batch size") }
      if (validationBatchSize !== baseline.validationBatchSize) { completionUpdates.validationBatchSize = validationBatchSize; changedFieldLabels.push("batch validation size") }

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
          setNameError("Enter a project title.")
          return false
        }
        if (isCloudProject) {
          const jwt = getJwt()
          if (!jwt) {
            setSaveError("You're signed out. Sign in again to rename this project.")
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
              setSaveError(err instanceof Error ? err.message : "Renaming the project failed.")
            }
            return false
          }
        }
        localUpdates.name = trimmedName
        changedFieldLabels.push("project title")
      }
      if (username !== baseline.username) { localUpdates.username = username; changedFieldLabels.push("username") }
      if (!decayEqual(decaySettings, baseline.decaySettings)) { localUpdates.decaySettings = decaySettings; changedFieldLabels.push("decay settings") }
      if (audioMediaStrategy !== baseline.audioMediaStrategy) { localUpdates.audioMediaStrategy = audioMediaStrategy; changedFieldLabels.push("audio media strategy") }
      // geminiApiKey handled below after `latest` is fetched, so voices/castAssignments are preserved.
      if (
        autoSyncEnabled !== baseline.autoSyncEnabled ||
        autoSyncInterval !== baseline.autoSyncInterval
      ) {
        localUpdates.syncSettings = {
          autoSync: { enabled: autoSyncEnabled, intervalMinutes: Math.max(1, autoSyncInterval) },
        }
        changedFieldLabels.push("auto-sync")
      }

      const geminiKeyChanged = geminiApiKey !== baseline.geminiApiKey
      if (geminiKeyChanged) changedFieldLabels.push("voice API key")
      const hasLocalWork =
        Object.keys(localUpdates).length > 0 || Object.keys(completionUpdates).length > 0 || geminiKeyChanged
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
          ...(Object.keys(completionUpdates).length > 0 ? { aiProviderChosen: true } : {}),
        })
      }

      const sharedUpdates: ProjectWideSettings = {}
      if (sourceLanguage !== baseline.sourceLanguage) { sharedUpdates.sourceLanguage = sourceLanguage; changedFieldLabels.push("source language") }
      if (targetLanguage !== baseline.targetLanguage) { sharedUpdates.targetLanguage = targetLanguage; changedFieldLabels.push("target language") }
      if (validationCount !== baseline.validationCount) { sharedUpdates.validationCount = validationCount; changedFieldLabels.push("validation count") }
      if (validationCountAudio !== baseline.validationCountAudio) {
        sharedUpdates.validationCountAudio = validationCountAudio
        changedFieldLabels.push("audio validation count")
      }
      if (validationRoleFloor !== baseline.validationRoleFloor) { sharedUpdates.validationRoleFloor = validationRoleFloor; changedFieldLabels.push("validation role floor") }
      if (JSON.stringify(validationNamedUsers) !== JSON.stringify(baseline.validationNamedUsers)) {
        sharedUpdates.validationNamedUsers = validationNamedUsers
        changedFieldLabels.push("named validators")
      }
      if (allowSelfValidation !== baseline.allowSelfValidation) { sharedUpdates.allowSelfValidation = allowSelfValidation; changedFieldLabels.push("self-validation") }
      if (cellEditingFloor !== baseline.cellEditingFloor) { sharedUpdates.cellEditingFloor = cellEditingFloor; changedFieldLabels.push("who can add and remove cells") }
      if (allowTrackEditing !== baseline.allowTrackEditing) { sharedUpdates.allowTrackEditing = allowTrackEditing; changedFieldLabels.push("timeline track editing") }
      if (timingLocked !== baseline.timingLocked) { sharedUpdates.timingLocked = timingLocked; changedFieldLabels.push("the timing lock") }
      if (harmonizeMinRole !== baseline.harmonize_min_role) { sharedUpdates.harmonize_min_role = harmonizeMinRole; changedFieldLabels.push("harmonize min role") }
      if (bibleResourcesEnabled !== baseline.bibleResourcesEnabled) { sharedUpdates.bibleResourcesEnabled = bibleResourcesEnabled; changedFieldLabels.push("Bible resources") }
      if (importExcludeFrontMatter !== baseline.importExcludeFrontMatter) { sharedUpdates.importExcludeFrontMatter = importExcludeFrontMatter; changedFieldLabels.push("USFM front matter") }
      if (precedingTargetCells !== baseline.precedingTargetCells) {
        sharedUpdates.draftContext = { precedingTargetCells }
        changedFieldLabels.push("draft context")
      }

      if (Object.keys(sharedUpdates).length > 0) {
        const out = await patchShared(sharedUpdates)
        if (out.kind === "conflict") {
          toast.add({
            type: "warning",
            title: t("projectSettings.save.conflictToast", {
              username: out.latest.updatedBy?.username ?? t("projectSettings.save.conflictFallbackUsername"),
            }),
          })
          setSaveError("Someone else updated shared settings. Refresh to reapply your edits.")
          return false
        }
        if (out.kind === "blocked") {
          if (out.reason === "offline") {
            setSaveError("You're offline. Reconnect to save shared fields.")
          } else {
            setSaveError(t("projectSettings.permission.onlyRoleCanModify", {
              role: resolveRoleName(t, ROLE.MAINTAINER, { plural: true }),
            }))
          }
          return false
        }
        if (out.kind === "error") {
          setSaveError(out.message || "Saving shared settings failed.")
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
      const newBaseline: Baseline = {
        name: trimmedName,
        sourceLanguage,
        targetLanguage,
        username,
        provider,
        endpoint: endpoint.trim(),
        apiKey,
        model,
        maxTokens,
        temperature,
        llmHealthPenalty,
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
        cellEditingFloor,
        allowTrackEditing,
        timingLocked,
        harmonize_min_role: harmonizeMinRole,
        bibleResourcesEnabled,
        decaySettings,
        audioMediaStrategy,
        geminiApiKey,
        precedingTargetCells,
        importExcludeFrontMatter,
      }
      setBaseline(newBaseline)
      // Refresh `useProject` in the background so other components see the
      // updated IDB record. We don't await it — the form is already correct.
      refresh()

      // AQU-408 acceptance criterion: the success message reflects the actual
      // delta saved (a brief enumeration of which fields changed), and the
      // page/modal stays open afterward — callers decide separately whether
      // to also navigate away (see handleSaveAndClose).
      const message =
        changedFieldLabels.length === 0
          ? "No changes to save."
          : changedFieldLabels.length <= 3
            ? `Saved: ${changedFieldLabels.join(", ")}.`
            : `Saved ${changedFieldLabels.length} changes: ${changedFieldLabels.slice(0, 3).join(", ")}, +${changedFieldLabels.length - 3} more.`
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
    id, baseline, name, sourceLanguage, targetLanguage, username, provider, endpoint, apiKey,
    model, maxTokens, temperature, llmHealthPenalty,
    topK, contextSize, useOnlyValidatedExamples, fewShotExampleFormat, mainChatLanguage,
    completionBatchSize, validationBatchSize,
    autoSyncEnabled, autoSyncInterval, validationCount, validationCountAudio,
    validationRoleFloor, validationNamedUsers, allowSelfValidation, harmonizeMinRole,
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
    bibleResourcesEnabled, audioMediaStrategy, decaySettings, geminiApiKey, patchShared, refresh, applyBaseline, project,
    precedingTargetCells, importExcludeFrontMatter, getJwt, isCloudProject, t,
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

  const ALL_SECTIONS: SettingsSection[] = [
    { id: "section-source-link", label: "Source link", keywords: ["source", "linked", "upstream", "detach"], visible: hasSourceLink },
    { id: "section-upstream-changes", label: "Upstream changes", keywords: ["upstream", "changes", "repin", "review", "mirror", "stale"], visible: hasLiveSourceLink },
    { id: "section-dcs-upstream", label: "Door43 upstream", keywords: ["door43", "dcs", "unfoldingword", "upstream", "check for updates", "import changes", "release"], visible: hasDcsUpstream },
    { id: "section-project-info", label: "Project Info", keywords: ["name", "source language", "target language"] },
    { id: "section-languages", label: "Languages", keywords: ["languages", "target lanes", "lane", "target language", "dialect"] },
    { id: "section-bible-resources", label: "Bible resources", keywords: ["bible resources", "aquifer", "bibletranslation", "reference", "scholarly", "translation notes"] },
    { id: "section-import", label: "Import", keywords: ["import", "usfm", "front matter", "book title", "book name", "introduction", "toc", "running header", "paratext", "door43"] },
    { id: "section-user", label: "User", keywords: ["username", "author"] },
    { id: "section-members", label: "Team members", keywords: ["members", "invite", "invite link", "link", "join", "share", "access", "role", "roster", "collaborator"], visible: canSeeMembers },
    // AQU-1068: a permission, so it lives with the roles rather than in the
    // Timeline card it grew out of — it governs ordinary text files now, not
    // just the timeline's silences.
    { id: "section-cell-editing", label: "Content structure", keywords: ["add cell", "remove cell", "insert", "delete", "structure", "verse", "line", "row", "restructure", "permission", "role"] },
    { id: "section-ai-instructions", label: "AI Instructions", keywords: ["ai", "llm", "instructions", "batch size", "completions batch", "validation batch", "batch validate", "top_k", "examples", "context window", "assistant language", "few shot"] },
    { id: "section-draft-context", label: "Draft Context", keywords: ["draft context", "preceding cells", "left context", "paragraph drafting", "context budget"] },
    { id: "section-advanced-llm", label: "Advanced LLM", keywords: ["provider", "endpoint", "api key", "model", "temperature", "max tokens", "health penalty", "frontier", "openai", "custom"] },
    { id: "section-voice", label: "Voice", keywords: ["tts", "voice studio", "audio", "gemini", "api key", "tts key"] },
    { id: "section-local-models", label: "Local AI models", keywords: ["whisper", "kokoro", "mms", "transcription", "model", "download", "offline", "local ai"] },
    { id: "section-validation", label: "Validation", keywords: ["validation count", "approvals", "audio validation"] },
    { id: "section-decay", label: "Retrieval support", keywords: ["decay", "decay threshold", "half life", "retrieval support", "max hops", "attention threshold"] },
    { id: "section-audio-media", label: "Audio Media", keywords: ["audio media strategy", "lazy", "eager"] },
    { id: "section-timeline", label: "Timeline", keywords: ["timeline", "add line", "create cell", "silence", "dubbing", "lines", "track", "tracks", "multi-track", "folder", "colour", "color"] },
    { id: "section-git-sync", label: "Git Sync", keywords: ["git", "sync", "auto sync", "interval", "branch", "clone"], visible: hasGitOrigin },
    { id: "section-terminology", label: "Terminology", keywords: ["terminology", "termbase", "glossary", "concepts"] },
    { id: "section-termbase-sharing", label: "Term Base Sharing", keywords: ["term base", "termbase", "publish", "subscribe", "org", "shared", "glossary"], visible: SHOW_TERMBASE_SHARING_IN_SETTINGS },
    { id: "section-ai-metrics", label: "AI Metrics", keywords: ["post-edit", "edit distance", "ai metrics", "magnitude", "levenshtein", "ned", "biblica"] },
    // Monday.com board sync — cloud (synced) projects only: the link lives on
    // the server against the project's org connection.
    { id: "section-monday", label: "Monday.com", keywords: ["monday", "integration", "board", "push", "progress sync", "project management"], visible: isCloudProject },
    { id: "section-experimental", label: "Experimental", keywords: ["experimental", "flags", "beta", "preview", "contextual", "contextual drafting"] },
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
    /** Hub group label on the settings index (NavList). */
    hub: string
    /** Omit from the settings index (still deep-linkable as a pane). */
    hideFromIndex?: boolean
    /** Parent group id when this is a nested detail pane (breadcrumb trail). */
    parentId?: string
  }[] = [
    {
      id: "general",
      label: "General",
      description: "Name, languages, content structure, username, Bible resources",
      icon: SlidersHorizontal,
      hub: "Project",
      sectionIds: ["section-project-info", "section-languages", "section-cell-editing", "section-bible-resources", "section-import", "section-user"],
    },
    {
      id: "members",
      label: "Members",
      description: "Who can access this project, invites, and roles",
      icon: Users,
      hub: "Project",
      wide: true,
      sectionIds: ["section-members"],
    },
    {
      id: "source-sync",
      label: "Source & sync",
      description: "Linked source project, upstream changes, git sync",
      icon: Link2,
      hub: "Project",
      sectionIds: [
        "section-source-link",
        "section-upstream-changes",
        "section-dcs-upstream",
        "section-git-sync",
      ],
    },
    {
      id: "ai",
      label: "AI & completion",
      description: "Instructions, draft context, provider, voice, terminology",
      icon: Sparkles,
      hub: "AI & media",
      // The system prompt (and the rest of Living Memory) lives on the
      // standalone /project/:id/memory surface; this pane keeps a cross-link
      // NavRow to memory/instructions instead of a nested settings page.
      sectionIds: [
        "section-ai-instructions", "section-draft-context", "section-advanced-llm",
        "section-voice", "section-local-models", "section-terminology", "section-termbase-sharing",
      ],
    },
    {
      id: "validation",
      label: "Validation & health",
      description: "Approvals, harmonization, staleness decay",
      icon: ShieldCheck,
      hub: "Quality",
      sectionIds: ["section-validation", "section-decay"],
    },
    {
      id: "audio-media",
      label: "Audio media",
      description: "How audio is fetched from storage",
      icon: AudioLines,
      hub: "AI & media",
      sectionIds: ["section-audio-media", "section-timeline"],
    },
    {
      id: "metrics",
      label: "AI metrics",
      description: "Post-edit distance and AI usage",
      icon: BarChart3,
      hub: "AI & media",
      sectionIds: ["section-ai-metrics"],
    },
    {
      id: "integrations",
      label: "Integrations",
      description: "Monday.com board sync",
      icon: Plug,
      hub: "Integrations",
      sectionIds: ["section-monday"],
    },
    {
      id: "experimental",
      label: "Experimental",
      description: "Early features, this device only",
      icon: FlaskConical,
      hub: "Integrations",
      sectionIds: ["section-experimental"],
    },
  ]

  const HUB_ORDER = ["Project", "AI & media", "Quality", "Integrations"] as const

  const visibleSectionIdSet = new Set(visibleSections.map((s) => s.id))
  const visibleGroups = SETTINGS_GROUPS
    .map((g) => ({ ...g, sectionIds: g.sectionIds.filter((id) => visibleSectionIdSet.has(id)) }))
    .filter((g) => g.sectionIds.length > 0)
  // Index lists only hub-level entries; a `hideFromIndex` pane stays
  // deep-linkable but is opened from a parent pane NavRow.
  const indexGroups = visibleGroups.filter((g) => !g.hideFromIndex)

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
    ? "Project settings"
    : activeGroup.label
  const pageDescription = lowerQuery || !activeGroup
    ? "Configure this project. Changes apply to everyone with access."
    : activeGroup.description
  // Table panes (Members roster) need the wider content well; form panes stay
  // intentional/narrow. Search flattens across groups → keep default width.
  const pageSize = activeGroup?.wide && !lowerQuery ? "wide" : "default"
  const modalWidthClass = pageSize === "wide"
    ? "max-w-[min(72rem,calc(100%-2rem))] sm:max-w-[min(72rem,calc(100%-2rem))]"
    : "max-w-[min(42rem,calc(100%-2rem))] sm:max-w-[min(42rem,calc(100%-2rem))]"

  // Hints for index NavRows — short current-value summaries (org / Preferences pattern).
  const groupHints: Record<string, string> = {
    general: name.trim() || "Untitled",
    members: "Roles & invites",
    "source-sync": hasSourceLink ? "Linked" : hasGitOrigin ? "Git" : "None",
    ai: provider === "frontier" ? "Frontier" : "Custom",
    validation: resolveRoleName(t, validationRoleFloor),
    "audio-media": t(AUDIO_MEDIA_STRATEGY_LABELS[audioMediaStrategy].nameKey),
    metrics: "Post-edit",
    integrations: "Monday.com",
    experimental: "This device",
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
                <Button
                  size="icon-sm"
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
          ? [{ label: "Editor", onClick: () => requestNavigate(editorPath) }]
          : []),
        onSettingsPane
          ? { label: "Settings", to: settingsHref() }
          : { label: "Settings" },
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

  const settingsContent = (
    <Page size={pageSize}>
          {modal && onSettingsPane ? (
            <BackLink
              className="mb-6"
              label={breadcrumbParent?.label ?? t("editor.navTitle.projectSettings")}
              onClick={() => requestHistoryNavigation(-1)}
            />
          ) : null}
          <div className="flex flex-col gap-12">
            <PageHeader
              title={pageTitle}
              description={pageDescription}
              actions={headerActions}
              inset={pageSize !== "wide"}
              className="mb-0"
            />

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
                    <NavList key={hub} label={hub}>
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
        {searchGroupLabel("section-source-link")}
        {hasSourceLink && project?.sourceProjectId && sectionsToRender.some((s) => s.id === "section-source-link") && (
          <SourceLinkSection
            projectId={id!}
            sourceProjectId={project.sourceProjectId}
            sourceLinkMode={project.sourceLinkMode}
            sourceLinkConsumes={project.sourceLinkConsumes}
            sourceLinkGate={project.sourceLinkGate}
            sourceLinkCursor={project.sourceLinkCursor}
            onDetached={refresh}
            roleLevel={project?.syncRole?.level ?? null}
          />
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
            <SettingsGroup label={t("projectSettings.section.projectInfo")}>
              <SettingsRow
                label={<label htmlFor="pname">{t("projectSettings.info.titleLabel")}</label>}
                description={
                  sharedUpdatedBy && sharedUpdatedAt && sharedVersion != null && sharedVersion > 0
                    ? t("projectSettings.shared.lastEdited", {
                        name: sharedUpdatedBy.username,
                        date: new Date(sharedUpdatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }),
                      })
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
                label={<label htmlFor="sl">{t("projectSettings.info.sourceLanguageLabel")}</label>}
                control={
                  <DisabledFieldTooltip disabled={!canEditLanguages} tooltip={languageDisabledTooltip}>
                    <LanguageComboboxInput
                      id="sl"
                      value={sourceLanguage}
                      onValueChange={setSourceLanguage}
                      disabled={!canEditLanguages}
                      aria-label={t("projectSettings.info.sourceLanguageLabel")}
                      className="w-40 bg-background"
                    />
                  </DisabledFieldTooltip>
                }
              />
              <SettingsRow
                label={<label htmlFor="tl">{t("projectSettings.info.targetLanguageLabel")}</label>}
                control={
                  <DisabledFieldTooltip disabled={!canEditLanguages} tooltip={languageDisabledTooltip}>
                    <LanguageComboboxInput
                      id="tl"
                      value={targetLanguage}
                      onValueChange={setTargetLanguage}
                      disabled={!canEditLanguages}
                      aria-label={t("projectSettings.info.targetLanguageLabel")}
                      className="w-40 bg-background"
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
          />
        )}

        {searchGroupLabel("section-cell-editing")}
        {sectionsToRender.some((s) => s.id === "section-cell-editing") && (
          <div id="section-cell-editing">
            {/* AQU-1068. One setting answers WHO; the file's own nature answers
                WHERE — a text file takes a cell anywhere, a subtitle file only
                in a gap — so nothing here mentions timings or media. */}
            <SettingsGroup label={t("projectSettings.cellEditing.sectionTitle")}>
              <SettingsRow
                label={<label htmlFor="cell-editing-floor">{t("projectSettings.cellEditing.label")}</label>}
                description={t("projectSettings.cellEditing.description")}
                control={
                  <DisabledFieldTooltip disabled={!canEditShared} tooltip={sharedDisabledTooltip ?? null}>
                    <Select
                      items={CELL_EDITING_FLOOR_OPTIONS.map((o) => ({
                        value: o.value,
                        label: (o.level != null ? FLOOR_LABEL[o.level] : undefined) ?? t(o.labelKey),
                      }))}
                      disabled={!canEditShared}
                      value={cellEditingFloor}
                      onValueChange={(value) =>
                        setCellEditingFloor((value ?? cellEditingFloor) as typeof cellEditingFloor)
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
                  </DisabledFieldTooltip>
                }
              />
            </SettingsGroup>
          </div>
        )}

        {searchGroupLabel("section-bible-resources")}
        {sectionsToRender.some((s) => s.id === "section-bible-resources") && (
          <div id="section-bible-resources">
            <SettingsGroup label={t("projectSettings.section.bibleResources")}>
              <SettingsRow
                label={<label htmlFor="bible-resources-enabled">{t("projectSettings.bible.enableLabel")}</label>}
                description={
                  <>
                    {t("projectSettings.bible.description")}
                    {bibleResourcesEnabled === undefined && projectHasScriptureFiles(project?.files) ? (
                      <span className="mt-1 block">{t("projectSettings.bible.scriptureDefaultHint")}</span>
                    ) : null}
                    {bibleResourcesEnabled === undefined && !projectHasScriptureFiles(project?.files) ? (
                      <span className="mt-1 block">{t("projectSettings.bible.nonScriptureDefaultHint")}</span>
                    ) : null}
                    {bibleResourcesEnabled === false ? (
                      <span className="mt-1 block">{t("projectSettings.bible.disabledHint")}</span>
                    ) : null}
                  </>
                }
                control={
                  <DisabledFieldTooltip disabled={!canEditShared} tooltip={sharedDisabledTooltip ?? null}>
                    <Switch
                      id="bible-resources-enabled"
                      checked={resolveBibleResourcesEnabled(bibleResourcesEnabled, projectHasScriptureFiles(project?.files))}
                      onCheckedChange={(checked) => setBibleResourcesEnabled(checked)}
                      disabled={!canEditShared}
                      aria-label={t("projectSettings.bible.enableLabel")}
                    />
                  </DisabledFieldTooltip>
                }
              />
            </SettingsGroup>
          </div>
        )}

        {searchGroupLabel("section-import")}
        {sectionsToRender.some((s) => s.id === "section-import") && (
          <div id="section-import">
            <SettingsGroup label={t("projectSettings.section.import")}>
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
            </SettingsGroup>
          </div>
        )}

        {searchGroupLabel("section-user")}
        {sectionsToRender.some((s) => s.id === "section-user") && (
          <div id="section-user">
            <SettingsGroup label={t("projectSettings.section.user")}>
              <SettingsRow
                label={<label htmlFor="un">{t("projectSettings.user.usernameLabel")}</label>}
                description={t("projectSettings.user.usernameDescription")}
                control={
                  <Input
                    id="un"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder={t("projectSettings.user.usernamePlaceholder")}
                    aria-label={t("projectSettings.user.usernameLabel")}
                    className="w-40 bg-background"
                  />
                }
              />
            </SettingsGroup>
          </div>
        )}

        {searchGroupLabel("section-members")}
        {id && sectionsToRender.some((s) => s.id === "section-members") && (
          <MembersSection projectId={id} />
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
                      ? "Custom"
                      : "Default"
                  }
                />
              </NavList>
            ) : null}
            <SettingsGroup label={t("projectSettings.section.aiInstructions")}>
              <SettingsRow
                label={<label htmlFor="top-k">{t("projectSettings.ai.topKLabel")}</label>}
                description={t("projectSettings.ai.topKDescription", { defaultCount: DEFAULT_APPROVED_EXAMPLE_COUNT })}
                control={
                  <Input
                    id="top-k"
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
              <SettingsRow label={t("projectSettings.advancedLlm.providerLabel")} block>
                <RadioGroup
                  name="provider"
                  value={provider}
                  onValueChange={(value) => setProvider(value as CompletionProvider)}
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
                    description={t("projectSettings.advancedLlm.apiKeyDeviceOnlyNote")}
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
                        <Select value={model} onValueChange={(value) => setModel(value ?? "")}>
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
                    />
                  </div>
                }
              />
              <SettingsRow
                label={t("projectSettings.advancedLlm.healthPenaltyLabel", { percent: Math.round(llmHealthPenalty * 100) })}
                description={t("projectSettings.advancedLlm.healthPenaltyDescription")}
                control={
                  <div className="w-40">
                    <Slider
                      min={0}
                      max={0.5}
                      step={0.05}
                      value={[llmHealthPenalty]}
                      onValueChange={(next) => setLlmHealthPenalty(Array.isArray(next) ? next[0] : next)}
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
                label="Gemini TTS"
                description={t("projectSettings.voice.geminiKeyHelp")}
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
                    onClick={() => requestNavigate("/preferences")}
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
              validationCount={validationCount}
              validationCountAudio={validationCountAudio}
              hasAnyAudioData={Boolean(project?.hasAnyAudioData)}
              validationRoleFloor={validationRoleFloor}
              validationNamedUsers={validationNamedUsers}
              allowSelfValidation={allowSelfValidation}
              disabled={!canEditShared}
              disabledTooltip={sharedDisabledTooltip ?? undefined}
              onChange={(u) => {
                if (u.validationCount !== undefined) setValidationCount(u.validationCount)
                if (u.validationCountAudio !== undefined) setValidationCountAudio(u.validationCountAudio)
                if (u.validationRoleFloor !== undefined) setValidationRoleFloor(u.validationRoleFloor)
                if (u.validationNamedUsers !== undefined) setValidationNamedUsers(u.validationNamedUsers)
                if (u.allowSelfValidation !== undefined) setAllowSelfValidation(u.allowSelfValidation)
              }}
            />
            {/* AQU-186: Harmonization settings — harmonize_min_role floor. */}
            <SettingsGroup label={t("projectSettings.harmonization.title")}>
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
              <div className="flex items-start gap-2">
                <Checkbox
                  id="timing-locked"
                  data-testid="settings-timing-locked"
                  checked={timingLocked}
                  disabled={!canEditShared}
                  onCheckedChange={(checked) => setTimingLocked(checked)}
                />
                <label htmlFor="timing-locked" className="text-sm">
                  {t("projectSettings.timeline.lockLabel")}
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t("projectSettings.timeline.lockHint")}
                  </p>
                </label>
              </div>
              {/* AQU-646 stage 2. LAST in the card, because it is the wider
                  claim of the two: the lock above constrains what may move on
                  a timeline, this one decides whether the timeline's own rows
                  may be added to, grouped and recoloured at all. Off by
                  default, and enforced on the server as well — the UI
                  withholding a button is not a permission. */}
              <div className="flex items-start gap-2">
                <Checkbox
                  id="allow-track-editing"
                  data-testid="settings-allow-track-editing"
                  checked={allowTrackEditing}
                  disabled={!canEditShared}
                  onCheckedChange={(checked) => setAllowTrackEditing(checked)}
                />
                <label htmlFor="allow-track-editing" className="text-sm">
                  {t("projectSettings.timeline.trackEditingLabel")}
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t("projectSettings.timeline.trackEditingHint")}
                  </p>
                </label>
              </div>
            </CardContent>
          </Card>
        )}

        {searchGroupLabel("section-git-sync")}
        {/* i18n-exempt "git" is a project-origin kind, not copy */}
        {project?.origin?.kind === "git" && sectionsToRender.some((s) => s.id === "section-git-sync") && (
          <div id="section-git-sync">
            <SettingsGroup label={t("projectSettings.section.gitSync")}>
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
                label={<label htmlFor="auto-sync">Auto-sync</label>}
                description={t("projectSettings.gitSync.intervalNote")}
                control={
                  <div className="flex items-center gap-2">
                    <Switch
                      id="auto-sync"
                      checked={autoSyncEnabled}
                      onCheckedChange={(checked) => setAutoSyncEnabled(checked)}
                      aria-label="Auto-sync"
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
            orgId={org?.id ?? null}
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
