import { Button } from "@/components/ui/button"
import { useBrand } from "@/branding/use-brand"
import { useT } from "@/lib/i18n/I18nProvider"

export function WelcomeStep({ onNext }: { onNext: () => void }) {
  const t = useT()
  const brand = useBrand()
  const Logo = brand.logo.Mark
  return (
    <div className="text-center space-y-6">
      <Logo className="mx-auto h-20 w-20 shadow-lg" aria-hidden />
      <div className="space-y-2">
        <h1 className="text-3xl font-bold tracking-tight">{brand.marketing.onboardingHeadline}</h1>
        <p className="text-muted-foreground">
          {brand.marketing.onboardingSubhead}
        </p>
      </div>
      <Button size="lg" onClick={onNext} className="w-full">
        {t("onboarding.step.welcome.getStarted")}
      </Button>
    </div>
  )
}
