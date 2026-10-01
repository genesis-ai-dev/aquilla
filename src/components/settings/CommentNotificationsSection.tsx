// Comment-email preference for the Preferences page (AQU-1193).
//
// One dropdown over one account-scoped setting: how much comment email this
// user gets. Server-persisted (users.preferences.commentEmails) rather than
// device-scoped like the rest of Preferences — a Worker reads it when it
// decides whether to send, so localStorage would be invisible to it.
//
// Follows UsageSection's fetch-render-in-Section pattern: read the jwt from
// useFrontierSession, load on mount, render nothing when signed out.

import { useEffect, useState } from "react"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { SettingsGroup, SettingsRow } from "@/components/ui/page"
import { useT } from "@/lib/i18n/I18nProvider"
import type { MessageKey } from "@/lib/i18n/messages/en"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import {
  COMMENT_EMAIL_PREFERENCES,
  DEFAULT_COMMENT_EMAIL_PREFERENCE,
  fetchCommentEmailPreference,
  saveCommentEmailPreference,
  type CommentEmailPreference,
} from "@/lib/notifications/comment-email-pref"

/** Render order of the dropdown: loudest → quietest, with the default in the middle. */
const OPTION_LABEL_KEYS: Record<CommentEmailPreference, MessageKey> = {
  all: "settings.notifications.option.all",
  mentions: "settings.notifications.option.mentions",
  off: "settings.notifications.option.off",
}

export function CommentNotificationsSection() {
  const t = useT()
  const { session } = useFrontierSession()
  const jwt = session?.jwt ?? null

  const [value, setValue] = useState<CommentEmailPreference>(DEFAULT_COMMENT_EMAIL_PREFERENCE)
  const [loading, setLoading] = useState(true)
  const [loadFailed, setLoadFailed] = useState(false)
  const [saveFailed, setSaveFailed] = useState(false)

  useEffect(() => {
    if (!jwt) return
    // Race guard: a jwt swap (account switch) must not let a stale response
    // overwrite the newer account's setting.
    let cancelled = false
    setLoading(true)
    setLoadFailed(false)
    fetchCommentEmailPreference(jwt)
      .then((pref) => {
        if (cancelled) return
        setValue(pref)
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [jwt])

  if (!jwt) return null

  const onChange = (next: CommentEmailPreference | null) => {
    if (next === null || !COMMENT_EMAIL_PREFERENCES.includes(next)) return
    const chosen = next
    const previous = value
    // Optimistic: the control is the only reader of this state, so a failed
    // save just puts the old value back rather than stranding a lie on screen.
    setValue(chosen)
    setSaveFailed(false)
    saveCommentEmailPreference(jwt, chosen)
      .then((confirmed) => setValue(confirmed))
      .catch(() => {
        setValue(previous)
        setSaveFailed(true)
      })
  }

  return (
    <SettingsGroup label={t("settings.notifications.groupLabel")}>
      <SettingsRow
        label={t("settings.notifications.commentEmailLabel")}
        description={
          loadFailed
            ? t("settings.notifications.loadFailed")
            : saveFailed
              ? t("settings.notifications.saveFailed")
              : t("settings.notifications.commentEmailDescription")
        }
        control={
          loading ? (
            <Spinner />
          ) : (
            <Select
              items={COMMENT_EMAIL_PREFERENCES.map((id) => ({
                value: id,
                label: t(OPTION_LABEL_KEYS[id]),
              }))}
              value={value}
              onValueChange={onChange}
            >
              <SelectTrigger
                id="comment-email-preference"
                aria-label={t("settings.notifications.commentEmailLabel")}
                className="w-64 bg-background"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {COMMENT_EMAIL_PREFERENCES.map((id) => (
                    <SelectItem key={id} value={id}>
                      {t(OPTION_LABEL_KEYS[id])}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          )
        }
      />
    </SettingsGroup>
  )
}
