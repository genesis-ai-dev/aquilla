import { Button } from "@/components/ui/button"
import { useBrand } from "@/branding/use-brand"

export function WelcomeStep({ onNext }: { onNext: () => void }) {
  const brand = useBrand()
  const Logo = brand.logo.Mark
  return (
    <div className="text-center space-y-6">
      <Logo className="mx-auto h-24 w-24 shadow-lg" aria-hidden />
      <div className="space-y-2">
        <h1 className="text-3xl font-bold tracking-tight">{brand.marketing.onboardingHeadline}</h1>
        <p className="text-muted-foreground">
          {brand.marketing.onboardingSubhead}
        </p>
      </div>
      <Button size="lg" onClick={onNext} className="w-full">
        Get Started
      </Button>
    </div>
  )
}
