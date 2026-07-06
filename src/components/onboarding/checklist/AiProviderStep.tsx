import { useState } from "react"
import { Sparkles, Server, Check } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { FieldLabel } from "@/components/ui/field"
import { FRONTIER_CHAT_URL } from "@/hooks/useCompletionSettings"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import type { ProjectRecord, CompletionProvider } from "@/lib/parsers/types"
import { useSaveCompletionSettings } from "@/hooks/useCompletionSettings"

interface AiProviderStepProps {
  project: ProjectRecord
  onUpdated: (p: ProjectRecord) => void
  /** Optional: invoked once a save round-trips successfully. SetupChecklistDrawer
   *  uses it implicitly via `complete` transition; standalone callers (e.g.
   *  AiSetupDialog) can use it to close on success. */
  onSaved?: () => void
}

export function AiProviderStep({ project, onUpdated, onSaved }: AiProviderStepProps) {
  const { session } = useFrontierSession()
  const currentProvider =
    project.completionSettings?.provider ??
    (project.completionSettings?.endpoint ? "custom" : "frontier")

  const [selected, setSelected] = useState<CompletionProvider>(currentProvider)
  const [customEndpoint, setCustomEndpoint] = useState(
    currentProvider === "custom" ? (project.completionSettings?.endpoint ?? "") : ""
  )
  const [customModel, setCustomModel] = useState(
    currentProvider === "custom" ? (project.completionSettings?.model ?? "") : ""
  )
  const [busy, setBusy] = useState(false)

  const saveSettings = useSaveCompletionSettings(project.id, onUpdated)

  async function handleSave() {
    setBusy(true)
    try {
      const isFrontier = selected === "frontier"
      await saveSettings({
        provider: isFrontier ? "frontier" : "custom",
        endpoint: isFrontier ? FRONTIER_CHAT_URL : customEndpoint.trim(),
        model: isFrontier ? "" : customModel.trim(),
      })
      onSaved?.()
    } finally {
      setBusy(false)
    }
  }

  const canSave =
    selected === "frontier" ? Boolean(session) : Boolean(customEndpoint.trim())

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        AI fills in suggested translations as you go and keeps style consistent
        across the project. You can change this later in Project Settings.
      </p>

      <ProviderOption
        icon={<Sparkles className="h-4 w-4" />}
        label="Frontier AI"
        badge="Recommended"
        description={
          session
            ? `Signed in as ${session.username} — no setup needed.`
            : "Sign in with a Frontier account to use the managed model."
        }
        selected={selected === "frontier"}
        onClick={() => setSelected("frontier")}
      />

      <ProviderOption
        icon={<Server className="h-4 w-4" />}
        label="Custom endpoint"
        description="Self-hosted, local, or any OpenAI-compatible server."
        selected={selected === "custom"}
        onClick={() => setSelected("custom")}
      />

      {selected === "custom" && (
        <div className="ml-7 space-y-2 rounded-md bg-muted/30 p-2">
          <div>
            <FieldLabel htmlFor="ai-endpoint" className="text-xs">
              Endpoint URL
            </FieldLabel>
            <Input
              id="ai-endpoint"
              value={customEndpoint}
              onChange={(e) => setCustomEndpoint(e.target.value)}
              placeholder="http://localhost:8000"
              className="text-sm"
            />
          </div>
          <div>
            <FieldLabel htmlFor="ai-model" className="text-xs">
              Model <span className="text-muted-foreground/70">(optional)</span>
            </FieldLabel>
            <Input
              id="ai-model"
              value={customModel}
              onChange={(e) => setCustomModel(e.target.value)}
              placeholder="gpt-4"
              className="text-sm"
            />
          </div>
        </div>
      )}

      <Button
        size="sm"
        onClick={handleSave}
        disabled={!canSave || busy}
        className="w-full"
      >
        {busy ? "Saving…" : "Save provider"}
      </Button>
    </div>
  )
}

interface ProviderOptionProps {
  icon: React.ReactNode
  label: string
  description: string
  selected: boolean
  badge?: string
  onClick: () => void
}

function ProviderOption({
  icon,
  label,
  description,
  selected,
  badge,
  onClick,
}: ProviderOptionProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={
        "flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors " +
        (selected
          ? "border-primary bg-primary/5"
          : "hover:bg-accent/40")
      }
    >
      <div
        className={
          "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border " +
          (selected
            ? "border-primary bg-primary text-primary-foreground"
            : "border-muted-foreground/30 text-muted-foreground")
        }
      >
        {selected ? <Check className="h-3 w-3" strokeWidth={3} /> : icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{label}</span>
          {badge && (
            <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary">
              {badge}
            </span>
          )}
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
      </div>
    </button>
  )
}
