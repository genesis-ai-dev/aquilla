import { useCallback, useEffect, useRef, useState } from "react"
import { Check } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Section } from "@/components/ui/page"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Switch } from "@/components/ui/switch"
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
          trafficPct: normalizeTrafficPct(abTrafficPct),
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
        <div className="h-56 animate-pulse rounded-2xl border bg-card" />
        <div className="h-40 animate-pulse rounded-2xl border bg-card" />
      </div>
    )
  }
  if (error && !data) return <p className="text-sm text-destructive">{error}</p>
  if (!data) return <p className="text-sm text-muted-foreground">No settings available.</p>

  const challengerTrafficPct = normalizeTrafficPct(abTrafficPct)
  const controlTrafficPct = 100 - challengerTrafficPct
  const challengerModels = modelList.models.filter((model) => model !== modelList.chatModel)

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
        title="Compare with default"
        description="Measure a challenger against the current default model using traffic from the same time window."
      >
        <FieldGroup>
          <Field orientation="horizontal">
            <FieldContent>
              <FieldLabel htmlFor="admin-ab-enabled">Compare with default</FieldLabel>
              <FieldDescription>
                The current default stays in the control arm while the challenger receives the
                selected share of otherwise-default requests.
              </FieldDescription>
            </FieldContent>
            <Switch
              id="admin-ab-enabled"
              checked={abEnabled}
              onCheckedChange={setAbEnabled}
            />
          </Field>

          <div className="grid gap-4 md:grid-cols-2">
            <Card size="sm" role="group" aria-labelledby="admin-ab-control-title">
              <CardHeader>
                <CardTitle id="admin-ab-control-title">Control</CardTitle>
                <CardDescription>Current default model</CardDescription>
                <CardAction>
                  <Badge variant="secondary">{controlTrafficPct}% traffic</Badge>
                </CardAction>
              </CardHeader>
              <CardContent>
                <code className="block truncate" title={modelList.chatModel || "Not set"}>
                  {modelList.chatModel || "Not set"}
                </code>
              </CardContent>
              <CardFooter>
                <p className="text-xs text-muted-foreground">
                  Serves every eligible request not assigned to the challenger.
                </p>
              </CardFooter>
            </Card>

            <Card size="sm" role="group" aria-labelledby="admin-ab-challenger-title">
              <CardHeader>
                <CardTitle id="admin-ab-challenger-title">Challenger</CardTitle>
                <CardDescription>Model being compared</CardDescription>
                <CardAction>
                  <Badge variant={abEnabled ? "default" : "outline"}>
                    {challengerTrafficPct}% traffic
                  </Badge>
                </CardAction>
              </CardHeader>
              <CardContent>
                <FieldGroup>
                  <Field data-disabled={!abEnabled}>
                    <FieldLabel htmlFor="admin-ab-challenger">Challenger model</FieldLabel>
                    <Select
                      items={challengerModels.map((model) => ({ value: model, label: model }))}
                      value={abChallenger || null}
                      onValueChange={(value) => setAbChallenger(value ?? "")}
                      disabled={!abEnabled}
                    >
                      <SelectTrigger id="admin-ab-challenger" className="w-full">
                        <SelectValue placeholder="Choose a model" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          {challengerModels.map((model) => (
                            <SelectItem key={model} value={model}>
                              {model}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </Field>

                  <Field data-disabled={!abEnabled}>
                    <FieldLabel htmlFor="admin-ab-traffic">Challenger traffic %</FieldLabel>
                    <Input
                      id="admin-ab-traffic"
                      type="number"
                      min={0}
                      max={100}
                      value={abTrafficPct}
                      onChange={(event) => setAbTrafficPct(event.target.value)}
                      disabled={!abEnabled}
                    />
                    <FieldDescription>
                      Control traffic adjusts automatically to keep the total at 100%.
                    </FieldDescription>
                  </Field>
                </FieldGroup>
              </CardContent>
              <CardFooter>
                <p className="text-xs text-muted-foreground">
                  Runs concurrently with the control so results are directly comparable.
                </p>
              </CardFooter>
            </Card>
          </div>

          <Separator />
          <div className="flex flex-col gap-2">
            <h3 className="mb-2 text-sm font-medium text-foreground">Results</h3>
            <AbResultsPanel jwt={jwt} />
          </div>
        </FieldGroup>
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

function normalizeTrafficPct(value: string): number {
  return Math.min(100, Math.max(0, Math.round(Number(value) || 0)))
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
