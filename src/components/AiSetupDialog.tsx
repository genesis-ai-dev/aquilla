import { useEffect, useMemo, useState } from "react"
import { Check, KeyRound, Sparkles, UserRound } from "lucide-react"
import { useLocation, useNavigate, useParams } from "react-router-dom"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { FieldError, FieldLabel, OptionalMark } from "@/components/ui/field"
import { Spinner } from "@/components/ui/spinner"
import { FRONTIER_CHAT_URL, useSaveCompletionSettings } from "@/hooks/useCompletionSettings"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import {
  OPENROUTER_BYOK_ENDPOINT,
  customProviderNeedsKey,
} from "@/lib/completion/completion-service"
import { getUserApiKey, resolveApiKey } from "@/lib/store/user-api-keys"
import {
  clearUserProviderOverride,
  useUserProviderOverride,
} from "@/lib/store/user-provider-override"
import { patchProject } from "@/lib/store/project-index"
import type { ProjectRecord } from "@/lib/parsers/types"
import { useT } from "@/lib/i18n/I18nProvider"

type SetupChoice = "frontier" | "project-key" | "override"

interface AiSetupDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  project: ProjectRecord
  onUpdated: (p: ProjectRecord) => void
}

export function AiSetupDialog({ open, onOpenChange, project, onUpdated }: AiSetupDialogProps) {
  const t = useT()
  const navigate = useNavigate()
  const location = useLocation()
  const { id } = useParams<{ id: string }>()
  const { session } = useFrontierSession()
  const override = useUserProviderOverride()

  const initialChoice = useMemo<SetupChoice>(() => {
    if (override) return "override"
    if (project.completionSettings?.provider === "custom" || project.completionSettings?.endpoint)
      return "project-key"
    return "frontier"
  }, [override, project.completionSettings?.endpoint, project.completionSettings?.provider])

  const [selected, setSelected] = useState<SetupChoice>(initialChoice)
  const [customEndpoint, setCustomEndpoint] = useState(
    project.completionSettings?.endpoint?.trim() || OPENROUTER_BYOK_ENDPOINT,
  )
  const [customModel, setCustomModel] = useState(project.completionSettings?.model ?? "")
  const [customApiKey, setCustomApiKey] = useState(
    project.completionSettings?.apiKey ?? getUserApiKey("completion") ?? "",
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const saveSettings = useSaveCompletionSettings(project.id, onUpdated)

  useEffect(() => {
    if (!open) return
    setSelected(initialChoice)
    setError(null)
  }, [open, initialChoice])

  async function markChosen(updated?: ProjectRecord) {
    const next = await patchProject(project.id, (latest) => ({
      ...latest,
      ...(updated ?? {}),
      aiProviderChosen: true,
    }))
    if (next) onUpdated(next)
  }

  async function handleContinue() {
    setError(null)
    if (selected === "frontier" && !session) {
      setError(t("onboarding.checklist.aiProvider.frontierSignInRequired"))
      return
    }
    if (selected === "override") {
      if (!override) {
        setError(t("workspace.aiSetup.overrideMissingError"))
        return
      }
      if (customProviderNeedsKey(override.endpoint) && !resolveApiKey("completion", override.apiKey)) {
        setError(t("workspace.aiSetup.overrideNeedsKey"))
        return
      }
      setBusy(true)
      try {
        // Clear a leftover project key so the global default can apply here.
        await saveSettings({
          provider: "frontier",
          endpoint: FRONTIER_CHAT_URL,
          model: "",
        })
        await markChosen()
        onOpenChange(false)
      } finally {
        setBusy(false)
      }
      return
    }
    if (selected === "project-key") {
      if (!customEndpoint.trim()) {
        setError(t("projectSettings.advancedLlm.endpointRequiredError"))
        return
      }
      const key = customApiKey.trim()
      if (customProviderNeedsKey(customEndpoint) && !key) {
        setError(t("projectSettings.advancedLlm.apiKeyRequiredError"))
        return
      }
      setBusy(true)
      try {
        await saveSettings({
          provider: "custom",
          endpoint: customEndpoint.trim(),
          model: customModel.trim(),
          ...(key ? { apiKey: key } : {}),
        })
        await markChosen()
        onOpenChange(false)
      } finally {
        setBusy(false)
      }
      return
    }
    setBusy(true)
    try {
      // This chooser is exclusive: Frontier drafts must not still ride a
      // device-wide personal override.
      if (override) clearUserProviderOverride()
      await saveSettings({
        provider: "frontier",
        endpoint: FRONTIER_CHAT_URL,
        model: "",
      })
      await markChosen()
      onOpenChange(false)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            {t("workspace.aiSetup.title")}
          </DialogTitle>
          <DialogDescription>
            {t("workspace.aiSetup.description")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <ProviderOption
            icon={<Sparkles className="h-4 w-4" />}
            label={t("onboarding.checklist.aiProvider.frontierLabel")}
            badge={t("onboarding.checklist.aiProvider.recommendedBadge")}
            description={
              session
                ? t("workspace.aiSetup.frontierDescriptionSignedIn", { username: session.username })
                : t("onboarding.checklist.aiProvider.frontierSignInRequired")
            }
            selected={selected === "frontier"}
            onClick={() => setSelected("frontier")}
          />

          <ProviderOption
            icon={<KeyRound className="h-4 w-4" />}
            label={t("workspace.aiSetup.projectKeyLabel")}
            description={t("workspace.aiSetup.projectKeyDescription")}
            selected={selected === "project-key"}
            onClick={() => setSelected("project-key")}
          />

          {selected === "project-key" && (
            <div className="ms-7 space-y-2 rounded-md bg-muted/30 p-2">
              <div>
                <FieldLabel htmlFor="ai-setup-endpoint" className="text-xs">
                  {t("projectSettings.advancedLlm.endpointLabel")}
                </FieldLabel>
                <Input
                  id="ai-setup-endpoint"
                  value={customEndpoint}
                  onChange={(e) => setCustomEndpoint(e.target.value)}
                  placeholder={OPENROUTER_BYOK_ENDPOINT}
                  className="text-sm"
                />
              </div>
              <div>
                <FieldLabel htmlFor="ai-setup-model" className="text-xs">
                  {t("projectSettings.advancedLlm.modelLabel")}{" "}
                  <OptionalMark />
                </FieldLabel>
                <Input
                  id="ai-setup-model"
                  value={customModel}
                  onChange={(e) => setCustomModel(e.target.value)}
                  placeholder="openai/gpt-4o-mini"
                  className="text-sm"
                />
              </div>
              <div>
                <FieldLabel htmlFor="ai-setup-key" className="text-xs">
                  {customProviderNeedsKey(customEndpoint)
                    ? t("projectSettings.field.apiKeyRequired")
                    : (
                      <>
                        {t("projectSettings.field.apiKey")}{" "}
                        <OptionalMark />
                      </>
                    )}
                </FieldLabel>
                <Input
                  id="ai-setup-key"
                  type="password"
                  value={customApiKey}
                  onChange={(e) => setCustomApiKey(e.target.value)}
                  placeholder={t("settings.personalProvider.apiKeyPlaceholder")}
                  className="text-sm"
                  autoComplete="off"
                />
              </div>
            </div>
          )}

          {override && (
            <ProviderOption
              icon={<UserRound className="h-4 w-4" />}
              label={t("settings.personalProvider.groupLabel")}
              description={t("workspace.aiSetup.overrideDescription", { endpoint: override.endpoint })}
              selected={selected === "override"}
              onClick={() => setSelected("override")}
            />
          )}

          {error && <FieldError>{error}</FieldError>}
          <Button onClick={() => void handleContinue()} className="w-full">
            {busy && <Spinner data-icon="inline-start" />}
            {busy ? t("common.saving") : t("onboarding.common.continue")}
          </Button>
        </div>

        <div className="text-center">
          <button
            className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
            onClick={() => {
              onOpenChange(false)
              navigate(`/project/${id}/settings/ai`, {
                state: { backgroundLocation: location, projectSettingsModalDepth: 1 },
              })
            }}
          >
            {t("workspace.aiSetup.fullSettingsLink")}
          </button>
        </div>
      </DialogContent>
    </Dialog>
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
