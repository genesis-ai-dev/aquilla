import { User, Users, ChevronLeft } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useT } from "@/lib/i18n/I18nProvider"

/**
 * Personal vs Team fork (PLG research: segment intent early, then bifurcate the
 * flow). Personal users go straight to creating a project in their personal
 * workspace; Team users first create an organization and invite collaborators,
 * because for a collaborative product the multiplayer setup is the real value.
 */
export function IntentStep({
  onChoosePersonal,
  onChooseTeam,
  onBack,
}: {
  onChoosePersonal: () => void
  onChooseTeam: () => void
  onBack: () => void
}) {
  const t = useT()
  return (
    <div className="space-y-6">
      <div className="space-y-2 text-center">
        <h2 className="text-2xl font-semibold">{t("onboarding.step.intent.heading")}</h2>
        <p className="text-sm text-muted-foreground">
          {t("onboarding.step.intent.description")}
        </p>
      </div>
      <div className="grid gap-3">
        <button
          type="button"
          onClick={onChoosePersonal}
          className="flex items-start gap-3 rounded-lg border p-4 text-start hover:border-primary hover:bg-accent"
        >
          <User className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" aria-hidden />
          <span>
            <span className="block text-sm font-medium">{t("onboarding.step.intent.personalTitle")}</span>
            <span className="block text-xs text-muted-foreground">
              {t("onboarding.step.intent.personalDescription")}
            </span>
          </span>
        </button>
        <button
          type="button"
          onClick={onChooseTeam}
          className="flex items-start gap-3 rounded-lg border p-4 text-start hover:border-primary hover:bg-accent"
        >
          <Users className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" aria-hidden />
          <span>
            <span className="block text-sm font-medium">{t("onboarding.step.intent.teamTitle")}</span>
            <span className="block text-xs text-muted-foreground">
              {t("onboarding.step.intent.teamDescription")}
            </span>
          </span>
        </button>
      </div>
      <Button variant="ghost" size="sm" onClick={onBack} className="w-full">
        <ChevronLeft className="h-4 w-4 rtl:rotate-180" />
        {t("common.back")}
      </Button>
    </div>
  )
}
