import { useCallback, useEffect, useRef, useState } from "react"
import { Check } from "lucide-react"
import { Button } from "@/components/ui/button"
import { FieldLabel } from "@/components/ui/field"
import { Section } from "@/components/ui/page"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { ModelListEditor, type ModelListValue } from "./ModelListEditor"
import { AbResultsPanel } from "./AbResultsPanel"
import {
  getPlatformSettings,
  updatePlatformSettings,
  type PlatformSettingsResponse,
} from "@/lib/frontier/admin"

/**
 * Platform-admin "Settings" — global, runtime-editable AI config: the allowed
 * model list (with the default chat + agent models marked on it), and the AI
 * request budgets. Saved to platform_settings (auth-worker) and read on the
 * chat/agent hot path with env-var fallbacks. Behind the elevation gate; every
 * call is server-enforced.
 *
 * Models are one managed list (ModelListEditor) — no free-text box feeding a
 * hidden dropdown — so a default can never point at a model that isn't allowed.
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
  const [modelList, setModelList] = useState<ModelListValue>({ models: [], chatModel: "", agentModel: "" })
  const [userLimit, setUserLimit] = useState("")
  const [globalLimit, setGlobalLimit] = useState("")
  const [enforce, setEnforce] = useState(false)
  const [abEnabled, setAbEnabled] = useState(false)
  const [abChallenger, setAbChallenger] = useState("")
  const [abTrafficPct, setAbTrafficPct] = useState("20")

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
      if (savedTimer.current) clearTimeout(savedTimer.current)
    }
  }, [])

  const hydrate = useCallback((d: PlatformSettingsResponse) => {
    setModelList({
      models: d.settings.allowedModels ?? d.effective.allowedModels,
      chatModel: d.settings.defaultLlmModel ?? d.effective.defaultLlmModel,
      agentModel: d.settings.agentModel ?? d.effective.agentModel,
    })
    setUserLimit(d.settings.aiUserDailyLimit != null ? String(d.settings.aiUserDailyLimit) : "")
    setGlobalLimit(d.settings.aiGlobalDailyLimit != null ? String(d.settings.aiGlobalDailyLimit) : "")
    setEnforce(d.settings.aiBudgetEnforce ?? false)
    setAbEnabled(d.settings.abTest?.enabled ?? false)
    setAbChallenger(d.settings.abTest?.challengerModel ?? "")
    setAbTrafficPct(String(d.settings.abTest?.trafficPct ?? 20))
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
    try {
      await updatePlatformSettings(jwt, {
        defaultLlmModel: modelList.chatModel,
        agentModel: modelList.agentModel,
        allowedModels: modelList.models,
        aiUserDailyLimit: userLimit === "" ? undefined : Number(userLimit),
        aiGlobalDailyLimit: globalLimit === "" ? undefined : Number(globalLimit),
        aiBudgetEnforce: enforce,
        abTest: {
          enabled: abEnabled,
          challengerModel: abChallenger,
          trafficPct: Math.min(100, Math.max(0, Math.round(Number(abTrafficPct) || 0))),
        },
        ifMatchVersion: data.version,
      })
      // Refetch so the version + effective values update.
      await refresh()
      if (aliveRef.current) {
        setSaved(true)
        if (savedTimer.current) clearTimeout(savedTimer.current)
        savedTimer.current = setTimeout(() => aliveRef.current && setSaved(false), 2500)
      }
    } catch (err) {
      // 409 → someone else changed it; reload so the admin retries against fresh state.
      const msg = err instanceof Error ? err.message : String(err)
      if (aliveRef.current) setError(msg)
      if (/mismatch|409/.test(msg)) await refresh()
    } finally {
      if (aliveRef.current) setBusy(false)
    }
  }, [data, jwt, modelList, userLimit, globalLimit, enforce, abEnabled, abChallenger, abTrafficPct, refresh])

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="h-56 animate-pulse rounded-lg border bg-card" />
        <div className="h-40 animate-pulse rounded-lg border bg-card" />
      </div>
    )
  }
  if (error && !data) return <p className="text-sm text-destructive">{error}</p>
  if (!data) return <p className="text-sm text-muted-foreground">No settings available.</p>

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        Global AI configuration for the whole platform. Changes apply within ~30s; an unset value
        falls back to the deploy default.
      </p>

      <Section title="Models" description="The allowed model list and which model powers chat and the agent.">
        <ModelListEditor value={modelList} onChange={setModelList} />
      </Section>

      <Section
        title="A/B experiment"
        description="Route a share of default-model chat traffic to a challenger and compare how often each model's drafts are accepted."
      >
        <div className="space-y-4">
          <label className="flex items-center gap-2 text-sm">
            <Toggle checked={abEnabled} onChange={setAbEnabled} label="enable A/B experiment" />
            <span>Run the experiment</span>
          </label>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <FieldLabel htmlFor="admin-ab-challenger">Challenger model</FieldLabel>
              <Select
                items={[
                  { value: "", label: "— choose a model —" },
                  ...modelList.models
                    .filter((m) => m !== modelList.chatModel)
                    .map((m) => ({ value: m, label: m })),
                ]}
                value={abChallenger}
                onValueChange={(v) => setAbChallenger(v ?? "")}
                disabled={!abEnabled}
              >
                <SelectTrigger id="admin-ab-challenger" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="">— choose a model —</SelectItem>
                    {modelList.models
                      .filter((m) => m !== modelList.chatModel)
                      .map((m) => (
                        <SelectItem key={m} value={m}>
                          {m}
                        </SelectItem>
                      ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Competes against the default chat model ({modelList.chatModel || "unset"}).
              </p>
            </div>
            <div className="space-y-1.5">
              <FieldLabel htmlFor="admin-ab-traffic">Challenger traffic %</FieldLabel>
              <NumberInput
                id="admin-ab-traffic"
                value={abTrafficPct}
                onChange={setAbTrafficPct}
                placeholder="20"
              />
              <p className="text-xs text-muted-foreground">
                Share of default-model requests served by the challenger (0–100).
              </p>
            </div>
          </div>

          <div className="border-t pt-4">
            <h3 className="mb-2 text-sm font-medium text-foreground">Results</h3>
            <AbResultsPanel jwt={jwt} />
          </div>
        </div>
      </Section>

      <Section title="AI budget" description="Daily request ceilings, and whether they block or just log.">
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <FieldLabel htmlFor="admin-user-limit">User daily limit</FieldLabel>
              <NumberInput id="admin-user-limit" value={userLimit} onChange={setUserLimit} placeholder="default 500" />
            </div>
            <div className="space-y-1.5">
              <FieldLabel htmlFor="admin-global-limit">Global daily limit</FieldLabel>
              <NumberInput
                id="admin-global-limit"
                value={globalLimit}
                onChange={setGlobalLimit}
                placeholder="default 5000"
              />
            </div>
          </div>

          <label className="flex items-center gap-2 text-sm">
            <Toggle checked={enforce} onChange={setEnforce} label="enforce AI budget" />
            <span>Enforce budget (block with 429 instead of log-only)</span>
          </label>
        </div>
      </Section>

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
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-lg transition-colors ${
        checked ? "bg-primary" : "bg-muted"
      }`}
    >
      <span
        className={`inline-block h-3.5 w-3.5 transform rounded-lg bg-white shadow transition-transform ${
          checked ? "translate-x-4" : "translate-x-0.5"
        }`}
      />
    </button>
  )
}
