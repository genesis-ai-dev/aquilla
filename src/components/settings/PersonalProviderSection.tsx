import { useEffect, useRef, useState } from "react"
import { ChevronDown, ChevronRight } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Section } from "@/components/ui/page"
import {
  clearUserProviderOverride,
  getUserProviderOverride,
  setUserProviderOverride,
} from "@/lib/store/user-provider-override"

/**
 * Advanced, opt-in: a personal AI provider override that beats per-project
 * settings on this device only. Hidden behind a disclosure so the default
 * Settings view stays uncluttered for users on the happy path (Frontier
 * managed model + sign-in).
 */
export function PersonalProviderSection() {
  const [open, setOpen] = useState(false)
  const [endpoint, setEndpoint] = useState("")
  const [model, setModel] = useState("")
  const [apiKey, setApiKey] = useState("")
  const [hasOverride, setHasOverride] = useState(false)
  const [saved, setSaved] = useState(false)
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Read once on mount; localStorage is sync but cheap and the section is hidden by default.
  useEffect(() => {
    const existing = getUserProviderOverride()
    if (existing) {
      setEndpoint(existing.endpoint)
      setModel(existing.model ?? "")
      setApiKey(existing.apiKey ?? "")
      setHasOverride(true)
      setOpen(true)
    }
  }, [])

  const canSave = endpoint.trim().length > 0

  function handleSave() {
    setUserProviderOverride({
      endpoint: endpoint.trim(),
      model: model.trim() || undefined,
      apiKey: apiKey.trim() || undefined,
    })
    setHasOverride(true)
    setSaved(true)
    if (savedTimerRef.current) clearTimeout(savedTimerRef.current)
    savedTimerRef.current = setTimeout(() => setSaved(false), 2500)
  }

  function handleClear() {
    clearUserProviderOverride()
    setEndpoint("")
    setModel("")
    setApiKey("")
    setHasOverride(false)
  }

  return (
    <Section contentClassName={open ? undefined : "pb-0"}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-start gap-2 text-left"
        aria-expanded={open}
      >
        {open ? (
          <ChevronDown className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        )}
        <div className="min-w-0 space-y-1">
          <h2 className="font-heading text-base leading-snug font-medium text-foreground">
            AI provider (advanced)
          </h2>
          <p className="text-sm text-muted-foreground">
            {hasOverride
              ? "Active — your projects use this endpoint on this device."
              : "Optional. Most users should leave this off and use Frontier."}
          </p>
        </div>
      </button>

      {open && (
        <div className="mt-4 space-y-4">
          <p className="text-xs text-muted-foreground">
            Use your own OpenAI-compatible endpoint instead of Frontier for AI
            translations. Stored only in this browser, never synced. Overrides
            any project-level provider setting.
          </p>

          <div className="space-y-2">
            <Label htmlFor="prov-endpoint">Endpoint URL</Label>
            <Input
              id="prov-endpoint"
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
              placeholder="https://openrouter.ai/api/v1"
              autoComplete="off"
            />
            <p className="text-[11px] text-muted-foreground">
              Trailing <code className="font-mono">/v1</code> or{" "}
              <code className="font-mono">/chat/completions</code> is fine.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="prov-model">
              Model <span className="text-muted-foreground/70">(optional)</span>
            </Label>
            <Input
              id="prov-model"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="gpt-4o-mini"
              autoComplete="off"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="prov-key">
              API key <span className="text-muted-foreground/70">(optional)</span>
            </Label>
            <Input
              id="prov-key"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="sk-…"
              autoComplete="off"
            />
            <p className="text-[11px] text-muted-foreground">
              Sent as <code className="font-mono">Authorization: Bearer …</code>.
              Leave blank for unauthenticated local endpoints.
            </p>
          </div>

          <div className="flex items-center justify-between gap-2 pt-2">
            <div className="flex items-center gap-3">
              <Button onClick={handleSave} disabled={!canSave} size="sm">
                {hasOverride ? "Update override" : "Save override"}
              </Button>
              {saved && (
                <span className="text-xs text-green-600 dark:text-green-400" role="status" data-testid="provider-override-saved">
                  Saved
                </span>
              )}
            </div>
            {hasOverride && (
              <Button variant="ghost" size="sm" onClick={handleClear}>
                Remove override
              </Button>
            )}
          </div>
        </div>
      )}
    </Section>
  )
}
