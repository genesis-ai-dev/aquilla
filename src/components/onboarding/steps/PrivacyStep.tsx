import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { FieldLabel } from "@/components/ui/field"
import { useAnalyticsConsent } from "@/hooks/useAnalyticsConsent"
import { ShieldCheck, ChevronLeft } from "lucide-react"
import { useT } from "@/lib/i18n/I18nProvider"

export function PrivacyStep({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  const t = useT()
  const { enabled, setEnabled } = useAnalyticsConsent()

  // Persist the current choice (default included) so it counts as an explicit
  // decision and this step is skipped on future onboarding runs.
  const handleContinue = () => {
    setEnabled(enabled)
    onNext()
  }

  return (
    <div className="space-y-6">
      <div className="text-center space-y-2">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <ShieldCheck className="h-6 w-6" />
        </div>
        <h2 className="text-2xl font-semibold">{t("onboarding.step.privacy.heading")}</h2>
        <p className="text-sm text-muted-foreground">
          {t("onboarding.step.privacy.description")}
        </p>
      </div>

      <div className="rounded-lg border bg-card p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <FieldLabel htmlFor="analytics-consent" className="text-sm font-medium">
              {t("onboarding.privacy.shareUsageData")}
            </FieldLabel>
            <p className="text-xs text-muted-foreground">
              {t("onboarding.step.privacy.shareDescription")}
            </p>
          </div>
          <Switch
            id="analytics-consent"
            checked={enabled}
            onCheckedChange={setEnabled}
          />
        </div>
        {!enabled && (
          <p className="mt-3 text-xs text-amber-600 dark:text-amber-400">
            {t("onboarding.privacy.disabledWarning")}
          </p>
        )}
      </div>

      <div className="space-y-2">
        <Button size="lg" onClick={handleContinue} className="w-full">
          {t("onboarding.common.continue")}
        </Button>
        <Button variant="ghost" size="sm" onClick={onBack} className="w-full">
          <ChevronLeft className="h-4 w-4 rtl:rotate-180" />
          {t("common.back")}
        </Button>
      </div>

      <p className="text-center text-xs text-muted-foreground">
        {t("onboarding.step.privacy.footer")}{" "}
        <a href="/privacy-policy" target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
          {t("onboarding.step.privacy.policyLink")}
        </a>.
      </p>
    </div>
  )
}
