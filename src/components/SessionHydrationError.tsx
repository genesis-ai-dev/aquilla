import { Button } from "@/components/ui/button"
import { useT } from "@/lib/i18n/I18nProvider"
import type { MessageKey } from "@/lib/i18n/messages/en"

export function SessionHydrationError({
  retry,
  messageKey = "auth.login.sessionLoadFailed",
}: {
  retry: () => Promise<void>
  messageKey?: MessageKey
}) {
  const t = useT()
  return (
    <div className="flex min-h-screen items-center justify-center p-8">
      <div role="alert" className="max-w-md space-y-4 text-center">
        <p className="text-sm text-muted-foreground">
          {t(messageKey)}
        </p>
        <Button onClick={() => { void retry() }}>{t("common.retry")}</Button>
      </div>
    </div>
  )
}
