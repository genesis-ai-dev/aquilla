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
import type { MessageKey } from "@/lib/i18n/messages/en"
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
// Module-scope option tables store MessageKeys, never call t() here — t() is a
// hook and can't run outside a component. Resolved with t(opt.labelKey) at
// each render site below.
const RAIL_OPTIONS: { id: DockRailPosition; labelKey: MessageKey }[] = [
  { id: "top", labelKey: "onboarding.preferences.rail.top" },
  { id: "left", labelKey: "onboarding.preferences.rail.left" },
]

const THEME_OPTIONS: { id: ThemeMode; labelKey: MessageKey }[] = [
  { id: "system", labelKey: "onboarding.preferences.theme.system" },
  { id: "light", labelKey: "onboarding.preferences.theme.light" },
  { id: "dark", labelKey: "onboarding.preferences.theme.dark" },
]

/** Single-line fields rendered as text inputs, in render order. */
const PROFILE_TEXT_FIELDS: {
  key: Exclude<keyof TranslatorProfile, "otherInfo">
  labelKey: MessageKey
  placeholderKey: MessageKey
}[] = [
  { key: "responseLanguage", labelKey: "onboarding.preferences.profile.responseLanguage.label", placeholderKey: "onboarding.preferences.profile.responseLanguage.placeholder" },
  { key: "age", labelKey: "onboarding.preferences.profile.age.label", placeholderKey: "onboarding.preferences.profile.age.placeholder" },
  { key: "gender", labelKey: "onboarding.preferences.profile.gender.label", placeholderKey: "onboarding.preferences.profile.gender.placeholder" },
  { key: "educationLevel", labelKey: "onboarding.preferences.profile.educationLevel.label", placeholderKey: "onboarding.preferences.profile.educationLevel.placeholder" },
  { key: "religiousBackground", labelKey: "onboarding.preferences.profile.religiousBackground.label", placeholderKey: "onboarding.preferences.profile.religiousBackground.placeholder" },
  { key: "translationExperience", labelKey: "onboarding.preferences.profile.translationExperience.label", placeholderKey: "onboarding.preferences.profile.translationExperience.placeholder" },
  { key: "geographicalSetting", labelKey: "onboarding.preferences.profile.geographicalSetting.label", placeholderKey: "onboarding.preferences.profile.geographicalSetting.placeholder" },
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
  const { t } = useI18n()
  const { position: railPosition, setPosition: setRailPosition } = useDockRailPosition()
  // AQU-591: the store tracks whether to SKIP the confirm; present it positively.
  const skipReplaceConfirm = useSkipReplaceConfirm()
  return (
    <SettingsGroup label={t("onboarding.preferences.workspace.groupLabel")}>
      <SettingsRow
        label={t("settings.preferences.workspace.sidebarLayoutLabel")}
        description={t("onboarding.preferences.workspace.railDescription")}
        control={
          <Select
            items={RAIL_OPTIONS.map((opt) => ({ value: opt.id, label: t(opt.labelKey) }))}
            value={railPosition}
            onValueChange={(value) => {
              if (value === "left" || value === "top") setRailPosition(value)
            }}
          >
            <SelectTrigger
              id="sidebar-tab-layout"
              aria-label={t("settings.preferences.workspace.sidebarLayoutLabel")}
              className="w-36 bg-background"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {RAIL_OPTIONS.map(({ id, labelKey }) => (
                  <SelectItem key={id} value={id}>
                    {t(labelKey)}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        }
      />
      <SettingsRow
        label={
          <label htmlFor="confirm-replace">
            {t("onboarding.preferences.workspace.confirmReplaceLabel")}
          </label>
        }
        description={t("onboarding.preferences.workspace.confirmReplaceDescription")}
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
function GeneralSection({
  workspaceHint,
}: {
  workspaceHint: string
}) {
  const { mode, setMode } = useThemeMode()
  const { locale, locales, setLocale, t } = useI18n()
  const { enabled, setEnabled } = useAnalyticsConsent()
  const languageItems = locales.map((l) => ({ value: l.code, label: l.nativeName }))

  return (
    <SettingsGroup label={t("common.general")}>
      <SettingsRow
        label={t("onboarding.preferences.appearance.groupLabel")}
        description={t("onboarding.preferences.appearance.themeDescription")}
        control={
          <Select
            items={THEME_OPTIONS.map((opt) => ({ value: opt.id, label: t(opt.labelKey) }))}
            value={mode}
            onValueChange={(value) => {
              if (value === "system" || value === "light" || value === "dark") {
                setMode(value)
              }
            }}
          >
            <SelectTrigger
              id="theme-mode"
              aria-label={t("onboarding.preferences.appearance.groupLabel")}
              className="w-36 bg-background"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {THEME_OPTIONS.map(({ id, labelKey }) => (
                  <SelectItem key={id} value={id}>
                    {t(labelKey)}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        }
      />
      <SettingsRow
        label={t("language.switcher.settingsRow")}
        description={t("onboarding.preferences.language.rowDescription")}
        control={
          <Select
            items={languageItems}
            value={locale}
            onValueChange={(value) => {
              if (value != null) setLocale(value)
            }}
          >
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
        label={t("onboarding.privacy.shareUsageData")}
        description={
          <>
            {t("onboarding.preferences.privacy.rowDescription")}
            {!enabled ? (
              <span className="mt-1 block text-amber-600 dark:text-amber-400">
                {t("onboarding.privacy.disabledWarning")}
              </span>
            ) : null}
          </>
        }
        control={
          <Switch
            id="analytics-consent"
            checked={enabled}
            onCheckedChange={setEnabled}
            aria-label={t("onboarding.privacy.shareUsageData")}
          />
        }
      />
      <NavRow
        to="/preferences/workspace"
        icon={PanelLeft}
        title={t("onboarding.preferences.workspace.groupLabel")}
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
  const { t } = useI18n()
  const [form, setForm] = useState<TranslatorProfile>(() => getTranslatorProfile())

  function update(key: keyof TranslatorProfile, value: string) {
    const next = { ...form, [key]: value }
    setForm(next)
    setTranslatorProfile(next)
  }

  return (
    <SettingsGroup label={t("onboarding.preferences.profileSection.groupLabel")}>
      {PROFILE_TEXT_FIELDS.map(({ key, labelKey, placeholderKey }) => (
        <SettingsRow
          key={key}
          label={<label htmlFor={`profile-${key}`}>{t(labelKey)}</label>}
          control={
            <Input
              id={`profile-${key}`}
              value={form[key] ?? ""}
              onChange={(e) => update(key, e.target.value)}
              placeholder={t(placeholderKey)}
              className="w-56 bg-background"
            />
          }
        />
      ))}
      <SettingsRow
        label={
          <label htmlFor="profile-otherInfo">{t("onboarding.preferences.profile.otherInfoLabel")}</label>
        }
        description={t("settings.preferences.profile.otherInfoDescription")}
        block
      >
        <Textarea
          id="profile-otherInfo"
          value={form.otherInfo ?? ""}
          onChange={(e) => update("otherInfo", e.target.value)}
          placeholder={t("onboarding.preferences.profile.otherInfoPlaceholder")}
          rows={3}
          className="bg-background"
        />
      </SettingsRow>
    </SettingsGroup>
  )
}

/** One preference section: its route slug, index-row presentation, and body.
 * title/description are MessageKeys, resolved with t() at each render site
 * (PreferencesIndex's NavRow, PreferencesDetail's PageHeader/OrgBreadcrumb) —
 * this table stays module scope, so no t() call here. */
interface PreferenceSection {
  slug: string
  titleKey: MessageKey
  descriptionKey: MessageKey
  group: string
  icon: React.ComponentType<{ className?: string }>
  render: () => React.ReactNode
}

/** Former nested slugs now inlined on the index — keep redirecting for bookmarks. */
const INLINE_PREFERENCE_SLUGS = new Set(["appearance", "language", "privacy"])

const PREFERENCE_SECTIONS: PreferenceSection[] = [
  {
    slug: "workspace",
    // Title text is identical to onboarding.preferences.workspace.groupLabel
    // (the in-page SettingsGroup heading) — reused rather than re-minted.
    titleKey: "onboarding.preferences.workspace.groupLabel",
    descriptionKey: "onboarding.preferences.section.workspace.description",
    group: "General",
    icon: PanelLeft,
    render: () => <WorkspaceSection />,
  },
  {
    slug: "profile",
    titleKey: "onboarding.preferences.section.profile.title",
    descriptionKey: "onboarding.preferences.section.profile.description",
    group: "AI & personalization",
    icon: UserRound,
    render: () => <TranslatorProfileSection />,
  },
  {
    slug: "provider-keys",
    titleKey: "onboarding.preferences.section.providerKeys.title",
    descriptionKey: "onboarding.preferences.section.providerKeys.description",
    group: "AI & personalization",
    icon: KeyRound,
    render: () => <PersonalProviderSection />,
  },
  {
    slug: "local-models",
    titleKey: "onboarding.preferences.section.localModels.title",
    descriptionKey: "onboarding.preferences.section.localModels.description",
    group: "AI & personalization",
    icon: Cpu,
    render: () => <LocalModelsSection />,
  },
  {
    slug: "usage",
    titleKey: "onboarding.preferences.section.usage.title",
    descriptionKey: "onboarding.preferences.section.usage.description",
    group: "Account",
    icon: Gauge,
    render: () => <UsageSection />,
  },
  {
    slug: "api-tokens",
    titleKey: "onboarding.preferences.section.apiTokens.title",
    descriptionKey: "onboarding.preferences.section.apiTokens.description",
    group: "Account",
    icon: KeyRound,
    render: () => <ApiTokensSection />,
  },
]

/** Nested nav groups after the inline General card. */
const PREFERENCE_GROUPS = ["AI & personalization", "Account"] as const

/** The index: inline General card + grouped navigation rows for nested sections. */
function PreferencesIndex() {
  const { t } = useI18n()
  const { position } = useDockRailPosition()

  const profile = getTranslatorProfile()
  const profileFilled = PROFILE_KEYS.filter((k) => (profile[k] ?? "").trim().length > 0).length

  const workspaceRailOption = RAIL_OPTIONS.find((o) => o.id === position)
  const hints: Record<string, string> = {
    workspace: workspaceRailOption ? t(workspaceRailOption.labelKey) : "",
    profile:
      profileFilled > 0
        ? t("onboarding.preferences.hint.profileSet", { filled: profileFilled, total: PROFILE_KEYS.length })
        : t("onboarding.preferences.hint.notSet"),
    "provider-keys": t("onboarding.preferences.hint.personal"),
    "local-models": t("onboarding.preferences.hint.onDevice"),
    usage: t("onboarding.timeWindow.thisWeek"),
  }

  const content = (
    <Page>
      <PageHeader
        title={t("nav.account.preferences")}
        description={t("onboarding.preferences.pageDescription")}
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
                title={t(s.titleKey)}
                hint={hints[s.slug]}
              />
            ))}
          </NavList>
        ))}
      </div>
    </Page>
  )

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
function PreferencesDetail({ slug }: { slug: string }) {
  const { t } = useI18n()
  if (INLINE_PREFERENCE_SLUGS.has(slug)) return <Navigate to="/preferences" replace />
  const section = PREFERENCE_SECTIONS.find((s) => s.slug === slug)
  if (!section) return <Navigate to="/preferences" replace />
  return (
    <AppShell
      sidebar={<OrgSidebar />}
      header={<OrgBreadcrumb parent={{ label: "Preferences", to: "/preferences" }} section={t(section.titleKey)} />}
      statusBar={null}
      main={
        <Page>
          <div className="flex flex-col gap-12">
            <PageHeader title={t(section.titleKey)} description={t(section.descriptionKey)} className="mb-0" />
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
