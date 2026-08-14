import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { FieldLabel } from "@/components/ui/field"
import { useAnalyticsConsent } from "@/hooks/useAnalyticsConsent"
import { ShieldCheck } from "lucide-react"

export function PrivacyStep({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
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
        <h2 className="text-2xl font-semibold">Help us improve</h2>
        <p className="text-sm text-muted-foreground">
          We use product analytics to understand which features people use and where things go wrong.
        </p>
      </div>

      <div className="rounded-lg border bg-card p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <FieldLabel htmlFor="analytics-consent" className="text-sm font-medium">
              Share usage data
            </FieldLabel>
            <p className="text-xs text-muted-foreground">
              Helps us provide support and improve Aquilla for everyone. Includes usage events
              and session recordings for diagnosing issues.
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
            With analytics disabled, we may not be able to help diagnose problems you encounter.
          </p>
        )}
      </div>

      <div className="space-y-2">
        <Button size="lg" onClick={handleContinue} className="w-full">
          Continue
        </Button>
        <Button variant="ghost" onClick={onBack} className="w-full">
          ← Back
        </Button>
      </div>

      <p className="text-center text-xs text-muted-foreground">
        You can change this anytime in Settings. Read our{" "}
        <a href="/privacy-policy" target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
          Privacy Policy
        </a>.
      </p>
    </div>
  )
}
