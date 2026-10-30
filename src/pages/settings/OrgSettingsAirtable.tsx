// Org settings → Airtable — the org's single Airtable connection (AQU-804).
//
// Monday's page (OrgSettingsMonday) without the OAuth trip: an org maintainer
// pastes a personal access token, the server checks it with Airtable and
// keeps it encrypted (it never comes back to the browser). Any member sees
// the status. Below it, as on Monday, every project with its table link or a
// "Set up" button.

import { useCallback, useEffect, useRef, useState } from "react"
import { AlertTriangle, CheckCircle2, ExternalLink } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button, buttonVariants } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Spinner } from "@/components/ui/spinner"
import { useActiveOrg } from "@/context/OrgContext"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { useI18n } from "@/lib/i18n/I18nProvider"
import { fmtShortCalendarDate } from "@/lib/format-date"
import { DateTooltip } from "@/components/ui/date-tooltip"
import { ROLE } from "@/lib/frontier/roles"
import {
  deleteAirtableConnection,
  fetchAirtableConnection,
  type AirtableConnectionStatus,
} from "@/lib/airtable/api"
import { AirtableTokenForm } from "@/components/ProjectSettings/AirtableTokenForm"
import { ORG_SETTINGS_SECTION_DESCRIPTIONS, ORG_SETTINGS_SECTION_TITLES } from "./constants"
import { OrgSettingsDetailPage } from "./OrgSettingsDetailPage"
import { OrgAirtableProjectLinks } from "./OrgAirtableProjectLinks"

export function OrgSettingsAirtable() {
  const { locale, t } = useI18n()
  const { activeOrg, activeOrgId, accessibleProjects, accessibleProjectsLoading, accessibleProjectsError, refreshAccessibleProjects } = useActiveOrg()
  const { session } = useFrontierSession()
  const jwt = session?.jwt ?? null
  const canManage = (activeOrg?.role?.level ?? 0) >= ROLE.MAINTAINER

  const [connection, setConnection] = useState<AirtableConnectionStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  /** "Replace token" opened the token field on a connected org. */
  const [replacing, setReplacing] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const aliveRef = useRef(true)
  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  const load = useCallback(async () => {
    if (!jwt || activeOrgId == null) return
    setLoading(true)
    setError(null)
    try {
      const got = await fetchAirtableConnection(jwt, activeOrgId)
      if (aliveRef.current) setConnection(got)
    } catch (e) {
      if (aliveRef.current) setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (aliveRef.current) setLoading(false)
    }
  }, [jwt, activeOrgId])

  useEffect(() => {
    void load()
  }, [load])

  const handleConnected = useCallback(
    (status: AirtableConnectionStatus) => {
      setConnection(status)
      setReplacing(false)
      setNotice(t("settings.airtable.connectedNotice", { count: status.baseCount ?? 0 }))
    },
    [t],
  )

  const handleDisconnect = useCallback(async () => {
    if (!jwt || activeOrgId == null) return
    setBusy(true)
    setError(null)
    try {
      await deleteAirtableConnection(jwt, activeOrgId)
      if (!aliveRef.current) return
      setConfirmOpen(false)
      setNotice(null)
      setConnection({ connected: false })
    } catch (e) {
      if (aliveRef.current) setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (aliveRef.current) setBusy(false)
    }
  }, [jwt, activeOrgId])

  const connected = connection?.connected === true
  const connectedBy = connection?.account?.email ?? connection?.account?.userId ?? null
  const connectedAt = connection?.createdAt
  const connectedDate = connectedAt ? fmtShortCalendarDate(connectedAt, undefined, locale) : ""
  const connectedRow = connectedAt ? (
    <DateTooltip value={connectedAt} label={t("common.date.created")}>
      {connectedBy
        ? t("settings.monday.connectedAsOnRow", { username: connectedBy, date: connectedDate })
        : t("settings.monday.connectedOnRow", { date: connectedDate })}
    </DateTooltip>
  ) : connectedBy ? (
    t("settings.monday.connectedAsRow", { username: connectedBy })
  ) : null
  const orgProjects = accessibleProjects.filter((project) => project.orgId === activeOrgId)

  return (
    <OrgSettingsDetailPage
      title={ORG_SETTINGS_SECTION_TITLES.airtable}
      page="airtable"
      description={ORG_SETTINGS_SECTION_DESCRIPTIONS.airtable}
    >
      {notice && (
        <div
          role="status"
          className="flex items-start justify-between gap-3 rounded border border-green-300 bg-green-50 px-4 py-3 text-sm text-green-900 dark:border-green-700 dark:bg-green-950 dark:text-green-100"
        >
          <span className="flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 shrink-0" /> {notice}
          </span>
          <button
            type="button"
            aria-label={t("settings.monday.dismissNoticeAriaLabel")}
            onClick={() => setNotice(null)}
            className="shrink-0 text-green-700 hover:text-green-900 dark:text-green-400 dark:hover:text-green-200"
          >
            ✕
          </button>
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            {t("settings.monday.connectionCardTitle")}
            {!loading && (
              <Badge variant={connected ? "default" : "secondary"}>
                {connected ? t("settings.airtable.connectedBadge") : t("settings.airtable.notConnectedBadge")}
              </Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4" data-testid="airtable-connection-card">
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner /> {t("settings.monday.loadingStatus")}
            </div>
          ) : connected ? (
            <>
              {(connection?.needsReauth || connection?.usable === false) && (
                <div
                  role="status"
                  className="flex items-start gap-2 rounded border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100"
                >
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>
                    {connection?.usable === false
                      ? t("settings.airtable.otherDeploymentNotice")
                      : t("settings.airtable.tokenRejectedNotice")}
                  </span>
                </div>
              )}
              <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
                <div className="min-w-0 space-y-0.5 text-sm">
                  {connectedRow && <p className="text-muted-foreground">{connectedRow}</p>}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <a
                    href="https://airtable.com"
                    target="_blank"
                    rel="noopener noreferrer"
                    className={buttonVariants({ variant: "outline" })}
                  >
                    <ExternalLink data-icon="inline-start" />
                    {t("settings.airtable.openAirtableButton")}
                  </a>
                  {canManage && (
                    <Button variant="outline" onClick={() => setReplacing((v) => !v)} disabled={busy}>
                      {t("settings.airtable.replaceTokenButton")}
                    </Button>
                  )}
                  {canManage && (
                    <Button variant="destructive" onClick={() => setConfirmOpen(true)} disabled={busy}>
                      {t("settings.monday.disconnectButton")}
                    </Button>
                  )}
                </div>
              </div>
              {canManage && (replacing || connection?.needsReauth || connection?.usable === false) && (
                <AirtableTokenForm
                  jwt={jwt}
                  orgId={activeOrgId}
                  onConnected={handleConnected}
                  submitLabel={t("settings.airtable.saveTokenButton")}
                />
              )}
              {/* AQU-2260: who can manage it is said once, at the page's top. */}
            </>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">{t("settings.airtable.connectPrompt")}</p>
              {canManage ? (
                <AirtableTokenForm jwt={jwt} orgId={activeOrgId} onConnected={handleConnected} />
              ) : (
                <p className="text-xs text-muted-foreground">{t("settings.airtable.connectRestrictedNotice")}</p>
              )}
            </>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
        </CardContent>
      </Card>

      {connected && (
        <Card>
          <CardHeader>
            <CardTitle>{t("projectSettings.monday.orgNextLinkProjectsTitle")}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">{t("projectSettings.airtable.orgNextLinkProjectsDescription")}</p>
            {accessibleProjectsLoading ? (
              <p role="status">{t("projectSettings.monday.orgProjectsLoading")}</p>
            ) : accessibleProjectsError ? (
              <div role="alert">
                <p>{accessibleProjectsError}</p>
                <Button variant="outline" onClick={() => void refreshAccessibleProjects()}>
                  {t("projectSettings.monday.orgProjectsRetry")}
                </Button>
              </div>
            ) : orgProjects.length === 0 ? (
              <p>{t("projectSettings.monday.orgNoAccessibleProjects")}</p>
            ) : activeOrgId != null ? (
              <OrgAirtableProjectLinks orgId={activeOrgId} jwt={jwt} canManageOrg={canManage} projects={orgProjects} />
            ) : null}
          </CardContent>
        </Card>
      )}

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("settings.airtable.disconnectConfirmTitle")}</DialogTitle>
            <DialogDescription>{t("settings.airtable.disconnectConfirmBody")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmOpen(false)} disabled={busy}>
              {t("common.cancel")}
            </Button>
            <Button variant="destructive" onClick={handleDisconnect} disabled={busy}>
              {busy && <Spinner data-icon="inline-start" />}
              {t("settings.monday.disconnectButton")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </OrgSettingsDetailPage>
  )
}
