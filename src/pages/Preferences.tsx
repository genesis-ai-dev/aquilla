import { AppShell } from "@/components/AppShell"
import { OrgSidebar } from "@/components/org/OrgSidebar"
import { OrgBreadcrumb } from "@/components/org/OrgBreadcrumb"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import { useAnalyticsConsent } from "@/hooks/useAnalyticsConsent"
import { PersonalProviderSection } from "@/components/settings/PersonalProviderSection"

/**
 * Personal, device-scoped preferences. Split out of the old /settings page so
 * these are reachable by EVERY signed-in user (via the AccountSwitcher), not
 * just org admins — /settings is now an org-level surface gated to managers.
 */
export function Preferences() {
  const { enabled, setEnabled } = useAnalyticsConsent()

  return (
    <AppShell
      sidebar={<OrgSidebar />}
      header={<OrgBreadcrumb section="Preferences" />}
      statusBar={null}
      main={
        <div className="h-full overflow-y-auto">
          <div className="p-6">
            <h1 className="mb-1 text-xl font-semibold">Preferences</h1>
            <p className="mb-6 text-sm text-muted-foreground">
              Personal preferences that apply to you across all projects on this device.
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
                      Share usage data
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
