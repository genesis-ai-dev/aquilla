import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import {
  DEFAULT_SYSTEM_PROMPT,
  useSaveCompletionSettings,
} from "@/hooks/useCompletionSettings"
import type { ProjectRecord } from "@/lib/parsers/types"
import { useT } from "@/lib/i18n/I18nProvider"

interface AiInstructionsStepProps {
  project: ProjectRecord
  onUpdated: (p: ProjectRecord) => void
}

export function AiInstructionsStep({ project, onUpdated }: AiInstructionsStepProps) {
  const t = useT()
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
        {t("onboarding.checklist.aiInstructions.introPrefix")}{" "}
        <code className="rounded bg-muted px-1 py-0.5 font-mono text-[10px]">
          {"{sourceLanguage}"}
        </code>{" "}
        {t("onboarding.checklist.aiInstructions.introAnd")}{" "}
        <code className="rounded bg-muted px-1 py-0.5 font-mono text-[10px]">
          {"{targetLanguage}"}
        </code>{" "}
        {t("onboarding.checklist.aiInstructions.introSuffix")}
      </p>

      <Textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        rows={6}
        className="resize-none font-mono leading-relaxed"
        spellCheck={false}
      />
      <div className="flex items-center justify-between text-[10px] text-muted-foreground">
        <button
          type="button"
          onClick={() => setPrompt(DEFAULT_SYSTEM_PROMPT)}
          disabled={isDefault}
          className="underline-offset-2 hover:underline disabled:opacity-50"
        >
          {t("onboarding.checklist.aiInstructions.resetToDefault")}
        </button>
        <span>{t("onboarding.checklist.aiInstructions.charCount", { count: prompt.length })}</span>
      </div>
      <Button
        size="sm"
        onClick={handleSave}
        disabled={busy || prompt.trim().length === 0}
        className="w-full"
      >
        {busy ? t("common.saving") : t("onboarding.checklist.aiInstructions.saveButton")}
      </Button>
    </div>
  )
}
