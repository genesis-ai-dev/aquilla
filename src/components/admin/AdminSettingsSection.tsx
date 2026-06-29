import { useCallback, useEffect, useRef, useState } from "react"
import { Check } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import {
  getPlatformSettings,
  updatePlatformSettings,
  type PlatformSettingsResponse,
} from "@/lib/frontier/admin"

/**
 * Platform-admin "Settings" section — global, runtime-editable AI config:
 * the default chat model, the agent model, the allowed-models list, and the AI
 * request budgets. Saved to platform_settings (auth-worker) and read on the
 * chat/agent hot path with env-var fallbacks. Behind the elevation gate (the
 * console only renders this once elevated), and every call is server-enforced.
 *
 * Model fields are dropdowns sourced from the allowed-models list (never free
 * text) so a typo can't break generation platform-wide.
 */
export function AdminSettingsSection({ jwt }: { jwt: string }) {
  const [data, setData] = useState<PlatformSettingsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const aliveRef = useRef(true)
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Draft form state.
  const [chatModel, setChatModel] = useState("")
  const [agentModel, setAgentModel] = useState("")
  const [allowedText, setAllowedText] = useState("")
  const [userLimit, setUserLimit] = useState("")
  const [globalLimit, setGlobalLimit] = useState("")
  const [enforce, setEnforce] = useState(false)

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
      if (savedTimer.current) clearTimeout(savedTimer.current)
    }
  }, [])

  const hydrate = useCallback((d: PlatformSettingsResponse) => {
    setChatModel(d.settings.defaultLlmModel ?? d.effective.defaultLlmModel)
    setAgentModel(d.settings.agentModel ?? d.effective.agentModel)
    setAllowedText((d.settings.allowedModels ?? d.effective.allowedModels).join("\n"))
    setUserLimit(d.settings.aiUserDailyLimit != null ? String(d.settings.aiUserDailyLimit) : "")
    setGlobalLimit(d.settings.aiGlobalDailyLimit != null ? String(d.settings.aiGlobalDailyLimit) : "")
    setEnforce(d.settings.aiBudgetEnforce ?? false)
  }, [])

  const refresh = useCallback(async () => {
    if (aliveRef.current) {
      setLoading(true)
      setError(null)
    }
    try {
      const d = await getPlatformSettings(jwt)
      if (aliveRef.current) {
        setData(d)
        hydrate(d)
      }
    } catch (err) {
      if (aliveRef.current) setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (aliveRef.current) setLoading(false)
    }
  }, [jwt, hydrate])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const save = useCallback(async () => {
    if (!data) return
    setBusy(true)
    setError(null)
    setSaved(false)
    const allowedModels = allowedText
      .split(/[\n,]/)
      .map((m) => m.trim())
      .filter(Boolean)
    try {
      const res = await updatePlatformSettings(jwt, {
        defaultLlmModel: chatModel,
        agentModel,
        allowedModels,
        aiUserDailyLimit: userLimit === "" ? undefined : Number(userLimit),
        aiGlobalDailyLimit: globalLimit === "" ? undefined : Number(globalLimit),
        aiBudgetEnforce: enforce,
        ifMatchVersion: data.version,
      })
      // Refetch so the version + effective values (and the dropdown menu) update.
      await refresh()
      if (aliveRef.current) {
        setSaved(true)
        if (savedTimer.current) clearTimeout(savedTimer.current)
        savedTimer.current = setTimeout(() => aliveRef.current && setSaved(false), 2500)
      }
      void res
    } catch (err) {
      // 409 → someone else changed it; reload so the admin retries against fresh state.
      const msg = err instanceof Error ? err.message : String(err)
      if (aliveRef.current) setError(msg)
      if (/mismatch|409/.test(msg)) await refresh()
    } finally {
      if (aliveRef.current) setBusy(false)
    }
  }, [data, jwt, chatModel, agentModel, allowedText, userLimit, globalLimit, enforce, refresh])

  if (loading) return <p className="text-sm text-muted-foreground">Loading settings…</p>
  if (error && !data) return <p className="text-sm text-destructive">{error}</p>
  if (!data) return <p className="text-sm text-muted-foreground">No settings available.</p>

  // Dropdown menu = allowed list ∪ the currently-selected values (so a selected
  // model never renders blank even if it's not in the persisted list).
  const menu = Array.from(
    new Set([...data.effective.allowedModels, chatModel, agentModel].filter(Boolean)),
  )

  return (
    <div className="max-w-2xl space-y-6">
      <p className="text-xs text-muted-foreground">
        Global AI configuration for the whole platform. Changes apply within ~30s. An unset
        value falls back to the deploy default.
      </p>

      <section className="space-y-4 rounded-2xl border bg-card p-5">
        <h2 className="font-heading text-base font-medium">Models</h2>

        <div className="space-y-1.5">
          <Label htmlFor="admin-chat-model">Default chat model</Label>
          <ModelSelect id="admin-chat-model" value={chatModel} options={menu} onChange={setChatModel} />
          <p className="text-xs text-muted-foreground">
            Used for chat completions when the client requests the default model.
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="admin-agent-model">Agent model</Label>
          <ModelSelect id="admin-agent-model" value={agentModel} options={menu} onChange={setAgentModel} />
          <p className="text-xs text-muted-foreground">Model the translation agent runs on.</p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="admin-allowed-models">Allowed models</Label>
          <textarea
            id="admin-allowed-models"
            value={allowedText}
            onChange={(e) => setAllowedText(e.target.value)}
            rows={5}
            spellCheck={false}
            className="w-full rounded-lg border bg-background p-2 font-mono text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <p className="text-xs text-muted-foreground">
            One model ID per line. The chat/agent models must be in this list.
          </p>
        </div>
      </section>

      <section className="space-y-4 rounded-2xl border bg-card p-5">
        <h2 className="font-heading text-base font-medium">AI budget</h2>

        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="admin-user-limit">User daily limit</Label>
            <NumberInput id="admin-user-limit" value={userLimit} onChange={setUserLimit} placeholder="default 500" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="admin-global-limit">Global daily limit</Label>
            <NumberInput id="admin-global-limit" value={globalLimit} onChange={setGlobalLimit} placeholder="default 5000" />
          </div>
        </div>

        <label className="flex items-center gap-2 text-sm">
          <Toggle checked={enforce} onChange={setEnforce} label="enforce AI budget" />
          <span>Enforce budget (block with 429 instead of log-only)</span>
        </label>
      </section>

      <div className="flex items-center gap-3">
        <Button type="button" onClick={save} disabled={busy}>
          {busy ? "Saving…" : "Save settings"}
        </Button>
        {saved && (
          <span className="flex items-center gap-1 text-xs text-green-600 dark:text-green-400">
            <Check className="size-3.5" /> Saved
          </span>
        )}
        {error && data && <span className="text-xs text-destructive">{error}</span>}
      </div>
    </div>
  )
}

function ModelSelect({
  id,
  value,
  options,
  onChange,
}: {
  id: string
  value: string
  options: string[]
  onChange: (v: string) => void
}) {
  return (
    <select
      id={id}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full rounded-lg border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {options.map((m) => (
        <option key={m} value={m}>
          {m}
        </option>
      ))}
    </select>
  )
}

function NumberInput({
  id,
  value,
  onChange,
  placeholder,
}: {
  id: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
}) {
  return (
    <input
      id={id}
      type="number"
      min={0}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      className="w-full rounded-lg border bg-background px-3 py-2 text-sm tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    />
  )
}

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
        checked ? "bg-primary" : "bg-muted"
      }`}
    >
      <span
        className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${
          checked ? "translate-x-4" : "translate-x-0.5"
        }`}
      />
    </button>
  )
}
