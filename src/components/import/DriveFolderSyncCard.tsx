// "Keep a Drive folder in sync": link a Google Drive folder the server polls.
// A changed Word file or Google Doc lands as one file revision, so its
// translations stay on their paragraphs and open editors reload. All the work
// is server-side (sync-worker/src/drive/); this card lists, links, unlinks and
// runs a pass on demand.

import { useCallback, useEffect, useState } from "react"
import { Loader2, RefreshCw, Unlink } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useT } from "@/lib/i18n/I18nProvider"
import {
  createDriveLink,
  deleteDriveLink,
  listDriveLinks,
  syncDriveLinkNow,
  type DriveLinkList,
} from "@/lib/sync/drive-links"

export function DriveFolderSyncCard({
  projectId,
  getToken,
}: {
  projectId: string
  getToken: (fileId: string) => Promise<string | null>
}) {
  const t = useT()
  const [state, setState] = useState<DriveLinkList | null>(null)
  const [folder, setFolder] = useState("")
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      setState(await listDriveLinks(projectId, getToken))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [projectId, getToken])

  useEffect(() => {
    let live = true
    listDriveLinks(projectId, getToken)
      .then((next) => {
        if (live) setState(next)
      })
      .catch((e: unknown) => {
        if (live) setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      live = false
    }
  }, [projectId, getToken])

  const run = async (key: string, action: () => Promise<void>) => {
    setBusy(key)
    setError(null)
    setNotice(null)
    try {
      await action()
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="mt-6 space-y-3 border-t pt-4" aria-labelledby="drive-folder-sync-heading">
      <h4 id="drive-folder-sync-heading" className="text-sm font-medium">
        {t("importExport.driveFolderSync.heading")}
      </h4>
      {state && !state.serviceAccountEmail ? (
        <p className="text-sm text-muted-foreground">{t("importExport.driveFolderSync.notConfigured")}</p>
      ) : (
        <>
          {state?.serviceAccountEmail && (
            <p className="text-sm text-muted-foreground">
              {t("importExport.driveFolderSync.description", { email: state.serviceAccountEmail })}
            </p>
          )}
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              if (!folder.trim()) return
              void run("link", async () => {
                await createDriveLink(projectId, getToken, folder.trim())
                setFolder("")
              })
            }}
          >
            <Input
              value={folder}
              onChange={(event) => setFolder(event.target.value)}
              placeholder={t("importExport.driveFolderSync.folderPlaceholder")}
              aria-label={t("importExport.driveFolderSync.folderPlaceholder")}
            />
            <Button type="submit" disabled={busy !== null || !folder.trim()}>
              {busy === "link" && <Loader2 className="mr-2 size-4 animate-spin" />}
              {t("importExport.driveFolderSync.linkButton")}
            </Button>
          </form>
        </>
      )}

      {error && (
        <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}
      {notice && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}

      {state && state.links.length > 0 && (
        <ul className="space-y-2">
          {state.links.map((link) => (
            <li key={link.id} className="rounded-md border p-3 text-sm">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate font-medium">{link.folderName ?? link.folderId}</div>
                  <div className="text-muted-foreground">
                    {t("importExport.driveFolderSync.linkSummary", {
                      count: link.fileCount,
                      user: link.linkedBy,
                      when: link.lastSyncedAt ? new Date(link.lastSyncedAt).toLocaleTimeString() : "—",
                    })}
                  </div>
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy !== null}
                    onClick={() => void run(`sync:${link.id}`, async () => {
                      const pass = await syncDriveLinkNow(projectId, getToken, link.id)
                      setNotice(t("importExport.driveFolderSync.passResult", {
                        created: pass.created.length,
                        revised: pass.revised.length,
                      }))
                    })}
                  >
                    {busy === `sync:${link.id}`
                      ? <Loader2 className="mr-1 size-4 animate-spin" />
                      : <RefreshCw className="mr-1 size-4" />}
                    {t("importExport.driveFolderSync.syncNow")}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy !== null}
                    onClick={() => void run(`unlink:${link.id}`, () => deleteDriveLink(projectId, getToken, link.id))}
                  >
                    <Unlink className="mr-1 size-4" />
                    {t("importExport.driveFolderSync.unlink")}
                  </Button>
                </div>
              </div>
              {link.lastError && (
                <p className="mt-2 whitespace-pre-wrap text-xs text-destructive">{link.lastError}</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
