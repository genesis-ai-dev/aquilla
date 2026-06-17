import { useState } from "react"
import { AppShell } from "@/components/AppShell"
import { OrgSidebar } from "@/components/org/OrgSidebar"
import { OrgBreadcrumb } from "@/components/org/OrgBreadcrumb"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { useAnalyticsConsent } from "@/hooks/useAnalyticsConsent"
import { useDockRailPosition } from "@/hooks/useDockRailPosition"
import { PersonalProviderSection } from "@/components/settings/PersonalProviderSection"
import { LocalModelsSection } from "@/components/ProjectSettings/LocalModelsSection"
import { UsageSection } from "@/components/settings/UsageSection"
import { cn } from "@/lib/utils"
import type { DockRailPosition } from "@/lib/dock-rail-position"
import {
  getTranslatorProfile,
  setTranslatorProfile,
  type TranslatorProfile,
} from "@/lib/translator-profile"

/**
 * Personal, device-scoped preferences. Split out of the old /settings page so
 * these are reachable by EVERY signed-in user (via the AccountSwitcher), not
 * just org admins — /settings is now an org-level surface gated to managers.
 */
const RAIL_OPTIONS: { id: DockRailPosition; label: string }[] = [
  { id: "left", label: "Left rail" },
  { id: "top", label: "Top bar" },
]

/** Single-line fields rendered as text inputs, in render order. */
const PROFILE_TEXT_FIELDS: {
  key: Exclude<keyof TranslatorProfile, "otherInfo">
  label: string
  placeholder: string
}[] = [
  { key: "responseLanguage", label: "Assistant language", placeholder: "e.g. Tagalog — the AI replies in this language" },
  { key: "age", label: "Age", placeholder: "e.g. 32" },
  { key: "gender", label: "Gender", placeholder: "e.g. Female" },
  { key: "educationLevel", label: "Level of education", placeholder: "e.g. High school" },
  { key: "religiousBackground", label: "Religious background", placeholder: "e.g. Christian" },
  { key: "translationExperience", label: "Translation experience", placeholder: "e.g. 2 years" },
  { key: "geographicalSetting", label: "Geographical setting", placeholder: "e.g. Rural, Asia" },
]

/**
 * Translator profile editor. Local form state so editing (incl. trailing
 * spaces) is smooth; every change is persisted via setTranslatorProfile, which
 * sanitizes for storage and notifies the chat/agent hooks.
 */
function TranslatorProfileSection() {
  const [form, setForm] = useState<TranslatorProfile>(() => getTranslatorProfile())

  function update(key: keyof TranslatorProfile, value: string) {
    const next = { ...form, [key]: value }
    setForm(next)
    setTranslatorProfile(next)
  }

  return (
    <section className="mt-8 space-y-3">
      <div>
        <h2 className="text-base font-semibold">Translator profile</h2>
        <p className="text-xs text-muted-foreground">
          Tell the AI about yourself so its summaries and answers fit your context — and so it
          replies in your language. All fields are optional.
        </p>
      </div>
      <div className="rounded-lg border bg-card p-4">
        <div className="grid gap-4 sm:grid-cols-2">
          {PROFILE_TEXT_FIELDS.map(({ key, label, placeholder }) => (
            <div key={key} className="space-y-1">
              <Label htmlFor={`profile-${key}`} className="text-sm font-medium">
                {label}
              </Label>
              <Input
                id={`profile-${key}`}
                value={form[key] ?? ""}
                onChange={(e) => update(key, e.target.value)}
                placeholder={placeholder}
              />
            </div>
          ))}
        </div>
        <div className="mt-4 space-y-1">
          <Label htmlFor="profile-otherInfo" className="text-sm font-medium">
            Other relevant information
          </Label>
          <Textarea
            id="profile-otherInfo"
            value={form.otherInfo ?? ""}
            onChange={(e) => update("otherInfo", e.target.value)}
            placeholder="Anything else that should shape the summaries you get"
            rows={3}
          />
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          This profile is stored on this device and sent to the AI to tailor your summaries.
        </p>
      </div>
    </section>
  )
}

export function Preferences() {
  const { enabled, setEnabled } = useAnalyticsConsent()
  const { position: railPosition, setPosition: setRailPosition } = useDockRailPosition()

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
                <h2 className="text-base font-semibold">Workspace</h2>
                <p className="text-xs text-muted-foreground">
                  Layout choices for the project sidebar.
                </p>
              </div>
              <div className="rounded-lg border bg-card p-4">
                <div className="space-y-3">
                  <div className="space-y-1">
                    <Label className="text-sm font-medium">Sidebar tab layout</Label>
                    <p className="text-xs text-muted-foreground">
                      Show Files, Chat, and Search as a vertical rail on the left or a horizontal bar
                      across the top of the sidebar.
                    </p>
                  </div>
                  <div
                    className="neu-inset inline-flex items-center gap-0.5 rounded-full p-1 text-xs"
                    role="group"
                    aria-label="Sidebar tab layout"
                  >
                    {RAIL_OPTIONS.map(({ id, label }) => {
                      const active = railPosition === id
                      return (
                        <button
                          key={id}
                          type="button"
                          onClick={() => setRailPosition(id)}
                          aria-pressed={active}
                          className={cn(
                            "rounded-full px-3 py-1.5 transition-all",
                            active
                              ? "bg-card font-medium text-foreground shadow-neu-xs"
                              : "text-muted-foreground hover:text-foreground",
                          )}
                        >
                          {label}
                        </button>
                      )
                    })}
                  </div>
                </div>
              </div>
            </section>

            <section className="mt-8 space-y-3">
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

            <TranslatorProfileSection />

            <UsageSection />

            <div className="mt-8">
              <PersonalProviderSection />
            </div>

            <LocalModelsSection />
          </div>
        </div>
      }
    />
  )
}
