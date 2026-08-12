import { useState } from "react"
import { Navigate, useLocation, useNavigate, useParams, type Location } from "react-router-dom"
import { Cpu, Gauge, Globe, KeyRound, Palette, PanelLeft, ShieldCheck, UserRound } from "lucide-react"
import { AppShell } from "@/components/AppShell"
import { OrgSidebar } from "@/components/org/OrgSidebar"
import { OrgBreadcrumb } from "@/components/org/OrgBreadcrumb"
import { Switch } from "@/components/ui/switch"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Page, PageHeader, SettingsGroup, SettingsRow } from "@/components/ui/page"
import { NavList, NavRow, BackLink } from "@/components/ui/nav-list"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { LanguageSwitcher } from "@/lib/i18n/LanguageSwitcher"
import { useI18n } from "@/lib/i18n/I18nProvider"
import { useThemeMode, type ThemeMode } from "@/branding/ThemeMode"
import { useAnalyticsConsent } from "@/hooks/useAnalyticsConsent"
import { useDockRailPosition } from "@/hooks/useDockRailPosition"
import { PersonalProviderSection } from "@/components/settings/PersonalProviderSection"
import { LocalModelsSection } from "@/components/ProjectSettings/LocalModelsSection"
import { UsageSection } from "@/components/settings/UsageSection"
import { ApiTokensSection } from "@/components/settings/ApiTokensSection"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import type { DockRailPosition } from "@/lib/dock-rail-position"
import { useSkipReplaceConfirm, setSkipReplaceConfirm } from "@/lib/store/replace-confirm-pref"
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
 *
 * Detail pages match the org-settings layout: page-sized title via PageHeader,
 * then floating SettingsGroup headers with content cards for the controls.
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
  // AQU-591: the store tracks whether to SKIP the confirm; present it positively.
  const skipReplaceConfirm = useSkipReplaceConfirm()
  return (
    <SettingsGroup label="Workspace">
      <SettingsRow
        label="Sidebar tab layout"
        description="Show Files, Chat, and Search as a vertical rail on the left or a horizontal bar across the top of the sidebar."
        block
      >
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
      </SettingsRow>
      <SettingsRow
        label={
          <label htmlFor="confirm-replace">Confirm before replacing a translation</label>
        }
        description="Ask for confirmation when AI Generate replaces a cell that already has a translation. Validated cells always confirm regardless of this setting."
        control={
          <Switch
            id="confirm-replace"
            checked={!skipReplaceConfirm}
            onCheckedChange={(on) => setSkipReplaceConfirm(!on)}
          />
        }
      />
    </SettingsGroup>
  )
}

/**
 * Appearance settings stay device-scoped and deliberately separate from the
 * source/target text direction and other project-specific display settings.
 */
function AppearanceSection() {
  const { mode, setMode } = useThemeMode()

  return (
    <SettingsGroup label="Theme">
      <SettingsRow
        label="Theme"
        description="Follow your system appearance or choose a theme for this device."
        block
      >
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
      </SettingsRow>
    </SettingsGroup>
  )
}

/**
 * UI language. Device-scoped like Appearance, and separate from the
 * translator profile's "Assistant language" (which only steers AI replies).
 */
function LanguageSection() {
  const { t } = useI18n()
  return (
    <SettingsGroup label="Language">
      <SettingsRow
        label="UI language"
        description="The language the app's own interface (menus, buttons, messages) is shown in."
        control={
          <LanguageSwitcher
            className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
            ariaLabel={t("language.switcher.settingsRow")}
          />
        }
      />
    </SettingsGroup>
  )
}

/** Analytics consent toggle. Self-contained for its detail page. */
function PrivacySection() {
  const { enabled, setEnabled } = useAnalyticsConsent()
  return (
    <SettingsGroup label="Analytics">
      <SettingsRow
        label="Share usage data"
        description={
          <>
            Events like project creation, exports, and AI translations. Never the contents of your
            translations or files.
            {!enabled ? (
              <span className="mt-1 block text-amber-600 dark:text-amber-400">
                With analytics disabled, we may not be able to help diagnose problems you encounter.
              </span>
            ) : null}
          </>
        }
        control={
          <Switch
            id="analytics-consent"
            checked={enabled}
            onCheckedChange={setEnabled}
            aria-label="Share usage data"
          />
        }
      />
    </SettingsGroup>
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
    <SettingsGroup label="About you">
      <SettingsRow
        label="Profile fields"
        description="All fields are optional. Stored on this device and sent to the AI to tailor your summaries."
        block
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
      </SettingsRow>
    </SettingsGroup>
  )
}

/** One preference section: its route slug, index-row presentation, and body. */
interface PreferenceSection {
  slug: string
  title: string
  description: string
  group: string
  icon: React.ComponentType<{ className?: string }>
  render: () => React.ReactNode
}

const PREFERENCE_SECTIONS: PreferenceSection[] = [
  {
    slug: "workspace",
    title: "Workspace",
    description: "Layout and editing behavior for the project workspace.",
    group: "General",
    icon: PanelLeft,
    render: () => <WorkspaceSection />,
  },
  {
    slug: "appearance",
    title: "Appearance",
    description: "How the workspace looks on this device.",
    group: "General",
    icon: Palette,
    render: () => <AppearanceSection />,
  },
  {
    slug: "language",
    title: "Language",
    description: "The language the app's own interface is shown in.",
    group: "General",
    icon: Globe,
    render: () => <LanguageSection />,
  },
  {
    slug: "privacy",
    title: "Privacy",
    description: "Control what's shared with us about how you use the app.",
    group: "General",
    icon: ShieldCheck,
    render: () => <PrivacySection />,
  },
  {
    slug: "profile",
    title: "Translator profile",
    description:
      "Tell the AI about yourself so its summaries and answers fit your context — and so it replies in your language.",
    group: "AI & personalization",
    icon: UserRound,
    render: () => <TranslatorProfileSection />,
  },
  {
    slug: "provider-keys",
    title: "AI provider keys",
    description: "Optional personal AI provider override for this device only.",
    group: "AI & personalization",
    icon: KeyRound,
    render: () => <PersonalProviderSection />,
  },
  {
    slug: "local-models",
    title: "Local models",
    description:
      "Whisper transcription and Kokoro / MMS voices run entirely in your browser — stored once and shared across all projects on this device.",
    group: "AI & personalization",
    icon: Cpu,
    render: () => <LocalModelsSection />,
  },
  {
    slug: "usage",
    title: "Usage",
    description: "Your audio and AI activity. No pricing is shown here.",
    group: "Account",
    icon: Gauge,
    render: () => <UsageSection />,
  },
  {
    slug: "api-tokens",
    title: "API tokens",
    description:
      "Personal access tokens for the Agent API. Anyone holding a token can act with your access, up to its scope — treat it like a password.",
    group: "Account",
    icon: KeyRound,
    render: () => <ApiTokensSection />,
  },
]

const PREFERENCE_GROUPS = ["General", "AI & personalization", "Account"] as const

/** The index: grouped navigation rows, each hinting its current value. */
function PreferencesIndex({ modal = false, backgroundLocation }: { modal?: boolean; backgroundLocation?: Location }) {
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

  const content = (
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
                state={backgroundLocation ? { backgroundLocation, preferencesModalDepth: 2 } : undefined}
                icon={s.icon}
                title={s.title}
                hint={hints[s.slug]}
              />
            ))}
          </NavList>
        ))}
      </div>
    </Page>
  )

  if (modal) return content
  return (
    <AppShell
      sidebar={<OrgSidebar />}
      header={<OrgBreadcrumb section="Preferences" />}
      statusBar={null}
      main={content}
    />
  )
}

/** A single section, rendered on its own page with a back breadcrumb. */
function PreferencesDetail({ slug, modal = false, backgroundLocation }: { slug: string; modal?: boolean; backgroundLocation?: Location }) {
  const navigate = useNavigate()
  const section = PREFERENCE_SECTIONS.find((s) => s.slug === slug)
  if (!section) return <Navigate to="/preferences" replace />
  const content = (
    <Page>
      <div className="space-y-6">
        <BackLink
          to="/preferences"
          onClick={modal ? () => navigate(-1) : undefined}
          label="Preferences"
        />
        <PageHeader title={section.title} description={section.description} />
        {section.render()}
      </div>
    </Page>
  )
  if (modal) return content
  return (
    <AppShell
      sidebar={<OrgSidebar />}
      header={<OrgBreadcrumb parent={{ label: "Preferences", to: "/preferences" }} section={section.title} />}
      statusBar={null}
      main={content}
    />
  )
}

export function Preferences() {
  const { section } = useParams<{ section?: string }>()
  return section ? <PreferencesDetail slug={section} /> : <PreferencesIndex />
}

/** Route-modal presentation used by in-app entry points. Direct URLs continue
 * to render the full-page Preferences surface above. */
export function PreferencesDialog() {
  const { section } = useParams<{ section?: string }>()
  const location = useLocation()
  const navigate = useNavigate()
  const modalState = location.state as {
    backgroundLocation?: Location
    preferencesModalDepth?: number
  } | null
  const backgroundLocation = modalState?.backgroundLocation
  const modalDepth = modalState?.preferencesModalDepth ?? 1

  return (
    <Dialog open onOpenChange={(open) => { if (!open) navigate(-modalDepth) }}>
      <DialogContent
        className="h-[min(90dvh,56rem)] max-w-[min(72rem,calc(100%-2rem))] gap-0 p-0 sm:max-w-[min(72rem,calc(100%-2rem))]"
        data-testid="preferences-dialog"
      >
        <DialogHeader className="sr-only">
          <DialogTitle>Preferences</DialogTitle>
          <DialogDescription>Personal preferences that apply across projects.</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {section
            ? <PreferencesDetail slug={section} modal backgroundLocation={backgroundLocation} />
            : <PreferencesIndex modal backgroundLocation={backgroundLocation} />}
        </div>
      </DialogContent>
    </Dialog>
  )
}
