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
import { useI18n, useT } from "@/lib/i18n/I18nProvider"
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
/** MessageKey, without importing from the generated catalog — see LeftDock.tsx. */
type PrefMessageKey = Parameters<ReturnType<typeof useT>>[0]

const RAIL_OPTIONS: { id: DockRailPosition; labelKey: PrefMessageKey }[] = [
  { id: "left", labelKey: "onboarding.preferences.rail.left" },
  { id: "top", labelKey: "onboarding.preferences.rail.top" },
]

const THEME_OPTIONS: { id: ThemeMode; labelKey: PrefMessageKey }[] = [
  { id: "system", labelKey: "onboarding.preferences.theme.system" },
  { id: "light", labelKey: "onboarding.preferences.theme.light" },
  { id: "dark", labelKey: "onboarding.preferences.theme.dark" },
]

/** Single-line fields rendered as text inputs, in render order. */
const PROFILE_TEXT_FIELDS: {
  key: Exclude<keyof TranslatorProfile, "otherInfo">
  labelKey: PrefMessageKey
  placeholderKey: PrefMessageKey
}[] = [
  {
    key: "responseLanguage",
    labelKey: "onboarding.preferences.profile.responseLanguage.label",
    placeholderKey: "onboarding.preferences.profile.responseLanguage.placeholder",
  },
  { key: "age", labelKey: "onboarding.preferences.profile.age.label", placeholderKey: "onboarding.preferences.profile.age.placeholder" },
  { key: "gender", labelKey: "onboarding.preferences.profile.gender.label", placeholderKey: "onboarding.preferences.profile.gender.placeholder" },
  {
    key: "educationLevel",
    labelKey: "onboarding.preferences.profile.educationLevel.label",
    placeholderKey: "onboarding.preferences.profile.educationLevel.placeholder",
  },
  {
    key: "religiousBackground",
    labelKey: "onboarding.preferences.profile.religiousBackground.label",
    placeholderKey: "onboarding.preferences.profile.religiousBackground.placeholder",
  },
  {
    key: "translationExperience",
    labelKey: "onboarding.preferences.profile.translationExperience.label",
    placeholderKey: "onboarding.preferences.profile.translationExperience.placeholder",
  },
  {
    key: "geographicalSetting",
    labelKey: "onboarding.preferences.profile.geographicalSetting.label",
    placeholderKey: "onboarding.preferences.profile.geographicalSetting.placeholder",
  },
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
  const t = useT()
  const { position: railPosition, setPosition: setRailPosition } = useDockRailPosition()
  // AQU-591: the store tracks whether to SKIP the confirm; present it positively.
  const skipReplaceConfirm = useSkipReplaceConfirm()
  return (
    <SettingsGroup label={t("onboarding.preferences.workspace.groupLabel")}>
      <SettingsRow
        label={t("onboarding.preferences.workspace.railLabel")}
        description={t("onboarding.preferences.workspace.railDescription")}
        block
      >
        <Tabs
          value={railPosition}
          onValueChange={(value) => setRailPosition(value as DockRailPosition)}
          className="gap-0"
        >
          <TabsList aria-label={t("onboarding.preferences.workspace.railLabel")}>
            {RAIL_OPTIONS.map(({ id, labelKey }) => (
              <TabsTrigger key={id} value={id}>
                {t(labelKey)}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </SettingsRow>
      <SettingsRow
        label={
          <label htmlFor="confirm-replace">{t("onboarding.preferences.workspace.confirmReplaceLabel")}</label>
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
 * Appearance settings stay device-scoped and deliberately separate from the
 * source/target text direction and other project-specific display settings.
 */
function AppearanceSection() {
  const t = useT()
  const { mode, setMode } = useThemeMode()

  return (
    <SettingsGroup label={t("onboarding.preferences.appearance.groupLabel")}>
      <SettingsRow
        label={t("onboarding.preferences.appearance.groupLabel")}
        description={t("onboarding.preferences.appearance.themeDescription")}
        block
      >
        <Tabs
          value={mode}
          onValueChange={(value) => setMode(value as ThemeMode)}
          className="gap-0"
        >
          <TabsList aria-label={t("onboarding.preferences.appearance.groupLabel")}>
            {THEME_OPTIONS.map(({ id, labelKey }) => (
              <TabsTrigger key={id} value={id}>
                {t(labelKey)}
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
    <SettingsGroup label={t("language.label")}>
      <SettingsRow
        label={t("language.switcher.settingsRow")}
        description={t("onboarding.preferences.language.rowDescription")}
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
  const t = useT()
  const { enabled, setEnabled } = useAnalyticsConsent()
  return (
    <SettingsGroup label={t("onboarding.preferences.privacy.groupLabel")}>
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
    </SettingsGroup>
  )
}

/**
 * Translator profile editor. Local form state so editing (incl. trailing
 * spaces) is smooth; every change is persisted via setTranslatorProfile, which
 * sanitizes for storage and notifies the chat/agent hooks.
 */
function TranslatorProfileSection() {
  const t = useT()
  const [form, setForm] = useState<TranslatorProfile>(() => getTranslatorProfile())

  function update(key: keyof TranslatorProfile, value: string) {
    const next = { ...form, [key]: value }
    setForm(next)
    setTranslatorProfile(next)
  }

  return (
    <SettingsGroup label={t("onboarding.preferences.profileSection.groupLabel")}>
      <SettingsRow
        label={t("onboarding.preferences.profileSection.rowLabel")}
        description={t("onboarding.preferences.profileSection.rowDescription")}
        block
      >
        <FieldGroup className="grid gap-4 sm:grid-cols-2">
          {PROFILE_TEXT_FIELDS.map(({ key, labelKey, placeholderKey }) => (
            <Field key={key}>
              <FieldLabel htmlFor={`profile-${key}`} className="text-sm font-medium">
                {t(labelKey)}
              </FieldLabel>
              <Input
                id={`profile-${key}`}
                value={form[key] ?? ""}
                onChange={(e) => update(key, e.target.value)}
                placeholder={t(placeholderKey)}
              />
            </Field>
          ))}
        </FieldGroup>
        <Field className="mt-4">
          <FieldLabel htmlFor="profile-otherInfo" className="text-sm font-medium">
            {t("onboarding.preferences.profile.otherInfoLabel")}
          </FieldLabel>
          <Textarea
            id="profile-otherInfo"
            value={form.otherInfo ?? ""}
            onChange={(e) => update("otherInfo", e.target.value)}
            placeholder={t("onboarding.preferences.profile.otherInfoPlaceholder")}
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
  titleKey: PrefMessageKey
  descriptionKey: PrefMessageKey
  group: (typeof PREFERENCE_GROUPS)[number]
  icon: React.ComponentType<{ className?: string }>
  render: () => React.ReactNode
}

const PREFERENCE_GROUPS = [
  "onboarding.preferences.group.general",
  "onboarding.preferences.group.aiPersonalization",
  "onboarding.preferences.group.account",
] as const satisfies readonly PrefMessageKey[]

const PREFERENCE_SECTIONS: PreferenceSection[] = [
  {
    slug: "workspace",
    titleKey: "onboarding.preferences.workspace.groupLabel",
    descriptionKey: "onboarding.preferences.section.workspace.description",
    group: "onboarding.preferences.group.general",
    icon: PanelLeft,
    render: () => <WorkspaceSection />,
  },
  {
    slug: "appearance",
    titleKey: "onboarding.preferences.section.appearance.title",
    descriptionKey: "onboarding.preferences.section.appearance.description",
    group: "onboarding.preferences.group.general",
    icon: Palette,
    render: () => <AppearanceSection />,
  },
  {
    slug: "language",
    titleKey: "language.label",
    descriptionKey: "onboarding.preferences.section.language.description",
    group: "onboarding.preferences.group.general",
    icon: Globe,
    render: () => <LanguageSection />,
  },
  {
    slug: "privacy",
    titleKey: "onboarding.preferences.section.privacy.title",
    descriptionKey: "onboarding.preferences.section.privacy.description",
    group: "onboarding.preferences.group.general",
    icon: ShieldCheck,
    render: () => <PrivacySection />,
  },
  {
    slug: "profile",
    titleKey: "onboarding.preferences.section.profile.title",
    descriptionKey: "onboarding.preferences.section.profile.description",
    group: "onboarding.preferences.group.aiPersonalization",
    icon: UserRound,
    render: () => <TranslatorProfileSection />,
  },
  {
    slug: "provider-keys",
    titleKey: "onboarding.preferences.section.providerKeys.title",
    descriptionKey: "onboarding.preferences.section.providerKeys.description",
    group: "onboarding.preferences.group.aiPersonalization",
    icon: KeyRound,
    render: () => <PersonalProviderSection />,
  },
  {
    slug: "local-models",
    titleKey: "onboarding.preferences.section.localModels.title",
    descriptionKey: "onboarding.preferences.section.localModels.description",
    group: "onboarding.preferences.group.aiPersonalization",
    icon: Cpu,
    render: () => <LocalModelsSection />,
  },
  {
    slug: "usage",
    titleKey: "onboarding.preferences.section.usage.title",
    descriptionKey: "onboarding.preferences.section.usage.description",
    group: "onboarding.preferences.group.account",
    icon: Gauge,
    render: () => <UsageSection />,
  },
  {
    slug: "api-tokens",
    titleKey: "onboarding.preferences.section.apiTokens.title",
    descriptionKey: "onboarding.preferences.section.apiTokens.description",
    group: "onboarding.preferences.group.account",
    icon: KeyRound,
    render: () => <ApiTokensSection />,
  },
]

/** The index: grouped navigation rows, each hinting its current value. */
function PreferencesIndex({ modal = false, backgroundLocation }: { modal?: boolean; backgroundLocation?: Location }) {
  const t = useT()
  const { enabled } = useAnalyticsConsent()
  const { position } = useDockRailPosition()
  const { mode } = useThemeMode()

  const profile = getTranslatorProfile()
  const profileFilled = PROFILE_KEYS.filter((k) => (profile[k] ?? "").trim().length > 0).length

  const railHintKey = RAIL_OPTIONS.find((o) => o.id === position)?.labelKey
  const themeHintKey =
    mode === "system"
      ? "onboarding.preferences.theme.system"
      : mode === "dark"
        ? "onboarding.preferences.theme.dark"
        : "onboarding.preferences.theme.light"

  const hints: Record<string, string> = {
    workspace: railHintKey ? t(railHintKey) : "",
    appearance: t(themeHintKey),
    privacy: t(enabled ? "onboarding.preferences.hint.sharingOn" : "onboarding.preferences.hint.sharingOff"),
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
      <div className="space-y-6">
        {PREFERENCE_GROUPS.map((group) => (
          <NavList key={group} label={t(group)}>
            {PREFERENCE_SECTIONS.filter((s) => s.group === group).map((s) => (
              <NavRow
                key={s.slug}
                to={`/preferences/${s.slug}`}
                state={backgroundLocation ? { backgroundLocation, preferencesModalDepth: 2 } : undefined}
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
function PreferencesDetail({ slug, modal = false }: { slug: string; modal?: boolean }) {
  const t = useT()
  const navigate = useNavigate()
  const section = PREFERENCE_SECTIONS.find((s) => s.slug === slug)
  if (!section) return <Navigate to="/preferences" replace />
  const title = t(section.titleKey)
  const content = (
    <Page>
      <div className="space-y-6">
        <BackLink
          to="/preferences"
          onClick={modal ? () => navigate(-1) : undefined}
          label={t("nav.account.preferences")}
        />
        <PageHeader title={title} description={t(section.descriptionKey)} />
        {section.render()}
      </div>
    </Page>
  )
  if (modal) return content
  return (
    <AppShell
      sidebar={<OrgSidebar />}
      header={<OrgBreadcrumb parent={{ label: t("nav.account.preferences"), to: "/preferences" }} section={title} />}
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
  const t = useT()
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
          <DialogTitle>{t("nav.account.preferences")}</DialogTitle>
          <DialogDescription>{t("onboarding.preferences.dialogDescription")}</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {section
            ? <PreferencesDetail slug={section} modal />
            : <PreferencesIndex modal backgroundLocation={backgroundLocation} />}
        </div>
      </DialogContent>
    </Dialog>
  )
}
