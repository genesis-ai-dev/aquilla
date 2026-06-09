import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useParams, useNavigate } from "react-router-dom"
import { ArrowLeft, CheckCircle, XCircle, ChevronDown, Loader2, Sparkles, Save } from "lucide-react"
import { Menu } from "@base-ui/react/menu"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
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
import { useProject } from "@/hooks/useProject"
import { useProjectSettings } from "@/hooks/useProjectSettings"
import { getProject, updateProject } from "@/lib/store/project-index"
import { fetchModels, resolveProvider } from "@/lib/completion/completion-service"
import { buildCompletionSettings, DEFAULT_SYSTEM_PROMPT } from "@/hooks/useCompletionSettings"
import type {
  AudioMediaStrategy,
  CompletionProvider,
  CompletionSettings,
  ContextSize,
  DecaySettings,
  ProjectRecord,
} from "@/lib/parsers/types"
import { ValidationSettingsSection } from "./ProjectSettings/ValidationSettingsSection"
import { DecaySettingsSection } from "./ProjectSettings/DecaySettingsSection"
import { AudioMediaStrategySection } from "./ProjectSettings/AudioMediaStrategySection"
import { TermbaseSharingSection } from "./ProjectSettings/TermbaseSharingSection"
import { useOrg } from "@/hooks/useOrg"
import { ApiKeyField } from "./ApiKeyField"
import { SettingsNav, useScrollSpy, type SettingsSection } from "./ProjectSettings/SettingsNav"
import { readValidationCount, readValidationCountAudio } from "@/lib/progress/read-validation-count"
import { setUserApiKey, useUserApiKey } from "@/lib/store/user-api-keys"
import type { ProjectWideSettings } from "@/lib/sync/project-settings"

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
  autoSyncEnabled: boolean
  autoSyncInterval: number
  validationCount: number
  validationCountAudio: number
  validationRoleFloor: "reviewer" | "project_lead" | "maintainer"
  validationNamedUsers: string[]
  allowSelfValidation: boolean
  decaySettings: DecaySettings | undefined
  audioMediaStrategy: AudioMediaStrategy
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
    top_k: project.completionSettings?.top_k ?? 5,
    contextSize: project.completionSettings?.contextSize ?? "medium",
    useOnlyValidatedExamples: project.completionSettings?.useOnlyValidatedExamples ?? false,
    main_chat_language: project.completionSettings?.main_chat_language ?? "",
    fewShotExampleFormat: project.completionSettings?.fewShotExampleFormat ?? "source-and-target",
    autoSyncEnabled: project.syncSettings?.autoSync.enabled ?? false,
    autoSyncInterval: project.syncSettings?.autoSync.intervalMinutes ?? 5,
    validationCount: readValidationCount(project),
    validationCountAudio: readValidationCountAudio(project),
    validationRoleFloor: project.validationRoleFloor ?? "reviewer",
    validationNamedUsers: project.validationNamedUsers ?? [],
    allowSelfValidation: project.allowSelfValidation ?? true,
    decaySettings: project.decaySettings,
    audioMediaStrategy: project.audioMediaStrategy ?? "lazy",
  }
}

function decayEqual(a: DecaySettings | undefined, b: DecaySettings | undefined): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return JSON.stringify(a) === JSON.stringify(b)
}

const ITEM_CLASS =
  "flex cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-accent"

export function ProjectSettings() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { project, loading, refresh } = useProject(id!)

  const [conflictBy, setConflictBy] = useState<string | null>(null)
  useEffect(() => {
    if (!conflictBy) return
    const t = setTimeout(() => setConflictBy(null), 4000)
    return () => clearTimeout(t)
  }, [conflictBy])

  const {
    canEdit: canEditShared,
    reasonCannotEdit,
    patch: patchShared,
    version: sharedVersion,
    updatedAt: sharedUpdatedAt,
    updatedBy: sharedUpdatedBy,
    conflict: sharedConflict,
    dismissConflict,
  } = useProjectSettings(id ?? null, project?.syncRole?.level ?? null)

  // Org context for the termbase-sharing section. The user's org; the section's
  // server calls re-validate org-membership / org-ownership, so a mismatch just
  // yields graceful empty/403 states.
  const { org } = useOrg()

  const sharedDisabledTooltip =
    reasonCannotEdit === "offline" ? "Reconnect to edit shared settings."
    : reasonCannotEdit === "role" ? "Project Lead or higher can edit shared settings."
    : null

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
  const [topK, setTopK] = useState(5)
  const [contextSize, setContextSize] = useState<ContextSize>("medium")
  const [useOnlyValidatedExamples, setUseOnlyValidatedExamples] = useState(false)
  const [fewShotExampleFormat, setFewShotExampleFormat] = useState<"source-and-target" | "target-only">("source-and-target")
  const [mainChatLanguage, setMainChatLanguage] = useState("")
  const [autoSyncEnabled, setAutoSyncEnabled] = useState(false)
  const [autoSyncInterval, setAutoSyncInterval] = useState(5)
  const [validationCount, setValidationCount] = useState(1)
  const [validationCountAudio, setValidationCountAudio] = useState(1)
  const [validationRoleFloor, setValidationRoleFloor] = useState<"reviewer" | "project_lead" | "maintainer">("reviewer")
  const [validationNamedUsers, setValidationNamedUsers] = useState<string[]>([])
  const [allowSelfValidation, setAllowSelfValidation] = useState(true)
  const [decaySettings, setDecaySettings] = useState<DecaySettings | undefined>(undefined)
  const [audioMediaStrategy, setAudioMediaStrategy] = useState<AudioMediaStrategy>("lazy")

  // Per-device user-scoped key — not part of the project record, not server-
  // synced, no race with the project save flow. Kept on its own immediate-save
  // path so the deferred-save bar isn't responsible for cross-project state.
  const completionUserKey = useUserApiKey("completion") ?? ""

  const [models, setModels] = useState<string[]>([])
  const [connecting, setConnecting] = useState(false)
  const [connectionError, setConnectionError] = useState<string | null>(null)
  const [connected, setConnected] = useState(false)

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
    setUseOnlyValidatedExamples(b.useOnlyValidatedExamples)
    setFewShotExampleFormat(b.fewShotExampleFormat)
    setMainChatLanguage(b.main_chat_language)
    setAutoSyncEnabled(b.autoSyncEnabled)
    setAutoSyncInterval(b.autoSyncInterval)
    setValidationCount(b.validationCount)
    setValidationCountAudio(b.validationCountAudio)
    setValidationRoleFloor(b.validationRoleFloor)
    setValidationNamedUsers(b.validationNamedUsers)
    setAllowSelfValidation(b.allowSelfValidation)
    setDecaySettings(b.decaySettings)
    setAudioMediaStrategy(b.audioMediaStrategy)
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
      autoSyncEnabled !== baseline.autoSyncEnabled ||
      autoSyncInterval !== baseline.autoSyncInterval ||
      validationCount !== baseline.validationCount ||
      validationCountAudio !== baseline.validationCountAudio ||
      validationRoleFloor !== baseline.validationRoleFloor ||
      JSON.stringify(validationNamedUsers) !== JSON.stringify(baseline.validationNamedUsers) ||
      allowSelfValidation !== baseline.allowSelfValidation ||
      audioMediaStrategy !== baseline.audioMediaStrategy ||
      !decayEqual(decaySettings, baseline.decaySettings)
    )
  }, [
    baseline, name, sourceLanguage, targetLanguage, username, provider, endpoint, apiKey,
    model, maxTokens, temperature, systemPrompt, llmHealthPenalty,
    topK, contextSize, useOnlyValidatedExamples, fewShotExampleFormat, mainChatLanguage,
    autoSyncEnabled, autoSyncInterval, validationCount, validationCountAudio,
    validationRoleFloor, validationNamedUsers, allowSelfValidation,
    audioMediaStrategy, decaySettings,
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

  async function handleConnect() {
    if (!endpoint.trim()) return
    setConnecting(true)
    setConnectionError(null)
    setConnected(false)
    try {
      const list = await fetchModels(endpoint.trim(), apiKey.trim() || undefined)
      setModels(list)
      setConnected(true)
      if (list.length > 0 && !model) setModel(list[0])
    } catch (err) {
      setConnectionError(err instanceof Error ? err.message : "Connection failed")
    } finally {
      setConnecting(false)
    }
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
  }

  // ── Save orchestration ─────────────────────────────────────────────
  // Order matters: local IDB writes first (cheap, can't fail meaningfully),
  // then the shared/server PATCH (the only one that can 409). If the PATCH
  // fails we leave local writes in place — they're idempotent and not the
  // source of truth for shared fields anyway.
  const handleSave = useCallback(async (): Promise<boolean> => {
    if (!id || !baseline) return false
    setSaving(true)
    setSaveError(null)
    try {
      const completionUpdates: Partial<CompletionSettings> = {}
      if (provider !== baseline.provider) completionUpdates.provider = provider
      if (endpoint.trim() !== baseline.endpoint) completionUpdates.endpoint = endpoint.trim()
      if (apiKey !== baseline.apiKey) completionUpdates.apiKey = apiKey || undefined
      if (model !== baseline.model) completionUpdates.model = model
      if (maxTokens !== baseline.maxTokens) completionUpdates.maxTokens = maxTokens
      if (temperature !== baseline.temperature) completionUpdates.temperature = temperature
      if (llmHealthPenalty !== baseline.llmHealthPenalty) completionUpdates.llmHealthPenalty = llmHealthPenalty
      if (topK !== baseline.top_k) completionUpdates.top_k = topK
      if (contextSize !== baseline.contextSize) completionUpdates.contextSize = contextSize
      if (useOnlyValidatedExamples !== baseline.useOnlyValidatedExamples) completionUpdates.useOnlyValidatedExamples = useOnlyValidatedExamples
      if (fewShotExampleFormat !== baseline.fewShotExampleFormat) completionUpdates.fewShotExampleFormat = fewShotExampleFormat
      if (mainChatLanguage !== baseline.main_chat_language) completionUpdates.main_chat_language = mainChatLanguage || undefined

      const localUpdates: Partial<ProjectRecord> = {}
      if (name !== baseline.name) localUpdates.name = name
      if (username !== baseline.username) localUpdates.username = username
      if (!decayEqual(decaySettings, baseline.decaySettings)) localUpdates.decaySettings = decaySettings
      if (audioMediaStrategy !== baseline.audioMediaStrategy) localUpdates.audioMediaStrategy = audioMediaStrategy
      if (
        autoSyncEnabled !== baseline.autoSyncEnabled ||
        autoSyncInterval !== baseline.autoSyncInterval
      ) {
        localUpdates.syncSettings = {
          autoSync: { enabled: autoSyncEnabled, intervalMinutes: Math.max(1, autoSyncInterval) },
        }
      }

      const hasLocalWork =
        Object.keys(localUpdates).length > 0 || Object.keys(completionUpdates).length > 0
      if (hasLocalWork) {
        const latest = await getProject(id)
        if (!latest) throw new Error("Project not found")
        const nextCompletion = Object.keys(completionUpdates).length
          ? buildCompletionSettings(latest.completionSettings, completionUpdates)
          : latest.completionSettings
        await updateProject({ ...latest, ...localUpdates, completionSettings: nextCompletion })
      }

      const sharedUpdates: ProjectWideSettings = {}
      if (sourceLanguage !== baseline.sourceLanguage) sharedUpdates.sourceLanguage = sourceLanguage
      if (targetLanguage !== baseline.targetLanguage) sharedUpdates.targetLanguage = targetLanguage
      if (systemPrompt !== baseline.systemPrompt) sharedUpdates.systemPrompt = systemPrompt
      if (validationCount !== baseline.validationCount) sharedUpdates.validationCount = validationCount
      if (validationCountAudio !== baseline.validationCountAudio) {
        sharedUpdates.validationCountAudio = validationCountAudio
      }
      if (validationRoleFloor !== baseline.validationRoleFloor) sharedUpdates.validationRoleFloor = validationRoleFloor
      if (JSON.stringify(validationNamedUsers) !== JSON.stringify(baseline.validationNamedUsers)) {
        sharedUpdates.validationNamedUsers = validationNamedUsers
      }
      if (allowSelfValidation !== baseline.allowSelfValidation) sharedUpdates.allowSelfValidation = allowSelfValidation

      if (Object.keys(sharedUpdates).length > 0) {
        const out = await patchShared(sharedUpdates)
        if (out.kind === "conflict") {
          setConflictBy(out.latest.updatedBy?.username ?? "another collaborator")
          setSaveError("Someone else updated shared settings. Refresh to reapply your edits.")
          return false
        }
        if (out.kind === "blocked") {
          setSaveError(
            out.reason === "offline"
              ? "You're offline. Reconnect to save shared fields."
              : "You don't have permission to change shared settings.",
          )
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
        autoSyncEnabled,
        autoSyncInterval: Math.max(1, autoSyncInterval),
        validationCount,
        validationCountAudio,
        validationRoleFloor,
        validationNamedUsers,
        allowSelfValidation,
        decaySettings,
        audioMediaStrategy,
      }
      setBaseline(newBaseline)
      // Refresh `useProject` in the background so other components see the
      // updated IDB record. We don't await it — the form is already correct.
      refresh()
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
    autoSyncEnabled, autoSyncInterval, validationCount, validationCountAudio,
    validationRoleFloor, validationNamedUsers, allowSelfValidation,
    audioMediaStrategy, decaySettings, patchShared, refresh, applyBaseline,
  ])

  const handleSaveAndClose = useCallback(async () => {
    const ok = await handleSave()
    // `saveError` from the render closure is stale (set inside handleSave
    // during this same tick); rely on the returned boolean instead.
    if (!ok) return
    navigate(`/project/${id}`)
  }, [handleSave, navigate, id])

  const handleDiscardConfirm = useCallback(() => {
    if (baseline) applyBaseline(baseline)
    setDiscardOpen(false)
    const target = pendingNav ?? `/project/${id}`
    setPendingNav(null)
    navigate(target)
  }, [baseline, applyBaseline, pendingNav, navigate, id])

  const handleDiscardCancel = useCallback(() => {
    setDiscardOpen(false)
    setPendingNav(null)
  }, [])

  // ── Settings sections definition ──────────────────────────────────────────
  const hasGitOrigin = project?.origin?.kind === "git"

  const ALL_SECTIONS: SettingsSection[] = [
    { id: "section-project-info", label: "Project Info", keywords: ["name", "source language", "target language"] },
    { id: "section-user", label: "User", keywords: ["username", "author"] },
    { id: "section-ai-instructions", label: "AI Instructions", keywords: ["system prompt", "ai", "llm", "instructions"] },
    { id: "section-advanced-llm", label: "Advanced LLM", keywords: ["provider", "endpoint", "api key", "model", "temperature", "max tokens", "health penalty", "frontier", "openai", "custom"] },
    { id: "section-voice", label: "Voice", keywords: ["tts", "voice studio", "audio", "gemini"] },
    { id: "section-decay", label: "Decay", keywords: ["decay", "decay threshold", "half life"] },
    { id: "section-validation", label: "Validation", keywords: ["validation count", "approvals", "audio validation"] },
    { id: "section-audio-media", label: "Audio Media", keywords: ["audio media strategy", "lazy", "eager"] },
    { id: "section-git-sync", label: "Git Sync", keywords: ["git", "sync", "auto sync", "interval", "branch", "clone"], visible: hasGitOrigin },
    { id: "section-terminology", label: "Terminology", keywords: ["terminology", "termbase", "glossary", "concepts"] },
    { id: "section-termbase-sharing", label: "Termbase Sharing", keywords: ["termbase", "publish", "subscribe", "org", "shared", "glossary"] },
  ]

  // ── Search filter ──────────────────────────────────────────────────────────
  const [searchQuery, setSearchQuery] = useState("")
  const lowerQuery = searchQuery.trim().toLowerCase()
  const visibleSections = lowerQuery
    ? ALL_SECTIONS.filter(
        (s) =>
          s.visible !== false &&
          (s.label.toLowerCase().includes(lowerQuery) ||
            s.keywords?.some((k) => k.toLowerCase().includes(lowerQuery))),
      )
    : ALL_SECTIONS.filter((s) => s.visible !== false)

  const visibleIds = visibleSections.map((s) => s.id)
  const activeId = useScrollSpy(visibleIds)

  if (loading) return <div className="p-8 text-muted-foreground">Loading...</div>

  const preset = CUSTOM_PRESETS.find((p) => p.id === presetId) ?? CUSTOM_PRESETS[0]

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-30 flex items-center gap-3 border-b bg-background/95 px-4 py-2 backdrop-blur supports-backdrop-filter:bg-background/80">
        {isDirty ? (
          <div className="flex items-stretch">
            <Button
              size="sm"
              onClick={handleSaveAndClose}
              disabled={saving}
              className="rounded-r-none"
            >
              {saving ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : (
                <Save className="mr-1 h-4 w-4" />
              )}
              Save changes
            </Button>
            <Menu.Root>
              <Menu.Trigger
                render={
                  <Button
                    size="sm"
                    disabled={saving}
                    className="rounded-l-none border-l border-primary-foreground/20 px-2"
                    aria-label="More save options"
                  >
                    <ChevronDown className="h-4 w-4" />
                  </Button>
                }
              />
              <Menu.Portal>
                <Menu.Positioner sideOffset={4} align="start" className="z-40">
                  <Menu.Popup className="min-w-56 rounded-xl border bg-popover p-1 text-popover-foreground shadow-soft-lg">
                    <Menu.Item onClick={() => setDiscardOpen(true)} className={ITEM_CLASS}>
                      Close without saving
                    </Menu.Item>
                  </Menu.Popup>
                </Menu.Positioner>
              </Menu.Portal>
            </Menu.Root>
          </div>
        ) : (
          <Button variant="ghost" size="sm" onClick={() => requestNavigate(`/project/${id}`)}>
            <ArrowLeft className="mr-1 h-4 w-4" /> Back to Editor
          </Button>
        )}
        <h2 className="font-semibold">Project Settings</h2>
        <div className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
          {isDirty && !saving && <span>Unsaved changes</span>}
          {saveError && <span className="text-destructive">{saveError}</span>}
        </div>
      </header>
      <div className="mx-auto flex max-w-5xl gap-6 px-4 py-6">
        {/* Left rail nav */}
        <aside className="hidden w-44 shrink-0 lg:block">
          <div className="sticky top-[60px]">
            <SettingsNav
              sections={visibleSections}
              activeId={activeId}
              onSearch={setSearchQuery}
              searchQuery={searchQuery}
            />
          </div>
        </aside>

        {/* Main content */}
        <main className="min-w-0 flex-1 space-y-6">
          {/* Mobile search — only shows on narrow widths where rail is hidden */}
          <div className="lg:hidden">
            <SettingsNav
              sections={visibleSections}
              activeId={activeId}
              onSearch={setSearchQuery}
              searchQuery={searchQuery}
            />
          </div>

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
        {visibleSections.some((s) => s.id === "section-project-info") && (
          <Card id="section-project-info">
            <CardHeader><CardTitle>Project Info</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <div>
                <Label htmlFor="pname">Project Name</Label>
                <Input id="pname" value={name} onChange={(e) => setName(e.target.value)} />
              </div>
              {sharedUpdatedBy && sharedUpdatedAt && sharedVersion != null && sharedVersion > 0 && (
                <p className="text-xs text-muted-foreground">
                  Last edited by {sharedUpdatedBy.username} ·{" "}
                  {new Date(sharedUpdatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
                </p>
              )}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="sl">Source Language</Label>
                  <DisabledFieldTooltip disabled={!canEditShared} tooltip={sharedDisabledTooltip}>
                    <Input id="sl" value={sourceLanguage} onChange={(e) => setSourceLanguage(e.target.value)} disabled={!canEditShared} />
                  </DisabledFieldTooltip>
                </div>
                <div>
                  <Label htmlFor="tl">Target Language</Label>
                  <DisabledFieldTooltip disabled={!canEditShared} tooltip={sharedDisabledTooltip}>
                    <Input id="tl" value={targetLanguage} onChange={(e) => setTargetLanguage(e.target.value)} disabled={!canEditShared} />
                  </DisabledFieldTooltip>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {visibleSections.some((s) => s.id === "section-user") && (
          <Card id="section-user">
            <CardHeader><CardTitle>User</CardTitle></CardHeader>
            <CardContent>
              <Label htmlFor="un">Username</Label>
              <Input id="un" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="local" />
              <p className="mt-1 text-xs text-muted-foreground">Used as author name in translation history.</p>
            </CardContent>
          </Card>
        )}

        {visibleSections.some((s) => s.id === "section-ai-instructions") && (
          <Card id="section-ai-instructions">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-primary" />
                AI Instructions
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <DisabledFieldTooltip disabled={!canEditShared} tooltip={sharedDisabledTooltip}>
                <textarea
                  id="sp"
                  value={systemPrompt}
                  onChange={(e) => setSystemPrompt(e.target.value)}
                  rows={6}
                  disabled={!canEditShared}
                  className="w-full rounded border bg-background px-3 py-2 font-mono text-sm disabled:cursor-not-allowed disabled:opacity-50"
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
                  <Label htmlFor="top-k">Examples retrieved (top_k)</Label>
                  <Input
                    id="top-k"
                    type="number"
                    min={1}
                    max={20}
                    value={topK}
                    onChange={(e) => setTopK(Math.max(1, Math.min(20, Number(e.target.value))))}
                  />
                  <p className="text-xs text-muted-foreground">
                    How many few-shot examples the AI retrieves per completion (1–20). Default: 5.
                  </p>
                </div>

                <div className="space-y-1">
                  <Label htmlFor="context-size">Context window</Label>
                  <select
                    id="context-size"
                    value={contextSize}
                    onChange={(e) => setContextSize(e.target.value as ContextSize)}
                    className="w-full rounded border bg-background px-3 py-2 text-sm"
                  >
                    <option value="small">Small — tight window</option>
                    <option value="medium">Medium — paragraph (default)</option>
                    <option value="large">Large — chapter</option>
                  </select>
                  <p className="text-xs text-muted-foreground">
                    Controls how much surrounding passage context is included.
                  </p>
                </div>

                <div className="space-y-1">
                  <Label htmlFor="main-chat-language">Assistant language</Label>
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
                  <input
                    id="validated-only"
                    type="checkbox"
                    className="mt-1"
                    checked={useOnlyValidatedExamples}
                    onChange={(e) => setUseOnlyValidatedExamples(e.target.checked)}
                  />
                  <div>
                    <Label htmlFor="validated-only">Validated examples only</Label>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      When on, only human-validated cells are used as few-shot examples — unvalidated search results are excluded.
                    </p>
                  </div>
                </div>

                <div className="space-y-1">
                  <Label htmlFor="few-shot-example-format">Example format</Label>
                  <select
                    id="few-shot-example-format"
                    value={fewShotExampleFormat}
                    onChange={(e) => setFewShotExampleFormat(e.target.value as "source-and-target" | "target-only")}
                    className="w-full rounded border bg-background px-3 py-2 text-sm"
                  >
                    <option value="source-and-target">Source + target (default)</option>
                    <option value="target-only">Target only</option>
                  </select>
                  <p className="text-xs text-muted-foreground">
                    "Target only" shows only the target text of each example, useful when source alignment is unavailable or undesirable. The model is told these are reference translations to imitate.
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {visibleSections.some((s) => s.id === "section-advanced-llm") && (
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
                <Label>Provider</Label>
                <div className="flex flex-col gap-2">
                  <label className="flex items-start gap-2 text-sm">
                    <input
                      type="radio"
                      name="provider"
                      className="mt-1"
                      checked={provider === "frontier"}
                      onChange={() => setProvider("frontier")}
                    />
                    <span>
                      <strong>Frontier</strong> (recommended) — calls <code className="rounded bg-muted px-1">api.frontierrnd.com</code>{" "}
                      using your Frontier login. Works out of the box.
                    </span>
                  </label>
                  <label className="flex items-start gap-2 text-sm">
                    <input
                      type="radio"
                      name="provider"
                      className="mt-1"
                      checked={provider === "custom"}
                      onChange={() => setProvider("custom")}
                    />
                    <span>
                      <strong>Custom endpoint</strong> — localhost, self-hosted, or a third-party OpenAI-compatible
                      API (OpenRouter, OpenAI, Groq, Together, ...). Bring your own key.
                    </span>
                  </label>
                </div>
              </div>

              {provider === "custom" && (
                <>
                  <div>
                    <Label htmlFor="preset">Provider preset</Label>
                    <select
                      id="preset"
                      value={presetId}
                      onChange={(e) => handlePresetChange(e.target.value)}
                      className="w-full rounded border bg-background px-3 py-2 text-sm"
                    >
                      {CUSTOM_PRESETS.map((p) => (
                        <option key={p.id} value={p.id}>{p.label}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <Label htmlFor="ep">Endpoint URL</Label>
                    <div className="flex gap-2">
                      <Input
                        id="ep"
                        value={endpoint}
                        onChange={(e) => { setEndpoint(e.target.value); setPresetId(presetIdForEndpoint(e.target.value)) }}
                        placeholder="http://localhost:8000"
                        className="flex-1"
                      />
                      <Button size="sm" onClick={handleConnect} disabled={connecting || !endpoint.trim()}>
                        {connecting ? <Loader2 className="h-4 w-4 animate-spin" /> : "Connect"}
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
                      <Label htmlFor="mdl">Model</Label>
                      <select id="mdl" value={model} onChange={(e) => setModel(e.target.value)} className="w-full rounded border bg-background px-3 py-2 text-sm">
                        {models.map((m) => <option key={m} value={m}>{m}</option>)}
                      </select>
                    </div>
                  )}
                  {models.length === 0 && (
                    <div>
                      <Label htmlFor="mdl-manual">Model (if not listed)</Label>
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
                  <Label htmlFor="mdl-frontier">Model override (optional)</Label>
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
                  <Label htmlFor="mt">Max Tokens</Label>
                  <Input id="mt" type="number" value={maxTokens} onChange={(e) => setMaxTokens(Number(e.target.value))} />
                </div>
                <div>
                  <Label>Temperature ({temperature})</Label>
                  <input type="range" min="0" max="1" step="0.05" value={temperature} onChange={(e) => setTemperature(Number(e.target.value))} className="mt-2 w-full" />
                </div>
              </div>

              <div>
                <Label>LLM Health Penalty ({Math.round(llmHealthPenalty * 100)}%)</Label>
                <input type="range" min="0" max="0.5" step="0.05" value={llmHealthPenalty} onChange={(e) => setLlmHealthPenalty(Number(e.target.value))} className="mt-2 w-full" />
                <p className="mt-1 text-xs text-muted-foreground">
                  LLM translations are penalized by this amount in health calculations. 0% = full trust, 50% = heavy penalty. Default: 10%.
                </p>
              </div>
            </div>
          </details>
        )}

        {visibleSections.some((s) => s.id === "section-voice") && (
          <Card id="section-voice">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-primary" /> Voice
              </CardTitle>
            </CardHeader>
            <CardContent className="flex items-center justify-between gap-4">
              <p className="text-sm text-muted-foreground">
                The TTS engine, Gemini API key, voice library, and voice cloning now live in the Voice Studio.
              </p>
              <Button variant="outline" onClick={() => {
                // Set the Audio lens preference before navigating so the workspace opens in audio mode.
                try { window.localStorage.setItem(`codex:editorLens:${id}`, "audio") } catch { /* ignore */ }
                requestNavigate(`/project/${id}`)
              }} className="shrink-0">
                Open Voice Studio
              </Button>
            </CardContent>
          </Card>
        )}

        {visibleSections.some((s) => s.id === "section-decay") && (
          <div id="section-decay">
            <DecaySettingsSection
              settings={decaySettings}
              requiredValidations={validationCount}
              onChange={setDecaySettings}
            />
          </div>
        )}

        {visibleSections.some((s) => s.id === "section-validation") && (
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

        {visibleSections.some((s) => s.id === "section-audio-media") && (
          <div id="section-audio-media">
            <AudioMediaStrategySection
              value={audioMediaStrategy}
              onChange={setAudioMediaStrategy}
            />
          </div>
        )}

        {project?.origin?.kind === "git" && visibleSections.some((s) => s.id === "section-git-sync") && (
          <Card id="section-git-sync">
            <CardHeader><CardTitle>Git Sync</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <p className="text-xs text-muted-foreground">
                Origin: <span className="font-mono">{project.origin.cloneUrl}</span> (branch: <span className="font-mono">{project.origin.branch}</span>)
              </p>
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="auto-sync"
                  checked={autoSyncEnabled}
                  onChange={(e) => setAutoSyncEnabled(e.target.checked)}
                />
                <Label htmlFor="auto-sync" className="text-sm">Auto-sync every</Label>
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
        {visibleSections.some((s) => s.id === "section-terminology") && (
          <Card id="section-terminology">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                Terminology Library
              </CardTitle>
            </CardHeader>
            <CardContent className="flex items-center justify-between gap-4">
              <p className="text-sm text-muted-foreground">
                Manage approved terms, renderings, and the project glossary (termbase).
              </p>
              <Button variant="outline" onClick={() => requestNavigate(`/project/${id}/terminology`)} className="shrink-0">
                Open Terminology Library
              </Button>
            </CardContent>
          </Card>
        )}
        {id && visibleSections.some((s) => s.id === "section-termbase-sharing") && (
          <TermbaseSharingSection
            projectId={id}
            orgId={org?.id ?? null}
            roleLevel={project?.syncRole?.level ?? null}
          />
        )}

        </main>
      </div>

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

      {conflictBy && (
        <div
          role="status"
          className="fixed bottom-4 right-4 z-60 rounded border bg-amber-50 px-3 py-2 text-sm text-amber-900 shadow-md dark:bg-amber-950 dark:text-amber-100"
        >
          Synced settings update from <span className="font-medium">{conflictBy}</span>.
        </div>
      )}
    </div>
  )
}
