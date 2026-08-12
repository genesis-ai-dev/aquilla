import { useState } from "react"
import { Navigate, useParams } from "react-router-dom"
import { Cpu, Gauge, KeyRound, PanelLeft, UserRound } from "lucide-react"
import { AppShell } from "@/components/AppShell"
import { OrgSidebar } from "@/components/org/OrgSidebar"
import { OrgBreadcrumb } from "@/components/org/OrgBreadcrumb"
import { Switch } from "@/components/ui/switch"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Page, PageHeader, SettingsGroup, SettingsRow } from "@/components/ui/page"
import { NavList, NavRow } from "@/components/ui/nav-list"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useI18n } from "@/lib/i18n/I18nProvider"
import { useThemeMode, type ThemeMode } from "@/branding/ThemeMode"
import { useAnalyticsConsent } from "@/hooks/useAnalyticsConsent"
import { useDockRailPosition } from "@/hooks/useDockRailPosition"
import { PersonalProviderSection } from "@/components/settings/PersonalProviderSection"
import { LocalModelsSection } from "@/components/ProjectSettings/LocalModelsSection"
import { UsageSection } from "@/components/settings/UsageSection"
import { ApiTokensSection } from "@/components/settings/ApiTokensSection"
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
 * `/preferences` shows a General card inline (theme, UI language, analytics,
 * and a Workspace nav row in the same group); heavier sections stay as
 * navigation rows into `/preferences/:section`. Both routes render this
 * same component — it branches on the `section` param.
 *
 * Detail pages match the org-settings layout: page-sized title via PageHeader,
 * then floating SettingsGroup headers with content cards for the controls.
 * Return to the index via the breadcrumb.
 */
const RAIL_OPTIONS: { id: DockRailPosition; label: string }[] = [
  { id: "top", label: "Top bar" },
  { id: "left", label: "Left rail" },
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
 * Editor sidebar tab layout — Files/Chat/Search as a left rail or a top bar.
 * Self-contained so it can render on its own detail page.
 */
function WorkspaceSection() {
  const { position: railPosition, setPosition: setRailPosition } = useDockRailPosition()
  // AQU-591: the store tracks whether to SKIP the confirm; present it positively.
  const skipReplaceConfirm = useSkipReplaceConfirm()
  return (
    <SettingsGroup label="Workspace">
      <SettingsRow
        label="Editor sidebar tab layout"
        description="Show Files, Chat, and Search as a vertical rail on the left or a horizontal bar across the top of the sidebar."
        control={
          <Select
            items={RAIL_OPTIONS.map((opt) => ({ value: opt.id, label: opt.label }))}
            value={railPosition}
            onValueChange={(value) => {
              if (value === "left" || value === "top") setRailPosition(value)
            }}
          >
            <SelectTrigger
              id="sidebar-tab-layout"
              aria-label="Editor sidebar tab layout"
              className="w-36 bg-background"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {RAIL_OPTIONS.map(({ id, label }) => (
                  <SelectItem key={id} value={id}>
                    {label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        }
      />
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
 * Device-scoped General card on the Preferences index — theme, UI language,
 * analytics consent, plus Workspace as a connected nav row into its detail page.
 */
function GeneralSection({ workspaceHint }: { workspaceHint: string }) {
  const { mode, setMode } = useThemeMode()
  const { locale, locales, setLocale, t } = useI18n()
  const { enabled, setEnabled } = useAnalyticsConsent()
  const languageItems = locales.map((l) => ({ value: l.code, label: l.nativeName }))

  return (
    <SettingsGroup label="General">
      <SettingsRow
        label="Theme"
        description="Follow your system appearance or choose a theme for this device."
        control={
          <Select
            items={THEME_OPTIONS.map((opt) => ({ value: opt.id, label: opt.label }))}
            value={mode}
            onValueChange={(value) => {
              if (value === "system" || value === "light" || value === "dark") {
                setMode(value)
              }
            }}
          >
            <SelectTrigger
              id="theme-mode"
              aria-label="Theme"
              className="w-36 bg-background"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {THEME_OPTIONS.map(({ id, label }) => (
                  <SelectItem key={id} value={id}>
                    {label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        }
      />
      <SettingsRow
        label="UI language"
        description="The language the app's own interface (menus, buttons, messages) is shown in."
        control={
          <Select items={languageItems} value={locale} onValueChange={setLocale}>
            <SelectTrigger
              id="ui-language"
              aria-label={t("language.switcher.settingsRow")}
              className="w-44 bg-background"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {locales.map((l) => (
                  <SelectItem
                    key={l.code}
                    value={l.code}
                    // Endonym alone for sighted users; tag lang/dir so the
                    // browser shapes the script correctly (incl. RTL Arabic).
                    lang={l.code}
                    dir={l.dir}
                  >
                    {l.nativeName}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        }
      />
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
      <NavRow
        to="/preferences/workspace"
        icon={PanelLeft}
        title="Workspace"
        hint={workspaceHint}
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
      {PROFILE_TEXT_FIELDS.map(({ key, label, placeholder }) => (
        <SettingsRow
          key={key}
          label={<label htmlFor={`profile-${key}`}>{label}</label>}
          control={
            <Input
              id={`profile-${key}`}
              value={form[key] ?? ""}
              onChange={(e) => update(key, e.target.value)}
              placeholder={placeholder}
              className="w-56 bg-background"
            />
          }
        />
      ))}
      <SettingsRow
        label={<label htmlFor="profile-otherInfo">Other relevant information</label>}
        description="Anything else that should shape the summaries you get. All fields are optional and stored on this device."
        block
      >
        <Textarea
          id="profile-otherInfo"
          value={form.otherInfo ?? ""}
          onChange={(e) => update("otherInfo", e.target.value)}
          placeholder="Anything else that should shape the summaries you get"
          rows={3}
          className="bg-background"
        />
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

/** Former nested slugs now inlined on the index — keep redirecting for bookmarks. */
const INLINE_PREFERENCE_SLUGS = new Set(["appearance", "language", "privacy"])

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

/** Nested nav groups after the inline General card. */
const PREFERENCE_GROUPS = ["AI & personalization", "Account"] as const

/** The index: inline General card + grouped navigation rows for nested sections. */
function PreferencesIndex() {
  const { position } = useDockRailPosition()

  const profile = getTranslatorProfile()
  const profileFilled = PROFILE_KEYS.filter((k) => (profile[k] ?? "").trim().length > 0).length

  const hints: Record<string, string> = {
    workspace: RAIL_OPTIONS.find((o) => o.id === position)?.label ?? "",
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
          <div className="flex flex-col gap-12">
            <GeneralSection workspaceHint={hints.workspace} />
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
  if (INLINE_PREFERENCE_SLUGS.has(slug)) return <Navigate to="/preferences" replace />
  const section = PREFERENCE_SECTIONS.find((s) => s.slug === slug)
  if (!section) return <Navigate to="/preferences" replace />
  return (
    <AppShell
      sidebar={<OrgSidebar />}
      header={<OrgBreadcrumb parent={{ label: "Preferences", to: "/preferences" }} section={section.title} />}
      statusBar={null}
      main={
        <Page>
          <div className="flex flex-col gap-12">
            <PageHeader title={section.title} description={section.description} className="mb-0" />
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
