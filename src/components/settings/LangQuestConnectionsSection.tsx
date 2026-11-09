// Preferences → Connected organizations: the LangQuest organizations this
// account holds a token for (AQU-2105 follow-up). Each row says whether the
// token still works ("Check now" asks LangQuest and records the answer),
// offers Reconnect when it does not, and can forget the connection. New
// connections are made from the New-project wizard, so "Connect an
// organization" here opens LangQuest Connect and the same token form.

import { useCallback, useEffect, useState } from "react"
import { ExternalLink } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Field, FieldError, FieldLabel } from "@/components/ui/field"
import { RevealableInput } from "@/components/ui/revealable-input"
import { Spinner } from "@/components/ui/spinner"
import { SettingsGroup, SettingsRow } from "@/components/ui/page"
import { ConfirmActionDialog } from "@/components/ConfirmActionDialog"
import { LangQuestHealthBadge } from "@/components/langquest/LangQuestHealthBadge"
import { LangQuestLogo } from "@/components/langquest/LangQuestLogo"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { useI18n } from "@/lib/i18n/I18nProvider"
import { formatDate, formatDateTime } from "@/lib/i18n/format"
import {
  checkLangQuestConnection,
  connectLangQuest,
  disconnectLangQuest,
  fetchLangQuestConnections,
  LangQuestLinkError,
} from "@/lib/langquest/api"
import type { LangQuestConnection } from "@/lib/langquest/types"
import { connectUrlFor } from "@/lib/langquest/wizard"

const TOKEN_RE = /^lqp_[A-Za-z0-9_-]{16,}$/

export function LangQuestConnectionsSection() {
  const { t, locale } = useI18n()
  const { session } = useFrontierSession()
  const jwt = session?.jwt ?? null
  const [connections, setConnections] = useState<LangQuestConnection[] | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<LangQuestConnection | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [token, setToken] = useState("")
  const [formError, setFormError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    if (!jwt) return
    try {
      setConnections(await fetchLangQuestConnections(jwt))
      setLoadFailed(false)
    } catch {
      setLoadFailed(true)
    }
  }, [jwt])

  useEffect(() => {
    let cancelled = false
    if (!jwt) return
    fetchLangQuestConnections(jwt)
      .then((list) => {
        if (!cancelled) setConnections(list)
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [jwt])

  if (!jwt) return null

  const replace = (next: LangQuestConnection) =>
    setConnections((prev) => (prev ?? []).map((c) => (c.id === next.id ? next : c)))

  const check = async (c: LangQuestConnection) => {
    setBusy(c.id)
    try {
      replace((await checkLangQuestConnection(jwt, c.id)).connection)
    } catch {
      // The probe's verdict is already recorded server-side; reread it.
      await reload()
    } finally {
      setBusy(null)
    }
  }

  const disconnect = async (c: LangQuestConnection) => {
    setBusy(c.id)
    try {
      await disconnectLangQuest(jwt, c.id, { revoke: true })
      setConnections((prev) => (prev ?? []).filter((x) => x.id !== c.id))
    } finally {
      setBusy(null)
      setConfirm(null)
    }
  }

  const connect = async () => {
    const trimmed = token.trim()
    if (!TOKEN_RE.test(trimmed)) {
      setFormError(t("langquest.error.notToken"))
      return
    }
    setBusy("connect")
    setFormError(null)
    try {
      const { connection } = await connectLangQuest(jwt, trimmed)
      setConnections((prev) => {
        const list = prev ?? []
        return list.some((c) => c.id === connection.id) ? list.map((c) => (c.id === connection.id ? connection : c)) : [...list, connection]
      })
      setToken("")
      setShowForm(false)
    } catch (err) {
      setFormError(
        err instanceof LangQuestLinkError && (err.needsReauth || err.status === 401)
          ? t("langquest.error.tokenRejected")
          : t("langquest.error.unreachable"),
      )
    } finally {
      setBusy(null)
    }
  }

  const connectUrl = connectUrlFor(connections ?? [])

  return (
    <SettingsGroup label={t("langquest.settings.groupLabel")}>
      {connections == null && !loadFailed && (
        <SettingsRow label={<Spinner />} />
      )}
      {loadFailed && <SettingsRow label={t("langquest.settings.loadFailed")} />}
      {connections?.length === 0 && <SettingsRow label={t("langquest.settings.none")} />}
      {connections?.map((c) => (
        <SettingsRow
          key={c.id}
          label={
            <span className="flex items-center gap-2">
              <LangQuestLogo className="size-4" />
              <span data-testid="langquest-connection-org">{c.org.name}</span>
              <LangQuestHealthBadge health={c.health} />
            </span>
          }
          description={
            <span className="flex flex-wrap gap-x-3">
              {c.connectedAt && <span>{t("langquest.settings.connectedOn", { date: formatDate(new Date(c.connectedAt), locale, {}) })}</span>}
              {c.lastCheckedAt && <span>{t("langquest.settings.lastChecked", { when: formatDateTime(new Date(c.lastCheckedAt), locale, {}) })}</span>}
              <span>{t("langquest.wizard.linkedProjects", { count: c.linkedProjects })}</span>
              {c.token.scopes.length > 0 && <span>{t("langquest.settings.scopes", { scopes: c.token.scopes.join(", ") })}</span>}
              {c.lastError && c.health !== "ok" && <span className="text-destructive">{c.lastError}</span>}
            </span>
          }
          control={
            <span className="flex items-center gap-2">
              {c.health === "ok" || c.health === "unreachable" ? (
                <Button type="button" variant="outline" size="sm" onClick={() => void check(c)} disabled={busy !== null}>
                  {busy === c.id ? t("langquest.settings.checking") : t("langquest.settings.check")}
                </Button>
              ) : (
                <Button type="button" size="sm" onClick={() => setShowForm(true)} disabled={busy !== null} data-testid="langquest-reconnect">
                  {t("langquest.wizard.reconnect")}
                </Button>
              )}
              <Button type="button" variant="ghost" size="sm" onClick={() => setConfirm(c)} disabled={busy !== null}>
                {t("langquest.settings.disconnect")}
              </Button>
            </span>
          }
        />
      ))}
      <SettingsRow
        label={showForm ? t("langquest.wizard.connectTitle") : t("langquest.settings.connectNew")}
        description={showForm ? t("langquest.wizard.connectIntro") : t("langquest.create.tokenHelp")}
        control={
          !showForm && (
            <Button type="button" variant="outline" size="sm" onClick={() => setShowForm(true)} data-testid="langquest-settings-connect">
              {t("langquest.wizard.connect")}
            </Button>
          )
        }
      >
        {showForm ? (
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault()
              void connect()
            }}
            data-testid="langquest-settings-token-form"
          >
            <Button
              type="button"
              variant="outline"
              className="w-fit"
              render={<a href={connectUrl} target="_blank" rel="noreferrer" />}
            >
              <LangQuestLogo className="size-4" />
              {t("langquest.create.openConnect")}
              <ExternalLink className="size-3.5" aria-hidden />
            </Button>
            <Field data-invalid={!!formError}>
              <FieldLabel htmlFor="langquest-settings-token">{t("langquest.create.tokenLabel")}</FieldLabel>
              <RevealableInput
                id="langquest-settings-token"
                autoComplete="off"
                spellCheck={false}
                // i18n-exempt: LangQuest token prefix, not copy
                placeholder="lqp_…"
                value={token}
                onChange={(e) => {
                  setToken(e.target.value)
                  setFormError(null)
                }}
                disabled={busy === "connect"}
              />
              {formError && <FieldError>{formError}</FieldError>}
            </Field>
            <div className="flex gap-2">
              <Button type="submit" size="sm" disabled={!token.trim() || busy !== null}>
                {busy === "connect" ? <Spinner data-icon="inline-start" /> : null}
                {busy === "connect" ? t("langquest.wizard.connecting") : t("langquest.wizard.connect")}
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setShowForm(false)} disabled={busy === "connect"}>
                {t("common.cancel")}
              </Button>
            </div>
          </form>
        ) : undefined}
      </SettingsRow>
      <ConfirmActionDialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open) setConfirm(null)
        }}
        title={t("langquest.settings.disconnectConfirmTitle", { org: confirm?.org.name ?? "" })}
        description={t("langquest.settings.disconnectConfirmBody")}
        confirmLabel={t("langquest.settings.disconnect")}
        variant="destructive"
        onConfirm={() => {
          if (confirm) void disconnect(confirm)
        }}
      />
    </SettingsGroup>
  )
}
