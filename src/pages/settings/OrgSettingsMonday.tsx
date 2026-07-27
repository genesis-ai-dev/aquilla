// Org settings → Monday.com — manage the org's single Monday connection.
//
// Contract: monday-integration-contract.md. One connection per org (OAuth
// token held server-side; never returned to the browser). Maintainer+ (600)
// on the org to connect/disconnect; any member can view status. The OAuth
// round-trip returns to this page with `?monday=connected` or
// `?monday=error&reason=...`, surfaced as an inline dismissible notice (this
// app has no global toast system).

import { useCallback, useEffect, useRef, useState } from "react"
import { useSearchParams } from "react-router-dom"
import { Check, CheckCircle2, Copy, ExternalLink, XCircle } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
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
import { ROLE } from "@/lib/frontier/roles"
import {
  deleteMondayConnection,
  fetchMondayConnection,
  startMondayConnect,
  type MondayConnectionStatus,
} from "@/lib/monday/api"
import { ORG_SETTINGS_SECTION_DESCRIPTIONS, ORG_SETTINGS_SECTION_TITLES } from "./constants"
import { OrgSettingsDetailPage } from "./OrgSettingsDetailPage"

export function OrgSettingsMonday() {
  const { activeOrg, activeOrgId } = useActiveOrg()
  const { session } = useFrontierSession()
  const jwt = session?.jwt ?? null
  const canManage = (activeOrg?.role?.level ?? 0) >= ROLE.MAINTAINER

  const [connection, setConnection] = useState<MondayConnectionStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [adminStepOpen, setAdminStepOpen] = useState(false)
  const [installLinkCopied, setInstallLinkCopied] = useState(false)
  const aliveRef = useRef(true)
  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  // OAuth return notice — read once, then strip the params so a reload
  // doesn't re-announce.
  const [searchParams, setSearchParams] = useSearchParams()
  const [returnNotice, setReturnNotice] = useState<{ kind: "connected" | "error"; reason?: string } | null>(null)
  useEffect(() => {
    const monday = searchParams.get("monday")
    if (monday !== "connected" && monday !== "error") return
    setReturnNotice(
      monday === "connected"
        ? { kind: "connected" }
        : { kind: "error", reason: searchParams.get("reason") ?? undefined },
    )
    const next = new URLSearchParams(searchParams)
    next.delete("monday")
    next.delete("reason")
    setSearchParams(next, { replace: true })
  }, [searchParams, setSearchParams])

  const load = useCallback(async () => {
    if (!jwt || activeOrgId == null) return
    setLoading(true)
    setError(null)
    try {
      const got = await fetchMondayConnection(jwt, activeOrgId)
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

  // The OAuth consent opens in a NEW tab: if Monday rejects the user (e.g.
  // they're not a workspace admin), cancelling there leaves them in Monday —
  // this page must stay put so they're never stranded. We refetch on focus so
  // the card flips to Connected when the other tab completes the round-trip.
  const [awaitingOAuth, setAwaitingOAuth] = useState(false)
  useEffect(() => {
    if (!awaitingOAuth) return
    const onFocus = () => void load()
    window.addEventListener("focus", onFocus)
    return () => window.removeEventListener("focus", onFocus)
  }, [awaitingOAuth, load])

  const handleConnect = useCallback(async () => {
    if (!jwt || activeOrgId == null) return
    setBusy(true)
    setError(null)
    // Open the tab SYNCHRONOUSLY inside the click's call stack — after the
    // awaited fetch below, window.open is no longer gesture-scoped and popup
    // blockers eat it. We navigate the placeholder once the URL arrives.
    // (No "noopener": we need the handle to set location; Monday is trusted.)
    const popup = window.open("about:blank", "_blank")
    try {
      const { url } = await startMondayConnect(jwt, activeOrgId, "/settings/monday")
      if (popup && !popup.closed) {
        popup.location.href = url
      } else {
        // Popup still blocked (or closed) — same-tab navigation as fallback.
        window.location.assign(url)
        return
      }
      setAdminStepOpen(false)
      setAwaitingOAuth(true)
    } catch (e) {
      popup?.close()
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [jwt, activeOrgId])

  const handleDisconnect = useCallback(async () => {
    if (!jwt || activeOrgId == null) return
    setBusy(true)
    setError(null)
    try {
      await deleteMondayConnection(jwt, activeOrgId)
      if (!aliveRef.current) return
      setConfirmOpen(false)
      setConnection({ connected: false })
    } catch (e) {
      if (aliveRef.current) setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (aliveRef.current) setBusy(false)
    }
  }, [jwt, activeOrgId])

  const connected = connection?.connected === true

  return (
    <OrgSettingsDetailPage
      title={ORG_SETTINGS_SECTION_TITLES.monday}
      description={ORG_SETTINGS_SECTION_DESCRIPTIONS.monday}
    >
      {returnNotice?.kind === "connected" && (
        <div
          role="status"
          className="flex items-start justify-between gap-3 rounded border border-green-300 bg-green-50 px-4 py-3 text-sm text-green-900 dark:border-green-700 dark:bg-green-950 dark:text-green-100"
        >
          <span className="flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 shrink-0" /> Monday.com connected.
          </span>
          <button
            type="button"
            aria-label="Dismiss notice"
            onClick={() => setReturnNotice(null)}
            className="shrink-0 text-green-700 hover:text-green-900 dark:text-green-400 dark:hover:text-green-200"
          >
            ✕
          </button>
        </div>
      )}
      {returnNotice?.kind === "error" && (
        <div
          role="alert"
          className="flex items-start justify-between gap-3 rounded border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive"
        >
          <span className="flex items-center gap-2">
            <XCircle className="h-4 w-4 shrink-0" />
            Connecting to Monday.com failed{returnNotice.reason ? ` (${returnNotice.reason})` : ""}. Try again.
          </span>
          <button
            type="button"
            aria-label="Dismiss notice"
            onClick={() => setReturnNotice(null)}
            className="shrink-0 hover:opacity-70"
          >
            ✕
          </button>
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            Connection
            {!loading && (
              <Badge variant={connected ? "default" : "secondary"}>
                {connected ? "Connected" : "Not connected"}
              </Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner /> Loading connection status…
            </div>
          ) : connected ? (
            <>
              {connection?.needsReauth && (
                <div
                  role="status"
                  className="flex items-center justify-between gap-3 rounded border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100"
                >
                  <span>
                    The Monday.com authorization has expired (Monday limits it to 6 months).
                    Reconnect to resume syncing — board links and mappings are kept.
                  </span>
                  {canManage && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="shrink-0"
                      onClick={() => setAdminStepOpen(true)}
                      disabled={busy}
                    >
                      Reconnect
                    </Button>
                  )}
                </div>
              )}
              <div className="space-y-1 text-sm">
                {connection?.account?.slug && (
                  <p>
                    Account: <span className="font-medium">{connection.account.slug}</span>
                  </p>
                )}
                {connection?.account?.userName && (
                  <p className="text-muted-foreground">
                    Connected as {connection.account.userName}
                  </p>
                )}
                {connection?.createdAt && (
                  <p className="text-xs text-muted-foreground">
                    Connected{" "}
                    {new Date(connection.createdAt).toLocaleDateString(undefined, {
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                    })}
                  </p>
                )}
              </div>
              {canManage ? (
                <Button variant="destructive" onClick={() => setConfirmOpen(true)} disabled={busy}>
                  Disconnect
                </Button>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Only org maintainers and owners can manage this connection.
                </p>
              )}
            </>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                Connect a Monday.com account to let projects in this organization link boards and
                push translation progress automatically.
              </p>
              {canManage ? (
                <Button onClick={() => setAdminStepOpen(true)} disabled={busy}>
                  <ExternalLink data-icon="inline-start" />
                  Connect Monday.com
                </Button>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Ask an org maintainer or owner to connect Monday.com.
                </p>
              )}
              {awaitingOAuth && (
                <p className="text-xs text-muted-foreground">
                  Waiting for the Monday.com tab… this page updates automatically once the
                  connection completes.
                </p>
              )}
            </>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
        </CardContent>
      </Card>

      {/* Two-step connect: the install needs a Monday WORKSPACE admin, and a
          non-admin who hits Monday's consent screen gets a dead-end "not
          authorized". Fork explicitly before sending anyone to Monday. */}
      <Dialog open={adminStepOpen} onOpenChange={setAdminStepOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Connect to Monday.com</DialogTitle>
            <DialogDescription>
              Installing the Aquilla app requires admin permissions in your Monday.com workspace.
              Are you an admin there?
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <button
              type="button"
              onClick={() => void handleConnect()}
              disabled={busy}
              className="w-full rounded-lg border p-4 text-left transition-colors hover:border-primary hover:bg-accent disabled:opacity-50"
            >
              <span className="flex items-center gap-2 font-medium">
                {busy ? <Spinner className="size-4" /> : <ExternalLink className="size-4" />}
                Yes, I'm a Monday admin
              </span>
              <span className="mt-1 block text-sm text-muted-foreground">
                Continue to Monday.com in a new tab to install and authorize Aquilla.
              </span>
            </button>
            <div className="w-full rounded-lg border p-4">
              <span className="flex items-center gap-2 font-medium">
                <Copy className="size-4" />
                No — my admin needs to install it
              </span>
              <span className="mt-1 block text-sm text-muted-foreground">
                Copy the install link and send it to your Monday admin. Once they've installed the
                Aquilla app, come back here and connect.
              </span>
              <div className="mt-3 flex items-center gap-3">
                {connection?.installUrl && (
                  <a href={connection.installUrl} target="_blank" rel="noreferrer">
                    {/* Monday's official install badge (their brand asset CDN). */}
                    <img
                      alt="Add to monday.com"
                      height={32}
                      className="h-8"
                      src="https://dapulse-res.cloudinary.com/image/upload/f_auto,q_auto/remote_mondaycom_static/uploads/Tal/4b5d9548-0598-436e-a5b6-9bc5f29ee1d9_Group12441.png"
                    />
                  </a>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  className="shrink-0"
                  disabled={!connection?.installUrl}
                  onClick={() => {
                    void navigator.clipboard.writeText(connection?.installUrl ?? "")
                    setInstallLinkCopied(true)
                    window.setTimeout(() => setInstallLinkCopied(false), 2000)
                  }}
                >
                  {installLinkCopied ? (
                    <Check data-icon="inline-start" />
                  ) : (
                    <Copy data-icon="inline-start" />
                  )}
                  {installLinkCopied ? "Copied" : "Copy install link"}
                </Button>
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Disconnect Monday.com?</DialogTitle>
            <DialogDescription>
              This removes the connection for the whole organization. Every project's board link
              and sync configuration will be deleted. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDisconnect} disabled={busy}>
              {busy && <Spinner data-icon="inline-start" />}
              Disconnect
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </OrgSettingsDetailPage>
  )
}
