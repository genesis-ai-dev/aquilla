import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from "react"
import { useParams, useNavigate, useSearchParams } from "react-router-dom"
import { projectSettingsPath } from "@/lib/navigation/org-paths"
import {
  Check, CheckCircle, XCircle, ChevronDown, Sparkles, Save, HardDriveDownload,
  SlidersHorizontal, Link2, BarChart3, ShieldCheck, AudioLines,
} from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { ButtonGroup, ButtonGroupSeparator } from "@/components/ui/button-group"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Checkbox } from "@/components/ui/checkbox"
import { Switch } from "@/components/ui/switch"
import { Input } from "@/components/ui/input"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
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
import { Textarea } from "@/components/ui/textarea"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { DisabledFieldTooltip } from "./ProjectSettings/DisabledFieldTooltip"
import { AppShell } from "@/components/AppShell"
import { OrgSidebar } from "@/components/org/OrgSidebar"
import { OrgBreadcrumb } from "@/components/org/OrgBreadcrumb"
import { Page, PageHeader } from "@/components/ui/page"
import { useProject } from "@/hooks/useProject"
import { useProjectSettings } from "@/hooks/useProjectSettings"
import { getProject, updateProject } from "@/lib/store/project-index"
import { fetchModels, resolveProvider } from "@/lib/completion/completion-service"
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
import { projectHasScriptureFiles, resolveBibleResourcesEnabled } from "@/lib/parsers/types"
import { DEFAULT_DRAFT_CONTEXT } from "@/lib/completion/draft-context"
import { ValidationSettingsSection } from "./ProjectSettings/ValidationSettingsSection"
import { DecaySettingsSection } from "./ProjectSettings/DecaySettingsSection"
import { AudioMediaStrategySection } from "./ProjectSettings/AudioMediaStrategySection"
import { TermbaseSharingSection } from "./ProjectSettings/TermbaseSharingSection"
import { SourceLinkSection } from "./ProjectSettings/SourceLinkSection"
import { LanguagesSection } from "./ProjectSettings/LanguagesSection"
import { DcsUpstreamPanel } from "@/components/dcs/DcsUpstreamPanel"
import { readCursor } from "@/lib/dcs/cursor"
import { UpstreamChangesPanel } from "./linked/UpstreamChangesPanel"
import { buildFileScopedTokenFetcher } from "@/lib/sync/cqrs-bridge"
import { useOrg } from "@/hooks/useOrg"
import { ApiKeyField } from "./ApiKeyField"
import { SettingsNav, type SettingsSection } from "./ProjectSettings/SettingsNav"
import { NavList, NavRow, BackLink } from "@/components/ui/nav-list"
import { readValidationCount, readValidationCountAudio } from "@/lib/progress/read-validation-count"
import { setUserApiKey, useUserApiKey } from "@/lib/store/user-api-keys"
import type { ProjectWideSettings } from "@/lib/sync/project-settings"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { PermissionDeniedAlert } from "@/components/PermissionDeniedAlert"
import { humanRoleName } from "@/lib/frontier/roles"
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

// Well-known OpenAI-compatible providers.
const CUSTOM_PRESETS: { id: string; label: string; endpoint: string; requiresKey: boolean; keyHint?: string }[] = [
  { id: "local", label: "Local / self-hosted (no key)", endpoint: "http://localhost:8000", requiresKey: false },
  { id: "openrouter", label: "OpenRouter", endpoint: "https://openrouter.ai/api/v1", requiresKey: true, keyHint: "sk-or-..." },
  { id: "openai", label: "OpenAI", endpoint: "https://api.openai.com/v1", requiresKey: true, keyHint: "sk-..." },
  { id: "groq", label: "Groq", endpoint: "https://api.groq.com/openai/v1", requiresKey: true, keyHint: "gsk_..." },
  { id: "together", label: "Together AI", endpoint: "https://api.together.xyz/v1", requiresKey: true },
  { id: "mistral", label: "Mistral", endpoint: "https://api.mistral.ai/v1", requiresKey: true },
  { id: "deepseek", label: "DeepSeek", endpoint: "https://api.deepseek.com/v1", requiresKey: true },
  { id: "custom", label: "Other (enter URL manually)", endpoint: "", requiresKey: false },
]

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
  systemPrompt: string
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
    maxTokens: project.completionSettings?.maxTokens ?? 512,
    temperature: project.completionSettings?.temperature ?? 0.3,
    systemPrompt: project.completionSettings?.systemPrompt || DEFAULT_SYSTEM_PROMPT,
    llmHealthPenalty: project.completionSettings?.llmHealthPenalty ?? 0.1,
    top_k: project.completionSettings?.top_k ?? 15,
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

export function ProjectSettings() {
  const { id, section: sectionParam } = useParams<{ id: string; section?: string }>()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { project, loading, refresh } = useProject(id!)

  // Workspace handoff (`?return=…`) — only accept same-origin relative paths.
  const returnParam = searchParams.get("return")
  const editorPath =
    returnParam && returnParam.startsWith("/") && !returnParam.startsWith("//")
      ? returnParam
      : `/project/${id}/editor`

  const {
    canEdit: canEditShared,
    reasonCannotEdit,
    patch: patchShared,
    version: sharedVersion,
    updatedAt: sharedUpdatedAt,
    updatedBy: sharedUpdatedBy,
    conflict: sharedConflict,
    dismissConflict,
    hasFetched: sharedSettingsFetched,
    settings: sharedSettingsBlob,
  } = useProjectSettings(id ?? null, project?.syncRole?.level ?? null)

  // Org context for the termbase-sharing section. The user's org; the section's
  // server calls re-validate org-membership / org-ownership, so a mismatch just
  // yields graceful empty/403 states.
  const { org } = useOrg()

  // AQU-311: AI post-edit metrics
  const { session } = useFrontierSession()
  const isCloudProject = !!(project?.syncRole)
  const metricsFiles = useMemo(
    () => (project?.files ?? []).map((f) => ({ id: f.id, name: f.name })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [(project?.files ?? []).map((f) => f.id).join(",")],
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

  // Server enforces MAINTAINER (600) for settings writes — show the correct
  // floor in the read-only tooltip so users know what role they need.
  const sharedDisabledTooltip =
    reasonCannotEdit === "offline" ? "Reconnect to edit shared settings."
    : reasonCannotEdit === "role" ? "Maintainer or higher can edit shared settings."
    : null

  // AQU-623: a below-floor member's shared inputs are disabled up-front, so a
  // role-blocked save can never actually fire — show the denial alert
  // persistently for them instead of only after a rejected PATCH. Gated on
  // isCloudProject because unsynced projects also report reason "role"
  // (roleLevel is null) but have no shared-settings permission model.
  const roleBlocked = isCloudProject && reasonCannotEdit === "role"

  // Baseline is the last-saved snapshot of every field on the page. The diff
  // between baseline and the form state determines `isDirty` and which writes
  // we actually have to fire on Save.
  const [baseline, setBaseline] = useState<Baseline | null>(null)

  // Draft state — what the user is currently editing. Seeded once from the
  // baseline; never overwritten by background project re-renders (that's what
  // caused the "typed letter flashes then disappears" bug under auto-save).
  const [name, setName] = useState("")
  const [sourceLanguage, setSourceLanguage] = useState("")
  const [targetLanguage, setTargetLanguage] = useState("")
  const [username, setUsername] = useState("")
  const [provider, setProvider] = useState<CompletionProvider>("frontier")
  const [endpoint, setEndpoint] = useState("")
  const [apiKey, setApiKey] = useState("")
  const [presetId, setPresetId] = useState<string>("local")
  const [model, setModel] = useState("")
  const [maxTokens, setMaxTokens] = useState(512)
  const [temperature, setTemperature] = useState(0.3)
  const [systemPrompt, setSystemPrompt] = useState(DEFAULT_SYSTEM_PROMPT)
  const [llmHealthPenalty, setLlmHealthPenalty] = useState(0.1)
  const [topK, setTopK] = useState(15)
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
    setSystemPrompt(b.systemPrompt)
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
    } catch (err) {
      if (lastModelFetchKeyRef.current !== fetchKey) return
      setModels([])
      setConnected(false)
      setConnectionError(err instanceof Error ? err.message : "Connection failed")
    } finally {
      if (lastModelFetchKeyRef.current === fetchKey) setConnecting(false)
    }
  }, [effectiveCompletionApiKey, endpoint, model])

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
      systemPrompt !== baseline.systemPrompt ||
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
    model, maxTokens, temperature, systemPrompt, llmHealthPenalty,
    topK, contextSize, useOnlyValidatedExamples, fewShotExampleFormat, mainChatLanguage,
    completionBatchSize, validationBatchSize,
    autoSyncEnabled, autoSyncInterval, validationCount, validationCountAudio,
    validationRoleFloor, validationNamedUsers, allowSelfValidation,
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
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  // Distinct from `saveError`: a shared-settings save blocked by the active
  // account's role. Rendered as an enriched inline alert (names the account,
  // offers an account switch) rather than the bare header string.
  const [permissionBlocked, setPermissionBlocked] = useState(false)
  // Clear the permission alert when the active account changes (e.g. the user
  // clicks "switch account" in the alert itself) or the current account gains
  // edit permission — otherwise the stale alert re-renders and misattributes the
  // denial to the newly-active, possibly-authorized account.
  useEffect(() => {
    setPermissionBlocked(false)
  }, [session?.username, canEditShared])
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
    setPermissionBlocked(false)
    setSavedMessage(null)
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
      if (name !== baseline.name) { localUpdates.name = name; changedFieldLabels.push("project name") }
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
        await updateProject({ ...latest, ...localUpdates, completionSettings: nextCompletion, ttsSettings: nextTtsSettings })
      }

      const sharedUpdates: ProjectWideSettings = {}
      if (sourceLanguage !== baseline.sourceLanguage) { sharedUpdates.sourceLanguage = sourceLanguage; changedFieldLabels.push("source language") }
      if (targetLanguage !== baseline.targetLanguage) { sharedUpdates.targetLanguage = targetLanguage; changedFieldLabels.push("target language") }
      if (systemPrompt !== baseline.systemPrompt) { sharedUpdates.systemPrompt = systemPrompt; changedFieldLabels.push("AI instructions") }
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
          toast.warning(
            `Synced settings update from ${out.latest.updatedBy?.username ?? "another collaborator"}.`,
          )
          setSaveError("Someone else updated shared settings. Refresh to reapply your edits.")
          return false
        }
        if (out.kind === "blocked") {
          if (out.reason === "offline") {
            setSaveError("You're offline. Reconnect to save shared fields.")
          } else {
            // Permission (role) block — surface the enriched alert that names
            // the active account and offers an account switch, instead of the
            // bare "You don't have permission…" header string.
            setPermissionBlocked(true)
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
      const newBaseline: Baseline = {
        name,
        sourceLanguage,
        targetLanguage,
        username,
        provider,
        endpoint: endpoint.trim(),
        apiKey,
        model,
        maxTokens,
        temperature,
        systemPrompt,
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
    model, maxTokens, temperature, systemPrompt, llmHealthPenalty,
    topK, contextSize, useOnlyValidatedExamples, fewShotExampleFormat, mainChatLanguage,
    completionBatchSize, validationBatchSize,
    autoSyncEnabled, autoSyncInterval, validationCount, validationCountAudio,
    validationRoleFloor, validationNamedUsers, allowSelfValidation, harmonizeMinRole,
    bibleResourcesEnabled, audioMediaStrategy, decaySettings, geminiApiKey, patchShared, refresh, applyBaseline, project,
    precedingTargetCells, importExcludeFrontMatter,
  ])

  const handleSaveAndClose = useCallback(async () => {
    const ok = await handleSave()
    // `saveError` from the render closure is stale (set inside handleSave
    // during this same tick); rely on the returned boolean instead.
    if (!ok) return
    navigate(editorPath)
  }, [handleSave, navigate, editorPath])

  const handleDiscardConfirm = useCallback(() => {
    if (baseline) applyBaseline(baseline)
    setDiscardOpen(false)
    const target = pendingNav ?? editorPath
    setPendingNav(null)
    navigate(target)
  }, [baseline, applyBaseline, pendingNav, navigate, editorPath])

  const handleDiscardCancel = useCallback(() => {
    setDiscardOpen(false)
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
    { id: "section-ai-instructions", label: "AI Instructions", keywords: ["system prompt", "ai", "llm", "instructions", "batch size", "completions batch", "validation batch", "batch validate"] },
    { id: "section-draft-context", label: "Draft Context", keywords: ["draft context", "preceding cells", "left context", "paragraph drafting", "context budget"] },
    { id: "section-advanced-llm", label: "Advanced LLM", keywords: ["provider", "endpoint", "api key", "model", "temperature", "max tokens", "health penalty", "frontier", "openai", "custom"] },
    { id: "section-voice", label: "Voice", keywords: ["tts", "voice studio", "audio", "gemini", "api key", "tts key"] },
    { id: "section-local-models", label: "Local AI models", keywords: ["whisper", "kokoro", "mms", "transcription", "model", "download", "offline", "local ai"] },
    { id: "section-decay", label: "Decay", keywords: ["decay", "decay threshold", "half life"] },
    { id: "section-validation", label: "Validation", keywords: ["validation count", "approvals", "audio validation"] },
    { id: "section-audio-media", label: "Audio Media", keywords: ["audio media strategy", "lazy", "eager"] },
    { id: "section-git-sync", label: "Git Sync", keywords: ["git", "sync", "auto sync", "interval", "branch", "clone"], visible: hasGitOrigin },
    { id: "section-terminology", label: "Terminology", keywords: ["terminology", "termbase", "glossary", "concepts"] },
    { id: "section-termbase-sharing", label: "Term Base Sharing", keywords: ["term base", "termbase", "publish", "subscribe", "org", "shared", "glossary"], visible: SHOW_TERMBASE_SHARING_IN_SETTINGS },
    { id: "section-ai-metrics", label: "AI Metrics", keywords: ["post-edit", "edit distance", "ai metrics", "magnitude", "levenshtein", "ned", "biblica"] },
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
  // index → detail pattern (src/pages/Settings.tsx) instead of one long
  // scroll. Pane identity lives in `/settings/:section`; search still
  // filters within the active pane, and clears the pane to show cross-group
  // matches (mirrors the old scroll-spy filter).
  const SETTINGS_GROUPS: {
    id: string
    label: string
    description: string
    icon: ComponentType<{ className?: string }>
    sectionIds: string[]
  }[] = [
    {
      id: "general",
      label: "General",
      description: "Name, languages, username, Bible resources",
      icon: SlidersHorizontal,
      sectionIds: ["section-project-info", "section-languages", "section-bible-resources", "section-import", "section-user"],
    },
    {
      id: "source-sync",
      label: "Source & sync",
      description: "Linked source project, upstream changes, git sync",
      icon: Link2,
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
      sectionIds: ["section-validation", "section-decay"],
    },
    {
      id: "audio-media",
      label: "Audio media",
      description: "How audio is fetched from storage",
      icon: AudioLines,
      sectionIds: ["section-audio-media"],
    },
    {
      id: "metrics",
      label: "AI metrics",
      description: "Post-edit distance and AI usage",
      icon: BarChart3,
      sectionIds: ["section-ai-metrics"],
    },
  ]

  const visibleSectionIdSet = new Set(visibleSections.map((s) => s.id))
  const visibleGroups = SETTINGS_GROUPS
    .map((g) => ({ ...g, sectionIds: g.sectionIds.filter((id) => visibleSectionIdSet.has(id)) }))
    .filter((g) => g.sectionIds.length > 0)

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
      "section-user",
      "section-ai-instructions",
      "section-draft-context",
      "section-advanced-llm",
      "section-voice",
      "section-local-models",
      "section-decay",
      "section-validation",
      "section-audio-media",
      "section-git-sync",
      "section-terminology",
      "section-termbase-sharing",
      "section-ai-metrics",
    ]
    const headers = new Map<string, string>()
    const claimedGroups = new Set<string>()
    for (const sectionId of renderOrder) {
      if (!shown.has(sectionId)) continue
      const group = visibleGroups.find((g) => g.sectionIds.includes(sectionId))
      if (!group || claimedGroups.has(group.id)) continue
      claimedGroups.add(group.id)
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

  const headerActions = (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {isDirty ? (
        <ButtonGroup>
          <Button size="sm" onClick={handleSave} disabled={saving}>
            {saving ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <Save data-icon="inline-start" />
            )}
            Save changes
          </Button>
          <ButtonGroupSeparator />
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  size="icon-sm"
                  disabled={saving}
                  aria-label="More save options"
                >
                  <ChevronDown />
                </Button>
              }
            />
            <DropdownMenuContent align="end" className="min-w-56">
              <DropdownMenuGroup>
                <DropdownMenuItem onClick={handleSaveAndClose}>
                  Save and close
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setDiscardOpen(true)}>
                  Close without saving
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </ButtonGroup>
      ) : null}
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        {isDirty && !saving && <span>Unsaved changes</span>}
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

  const breadcrumb = (
    <OrgBreadcrumb
      section={project?.name ?? "Project"}
      sectionTo={id ? `/projects/${id}` : undefined}
      orgId={project?.orgId}
      trail={[
        { label: "Editor", onClick: () => requestNavigate(editorPath) },
        { label: "Settings" },
      ]}
    />
  )

  if (loading) {
    return (
      <AppShell
        sidebar={<OrgSidebar />}
        header={breadcrumb}
        statusBar={null}
        main={
          <Page>
            <p className="text-muted-foreground">Loading...</p>
          </Page>
        }
      />
    )
  }

  const shell = (
    <AppShell
      sidebar={<OrgSidebar />}
      header={breadcrumb}
      statusBar={null}
      main={
        <Page>
          <div className="space-y-6">
            {!showIndex && (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <BackLink to={projectSettingsPath(id!)} label="Settings" />
              </div>
            )}
            <PageHeader
              title={pageTitle}
              description={pageDescription}
              actions={headerActions}
            />

            <SettingsNav onSearch={setSearchQuery} searchQuery={searchQuery} />

            {showIndex && !lowerQuery ? (
              <NavList>
                {visibleGroups.map((g) => (
                  <NavRow
                    key={g.id}
                    to={projectSettingsPath(id!, g.id)}
                    icon={g.icon}
                    title={g.label}
                    description={g.description}
                  />
                ))}
              </NavList>
            ) : null}

            {showIndex && lowerQuery && sectionsToRender.length === 0 ? (
              <p className="px-2 py-1.5 text-sm text-muted-foreground">No matching settings.</p>
            ) : null}

        {(permissionBlocked || roleBlocked) && (
          <PermissionDeniedAlert
            action="change shared settings"
            requiredRole="Maintainer or higher"
            currentRole={
              project?.syncRole ? humanRoleName(project.syncRole.level) : undefined
            }
          />
        )}
        {sharedConflict && (
          <div
            role="alert"
            className="flex items-start justify-between gap-3 rounded border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100"
          >
            <span>Settings changed elsewhere — refresh to reapply.</span>
            <button
              type="button"
              aria-label="Dismiss conflict notice"
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
          <Card id="section-project-info">
            <CardHeader><CardTitle>Project Info</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <div>
                <FieldLabel htmlFor="pname">Project Name</FieldLabel>
                {/* AQU-480: a synced project's name comes from the server and has
                    no rename endpoint (see auth-worker projects route — INSERT
                    only). Editing this field only wrote local IDB, which reverts
                    on the next server sync — a silent no-op for every role, and
                    un-gated for contributors. Gate it read-only with an honest
                    reason on cloud projects; local projects keep it editable
                    (their IDB record IS the source of truth). */}
                <DisabledFieldTooltip
                  disabled={isCloudProject}
                  tooltip={isCloudProject ? "Renaming a synced project isn't supported yet." : null}
                >
                  <Input
                    id="pname"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    disabled={isCloudProject}
                  />
                </DisabledFieldTooltip>
                {isCloudProject && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    Renaming a synced project isn't supported yet.
                  </p>
                )}
              </div>
              {sharedUpdatedBy && sharedUpdatedAt && sharedVersion != null && sharedVersion > 0 && (
                <p className="text-xs text-muted-foreground">
                  Last edited by {sharedUpdatedBy.username} ·{" "}
                  {new Date(sharedUpdatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
                </p>
              )}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <FieldLabel htmlFor="sl">Source Language</FieldLabel>
                  <DisabledFieldTooltip disabled={!canEditShared} tooltip={sharedDisabledTooltip}>
                    <Input id="sl" value={sourceLanguage} onChange={(e) => setSourceLanguage(e.target.value)} disabled={!canEditShared} />
                  </DisabledFieldTooltip>
                </div>
                <div>
                  <FieldLabel htmlFor="tl">Target Language</FieldLabel>
                  <DisabledFieldTooltip disabled={!canEditShared} tooltip={sharedDisabledTooltip}>
                    <Input id="tl" value={targetLanguage} onChange={(e) => setTargetLanguage(e.target.value)} disabled={!canEditShared} />
                  </DisabledFieldTooltip>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {searchGroupLabel("section-languages")}
        {sectionsToRender.some((s) => s.id === "section-languages") && (
          <LanguagesSection
            defaultTargetLanguage={sharedSettingsBlob?.targetLanguage ?? project?.targetLanguage ?? ""}
            targetLanes={sharedSettingsBlob?.targetLanes ?? []}
            archivedLanes={sharedSettingsBlob?.archivedLanes ?? []}
            canEdit={canEditShared}
            disabledTooltip={sharedDisabledTooltip}
            patch={patchShared}
          />
        )}

        {searchGroupLabel("section-bible-resources")}
        {sectionsToRender.some((s) => s.id === "section-bible-resources") && (
          <Card id="section-bible-resources">
            <CardHeader>
              <CardTitle>Bible resources</CardTitle>
            </CardHeader>
            <CardContent>
              <DisabledFieldTooltip disabled={!canEditShared} tooltip={sharedDisabledTooltip ?? null}>
                <div className="flex items-start justify-between gap-4">
                  <div className="space-y-0.5">
                    <FieldLabel htmlFor="bible-resources-enabled" className="text-sm">
                      Enable Bible resources
                    </FieldLabel>
                    <p className="text-xs text-muted-foreground">
                      Scholarly reference data from bibletranslation.org in Search and the agent.
                    </p>
                    {/* AQU-460 derive-on-read: nothing is written just by viewing this
                        page — the hint below only describes what's already true. */}
                    {bibleResourcesEnabled === undefined && projectHasScriptureFiles(project?.files) && (
                      <p className="text-xs text-muted-foreground">
                        Available by default for scripture projects — turn off to disable.
                      </p>
                    )}
                    {bibleResourcesEnabled === undefined && !projectHasScriptureFiles(project?.files) && (
                      <p className="text-xs text-muted-foreground">
                        Off by default for non-scripture projects — turn on to enable.
                      </p>
                    )}
                    {bibleResourcesEnabled === false && (
                      <p className="text-xs text-muted-foreground">
                        Turned off for this project. This is always respected, even for scripture projects.
                      </p>
                    )}
                  </div>
                  <Switch
                    id="bible-resources-enabled"
                    checked={resolveBibleResourcesEnabled(bibleResourcesEnabled, projectHasScriptureFiles(project?.files))}
                    onCheckedChange={(checked) => setBibleResourcesEnabled(checked)}
                    disabled={!canEditShared}
                  />
                </div>
              </DisabledFieldTooltip>
            </CardContent>
          </Card>
        )}

        {searchGroupLabel("section-import")}
        {sectionsToRender.some((s) => s.id === "section-import") && (
          <Card id="section-import">
            <CardHeader>
              <CardTitle>Import</CardTitle>
            </CardHeader>
            <CardContent>
              <DisabledFieldTooltip disabled={!canEditShared} tooltip={sharedDisabledTooltip ?? null}>
                <div className="flex items-start justify-between gap-4">
                  <div className="space-y-0.5">
                    <FieldLabel htmlFor="import-exclude-front-matter" className="text-sm">
                      Exclude USFM front matter
                    </FieldLabel>
                    <p className="text-xs text-muted-foreground">
                      When on, USFM imports drop the book name, running header, TOC, main
                      title, and introduction paragraphs. Section headings and Psalm titles
                      still import. Off (the default) imports front matter as translatable cells.
                    </p>
                  </div>
                  <Switch
                    id="import-exclude-front-matter"
                    checked={importExcludeFrontMatter}
                    onCheckedChange={(checked) => setImportExcludeFrontMatter(checked)}
                    disabled={!canEditShared}
                  />
                </div>
              </DisabledFieldTooltip>
            </CardContent>
          </Card>
        )}

        {searchGroupLabel("section-user")}
        {sectionsToRender.some((s) => s.id === "section-user") && (
          <Card id="section-user">
            <CardHeader><CardTitle>User</CardTitle></CardHeader>
            <CardContent>
              <FieldLabel htmlFor="un">Username</FieldLabel>
              <Input id="un" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="local" />
              <p className="mt-1 text-xs text-muted-foreground">Used as author name in translation history.</p>
            </CardContent>
          </Card>
        )}

        {searchGroupLabel("section-ai-instructions")}
        {sectionsToRender.some((s) => s.id === "section-ai-instructions") && (
          <Card id="section-ai-instructions">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-primary" />
                AI Instructions
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <DisabledFieldTooltip disabled={!canEditShared} tooltip={sharedDisabledTooltip}>
                <Textarea
                  id="sp"
                  value={systemPrompt}
                  onChange={(e) => setSystemPrompt(e.target.value)}
                  rows={6}
                  disabled={!canEditShared}
                  className="font-mono"
                  placeholder={DEFAULT_SYSTEM_PROMPT}
                />
              </DisabledFieldTooltip>
              <p className="text-xs text-muted-foreground">
                Describe what this project is producing and how translations should read — the AI uses this on every
                completion. Use <code className="rounded bg-muted px-1">{"{sourceLanguage}"}</code> and{" "}
                <code className="rounded bg-muted px-1">{"{targetLanguage}"}</code> as placeholders.
              </p>

              <div className="grid grid-cols-1 gap-4 pt-2 sm:grid-cols-2">
                <div className="space-y-1">
                  <FieldLabel htmlFor="top-k">Examples retrieved (top_k)</FieldLabel>
                  <Input
                    id="top-k"
                    type="number"
                    min={1}
                    max={20}
                    value={topK}
                    onChange={(e) => setTopK(Math.max(1, Math.min(20, Number(e.target.value))))}
                  />
                  <p className="text-xs text-muted-foreground">
                    How many reference examples the AI retrieves per translation (1–20). Default: 5.
                  </p>
                </div>

                {/* AQU-586: configurable batch sizes for the Run AI completions
                    and Batch validate workspace actions. */}
                <div className="space-y-1">
                  <FieldLabel htmlFor="completion-batch-size">AI completions batch size</FieldLabel>
                  <Input
                    id="completion-batch-size"
                    type="number"
                    min={1}
                    max={50}
                    value={completionBatchSize}
                    onChange={(e) =>
                      setCompletionBatchSize(Math.max(1, Math.min(50, Number(e.target.value) || 1)))
                    }
                    className="w-24"
                  />
                  <p className="text-xs text-muted-foreground">
                    How many untranslated cells one "Run AI completions" package drafts (1–50).
                    Run again to advance further. Default: {MAX_BATCH_COMPLETIONS}.
                  </p>
                </div>

                <div className="space-y-1">
                  <FieldLabel htmlFor="validation-batch-size">Batch validation size</FieldLabel>
                  <Input
                    id="validation-batch-size"
                    type="number"
                    min={0}
                    max={500}
                    value={validationBatchSize}
                    onChange={(e) =>
                      setValidationBatchSize(Math.max(0, Math.min(500, Number(e.target.value) || 0)))
                    }
                    className="w-24"
                  />
                  <p className="text-xs text-muted-foreground">
                    How many eligible cells one "Batch validate" run approves (0–500).
                    <strong> 0 validates all eligible cells</strong> (default); set a cap to
                    validate in bounded batches.
                  </p>
                </div>

                <div className="space-y-1">
                  <FieldLabel htmlFor="context-size">Context window</FieldLabel>
                  <Select
                    items={{
                      small: "Small — tight window",
                      medium: "Medium — paragraph (default)",
                      large: "Large — chapter",
                    }}
                    value={contextSize}
                    onValueChange={(value) => setContextSize(value as ContextSize)}
                  >
                    <SelectTrigger id="context-size" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value="small">Small — tight window</SelectItem>
                        <SelectItem value="medium">Medium — paragraph (default)</SelectItem>
                        <SelectItem value="large">Large — chapter</SelectItem>
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    Controls how much surrounding passage context is included.
                  </p>
                </div>

                <div className="space-y-1">
                  <FieldLabel htmlFor="main-chat-language">Assistant language</FieldLabel>
                  <Input
                    id="main-chat-language"
                    value={mainChatLanguage}
                    onChange={(e) => setMainChatLanguage(e.target.value)}
                    placeholder="e.g. English, Français, Español…"
                  />
                  <p className="text-xs text-muted-foreground">
                    Language the AI assistant uses in chat responses. Independent of the UI locale.
                  </p>
                </div>

                <div className="flex items-start gap-3 pt-1">
                  <Checkbox
                    id="validated-only"
                    className="mt-1"
                    checked
                    disabled
                  />
                  <div>
                    <FieldLabel htmlFor="validated-only">Approved examples only</FieldLabel>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      Drafting always retrieves human-validated project translations. Raw machine drafts never enter the trusted example pool.
                    </p>
                  </div>
                </div>

                <div className="space-y-1">
                  <FieldLabel htmlFor="few-shot-example-format">Reference example format</FieldLabel>
                  <Select
                    items={{
                      "source-and-target": "Source + target (default)",
                      "target-only": "Target only",
                    }}
                    value={fewShotExampleFormat}
                    onValueChange={(value) => setFewShotExampleFormat(value as "source-and-target" | "target-only")}
                  >
                    <SelectTrigger id="few-shot-example-format" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value="source-and-target">Source + target (default)</SelectItem>
                        <SelectItem value="target-only">Target only</SelectItem>
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    "Target only" shows only the target text of each example, useful when source alignment is unavailable or undesirable. The model is told these are reference translations to imitate.
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {searchGroupLabel("section-draft-context")}
        {sectionsToRender.some((s) => s.id === "section-draft-context") && (
          <Card id="section-draft-context">
            <CardHeader>
              <CardTitle>Draft Context</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-1">
                <FieldLabel htmlFor="preceding-target-cells">Preceding committed-target cells</FieldLabel>
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
                  className="w-24"
                />
                <p className="text-xs text-muted-foreground">
                  How many immediately preceding committed target cells to include as discourse
                  left-context when drafting. 0 disables preceding-context. Default:{" "}
                  {DEFAULT_DRAFT_CONTEXT.precedingTargetCells}.
                </p>
              </div>
            </CardContent>
          </Card>
        )}

        {searchGroupLabel("section-advanced-llm")}
        {sectionsToRender.some((s) => s.id === "section-advanced-llm") && (
          <details id="section-advanced-llm" className="group rounded-lg border bg-card">
            <summary className="cursor-pointer select-none list-none px-6 py-4 text-sm font-medium marker:hidden">
              <span className="flex items-center justify-between">
                <span>Advanced LLM settings</span>
                <span className="text-xs text-muted-foreground">
                  {provider === "frontier" ? "Frontier (default)" : `Custom: ${endpoint || "not set"}`}
                </span>
              </span>
            </summary>
            <div className="space-y-4 border-t px-6 py-4">
              <div className="space-y-2">
                <FieldLabel>Provider</FieldLabel>
                <RadioGroup
                  name="provider"
                  value={provider}
                  onValueChange={(value) => setProvider(value as CompletionProvider)}
                  className="flex flex-col gap-2"
                >
                  <label className="flex items-start gap-2 text-sm">
                    <RadioGroupItem value="frontier" className="mt-1" />
                    <span>
                      <strong>Frontier</strong> (recommended) — calls <code className="rounded bg-muted px-1">api.frontierrnd.com</code>{" "}
                      using your Frontier login. Works out of the box.
                    </span>
                  </label>
                  <label className="flex items-start gap-2 text-sm">
                    <RadioGroupItem value="custom" className="mt-1" />
                    <span>
                      <strong>Custom endpoint</strong> — localhost, self-hosted, or a third-party OpenAI-compatible
                      API (OpenRouter, OpenAI, Groq, Together, ...). Bring your own key.
                    </span>
                  </label>
                </RadioGroup>
              </div>

              {provider === "custom" && (
                <>
                  <div>
                    <FieldLabel htmlFor="preset">Provider preset</FieldLabel>
                    <Select
                      items={CUSTOM_PRESETS.map((p) => ({ value: p.id, label: p.label }))}
                      value={presetId}
                      onValueChange={(value) => handlePresetChange(value ?? "")}
                    >
                      <SelectTrigger id="preset" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          {CUSTOM_PRESETS.map((p) => (
                            <SelectItem key={p.id} value={p.id}>{p.label}</SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <FieldLabel htmlFor="ep">Endpoint URL</FieldLabel>
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
                        className="flex-1"
                      />
                      <Button size="sm" onClick={handleConnect} disabled={connecting}>
                        {connecting ? <Spinner /> : "Connect"}
                      </Button>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Base URL. Trailing <code className="rounded bg-muted px-1">/v1</code> or
                      {" "}<code className="rounded bg-muted px-1">/chat/completions</code> is accepted.
                    </p>
                    {connected && <p className="mt-1 flex items-center gap-1 text-xs text-green-600"><CheckCircle className="h-3 w-3" /> Connected — {models.length} model(s)</p>}
                    {connectionError && <p className="mt-1 flex items-center gap-1 text-xs text-destructive"><XCircle className="h-3 w-3" /> {connectionError}</p>}
                  </div>
                  <ApiKeyField
                    label={`API key${preset.requiresKey ? " *" : " (optional)"}`}
                    placeholder={preset.keyHint ?? (preset.requiresKey ? "Paste your API key" : "Leave blank for no auth")}
                    projectKey={apiKey}
                    userKey={completionUserKey}
                    onProjectKeyChange={setApiKey}
                    onUserKeyChange={(v) => setUserApiKey("completion", v)}
                    help="Sent as Authorization: Bearer <key>. Stored locally in your browser; never uploaded to Frontier."
                  />
                  <p className="text-xs text-muted-foreground">
                    Stays on this device — not shared with collaborators.
                  </p>
                  {models.length > 0 && (
                    <div>
                      <FieldLabel htmlFor="mdl">Model</FieldLabel>
                      <Select value={model} onValueChange={(value) => setModel(value ?? "")}>
                        <SelectTrigger id="mdl" className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            {models.map((m) => <SelectItem key={m} value={m}>{m}</SelectItem>)}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                  {models.length === 0 && (
                    <div>
                      <FieldLabel htmlFor="mdl-manual">Model (if not listed)</FieldLabel>
                      <Input
                        id="mdl-manual"
                        value={model}
                        onChange={(e) => setModel(e.target.value)}
                        placeholder={presetId === "openrouter" ? "anthropic/claude-3.5-sonnet" : "Type a model id"}
                      />
                      <p className="mt-1 text-xs text-muted-foreground">
                        Click Connect to discover models, or type one manually (required for providers that don't expose <code className="rounded bg-muted px-1">/models</code>).
                      </p>
                    </div>
                  )}
                </>
              )}

              {provider === "frontier" && (
                <div>
                  <FieldLabel htmlFor="mdl-frontier">Model override (optional)</FieldLabel>
                  <Input
                    id="mdl-frontier"
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    placeholder="Leave blank for Frontier's default"
                  />
                  <p className="mt-1 text-xs text-muted-foreground">
                    Optionally specify an OpenRouter model (e.g. <code className="rounded bg-muted px-1">anthropic/claude-3.5-sonnet</code>).
                  </p>
                </div>
              )}

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <FieldLabel htmlFor="mt">Max Tokens</FieldLabel>
                  <Input id="mt" type="number" value={maxTokens} onChange={(e) => setMaxTokens(Number(e.target.value))} />
                </div>
                <Field>
                  <FieldLabel>Temperature ({temperature})</FieldLabel>
                  <Slider
                    min={0}
                    max={1}
                    step={0.05}
                    value={[temperature]}
                    onValueChange={(next) => setTemperature(Array.isArray(next) ? next[0] : next)}
                  />
                </Field>
              </div>

              <Field>
                <FieldLabel>LLM Health Penalty ({Math.round(llmHealthPenalty * 100)}%)</FieldLabel>
                <Slider
                  min={0}
                  max={0.5}
                  step={0.05}
                  value={[llmHealthPenalty]}
                  onValueChange={(next) => setLlmHealthPenalty(Array.isArray(next) ? next[0] : next)}
                />
                <FieldDescription>
                  LLM translations are penalized by this amount in health calculations. 0% = full trust, 50% = heavy penalty. Default: 10%.
                </FieldDescription>
              </Field>
            </div>
          </details>
        )}

        {searchGroupLabel("section-voice")}
        {sectionsToRender.some((s) => s.id === "section-voice") && (
          <Card id="section-voice">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-primary" /> Voice
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <ApiKeyField
                label="Gemini API key"
                placeholder="AIza..."
                projectKey={geminiApiKey}
                userKey={geminiUserKey}
                onProjectKeyChange={setGeminiApiKey}
                onUserKeyChange={(v) => setUserApiKey("gemini-tts", v)}
                help="Used for Gemini-powered text-to-speech. Get a key at aistudio.google.com/apikey. Sent directly to Google; never uploaded to Frontier."
              />
              <div className="flex items-center justify-between gap-4 pt-1">
                <p className="text-sm text-muted-foreground">
                  Voice library and cast assignments live in the Voice Studio.
                </p>
                <Button variant="outline" onClick={() => {
                  // Set the Audio lens preference before navigating so the workspace opens in audio mode.
                  try { window.localStorage.setItem(`codex:editorLens:${id}`, "audio") } catch { /* ignore */ }
                  requestNavigate(`/project/${id}/editor`)
                }} className="shrink-0">
                  Open Voice Studio
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {searchGroupLabel("section-local-models")}
        {sectionsToRender.some((s) => s.id === "section-local-models") && (
          <Card id="section-local-models">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <HardDriveDownload className="h-4 w-4 text-primary" /> Local AI models
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-center justify-between gap-4">
                <p className="text-sm text-muted-foreground">
                  Whisper transcription and the local voices run in your browser and
                  are shared across every project on this device. Manage downloads in
                  your personal preferences.
                </p>
                <Button
                  variant="outline"
                  onClick={() => requestNavigate("/preferences")}
                  className="shrink-0"
                >
                  Manage models
                </Button>
              </div>
            </CardContent>
          </Card>
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

        {searchGroupLabel("section-validation")}
        {sectionsToRender.some((s) => s.id === "section-validation") && (
          <div id="section-validation">
            <ValidationSettingsSection
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
          </div>
        )}

        {/* AQU-186: Harmonization settings — harmonize_min_role floor. */}
        {sectionsToRender.some((s) => s.id === "section-validation") && (
          <Card>
            <CardHeader>
              <CardTitle>Harmonization</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <FieldLabel htmlFor="harmonize-min-role">Minimum role to run a harmonization sweep</FieldLabel>
                <DisabledFieldTooltip disabled={!canEditShared} tooltip={sharedDisabledTooltip ?? null}>
                  <Select
                    items={{
                      project_lead: "Project Lead (default)",
                      maintainer: "Maintainer",
                    }}
                    disabled={!canEditShared}
                    value={harmonizeMinRole}
                    onValueChange={(value) => setHarmonizeMinRole(value as "project_lead" | "maintainer")}
                  >
                    <SelectTrigger id="harmonize-min-role" className="w-48">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value="project_lead">Project Lead (default)</SelectItem>
                        <SelectItem value="maintainer">Maintainer</SelectItem>
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </DisabledFieldTooltip>
                <p className="text-xs text-muted-foreground">
                  Only users with at least this role can open a harmonization sweep on this project.
                  The floor cannot be lowered below Project Lead (hard floor per spec).
                </p>
              </div>
            </CardContent>
          </Card>
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

        {searchGroupLabel("section-git-sync")}
        {project?.origin?.kind === "git" && sectionsToRender.some((s) => s.id === "section-git-sync") && (
          <Card id="section-git-sync">
            <CardHeader><CardTitle>Git Sync</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <p className="text-xs text-muted-foreground">
                Origin: <span className="font-mono">{project.origin.cloneUrl}</span> (branch: <span className="font-mono">{project.origin.branch}</span>)
              </p>
              <div className="flex items-center gap-2">
                <Checkbox
                  id="auto-sync"
                  checked={autoSyncEnabled}
                  onCheckedChange={(checked) => setAutoSyncEnabled(checked)}
                />
                <FieldLabel htmlFor="auto-sync" className="text-sm">Auto-sync every</FieldLabel>
                <Input
                  type="number"
                  min={1}
                  max={60}
                  className="h-8 w-20"
                  value={autoSyncInterval}
                  onChange={(e) => setAutoSyncInterval(Math.max(1, Number(e.target.value) || 1))}
                />
                <span className="text-sm">minutes (only when there are changes)</span>
              </div>
              <p className="text-xs text-muted-foreground">
                Interval is floored at 1 minute. Sync will only push when there are local changes.
              </p>
            </CardContent>
          </Card>
        )}
        {searchGroupLabel("section-terminology")}
        {sectionsToRender.some((s) => s.id === "section-terminology") && (
          <Card id="section-terminology">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                Terminology Library
              </CardTitle>
            </CardHeader>
            <CardContent className="flex items-center justify-between gap-4">
              <p className="text-sm text-muted-foreground">
                Manage approved terms, renderings, and the project glossary (term base).
              </p>
              <Button variant="outline" onClick={() => requestNavigate(`/project/${id}/terminology`)} className="shrink-0">
                Open Terminology Library
              </Button>
            </CardContent>
          </Card>
        )}
        {searchGroupLabel("section-termbase-sharing")}
        {id && SHOW_TERMBASE_SHARING_IN_SETTINGS && sectionsToRender.some((s) => s.id === "section-termbase-sharing") && (
          <TermbaseSharingSection
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
          </div>
        </Page>
      }
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
            <DialogTitle>Discard changes?</DialogTitle>
            <DialogDescription>
              You have unsaved changes to project settings. They will be lost if you leave now.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={handleDiscardCancel}>Keep editing</Button>
            <Button variant="destructive" onClick={handleDiscardConfirm}>Discard</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
