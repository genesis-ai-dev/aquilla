import { useState } from "react"
import { Navigate, useParams } from "react-router-dom"
import { Cpu, Gauge, KeyRound, Palette, PanelLeft, ShieldCheck, UserRound } from "lucide-react"
import { AppShell } from "@/components/AppShell"
import { OrgSidebar } from "@/components/org/OrgSidebar"
import { OrgBreadcrumb } from "@/components/org/OrgBreadcrumb"
import { Switch } from "@/components/ui/switch"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Page, PageHeader, Section } from "@/components/ui/page"
import { NavList, NavRow, BackLink } from "@/components/ui/nav-list"
import { useThemeMode, type ThemeMode } from "@/branding/ThemeMode"
import { useAnalyticsConsent } from "@/hooks/useAnalyticsConsent"
import { useDockRailPosition } from "@/hooks/useDockRailPosition"
import { PersonalProviderSection } from "@/components/settings/PersonalProviderSection"
import { LocalModelsSection } from "@/components/ProjectSettings/LocalModelsSection"
import { UsageSection } from "@/components/settings/UsageSection"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
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
 *
 * Rather than stacking every form onto one long page, `/preferences` is an
 * index of navigation rows (grouped, with a hint showing the current value);
 * each row opens a focused detail sub-page at `/preferences/:section`. Both
 * routes render this same component — it branches on the `section` param.
 */
const RAIL_OPTIONS: { id: DockRailPosition; label: string }[] = [
  { id: "left", label: "Left rail" },
  { id: "top", label: "Top bar" },
]

const THEME_OPTIONS: { id: ThemeMode; label: string }[] = [
  { id: "system", label: "System" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
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

/** All translator-profile keys, used to count how many fields are filled in. */
const PROFILE_KEYS: (keyof TranslatorProfile)[] = [
  ...PROFILE_TEXT_FIELDS.map((f) => f.key),
  "otherInfo",
]

/**
 * Sidebar tab layout — Files/Chat/Search as a left rail or a top bar.
 * Self-contained so it can render on its own detail page.
 */
function WorkspaceSection() {
  const { position: railPosition, setPosition: setRailPosition } = useDockRailPosition()
  return (
    <Section title="Workspace" description="Layout choices for the project sidebar.">
      <Field>
        <FieldLabel className="text-sm font-medium">Sidebar tab layout</FieldLabel>
        <FieldDescription>
          Show Files, Chat, and Search as a vertical rail on the left or a horizontal bar
          across the top of the sidebar.
        </FieldDescription>
        <Tabs
          value={railPosition}
          onValueChange={(value) => setRailPosition(value as DockRailPosition)}
          className="gap-0"
        >
          <TabsList aria-label="Sidebar tab layout">
            {RAIL_OPTIONS.map(({ id, label }) => (
              <TabsTrigger key={id} value={id}>
                {label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </Field>
    </Section>
  )
}

/**
 * Appearance settings stay device-scoped and deliberately separate from the
 * source/target text direction and other project-specific display settings.
 */
function AppearanceSection() {
  const { mode, setMode } = useThemeMode()

  return (
    <Section title="Appearance" description="How the workspace looks on this device.">
      <Field>
        <FieldLabel className="text-sm font-medium">Theme</FieldLabel>
        <FieldDescription>
          Follow your system appearance or choose a theme for this device.
        </FieldDescription>
        <Tabs
          value={mode}
          onValueChange={(value) => setMode(value as ThemeMode)}
          className="gap-0"
        >
          <TabsList aria-label="Theme">
            {THEME_OPTIONS.map(({ id, label }) => (
              <TabsTrigger key={id} value={id}>
                {label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </Field>
    </Section>
  )
}

/** Analytics consent toggle. Self-contained for its detail page. */
function PrivacySection() {
  const { enabled, setEnabled } = useAnalyticsConsent()
  return (
    <Section title="Privacy" description="Control what's shared with us about how you use the app.">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <FieldLabel htmlFor="analytics-consent" className="text-sm font-medium">
            Share usage data
          </FieldLabel>
          <p className="text-xs text-muted-foreground">
            Events like project creation, exports, and AI translations. Never the contents of your
            translations or files.
          </p>
        </div>
        <Switch id="analytics-consent" checked={enabled} onCheckedChange={setEnabled} />
      </div>
      {!enabled && (
        <p className="mt-3 text-xs text-amber-600 dark:text-amber-400">
          With analytics disabled, we may not be able to help diagnose problems you encounter.
        </p>
      )}
    </Section>
  )
}

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
    <Section
      title="Translator profile"
      description="Tell the AI about yourself so its summaries and answers fit your context — and so it replies in your language. All fields are optional."
    >
      <FieldGroup className="grid gap-4 sm:grid-cols-2">
        {PROFILE_TEXT_FIELDS.map(({ key, label, placeholder }) => (
          <Field key={key}>
            <FieldLabel htmlFor={`profile-${key}`} className="text-sm font-medium">
              {label}
            </FieldLabel>
            <Input
              id={`profile-${key}`}
              value={form[key] ?? ""}
              onChange={(e) => update(key, e.target.value)}
              placeholder={placeholder}
            />
          </Field>
        ))}
      </FieldGroup>
      <Field className="mt-4">
        <FieldLabel htmlFor="profile-otherInfo" className="text-sm font-medium">
          Other relevant information
        </FieldLabel>
        <Textarea
          id="profile-otherInfo"
          value={form.otherInfo ?? ""}
          onChange={(e) => update("otherInfo", e.target.value)}
          placeholder="Anything else that should shape the summaries you get"
          rows={3}
        />
      </Field>
      <p className="mt-3 text-xs text-muted-foreground">
        This profile is stored on this device and sent to the AI to tailor your summaries.
      </p>
    </Section>
  )
}

/** One preference section: its route slug, index-row presentation, and body. */
interface PreferenceSection {
  slug: string
  title: string
  group: string
  icon: React.ComponentType<{ className?: string }>
  render: () => React.ReactNode
}

const PREFERENCE_SECTIONS: PreferenceSection[] = [
  { slug: "workspace", title: "Workspace", group: "General", icon: PanelLeft, render: () => <WorkspaceSection /> },
  { slug: "appearance", title: "Appearance", group: "General", icon: Palette, render: () => <AppearanceSection /> },
  { slug: "privacy", title: "Privacy", group: "General", icon: ShieldCheck, render: () => <PrivacySection /> },
  { slug: "profile", title: "Translator profile", group: "AI & personalization", icon: UserRound, render: () => <TranslatorProfileSection /> },
  { slug: "provider-keys", title: "AI provider keys", group: "AI & personalization", icon: KeyRound, render: () => <PersonalProviderSection /> },
  { slug: "local-models", title: "Local models", group: "AI & personalization", icon: Cpu, render: () => <LocalModelsSection /> },
  { slug: "usage", title: "Usage", group: "Account", icon: Gauge, render: () => <UsageSection /> },
]

const PREFERENCE_GROUPS = ["General", "AI & personalization", "Account"] as const

/** The index: grouped navigation rows, each hinting its current value. */
function PreferencesIndex() {
  const { enabled } = useAnalyticsConsent()
  const { position } = useDockRailPosition()
  const { mode } = useThemeMode()

  const profile = getTranslatorProfile()
  const profileFilled = PROFILE_KEYS.filter((k) => (profile[k] ?? "").trim().length > 0).length

  const hints: Record<string, string> = {
    workspace: RAIL_OPTIONS.find((o) => o.id === position)?.label ?? "",
    appearance: mode === "system" ? "System" : mode === "dark" ? "Dark" : "Light",
    privacy: enabled ? "Sharing on" : "Sharing off",
    profile: profileFilled > 0 ? `${profileFilled}/${PROFILE_KEYS.length} set` : "Not set",
    "provider-keys": "Personal",
    "local-models": "On-device",
    usage: "This week",
  }

  return (
    <AppShell
      sidebar={<OrgSidebar />}
      header={<OrgBreadcrumb section="Preferences" />}
      statusBar={null}
      main={
        <Page>
          <PageHeader
            title="Preferences"
            description="Personal preferences that apply to you across all projects on this device."
          />
          <div className="space-y-6">
            {PREFERENCE_GROUPS.map((group) => (
              <NavList key={group} label={group}>
                {PREFERENCE_SECTIONS.filter((s) => s.group === group).map((s) => (
                  <NavRow
                    key={s.slug}
                    to={`/preferences/${s.slug}`}
                    icon={s.icon}
                    title={s.title}
                    hint={hints[s.slug]}
                  />
                ))}
              </NavList>
            ))}
          </div>
        </Page>
      }
    />
  )
}

/** A single section, rendered on its own page with a back breadcrumb. */
function PreferencesDetail({ slug }: { slug: string }) {
  const section = PREFERENCE_SECTIONS.find((s) => s.slug === slug)
  if (!section) return <Navigate to="/preferences" replace />
  return (
    <AppShell
      sidebar={<OrgSidebar />}
      header={<OrgBreadcrumb parent={{ label: "Preferences", to: "/preferences" }} section={section.title} />}
      statusBar={null}
      main={
        <Page>
          <div className="space-y-4">
            <BackLink to="/preferences" label="Preferences" />
            {section.render()}
          </div>
        </Page>
      }
    />
  )
}

export function Preferences() {
  const { section } = useParams<{ section?: string }>()
  return section ? <PreferencesDetail slug={section} /> : <PreferencesIndex />
}
