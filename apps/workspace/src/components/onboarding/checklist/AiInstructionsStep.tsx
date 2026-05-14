import { useState } from "react"
import { Button } from "@/components/ui/button"
import {
  DEFAULT_SYSTEM_PROMPT,
  useSaveCompletionSettings,
} from "@/hooks/useCompletionSettings"
import type { ProjectRecord } from "@/lib/parsers/types"

interface AiInstructionsStepProps {
  project: ProjectRecord
  onUpdated: (p: ProjectRecord) => void
}

export function AiInstructionsStep({ project, onUpdated }: AiInstructionsStepProps) {
  const saved = project.completionSettings?.systemPrompt ?? ""
  const [prompt, setPrompt] = useState(saved || DEFAULT_SYSTEM_PROMPT)
  const [busy, setBusy] = useState(false)

  const saveSettings = useSaveCompletionSettings(project.id, onUpdated)

  async function handleSave() {
    setBusy(true)
    try {
      await saveSettings({ systemPrompt: prompt.trim() })
    } finally {
      setBusy(false)
    }
  }

  const isDefault = prompt.trim() === DEFAULT_SYSTEM_PROMPT.trim()

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Tell the AI how to translate. The starter prompt works for most projects;
        edit it to match your tone, formality, or domain (legal, scripture,
        marketing, etc.). Use{" "}
        <code className="rounded bg-muted px-1 py-0.5 font-mono text-[10px]">
          {"{sourceLanguage}"}
        </code>{" "}
        and{" "}
        <code className="rounded bg-muted px-1 py-0.5 font-mono text-[10px]">
          {"{targetLanguage}"}
        </code>{" "}
        as placeholders.
      </p>

      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        rows={6}
        className="w-full resize-none rounded-md border bg-background px-3 py-2 text-sm font-mono leading-relaxed focus:outline-none focus:ring-1 focus:ring-ring"
        spellCheck={false}
      />
      <div className="flex items-center justify-between text-[10px] text-muted-foreground">
        <button
          type="button"
          onClick={() => setPrompt(DEFAULT_SYSTEM_PROMPT)}
          disabled={isDefault}
          className="underline-offset-2 hover:underline disabled:opacity-50"
        >
          Reset to default
        </button>
        <span>{prompt.length} characters</span>
      </div>
      <Button
        size="sm"
        onClick={handleSave}
        disabled={busy || prompt.trim().length === 0}
        className="w-full"
      >
        {busy ? "Saving…" : "Save instructions"}
      </Button>
    </div>
  )
}
