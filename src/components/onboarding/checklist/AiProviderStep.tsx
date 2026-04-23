import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { FRONTIER_CHAT_URL, DEFAULT_SYSTEM_PROMPT } from "@/hooks/useCompletionSettings"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import type { ProjectRecord, CompletionProvider } from "@/lib/parsers/types"
import { useSaveCompletionSettings } from "@/hooks/useCompletionSettings"
import { Check } from "lucide-react"

export function AiProviderStep({
  project,
  onUpdated,
}: {
  project: ProjectRecord
  onUpdated: (p: ProjectRecord) => void
}) {
  const { session } = useFrontierSession()
  const currentProvider = project.completionSettings?.provider ?? (project.completionSettings?.endpoint ? "custom" : "frontier")
  const [selected, setSelected] = useState<CompletionProvider | "byo">(currentProvider)
  const [customEndpoint, setCustomEndpoint] = useState(
    currentProvider === "custom" ? (project.completionSettings?.endpoint ?? "") : ""
  )
  const [customModel, setCustomModel] = useState(
    currentProvider === "custom" ? (project.completionSettings?.model ?? "") : ""
  )

  const saveSettings = useSaveCompletionSettings(project.id, onUpdated)

  async function handleSave() {
    const isFrontier = selected === "frontier"
    await saveSettings({
      provider: isFrontier ? "frontier" : "custom",
      endpoint: isFrontier ? FRONTIER_CHAT_URL : customEndpoint.trim(),
      model: isFrontier ? "" : customModel.trim(),
    })
  }

  const canSave = selected === "frontier"
    ? true
    : selected === "custom" ? Boolean(customEndpoint.trim()) : false

  return (
    <div className="space-y-3">
      {/* Frontier AI */}
      <button
        className={
          "flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors " +
          (selected === "frontier" ? "border-primary bg-primary/5" : "hover:bg-accent/50")
        }
        onClick={() => setSelected("frontier")}
      >
        <div className={"mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border " + (selected === "frontier" ? "border-primary bg-primary text-primary-foreground" : "")}>
          {selected === "frontier" && <Check className="h-2.5 w-2.5" />}
        </div>
        <div>
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">Frontier AI</span>
            <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">Recommended</span>
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {session ? `Connected as ${session.username}` : "Sign in to use Frontier AI"}
          </p>
        </div>
      </button>

      {/* Custom endpoint */}
      <button
        className={
          "flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors " +
          (selected === "custom" ? "border-primary bg-primary/5" : "hover:bg-accent/50")
        }
        onClick={() => setSelected("custom")}
      >
        <div className={"mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border " + (selected === "custom" ? "border-primary bg-primary text-primary-foreground" : "")}>
          {selected === "custom" && <Check className="h-2.5 w-2.5" />}
        </div>
        <div>
          <span className="text-sm font-medium">Custom endpoint</span>
          <p className="mt-0.5 text-xs text-muted-foreground">Self-hosted or local OpenAI-compatible server</p>
        </div>
      </button>

      {selected === "custom" && (
        <div className="ml-7 space-y-2">
          <div>
            <Label className="text-xs">Endpoint URL</Label>
            <Input value={customEndpoint} onChange={(e) => setCustomEndpoint(e.target.value)} placeholder="http://localhost:8000" className="text-sm" />
          </div>
          <div>
            <Label className="text-xs">Model (optional)</Label>
            <Input value={customModel} onChange={(e) => setCustomModel(e.target.value)} placeholder="gpt-4" className="text-sm" />
          </div>
        </div>
      )}

      {/* Bring your own keys — coming soon */}
      <div className="flex items-start gap-3 rounded-lg border border-dashed p-3 opacity-50">
        <div className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border">—</div>
        <div>
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-muted-foreground">Bring your own keys</span>
            <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">Coming soon</span>
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">Use your own API keys for OpenAI, Anthropic, etc.</p>
        </div>
      </div>

      <Button size="sm" onClick={handleSave} disabled={!canSave} className="w-full">
        Save
      </Button>
    </div>
  )
}
