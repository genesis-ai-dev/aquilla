import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { DEFAULT_SYSTEM_PROMPT, useSaveCompletionSettings } from "@/hooks/useCompletionSettings"
import type { ProjectRecord } from "@/lib/parsers/types"

export function AiInstructionsStep({
  project,
  onUpdated,
}: {
  project: ProjectRecord
  onUpdated: (p: ProjectRecord) => void
}) {
  const [prompt, setPrompt] = useState(
    project.completionSettings?.systemPrompt ?? DEFAULT_SYSTEM_PROMPT
  )

  const saveSettings = useSaveCompletionSettings(project.id, onUpdated)

  async function handleSave() {
    await saveSettings({ systemPrompt: prompt })
  }

  return (
    <div className="space-y-3">
      <div>
        <Label className="text-xs">System prompt</Label>
        <p className="mb-1 text-[11px] text-muted-foreground">
          Instructions the AI follows when generating translations. Use {"{sourceLanguage}"} and {"{targetLanguage}"} as placeholders.
        </p>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={5}
          className="w-full resize-none rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
        />
        <p className="mt-1 text-right text-[10px] text-muted-foreground">
          {prompt.length} characters
        </p>
      </div>
      <Button size="sm" onClick={handleSave} className="w-full">
        Save Instructions
      </Button>
    </div>
  )
}
