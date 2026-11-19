// AQU-2549 — "Join into my existing file", from the Source link card.
//
// The lead picks a copy the link brought in and the file of his own it joins
// into (the same-named one to start with). The dialog shows the comparison
// the link dialog shows (`ReplaceMatchNote`: how many lines match, and the
// half-the-lines refusal), refuses a copy that has translations of its own in
// one sentence, and on Join the project's file takes the source and the copy
// goes to Recently deleted. Server halves: auth-worker
// source-linking-join-copy.test.ts, sync-worker link-sync-join-copy.test.ts.

import { useEffect, useMemo, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { ReplaceMatchNote, type ReplaceMatchState } from "@/components/UpstreamFileChoiceList"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { fetchLinkFileMatches } from "@/lib/sync/link-file-match"
import { fetchLinkedFileCopies, joinLinkedCopy, type LinkedFileCopies } from "@/lib/sync/link-join-copy"
import { markAdoptedFilesForIdmlAlignment } from "@/lib/idml/link-adopted-align"
import { toUserFacingError } from "@/lib/errors/user-error"
import { useT } from "@/lib/i18n/I18nProvider"

export interface JoinLinkedCopyDialogProps {
  projectId: string
  sourceProjectId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called once a join is recorded, so the host can refresh the file list. */
  onJoined: () => void
}

export function JoinLinkedCopyDialog({
  projectId,
  sourceProjectId,
  open,
  onOpenChange,
  onJoined,
}: JoinLinkedCopyDialogProps) {
  const t = useT()
  const { session } = useFrontierSession()
  const jwt = session?.jwt
  const [list, setList] = useState<LinkedFileCopies | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [copyId, setCopyId] = useState<string | null>(null)
  const [targetId, setTargetId] = useState<string | null>(null)
  const [match, setMatch] = useState<ReplaceMatchState | undefined>(undefined)
  const [joining, setJoining] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const ask = useRef(0)

  useEffect(() => {
    if (!open || !jwt) return
    let live = true
    setList(null)
    setLoadFailed(false)
    setError(null)
    setNote(null)
    fetchLinkedFileCopies(jwt, projectId)
      .then((answer) => {
        if (!live) return
        setList(answer)
        // Start on a copy that has a file of the same name here: the usual case.
        const first = answer.copies.find((c) => c.suggestedFileId) ?? answer.copies[0]
        setCopyId(first?.fileId ?? null)
        setTargetId(first?.suggestedFileId ?? null)
      })
      .catch(() => live && setLoadFailed(true))
    return () => {
      live = false
    }
  }, [open, jwt, projectId])

  const copy = useMemo(() => list?.copies.find((c) => c.fileId === copyId) ?? null, [list, copyId])

  // The comparison for the pair now picked, as the link dialog shows it.
  useEffect(() => {
    const mine = ++ask.current
    setMatch(undefined)
    if (!jwt || !copy || copy.translated || !targetId) return
    setMatch({ status: "loading" })
    void Promise.resolve(
      fetchLinkFileMatches(jwt, projectId, sourceProjectId, [{ upstreamFileId: copy.upstreamFileId, fileId: targetId }]),
    )
      .then(([answer]) => mine === ask.current && setMatch(answer ? { status: "ready", match: answer } : { status: "failed" }))
      .catch(() => mine === ask.current && setMatch({ status: "failed" }))
  }, [jwt, projectId, sourceProjectId, copy, targetId])

  const canJoin = !!copy && !copy.translated && !!targetId && match?.status === "ready" && match.match.canReplace

  async function handleJoin() {
    if (!jwt || !copy || !targetId || !canJoin || joining) return
    setJoining(true)
    setError(null)
    try {
      const result = await joinLinkedCopy(jwt, projectId, copy.fileId, targetId)
      markAdoptedFilesForIdmlAlignment(projectId, [targetId])
      onJoined()
      if (result.complete) {
        onOpenChange(false)
      } else {
        setNote(t("projectSettings.sourceLink.joinIncomplete"))
      }
    } catch (err) {
      setError(toUserFacingError(err, "project").message)
    } finally {
      setJoining(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("projectSettings.sourceLink.joinTitle")}</DialogTitle>
          <DialogDescription>{t("projectSettings.sourceLink.joinDescription")}</DialogDescription>
        </DialogHeader>
        {loadFailed ? (
          <p className="text-sm text-destructive" role="alert">
            {t("projectSettings.sourceLink.joinLoadFailed")}
          </p>
        ) : !list ? (
          <p className="text-sm text-muted-foreground">{t("projectSettings.sourceLink.joinLoading")}</p>
        ) : list.copies.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("projectSettings.sourceLink.joinNoCopies")}</p>
        ) : (
          <div className="space-y-3 text-sm">
            <Select
              items={list.copies.map((c) => ({ value: c.fileId, label: c.name }))}
              value={copyId}
              onValueChange={(value) => {
                if (typeof value !== "string") return
                setCopyId(value)
                setTargetId(list.copies.find((c) => c.fileId === value)?.suggestedFileId ?? null)
              }}
              disabled={joining}
            >
              <SelectTrigger className="w-full" aria-label={t("projectSettings.sourceLink.joinCopyLabel")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {list.copies.map((c) => (
                  <SelectItem key={c.fileId} value={c.fileId}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {copy?.translated ? (
              <p className="text-xs text-destructive" role="alert">
                {t("projectSettings.sourceLink.joinCopyTranslated", { name: copy.name })}
              </p>
            ) : (
              <>
                <Select
                  items={list.ownFiles.map((f) => ({ value: f.id, label: f.name }))}
                  value={targetId}
                  onValueChange={(value) => typeof value === "string" && setTargetId(value)}
                  disabled={joining}
                >
                  <SelectTrigger className="w-full" aria-label={t("projectSettings.sourceLink.joinTargetLabel")}>
                    <SelectValue placeholder={t("projectSettings.linkSource.replaceTargetPlaceholder")} />
                  </SelectTrigger>
                  <SelectContent>
                    {list.ownFiles.map((f) => (
                      <SelectItem key={f.id} value={f.id}>
                        {f.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {targetId && <ReplaceMatchNote state={match} join />}
              </>
            )}
          </div>
        )}
        {note && (
          <p className="text-sm text-muted-foreground" role="status">
            {note}
          </p>
        )}
        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={joining}>
            {t("common.cancel")}
          </Button>
          <Button onClick={() => void handleJoin()} disabled={!canJoin || joining}>
            {joining ? t("projectSettings.sourceLink.joinJoining") : t("projectSettings.sourceLink.joinConfirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
