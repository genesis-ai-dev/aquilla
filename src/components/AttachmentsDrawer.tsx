// AQU-777: the right-hand Attachments panel — every attachment in the open
// file, grouped by the cell it belongs to, scrolled to the one that was
// clicked.
//
// It lives in the same aside slot as the comments/history drawers and follows
// their shape: a RightSidebarPanel with its own persisted width, a header with
// a close button, and a scrolling body. Like them it is mutually exclusive with
// the other drawers — the workspace enforces that by nulling their state when
// this one opens (see ProjectWorkspace's handleOpen* block).
//
// The preview `<img src>` is a per-attachment `?t=<sync-token>` URL, resolved
// asynchronously because minting the token is async. That resolution is why
// this file has an effect at all: the URLs cannot be derived synchronously from
// the records, and building them per render would re-mint on every keystroke
// elsewhere in the workspace.

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ExternalLink, FileText, Trash2, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { RightSidebarPanel } from "@/components/RightSidebarPanel"
import { AppTooltip } from "@/components/ui/tooltip"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"
import { getCellAttachmentUrl, isPreviewableAttachment } from "@/lib/attachments/upload"
import { audioSyncTokenFetcherForSession } from "@/lib/audio/sync-token-fetcher"
import type { FrontierSession } from "@/lib/frontier/types"
import type { CellAttachmentRecord } from "@/lib/sync/cell-attachments-read-types"
import { useT } from "@/lib/i18n/I18nProvider"

interface Props {
  projectId: string
  fileId: string
  session: FrontierSession | null
  attachments: readonly CellAttachmentRecord[]
  isLoading: boolean
  isError: boolean
  truncated: boolean
  /** The attachment the user clicked; the panel scrolls to and highlights it. */
  focusAttachmentId: string | null
  /** Null when the viewer may not remove attachments (below contributor). */
  onRemove: ((attachment: CellAttachmentRecord) => Promise<void> | void) | null
  onClose: () => void
}

interface CellGroup {
  cellId: string
  cellRef: string | null
  rows: CellAttachmentRecord[]
}

/**
 * Group the flat list by cell, preserving the order the read route returned.
 *
 * Cells with no attachments never appear here, which is the point: the list is
 * built FROM the attachments, so an empty group is not something to filter out
 * later — it cannot be constructed in the first place.
 */
function groupByCell(rows: readonly CellAttachmentRecord[]): CellGroup[] {
  const groups: CellGroup[] = []
  let current: CellGroup | null = null
  for (const row of rows) {
    if (!current || current.cellId !== row.cellId) {
      current = { cellId: row.cellId, cellRef: row.cellRef, rows: [] }
      groups.push(current)
    }
    // A group's label comes from whichever of its rows first carries one: the
    // LEFT JOIN behind cellRef can leave it null on some rows of a cell.
    if (!current.cellRef && row.cellRef) current.cellRef = row.cellRef
    current.rows.push(row)
  }
  return groups
}

export function AttachmentsDrawer({
  projectId,
  fileId,
  session,
  attachments,
  isLoading,
  isError,
  truncated,
  focusAttachmentId,
  onRemove,
  onClose,
}: Props) {
  const t = useT()
  const groups = useMemo(() => groupByCell(attachments), [attachments])
  const [urls, setUrls] = useState<ReadonlyMap<string, string>>(new Map())
  const [removingId, setRemovingId] = useState<string | null>(null)
  const [removeError, setRemoveError] = useState<string | null>(null)
  const focusRef = useRef<HTMLDivElement | null>(null)

  // Resolve one authenticated URL per previewable attachment. Keyed by
  // objectName so an attachment already resolved is never re-minted when the
  // list changes around it.
  const objectNames = useMemo(
    () =>
      attachments
        .filter((a) => isPreviewableAttachment(a.mimeType))
        .map((a) => a.objectName)
        .join("\u0000"),
    [attachments],
  )
  useEffect(() => {
    if (!session?.jwt) {
      setUrls(new Map())
      return
    }
    let cancelled = false
    const names = objectNames ? objectNames.split("\u0000") : []
    const getSyncToken = audioSyncTokenFetcherForSession(session)
    void (async () => {
      const next = new Map<string, string>()
      for (const objectName of names) {
        const url = await getCellAttachmentUrl({
          projectId,
          fileId,
          objectName,
          getSyncToken,
        })
        if (cancelled) return
        if (url) next.set(objectName, url)
      }
      if (!cancelled) setUrls(next)
    })()
    return () => {
      cancelled = true
    }
  }, [projectId, fileId, session, objectNames])

  // Scroll the clicked attachment into view once it has rendered. Keyed on the
  // id (not on mount) so clicking a second link while the panel is already
  // open re-scrolls instead of doing nothing.
  useEffect(() => {
    if (!focusAttachmentId) return
    focusRef.current?.scrollIntoView({ block: "center", behavior: "smooth" })
  }, [focusAttachmentId, attachments])

  const handleRemove = useCallback(
    async (attachment: CellAttachmentRecord) => {
      if (!onRemove) return
      setRemovingId(attachment.attachmentId)
      setRemoveError(null)
      try {
        await onRemove(attachment)
      } catch (e) {
        setRemoveError(e instanceof Error ? e.message : t("editor.attachments.removeFailed"))
      } finally {
        setRemovingId(null)
      }
    },
    [onRemove, t],
  )

  return (
    <RightSidebarPanel
      storageKey="attachments"
      defaultWidth={384}
      resizeLabel={t("editor.attachments.resizeLabel")}
    >
      <div
        className="bg-card relative z-10 flex h-full w-full flex-col border-s"
        data-testid="attachments-drawer"
      >
        <div className="flex items-center justify-between border-b p-2">
          <h3 className="text-sm font-semibold">{t("editor.attachments.drawerTitle")}</h3>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onClose}
            aria-label={t("editor.attachments.closeLabel")}
          >
            <X />
          </Button>
        </div>

        {truncated && (
          <p className="border-b px-3 py-2 text-[11px] text-muted-foreground">
            {t("editor.attachments.truncated", { count: attachments.length })}
          </p>
        )}
        {removeError && (
          <p role="alert" className="border-b px-3 py-2 text-[11px] text-destructive">
            {removeError}
          </p>
        )}

        <div className="flex-1 overflow-auto p-3">
          {isError ? (
            <p className="text-xs text-destructive">{t("editor.attachments.loadError")}</p>
          ) : isLoading && attachments.length === 0 ? (
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Spinner className="size-3.5" aria-hidden />
              {t("editor.attachments.loading")}
            </p>
          ) : groups.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("editor.attachments.empty")}</p>
          ) : (
            <div className="space-y-4">
              {groups.map((group) => (
                <section key={group.cellId} aria-label={group.cellRef ?? group.cellId}>
                  <h4 className="mb-1.5 text-[11px] font-semibold text-muted-foreground">
                    {group.cellRef ?? t("editor.attachments.cellGroupUnlabelled")}
                  </h4>
                  <div className="space-y-2">
                    {group.rows.map((attachment) => {
                      const focused = attachment.attachmentId === focusAttachmentId
                      const url = urls.get(attachment.objectName)
                      const previewable = isPreviewableAttachment(attachment.mimeType)
                      return (
                        <div
                          key={attachment.attachmentId}
                          ref={focused ? focusRef : undefined}
                          data-attachment-id={attachment.attachmentId}
                          data-focused={focused ? "true" : undefined}
                          className={cn(
                            "rounded-md border p-2",
                            focused && "border-primary ring-1 ring-primary/40",
                          )}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <span className="min-w-0 flex-1 truncate text-xs" title={attachment.name}>
                              {attachment.name}
                            </span>
                            {onRemove && (
                              <AppTooltip content={t("editor.attachments.remove")}>
                                <Button
                                  variant="ghost"
                                  size="icon-xs"
                                  aria-label={t("editor.attachments.remove")}
                                  disabled={removingId === attachment.attachmentId}
                                  onClick={() => void handleRemove(attachment)}
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </Button>
                              </AppTooltip>
                            )}
                          </div>
                          {previewable ? (
                            url ? (
                              <img
                                src={url}
                                alt={t("editor.attachments.previewAlt", { name: attachment.name })}
                                loading="lazy"
                                className="mt-1.5 max-h-64 w-full rounded-sm object-contain"
                              />
                            ) : (
                              <div className="mt-1.5 flex h-16 items-center justify-center rounded-sm bg-muted">
                                <Spinner className="size-4" aria-hidden />
                              </div>
                            )
                          ) : (
                            <div className="mt-1.5 flex items-center gap-1.5 rounded-sm bg-muted px-2 py-3 text-[11px] text-muted-foreground">
                              <FileText className="h-4 w-4" aria-hidden />
                              {attachment.mimeType ?? ""}
                            </div>
                          )}
                          {url && (
                            <a
                              href={url}
                              target="_blank"
                              rel="noreferrer"
                              className="mt-1.5 inline-flex items-center gap-1 text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                            >
                              <ExternalLink className="h-3 w-3" aria-hidden />
                              {t("editor.attachments.openFull")}
                            </a>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </section>
              ))}
            </div>
          )}
        </div>
      </div>
    </RightSidebarPanel>
  )
}
