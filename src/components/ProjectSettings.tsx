import { useEffect, useState } from "react"
import { useParams, useNavigate } from "react-router-dom"
import { ArrowLeft, CheckCircle, XCircle, Loader2, Sparkles, Eye, EyeOff } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Switch } from "@/components/ui/switch"
import { getProject, updateProject } from "@/lib/store/project-index"
import { fetchModels, DEFAULT_SYSTEM_PROMPT, resolveProvider } from "@/lib/completion/completion-service"
import type { ProjectRecord, CompletionProvider } from "@/lib/parsers/types"
import { listFlags } from "@/lib/features/flags"
import { useFeatureFlag, setFeatureFlag } from "@/hooks/useFeatureFlag"

// Well-known OpenAI-compatible providers. Keys are stable IDs for the preset dropdown.
// "local" is the default for self-hosted/localhost setups with no API key.
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

export function ProjectSettings() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [project, setProject] = useState<ProjectRecord | null>(null)
  const [loading, setLoading] = useState(true)

  const [name, setName] = useState("")
  const [sourceLanguage, setSourceLanguage] = useState("")
  const [targetLanguage, setTargetLanguage] = useState("")
  const [username, setUsername] = useState("")

  const [provider, setProvider] = useState<CompletionProvider>("frontier")
  const [endpoint, setEndpoint] = useState("")
  const [apiKey, setApiKey] = useState("")
  const [showApiKey, setShowApiKey] = useState(false)
  const [presetId, setPresetId] = useState<string>("local")
  const [model, setModel] = useState("")
  const [maxTokens, setMaxTokens] = useState(512)
  const [temperature, setTemperature] = useState(0.3)
  const [systemPrompt, setSystemPrompt] = useState(DEFAULT_SYSTEM_PROMPT)
  const [llmHealthPenalty, setLlmHealthPenalty] = useState(0.1)

  const [autoSyncEnabled, setAutoSyncEnabled] = useState(false)
  const [autoSyncInterval, setAutoSyncInterval] = useState(5)

  const [models, setModels] = useState<string[]>([])
  const [connecting, setConnecting] = useState(false)
  const [connectionError, setConnectionError] = useState<string | null>(null)
  const [connected, setConnected] = useState(false)

  useEffect(() => {
    if (!id) return
    getProject(id).then((p) => {
      if (!p) return
      setProject(p)
      setName(p.name)
      setSourceLanguage(p.sourceLanguage)
      setTargetLanguage(p.targetLanguage)
      setUsername(p.username || "local")
      if (p.completionSettings) {
        setProvider(resolveProvider(p.completionSettings))
        setEndpoint(p.completionSettings.endpoint)
        setApiKey(p.completionSettings.apiKey ?? "")
        setPresetId(presetIdForEndpoint(p.completionSettings.endpoint))
        setModel(p.completionSettings.model)
        setMaxTokens(p.completionSettings.maxTokens)
        setTemperature(p.completionSettings.temperature)
        setSystemPrompt(p.completionSettings.systemPrompt)
        setLlmHealthPenalty(p.completionSettings.llmHealthPenalty ?? 0.1)
      }
      setAutoSyncEnabled(p.syncSettings?.autoSync.enabled ?? false)
      setAutoSyncInterval(p.syncSettings?.autoSync.intervalMinutes ?? 5)
      setLoading(false)
    })
  }, [id])

  async function save(updates: Partial<ProjectRecord>) {
    if (!project) return
    const updated = { ...project, ...updates }
    await updateProject(updated)
    setProject(updated)
  }

  function saveCompletionSettings(overrides: {
    provider?: CompletionProvider
    endpoint?: string
    apiKey?: string
  } = {}) {
    const nextProvider = overrides.provider ?? provider
    const nextEndpoint = (overrides.endpoint ?? endpoint).trim()
    const nextApiKey = (overrides.apiKey ?? apiKey).trim()
    save({
      completionSettings: {
        provider: nextProvider,
        endpoint: nextEndpoint,
        apiKey: nextApiKey || undefined,
        model,
        maxTokens,
        temperature,
        systemPrompt,
        llmHealthPenalty,
      },
    })
  }

  function handlePresetChange(nextPresetId: string) {
    setPresetId(nextPresetId)
    const preset = CUSTOM_PRESETS.find((p) => p.id === nextPresetId)
    if (!preset) return
    // "custom" leaves the existing endpoint alone so the user can type their own.
    const nextEndpoint = preset.id === "custom" ? endpoint : preset.endpoint
    setEndpoint(nextEndpoint)
    setConnected(false)
    setConnectionError(null)
    setModels([])
    saveCompletionSettings({ endpoint: nextEndpoint })
  }

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

  if (loading) return <div className="p-8 text-muted-foreground">Loading...</div>

  return (
    <div className="min-h-screen bg-background">
      <header className="flex items-center gap-4 border-b px-4 py-2">
        <Button variant="ghost" size="sm" onClick={() => navigate(`/project/${id}`)}>
          <ArrowLeft className="mr-1 h-4 w-4" /> Back to Editor
        </Button>
        <h2 className="font-semibold">Project Settings</h2>
        <div className="ml-auto">
          <Button
            variant="outline"
            size="sm"
            onClick={() => navigate(`/project/${id}`)}
          >
            View Setup Checklist
          </Button>
        </div>
      </header>
      <main className="mx-auto max-w-2xl space-y-6 p-6">
        <Card>
          <CardHeader><CardTitle>Project Info</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label htmlFor="pname">Project Name</Label>
              <Input id="pname" value={name} onChange={(e) => setName(e.target.value)} onBlur={() => save({ name })} />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="sl">Source Language</Label>
                <Input id="sl" value={sourceLanguage} onChange={(e) => setSourceLanguage(e.target.value)} onBlur={() => save({ sourceLanguage })} />
              </div>
              <div>
                <Label htmlFor="tl">Target Language</Label>
                <Input id="tl" value={targetLanguage} onChange={(e) => setTargetLanguage(e.target.value)} onBlur={() => save({ targetLanguage })} />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>User</CardTitle></CardHeader>
          <CardContent>
            <Label htmlFor="un">Username</Label>
            <Input id="un" value={username} onChange={(e) => setUsername(e.target.value)} onBlur={() => save({ username })} placeholder="local" />
            <p className="mt-1 text-xs text-muted-foreground">Used as author name in translation history.</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-primary" />
              AI Instructions
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <textarea
              id="sp"
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              onBlur={() => saveCompletionSettings()}
              rows={6}
              className="w-full rounded border bg-background px-3 py-2 font-mono text-sm"
              placeholder={DEFAULT_SYSTEM_PROMPT}
            />
            <p className="text-xs text-muted-foreground">
              Describe what this project is producing and how translations should read — the AI uses this on every
              completion. Use <code className="rounded bg-muted px-1">{"{sourceLanguage}"}</code> and{" "}
              <code className="rounded bg-muted px-1">{"{targetLanguage}"}</code> as placeholders.
            </p>
          </CardContent>
        </Card>

        <details className="group rounded-lg border bg-card">
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
                    onChange={() => { setProvider("frontier"); saveCompletionSettings({ provider: "frontier" }) }}
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
                    onChange={() => { setProvider("custom"); saveCompletionSettings({ provider: "custom" }) }}
                  />
                  <span>
                    <strong>Custom endpoint</strong> — localhost, self-hosted, or a third-party OpenAI-compatible
                    API (OpenRouter, OpenAI, Groq, Together, ...). Bring your own key.
                  </span>
                </label>
              </div>
            </div>

            {provider === "custom" && (() => {
              const preset = CUSTOM_PRESETS.find((p) => p.id === presetId) ?? CUSTOM_PRESETS[0]
              return (
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
                        onBlur={() => saveCompletionSettings()}
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
                  <div>
                    <Label htmlFor="apikey">
                      API key {preset.requiresKey ? <span className="text-destructive">*</span> : <span className="text-muted-foreground">(optional)</span>}
                    </Label>
                    <div className="flex gap-2">
                      <Input
                        id="apikey"
                        type={showApiKey ? "text" : "password"}
                        value={apiKey}
                        onChange={(e) => setApiKey(e.target.value)}
                        onBlur={() => saveCompletionSettings()}
                        placeholder={preset.keyHint ?? (preset.requiresKey ? "Paste your API key" : "Leave blank for no auth")}
                        autoComplete="off"
                        spellCheck={false}
                        className="flex-1 font-mono"
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setShowApiKey((v) => !v)}
                        aria-label={showApiKey ? "Hide API key" : "Show API key"}
                      >
                        {showApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </Button>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Sent as <code className="rounded bg-muted px-1">Authorization: Bearer &lt;key&gt;</code>. Stored
                      locally in your browser (IndexedDB) — never uploaded to Frontier.
                    </p>
                  </div>
                  {models.length > 0 && (
                    <div>
                      <Label htmlFor="mdl">Model</Label>
                      <select id="mdl" value={model} onChange={(e) => { setModel(e.target.value); saveCompletionSettings() }} className="w-full rounded border bg-background px-3 py-2 text-sm">
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
                        onBlur={() => saveCompletionSettings()}
                        placeholder={presetId === "openrouter" ? "anthropic/claude-3.5-sonnet" : "Type a model id"}
                      />
                      <p className="mt-1 text-xs text-muted-foreground">
                        Click Connect to discover models, or type one manually (required for providers that don't expose <code className="rounded bg-muted px-1">/models</code>).
                      </p>
                    </div>
                  )}
                </>
              )
            })()}

            {provider === "frontier" && (
              <div>
                <Label htmlFor="mdl-frontier">Model override (optional)</Label>
                <Input
                  id="mdl-frontier"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  onBlur={() => saveCompletionSettings()}
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
                <Input id="mt" type="number" value={maxTokens} onChange={(e) => setMaxTokens(Number(e.target.value))} onBlur={() => saveCompletionSettings()} />
              </div>
              <div>
                <Label>Temperature ({temperature})</Label>
                <input type="range" min="0" max="1" step="0.05" value={temperature} onChange={(e) => setTemperature(Number(e.target.value))} onMouseUp={() => saveCompletionSettings()} className="mt-2 w-full" />
              </div>
            </div>

            <div>
              <Label>LLM Health Penalty ({Math.round(llmHealthPenalty * 100)}%)</Label>
              <input type="range" min="0" max="0.5" step="0.05" value={llmHealthPenalty} onChange={(e) => setLlmHealthPenalty(Number(e.target.value))} onMouseUp={() => saveCompletionSettings()} className="mt-2 w-full" />
              <p className="mt-1 text-xs text-muted-foreground">
                LLM translations are penalized by this amount in health calculations. 0% = full trust, 50% = heavy penalty. Default: 10%.
              </p>
            </div>
          </div>
        </details>

        {project?.origin?.kind === "git" && (
          <Card>
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
                  onChange={(e) => {
                    const enabled = e.target.checked
                    setAutoSyncEnabled(enabled)
                    save({ syncSettings: { autoSync: { enabled, intervalMinutes: autoSyncInterval } } })
                  }}
                />
                <Label htmlFor="auto-sync" className="text-sm">Auto-sync every</Label>
                <Input
                  type="number"
                  min={1}
                  max={60}
                  className="h-8 w-20"
                  value={autoSyncInterval}
                  onChange={(e) => setAutoSyncInterval(Math.max(1, Number(e.target.value) || 1))}
                  onBlur={() => save({ syncSettings: { autoSync: { enabled: autoSyncEnabled, intervalMinutes: Math.max(1, autoSyncInterval) } } })}
                />
                <span className="text-sm">minutes (only when there are changes)</span>
              </div>
              <p className="text-xs text-muted-foreground">
                Interval is floored at 1 minute. Sync will only push when there are local changes.
              </p>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle>Experimental</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              These features are in active development. They may change, move, or be
              removed. Expect rough edges.
            </p>
            {listFlags().length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No experimental features available.
              </p>
            ) : (
              <div className="space-y-3">
                {listFlags().map(({ key, def }) => (
                  <ExperimentalFlagRow
                    key={key}
                    flagKey={key}
                    label={def.label}
                    description={def.description}
                    project={project}
                  />
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </main>
    </div>
  )
}

function ExperimentalFlagRow({
  flagKey,
  label,
  description,
  project,
}: {
  flagKey: Parameters<typeof useFeatureFlag>[0]
  label: string
  description: string
  project: ProjectRecord | null
}) {
  const value = useFeatureFlag(flagKey, project)
  const [optimistic, setOptimistic] = useState<boolean | null>(null)
  const checked = optimistic ?? value

  const handleChange = async (next: boolean) => {
    if (!project) return
    setOptimistic(next)
    try {
      await setFeatureFlag(project.id, flagKey, next)
      setOptimistic(null)
    } catch {
      setOptimistic(null) // revert to store value on failure
    }
  }

  return (
    <div className="flex items-start justify-between gap-4 rounded-md border p-3">
      <div className="flex-1">
        <div className="text-sm font-medium">{label}</div>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      <Switch
        checked={checked}
        onCheckedChange={handleChange}
        aria-label={`Toggle ${label}`}
      />
    </div>
  )
}
