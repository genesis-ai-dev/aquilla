// AQU-2265: the temporary note left in a setting's old place, pointing to its
// new home. One line: <SettingMovedNote to="/preferences" target="pref-x"
// where={[t("nav.account.preferences"), t("common.general")]} />.
// Every note stops showing after SETTING_MOVED_NOTES_UNTIL; there is no
// dismissal (Sam, Oct 29). See src/lib/settings/setting-moved.ts to remove them.

import { ArrowRight } from "lucide-react"
import { Link } from "react-router-dom"
import { useT } from "@/lib/i18n/I18nProvider"
import { settingMovedNotesShowing } from "@/lib/settings/setting-moved"
import { settingHighlightHref } from "@/lib/settings/setting-highlight"

interface SettingMovedNoteProps {
  /** The route of the setting's new home. */
  to: string
  /** The id of the setting's element there; it is scrolled to and highlighted. */
  target: string
  /** The new home as the reader would find it, already translated, e.g. ["Preferences", "General"]. */
  where: string[]
  /**
   * For a page that guards leaving (unsaved changes): called instead of
   * following the link, with the full address to go to.
   */
  onNavigate?: (href: string) => void
}

export function SettingMovedNote({ to, target, where, onNavigate }: SettingMovedNoteProps) {
  const t = useT()
  if (!settingMovedNotesShowing()) return null
  const href = settingHighlightHref(to, target)
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 px-4 py-3 text-sm text-muted-foreground" data-testid="setting-moved-note">
      <span>{t("settings.moved.note", { where: where.join(" → ") })}</span>
      <Link
        to={href}
        onClick={onNavigate ? (event) => { event.preventDefault(); onNavigate(href) } : undefined}
        className="inline-flex items-center gap-1 font-medium text-foreground underline-offset-4 hover:underline"
      >
        {t("settings.moved.goThere")}
        <ArrowRight className="size-3.5" aria-hidden />
      </Link>
    </p>
  )
}
