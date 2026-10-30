// AQU-2263: "Share usage data" — one switch with one description, the same in
// every door it has (Preferences → General, onboarding's privacy step). Its
// default is the consent store's (useAnalyticsConsent), which AQU-2242 owns;
// nothing here changes it.

import { SettingsRow } from "@/components/ui/page"
import { Switch } from "@/components/ui/switch"
import { useT } from "@/lib/i18n/I18nProvider"

export function ShareUsageDataSetting({
  enabled,
  onEnabledChange,
}: {
  enabled: boolean
  onEnabledChange: (next: boolean) => void
}) {
  const t = useT()
  return (
    <div data-testid="share-usage-data">
      <SettingsRow
        label={<label htmlFor="analytics-consent">{t("onboarding.privacy.shareUsageData")}</label>}
        description={
          <>
            {t("settings.shareUsageData.description")}
            {!enabled ? (
              <span className="mt-1 block text-amber-600 dark:text-amber-400">
                {t("onboarding.privacy.disabledWarning")}
              </span>
            ) : null}
          </>
        }
        control={
          <Switch
            id="analytics-consent"
            checked={enabled}
            onCheckedChange={(checked) => onEnabledChange(checked)}
            aria-label={t("onboarding.privacy.shareUsageData")}
          />
        }
      />
    </div>
  )
}
