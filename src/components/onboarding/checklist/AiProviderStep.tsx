import { useState } from "react"
import { Sparkles, Server, Check } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { FieldError, FieldLabel } from "@/components/ui/field"
import { Spinner } from "@/components/ui/spinner"
import { FRONTIER_CHAT_URL } from "@/hooks/useCompletionSettings"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import type { ProjectRecord, CompletionProvider } from "@/lib/parsers/types"
import { useSaveCompletionSettings } from "@/hooks/useCompletionSettings"
import { useT } from "@/lib/i18n/I18nProvider"

interface AiProviderStepProps {
  project: ProjectRecord
  onUpdated: (p: ProjectRecord) => void
  /** Optional: invoked once a save round-trips successfully. SetupChecklistDrawer
   *  uses it implicitly via `complete` transition; standalone callers (e.g.
   *  AiSetupDialog) can use it to close on success. */
  onSaved?: () => void
}

export function AiProviderStep({ project, onUpdated, onSaved }: AiProviderStepProps) {
  const t = useT()
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
  const [error, setError] = useState<string | null>(null)

  const saveSettings = useSaveCompletionSettings(project.id, onUpdated)

  async function handleSave() {
    if (selected === "frontier" && !session) {
      setError(t("onboarding.checklist.aiProvider.frontierSignInRequired"))
      return
    }
    if (selected === "custom" && !customEndpoint.trim()) {
      setError(t("projectSettings.advancedLlm.endpointRequiredError"))
      return
    }
    setError(null)
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

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        {t("onboarding.checklist.aiProvider.description")}
      </p>

      <ProviderOption
        icon={<Sparkles className="h-4 w-4" />}
        label={t("onboarding.checklist.aiProvider.frontierLabel")}
        badge={t("onboarding.checklist.aiProvider.recommendedBadge")}
        description={
          session
            ? t("onboarding.checklist.aiProvider.frontierSignedIn", { username: session.username })
            : t("onboarding.checklist.aiProvider.frontierSignInRequired")
        }
        selected={selected === "frontier"}
        onClick={() => setSelected("frontier")}
      />

      <ProviderOption
        icon={<Server className="h-4 w-4" />}
        label={t("projectSettings.advancedLlm.providerCustomName")}
        description={t("onboarding.checklist.aiProvider.customDescription")}
        selected={selected === "custom"}
        onClick={() => setSelected("custom")}
      />

      {selected === "custom" && (
        <div className="ms-7 space-y-2 rounded-md bg-muted/30 p-2">
          <div>
            <FieldLabel htmlFor="ai-endpoint" className="text-xs">
              {t("projectSettings.advancedLlm.endpointLabel")}
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
              {t("projectSettings.advancedLlm.modelLabel")}{" "}
              <span className="text-muted-foreground/70">{t("common.optionalFieldNote")}</span>
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

      {error && <FieldError>{error}</FieldError>}
      <Button
        size="sm"
        onClick={handleSave}
        className="w-full"
      >
        {busy && <Spinner data-icon="inline-start" />}
        {busy ? t("common.saving") : t("onboarding.checklist.aiProvider.saveButton")}
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
        "flex w-full items-start gap-3 rounded-lg border p-3 text-start transition-colors " +
        (selected
          ? "border-primary bg-primary/5"
          : "hover:bg-accent/40")
      }
    >
      <div
        className={
          "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-lg border " +
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
          {badge && <Badge>{badge}</Badge>}
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
      </div>
    </button>
  )
}
