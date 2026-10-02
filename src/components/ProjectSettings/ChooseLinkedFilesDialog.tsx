// ChooseLinkedFilesDialog — AQU-1560 "Choose files" on the Source link card.
//
// AQU-1559 let a Project Lead pick which of the upstream's files a link follows,
// but only while making the link. A team that linked Matthew and later needed
// Mark had to detach (irreversible) and link again; a file the upstream gained
// after the link was made never arrived on a fixed-list link, and nothing in
// the project offered it. This dialog lists the upstream's files as they are
// now: the ones the link follows checked and locked, every other one —
// including files the upstream gained since — unchecked, to add.
//
// Confirming posts the newly checked UPSTREAM file ids
// (POST /api/v2/projects/:id/link-source/files). Each file arrives with its
// complete current source, not only changes from now on: the server replays its
// upstream history before the file joins the link, and answers once that has
// run. If every upstream file is linked afterwards, the link follows the whole
// project again (AQU-1559's rule) — the scope note below says which outcome a
// confirm will produce.
//
// Unchecking a linked file (stopping it) is the follow-up slice, AQU-1562, so
// linked rows are locked here.
//
// The count sentence, the scope notes and the same-name warning are the link
// flow's own (LinkSourceFlow, AQU-1526/AQU-1559) — the same file list, the same
// preview read (`loadLinkSourcePreview`), the same words, so adding a file later
// reads exactly like picking it at link time.

import { useCallback, useEffect, useMemo, useState } from "react"
import { AlertTriangle } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { addLinkedSourceFiles } from "@/lib/sync/archive"
import { loadLinkSourcePreview, type LinkSourcePreview } from "@/lib/sync/link-source-preview"
import { toUserFacingError } from "@/lib/errors/user-error"
import { useT } from "@/lib/i18n/I18nProvider"

export interface ChooseLinkedFilesDialogProps {
  projectId: string
  /** The upstream this project's live link reads from. */
  sourceProjectId: string
  /** The UPSTREAM file ids the link follows, or null/undefined for a
   *  whole-project link (which already follows every file). */
  followedFileIds: string[] | null | undefined
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called once added files are in, so the host can refresh the project
   *  record (the card's count, the file list). */
  onAdded: () => void
}

export function ChooseLinkedFilesDialog({
  projectId,
  sourceProjectId,
  followedFileIds,
  open,
  onOpenChange,
  onAdded,
}: ChooseLinkedFilesDialogProps) {
  const t = useT()
  const { session } = useFrontierSession()
  const jwt = session?.jwt

  const [preview, setPreview] = useState<LinkSourcePreview | null>(null)
  const [previewFailed, setPreviewFailed] = useState(false)
  // Bumped by "Try again" so the effect re-reads the same upstream.
  const [previewAttempt, setPreviewAttempt] = useState(0)
  // The NEWLY checked upstream file ids — linked rows are never in here.
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // The list is read fresh on every open: it has to show files the upstream
  // gained since the link was made, and anything added since the last open.
  useEffect(() => {
    if (!open || !jwt) return
    let cancelled = false
    void loadLinkSourcePreview(jwt, projectId, sourceProjectId)
      .then((result) => {
        if (!cancelled) setPreview(result)
      })
      .catch(() => {
        if (!cancelled) setPreviewFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [open, jwt, projectId, sourceProjectId, previewAttempt])

  // Closing (cancel, Esc, or after an add) forgets everything, so the next open
  // starts from the server's current answer rather than a stale pick.
  const close = useCallback(() => {
    onOpenChange(false)
    setPreview(null)
    setPreviewFailed(false)
    setPicked(new Set())
    setError(null)
  }, [onOpenChange])

  const followed = useMemo(
    () => (followedFileIds && followedFileIds.length > 0 ? new Set(followedFileIds) : null),
    [followedFileIds],
  )
  const files = useMemo(() => preview?.files ?? [], [preview])
  const isLinked = useCallback((fileId: string) => followed === null || followed.has(fileId), [followed])
  const linkedCount = files.filter((f) => isLinked(f.id)).length
  const unlinkedCount = files.length - linkedCount
  // Once every file is checked, the link follows the whole project again.
  const becomesWholeProject = picked.size > 0 && linkedCount + picked.size === files.length

  // Same rule as the link flow's warning: only files still coming can clash,
  // and a name is listed once however many rows carry it.
  const pickedClashNames = useMemo(() => {
    const names: string[] = []
    const seen = new Set<string>()
    for (const f of files) {
      if (!f.clashes || !picked.has(f.id)) continue
      const key = f.name.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      names.push(f.name)
    }
    return names
  }, [files, picked])

  const toggle = useCallback((fileId: string) => {
    setPicked((current) => {
      const next = new Set(current)
      if (next.has(fileId)) next.delete(fileId)
      else next.add(fileId)
      return next
    })
    setError(null)
  }, [])

  async function handleAdd() {
    if (!jwt || adding || picked.size === 0) return
    setAdding(true)
    setError(null)
    try {
      const result = await addLinkedSourceFiles(jwt, projectId, [...picked])
      if (!result.complete) {
        // Nothing is half-added: the files are not in the project yet, and the
        // same press resumes where the server stopped.
        setError(t("projectSettings.sourceLink.chooseFilesIncomplete"))
        return
      }
      close()
      onAdded()
    } catch (err) {
      setError(toUserFacingError(err, "project").message)
    } finally {
      setAdding(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (adding) return
        if (next) onOpenChange(true)
        else close()
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("projectSettings.sourceLink.chooseFilesTitle")}</DialogTitle>
          <DialogDescription>{t("projectSettings.sourceLink.chooseFilesDescription")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-1">
          {previewFailed ? (
            <div className="space-y-2">
              <p className="text-sm text-destructive" role="alert">
                {t("projectSettings.sourceLink.chooseFilesLoadError")}
              </p>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setPreviewFailed(false)
                  setPreviewAttempt((n) => n + 1)
                }}
              >
                {t("projectSettings.linkSource.previewRetryButton")}
              </Button>
            </div>
          ) : !preview ? (
            <p className="text-sm text-muted-foreground">{t("projectSettings.sourceLink.chooseFilesLoading")}</p>
          ) : (
            <>
              {/* The upstream's own order, scrolled rather than paged — an
                  upstream can hold 66 books or more. */}
              <ul className="max-h-64 space-y-1 overflow-y-auto rounded border px-3 py-2">
                {files.map((f) => {
                  const linked = isLinked(f.id)
                  return (
                    <li key={f.id}>
                      <label className="flex items-center gap-2 text-sm">
                        <Checkbox
                          checked={linked || picked.has(f.id)}
                          // AQU-1562 is where a linked file can be stopped;
                          // until then it is shown, not offered.
                          disabled={linked || adding}
                          onCheckedChange={() => toggle(f.id)}
                        />
                        <span className={linked ? "truncate text-muted-foreground" : "truncate"}>{f.name}</span>
                        {linked ? (
                          <Badge variant="outline" className="shrink-0">
                            {t("projectSettings.sourceLink.chooseFilesLinkedBadge")}
                          </Badge>
                        ) : (
                          f.clashes && (
                            <Badge variant="outline" className="shrink-0 text-amber-700 dark:text-amber-300">
                              {t("projectSettings.linkSource.fileClashBadge")}
                            </Badge>
                          )
                        )}
                      </label>
                    </li>
                  )
                })}
              </ul>
              {unlinkedCount === 0 ? (
                <p className="text-sm">{t("projectSettings.sourceLink.chooseFilesAllLinked")}</p>
              ) : picked.size === 0 ? (
                <p className="text-sm text-muted-foreground">{t("projectSettings.sourceLink.chooseFilesNoneChecked")}</p>
              ) : (
                <>
                  <p className="text-sm">
                    {t("projectSettings.linkSource.previewCount", { count: picked.size })}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {becomesWholeProject
                      ? t("projectSettings.linkSource.scopeAllNote")
                      : t("projectSettings.linkSource.scopeSubsetNote")}
                  </p>
                </>
              )}
              {/* A warning, never a refusal: the add button stays live. */}
              {pickedClashNames.length > 0 && (
                <div
                  role="alert"
                  className="flex items-start gap-2 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100"
                >
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <div className="space-y-1">
                    <p>{t("projectSettings.linkSource.clashWarningHeading", { count: pickedClashNames.length })}</p>
                    <ul className="list-inside list-disc font-medium">
                      {pickedClashNames.map((name) => (
                        <li key={name.toLowerCase()}>{name}</li>
                      ))}
                    </ul>
                    <p>{t("projectSettings.linkSource.clashWarningBody", { count: pickedClashNames.length })}</p>
                  </div>
                </div>
              )}
            </>
          )}
          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={close} disabled={adding}>
            {t("projectSettings.linkSource.cancelButton")}
          </Button>
          <Button onClick={() => void handleAdd()} disabled={adding || picked.size === 0 || !jwt}>
            {adding
              ? t("projectSettings.sourceLink.chooseFilesAddingButton")
              : t("projectSettings.sourceLink.chooseFilesAddButton")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
