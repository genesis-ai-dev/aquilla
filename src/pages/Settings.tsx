import { AppShell } from "@/components/AppShell"
import { OrgSidebar } from "@/components/org/OrgSidebar"
import { OrgBreadcrumb } from "@/components/org/OrgBreadcrumb"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import { useAnalyticsConsent } from "@/hooks/useAnalyticsConsent"
import { PersonalProviderSection } from "@/components/settings/PersonalProviderSection"

export function Settings() {
  const { enabled, setEnabled } = useAnalyticsConsent()

  // Settings is reached from the org sidebar, so it renders inside the same
  // AppShell + OrgSidebar chrome as the other sections — keeping the org frame
  // visible instead of ejecting to a bare page. (The preferences themselves are
  // personal/device-scoped, as the subtitle states; the breadcrumb just shows
  // which workspace you're in.) The main slot owns its scroll because
  // AppShell's main wrapper is overflow-hidden.
  return (
    <AppShell
      sidebar={<OrgSidebar />}
      header={<OrgBreadcrumb section="Settings" />}
      statusBar={null}
      main={
        <div className="h-full overflow-y-auto">
          <div className="mx-auto max-w-2xl p-6">
            <h1 className="mb-1 text-xl font-semibold">Settings</h1>
            <p className="mb-6 text-sm text-muted-foreground">
              Preferences that apply to you across all projects on this device.
            </p>

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
        </div>
      }
    />
  )
}
