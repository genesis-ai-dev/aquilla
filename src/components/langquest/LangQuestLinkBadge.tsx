// The workspace-header badge on a project linked to LangQuest (AQU-2105), and
// the panel it opens: sync state and "Sync now", a new token when LangQuest
// stops accepting the old one, publishing approved versions to a channel
// (with the token's `release` scope), and unlink. Renders nothing for a
// project with no link. Mounting it is what keeps the project following
// LangQuest — the sync lives in useLangQuestLink.

import { useState } from "react"
import { AlertTriangle, RefreshCw } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Popover, PopoverContent, PopoverDescription, PopoverHeader, PopoverTitle, PopoverTrigger } from "@/components/ui/popover"
import { RevealableInput } from "@/components/ui/revealable-input"
import { Separator } from "@/components/ui/separator"
import { Spinner } from "@/components/ui/spinner"
import { ConfirmActionDialog } from "@/components/ConfirmActionDialog"
import { LangQuestLogo } from "@/components/langquest/LangQuestLogo"
import { useLangQuestLink } from "@/hooks/useLangQuestLink"
import { useI18n } from "@/lib/i18n/I18nProvider"
import { formatDate } from "@/lib/i18n/format"
import { ROLE } from "@/lib/sync/role-policy"
import { LangQuestLinkError, linkLangQuest, publishLangQuestReleases, unlinkLangQuest } from "@/lib/langquest/api"
import posthog from "@/lib/posthog"

export function LangQuestLinkBadge({
  projectId,
  roleLevel,
  onSynced,
}: {
  projectId: string
  roleLevel: number | null
  /** After a sync that changed the project, so the host can re-read its files. */
  onSynced?: () => void
}) {
  const { t, locale } = useI18n()
  const { link, sync, canSync, runSync, reload, jwt } = useLangQuestLink(projectId, roleLevel, onSynced)
  const canManage = (roleLevel ?? 0) >= ROLE.MAINTAINER
  const [newToken, setNewToken] = useState("")
  const [channel, setChannel] = useState("")
  const [channelUrl, setChannelUrl] = useState("")
  const [action, setAction] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [confirmUnlink, setConfirmUnlink] = useState(false)
  if (!link) return null

  const when = (iso: string) => formatDate(new Date(iso), locale, { dateStyle: "medium", timeStyle: "short" })
  const running = sync.kind === "running"
  const canRelease = canManage && link.scopes.includes("release")

  const saveToken = async () => {
    if (!jwt) return
    setAction("token")
    setMessage(null)
    try {
      await linkLangQuest(jwt, projectId, newToken.trim(), link.language.id)
      setNewToken("")
      await reload()
    } catch (err) {
      setMessage(err instanceof LangQuestLinkError && err.status === 401 ? t("langquest.error.tokenRejected") : t("langquest.error.unreachable"))
    } finally {
      setAction(null)
    }
  }

  const publish = async (live: boolean) => {
    if (!jwt || !channel.trim()) return
    setAction(live ? "live" : "down")
    setMessage(null)
    try {
      const r = await publishLangQuestReleases(jwt, projectId, {
        channel: channel.trim(),
        live,
        ...(channelUrl.trim() ? { url: channelUrl.trim() } : {}),
      })
      setMessage(t("langquest.panel.published", { released: r.released, unchanged: r.unchanged, failed: r.failed.length }))
      posthog.capture("langquest releases published", { project_id: projectId, live, released: r.released, failed: r.failed.length })
    } catch (err) {
      setMessage(t("langquest.panel.syncFailed", { reason: err instanceof Error ? err.message : String(err) }))
    } finally {
      setAction(null)
    }
  }

  const unlink = async () => {
    if (!jwt) return
    setAction("unlink")
    try {
      await unlinkLangQuest(jwt, projectId, { revoke: true })
      posthog.capture("langquest unlinked", { project_id: projectId })
      await reload()
    } finally {
      setAction(null)
    }
  }

  return (
    <>
      <Popover>
        <PopoverTrigger
          render={
            <Badge
              variant="outline"
              data-testid="langquest-badge"
              render={<button type="button" aria-label={t("langquest.badge.ariaLabel")} />}
            />
          }
        >
          {running ? <Spinner className="size-3.5" /> : <LangQuestLogo className="size-3.5" />}
          {t("langquest.badge.label", { language: link.language.name })}
          {(link.needsReauth || sync.kind === "failed") && <AlertTriangle className="size-3.5 text-destructive" aria-hidden />}
        </PopoverTrigger>
        <PopoverContent align="end" side="bottom" sideOffset={6} className="w-80 space-y-3 p-3 text-sm">
          <PopoverHeader className="flex flex-row items-center gap-2">
            <LangQuestLogo className="size-6" />
            <div className="min-w-0">
              <PopoverTitle>{t("langquest.panel.title")}</PopoverTitle>
              <PopoverDescription>
                {t("langquest.panel.orgLanguage", { language: link.language.name, org: link.org.name })}
              </PopoverDescription>
            </div>
          </PopoverHeader>

          {link.needsReauth ? (
            <div className="space-y-2" data-testid="langquest-needs-token">
              <p className="text-destructive">{t("langquest.panel.needsToken")}</p>
              {canManage && (
                <div className="flex gap-2">
                  <RevealableInput
                    aria-label={t("langquest.create.tokenLabel")}
                    // i18n-exempt: LangQuest token prefix, not copy
                  placeholder="lqp_…"
                    value={newToken}
                    onChange={(e) => setNewToken(e.target.value)}
                  />
                  <Button type="button" size="sm" onClick={() => void saveToken()} disabled={!newToken.trim() || action !== null}>
                    {t("langquest.panel.saveToken")}
                  </Button>
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-2">
              <p className="text-muted-foreground" data-testid="langquest-sync-status">
                {sync.kind === "running"
                  ? t("langquest.panel.syncing", {
                      passages: sync.progress?.passagesRead ?? 0,
                      takes: sync.progress?.takesAttached ?? 0,
                    })
                  : sync.kind === "done"
                    ? t("langquest.panel.synced", { cells: sync.result.cellsCreated, takes: sync.result.takesAttached })
                    : sync.kind === "failed"
                      ? t("langquest.panel.syncFailed", { reason: sync.message })
                      : link.lastSyncError
                        ? t("langquest.panel.lastError", { reason: link.lastSyncError })
                        : link.lastSyncedAt
                          ? t("langquest.panel.lastSynced", { when: when(link.lastSyncedAt) })
                          : t("langquest.panel.neverSynced")}
              </p>
              {canSync ? (
                <Button type="button" size="sm" variant="outline" onClick={() => void runSync("manual")} disabled={running}>
                  <RefreshCw data-icon="inline-start" className={running ? "animate-spin" : undefined} aria-hidden />
                  {t("langquest.panel.syncNow")}
                </Button>
              ) : (
                <p className="text-xs text-muted-foreground">{t("langquest.panel.leadOnly")}</p>
              )}
            </div>
          )}

          {canManage && (
            <>
              <Separator />
              <div className="space-y-2" data-testid="langquest-publish">
                <p className="font-medium">{t("langquest.panel.publishTitle")}</p>
                {canRelease ? (
                  <>
                    <div className="space-y-1">
                      <Label htmlFor="langquest-channel">{t("langquest.panel.channelLabel")}</Label>
                      <Input
                        id="langquest-channel"
                        placeholder={t("langquest.panel.channelPlaceholder")}
                        value={channel}
                        onChange={(e) => setChannel(e.target.value)}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="langquest-channel-url">{t("langquest.panel.urlLabel")}</Label>
                      <Input
                        id="langquest-channel-url"
                        type="url"
                        placeholder="https://"
                        value={channelUrl}
                        onChange={(e) => setChannelUrl(e.target.value)}
                      />
                    </div>
                    <div className="flex gap-2">
                      <Button type="button" size="sm" onClick={() => void publish(true)} disabled={!channel.trim() || action !== null}>
                        {action === "live" && <Spinner data-icon="inline-start" />}
                        {t("langquest.panel.goLive")}
                      </Button>
                      <Button type="button" size="sm" variant="outline" onClick={() => void publish(false)} disabled={!channel.trim() || action !== null}>
                        {action === "down" && <Spinner data-icon="inline-start" />}
                        {t("langquest.panel.takeDown")}
                      </Button>
                    </div>
                  </>
                ) : (
                  <p className="text-xs text-muted-foreground">{t("langquest.panel.noRelease")}</p>
                )}
              </div>
              <Separator />
              <Button type="button" size="sm" variant="ghost" className="text-destructive" onClick={() => setConfirmUnlink(true)}>
                {t("langquest.panel.unlink")}
              </Button>
            </>
          )}
          {message && <p className="text-xs" role="status">{message}</p>}
        </PopoverContent>
      </Popover>
      <ConfirmActionDialog
        open={confirmUnlink}
        onOpenChange={setConfirmUnlink}
        title={t("langquest.panel.unlink")}
        description={t("langquest.panel.unlinkConfirm")}
        confirmLabel={t("langquest.panel.unlink")}
        variant="destructive"
        onConfirm={() => void unlink()}
      />
    </>
  )
}
