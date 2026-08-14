import { Button } from "@/components/ui/button"
import { Check } from "lucide-react"
import type { ProjectRecord } from "@/lib/parsers/types"
import { useT } from "@/lib/i18n/I18nProvider"

export function ReadyStep({
  project,
  onFinish,
}: {
  project: ProjectRecord
  onFinish: () => void
}) {
  const t = useT()
  return (
    <div className="space-y-6 text-center">
      <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-lg bg-green-100 text-green-600">
        <Check className="h-8 w-8" />
      </div>
      <div className="space-y-2">
        <h2 className="text-2xl font-semibold">{t("onboarding.step.ready.heading")}</h2>
        <p className="text-muted-foreground">
          {t("onboarding.step.ready.description", { projectName: project.name })}
        </p>
      </div>
      <Button size="lg" onClick={onFinish} className="w-full">
        {t("onboarding.step.ready.startTranslating")}
      </Button>
    </div>
  )
}
