import { Link } from "react-router-dom"
import { ArrowLeft, Monitor, Moon, Sun } from "lucide-react"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { useAnalyticsConsent } from "@/hooks/useAnalyticsConsent"
import { PersonalProviderSection } from "@/components/settings/PersonalProviderSection"
import { useThemeMode } from "@/branding/ThemeMode"
import type { ThemeMode } from "@/branding/ThemeMode"

const THEME_OPTIONS: Array<{ value: ThemeMode; label: string; Icon: typeof Sun }> = [
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
  { value: "system", label: "System", Icon: Monitor },
]

export function Settings() {
  const { enabled, setEnabled } = useAnalyticsConsent()
  const { mode, setMode } = useThemeMode()

  return (
    <div className="mx-auto max-w-2xl p-6">
      <Link
        to="/"
        className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground underline-offset-2 hover:underline"
      >
        <ArrowLeft className="h-4 w-4" />
        Back
      </Link>
      <h1 className="mb-1 text-xl font-semibold">Settings</h1>
      <p className="mb-6 text-sm text-muted-foreground">
        Preferences that apply to you across all of Aquilla on this device.
      </p>

      <section className="mb-8 space-y-3">
        <div>
          <h2 className="text-base font-semibold">Appearance</h2>
          <p className="text-xs text-muted-foreground">
            Theme follows you to every page across Aquilla (projects, org, billing).
          </p>
        </div>
        <div
          className="inline-flex rounded-lg border bg-card p-1"
          role="radiogroup"
          aria-label="Theme"
        >
          {THEME_OPTIONS.map(({ value, label, Icon }) => {
            const active = mode === value
            return (
              <Button
                key={value}
                type="button"
                role="radio"
                aria-checked={active}
                variant={active ? "default" : "ghost"}
                size="sm"
                onClick={() => setMode(value)}
                className="gap-2"
              >
                <Icon className="h-4 w-4" />
                {label}
              </Button>
            )
          })}
        </div>
      </section>

      <section className="space-y-3">
        <div>
          <h2 className="text-base font-semibold">Privacy</h2>
          <p className="text-xs text-muted-foreground">
            Control what's shared with us about how you use the app.
          </p>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <Label htmlFor="analytics-consent" className="text-sm font-medium">
                Share anonymous usage data
              </Label>
              <p className="text-xs text-muted-foreground">
                Events like project creation, exports, and AI translations. Never the contents of your
                translations or files.
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
      </section>

      <div className="mt-8">
        <PersonalProviderSection />
      </div>
    </div>
  )
}
