import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { ArrowLeft, ChevronLeft, ChevronRight } from "lucide-react"
import { ContextualDraftCard } from "@/components/contextual/ContextualDraftCard"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { EmptyState } from "@/components/ui/empty"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Skeleton } from "@/components/ui/skeleton"
import { Textarea } from "@/components/ui/textarea"
import {
  attachContextualDrafts,
  hydrateContextualDrafts,
  useContextualDrafts,
  useContextualDraftsSummary,
  type ContextualDraftsScope,
} from "@/lib/contextual/drafts-store"
import type { ContextualRunRecord } from "@/lib/contextual/transport"
import { cellTextForDisplay, effectiveSourceText } from "@/lib/cell-text"
import { useT } from "@/lib/i18n/I18nProvider"
import { canPerform } from "@/lib/sync/role-policy"
import { createWsReconciler, type WsReconciler } from "@/lib/sync/ws-reconciler"
import { syncWorkerHttpOrigin } from "@/lib/sync/sync-worker-url"
import { loadSession } from "@/lib/frontier/session-store"
import { fetchSyncToken } from "@/lib/sync/sync-token"
import { focusLockKey } from "@/hooks/useFocusLock"
import { readAtVersion } from "@/hooks/useActiveCellStore"
import { getOutboxRecords } from "@/lib/sync/outbox"
import {
  acceptDraftReview,
  DraftReviewError,
  loadDraftReview,
  type DraftReviewCommit,
  type DraftReviewSnapshot,
} from "./agent-draft-review"

interface AgentDraftReviewProps {
  projectId: string
  run: ContextualRunRecord
  fileName?: string
  onBack: () => void
  onReviewed?: () => void
}

/** An isolated task surface, not an editor mode or an editor-preference write. */
export function AgentDraftReview(props: AgentDraftReviewProps) {
  return <DraftReviewSession key={`${props.projectId}:${props.run.runId}:${props.run.fileId}:${props.run.targetLang ?? ""}`} {...props} />
}

function DraftReviewSession({ projectId, run, fileName, onBack, onReviewed }: AgentDraftReviewProps) {
  const t = useT()
  const lane = run.targetLang ?? ""
  const drafts = useContextualDrafts()
  const summary = useContextualDraftsSummary()
  const scopeRef = useRef<ContextualDraftsScope | null>(null)
  const requestRef = useRef(0)
  const busyRef = useRef(false)
  const [snapshot, setSnapshot] = useState<DraftReviewSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<unknown>(null)
  const [writeError, setWriteError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const [cursor, setCursor] = useState<string | null>(null)
  const previousIds = useRef<string[]>([])
  const [edits, setEdits] = useState<Record<string, string>>({})
  const queued = useRef(new Map<string, DraftReviewCommit>())
  const [queuedVersion, setQueuedVersion] = useState(0)
  const locks = useRef(new Map<string, string>())
  const [lockVersion, setLockVersion] = useState(0)
  const socketRef = useRef<WsReconciler | null>(null)
  const reviewedRef = useRef(onReviewed)
  reviewedRef.current = onReviewed
  const rejectedRef = useRef(0)

  const refresh = useCallback(async () => {
    const scope = scopeRef.current
    if (!scope) return
    const request = ++requestRef.current
    setLoading(true)
    setLoadError(null)
    try {
      const next = await loadDraftReview(projectId, run)
      if (request !== requestRef.current || scope !== scopeRef.current) return
      if (!hydrateContextualDrafts(scope, next.drafts)) throw new DraftReviewError("stale")
      setSnapshot(next)
      setLoading(false)
    } catch (error) {
      if (request !== requestRef.current || scope !== scopeRef.current) return
      setLoadError(error)
      setLoading(false)
    }
  }, [projectId, run])

  useLayoutEffect(() => {
    scopeRef.current = attachContextualDrafts(projectId, run.fileId, lane)
    rejectedRef.current = summary.rejectedThisSession
    void refresh()
    return () => {
      scopeRef.current = null
      requestRef.current += 1
    }
    // The wrapper keys this entire session by immutable task/file/lane.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const refreshRef = useRef(refresh)
  refreshRef.current = refresh
  useEffect(() => {
    if (!snapshot?.username) return
    const username = snapshot.username
    const socket = createWsReconciler({
      projectId, userId: username, baseUrl: syncWorkerHttpOrigin(),
      getToken: async () => {
        try {
          const session = await loadSession()
          if (!session?.jwt) return null
          return (await fetchSyncToken(session.jwt, projectId, run.fileId)).token
        } catch (error) {
          setLoadError(error)
          return null
        }
      },
    }, {
      onOpen: () => {
        socket.send({ t: "presence.update", currentFileId: run.fileId })
      },
      onMessage: (message) => {
        if (message.t === "presence") {
          locks.current = new Map(message.users.flatMap((user) =>
            user.focusedCell && user.userId !== username ? [[user.focusedCell, user.userId]] : [],
          ))
          setLockVersion((version) => version + 1)
        } else if (message.t === "lock.claimed") {
          if (message.by.userId !== username) locks.current.set(message.cellId, message.by.userId)
          setLockVersion((version) => version + 1)
        } else if (message.t === "lock.released") {
          locks.current.delete(message.cellId)
          setLockVersion((version) => version + 1)
        } else if (
          (message.t === "event.applied" && message.project === projectId && message.file === run.fileId) ||
          (message.t === "contextual.activity" && message.project === projectId && message.frame.runId === run.runId)
        ) {
          if (!busyRef.current) void refreshRef.current()
        }
      },
    })
    socketRef.current = socket
    return () => { socketRef.current = null; socket.close() }
  }, [projectId, run.fileId, run.runId, snapshot?.username])

  useEffect(() => {
    const refreshOnFocus = () => { if (!busyRef.current) void refreshRef.current() }
    window.addEventListener("focus", refreshOnFocus)
    return () => window.removeEventListener("focus", refreshOnFocus)
  }, [])

  useEffect(() => {
    if (summary.rejectedThisSession > rejectedRef.current) reviewedRef.current?.()
    rejectedRef.current = summary.rejectedThisSession
  }, [summary.rejectedThisSession])

  const inScope = summary.projectId === projectId && summary.fileId === run.fileId && summary.targetLang === lane
  const pending = inScope && snapshot ? [...drafts.values()].filter((draft) =>
    draft.runId === run.runId && draft.projectId === projectId && draft.fileId === run.fileId && draft.targetLang === lane,
  ).sort((a, b) =>
    (snapshot?.documentOrder.get(a.cellId) ?? Number.MAX_SAFE_INTEGER) -
    (snapshot?.documentOrder.get(b.cellId) ?? Number.MAX_SAFE_INTEGER),
  ) : []
  const ids = pending.map((draft) => draft.cellId)
  const oldIndex = cursor ? previousIds.current.indexOf(cursor) : -1
  const selectedId = cursor && ids.includes(cursor) ? cursor
    : previousIds.current.slice(oldIndex + 1).find((id) => ids.includes(id))
      ?? previousIds.current.slice(0, Math.max(0, oldIndex)).reverse().find((id) => ids.includes(id))
      ?? ids[0]
      ?? null
  const index = pending.findIndex((draft) => draft.cellId === selectedId)
  const selected = pending[index]
  const cell = selected ? snapshot?.cells.get(selected.cellId) : undefined
  const draftKey = selected?.draftId ?? ""
  // Version state makes external mutable bookkeeping visible to React Compiler.
  const waiting = readAtVersion(queuedVersion, () => queued.current.get(draftKey))
  const locked = readAtVersion(lockVersion, () => Boolean(selected && locks.current.has(focusLockKey(selected.cellId, lane))))
  const canWrite = Boolean(snapshot && canPerform("target.cell.commit", snapshot.roleLevel))
  const ready = canWrite && Boolean(cell?.sourceEventId) && !locked && !busy && !loading && !loadError && !waiting

  useEffect(() => {
    previousIds.current = ids
    if (selectedId !== cursor) setCursor(selectedId)
  }, [ids, selectedId, cursor])

  const errorText = (error: unknown) => {
    if (error instanceof DraftReviewError) {
      switch (error.code) {
        case "stale": return t("agentDraftReview.stale")
        case "queued": return t("agentDraftReview.queued")
        case "locked": return t("agentDraftReview.locked")
        case "readOnly": return t("agentDraftReview.readOnly")
        case "unavailable": return t("agentDraftReview.unavailable")
        case "rejected": return t("agentDraftReview.rejected")
      }
    }
    return error instanceof Error ? error.message : String(error)
  }

  const accept = async (text: string): Promise<boolean> => {
    if (!selected || !cell || busyRef.current || !canWrite) return false
    const scope = scopeRef.current
    busyRef.current = true
    setBusy(true)
    setWriteError(null)
    try {
      await acceptDraftReview({
        projectId, run, draft: { ...selected, runId: run.runId }, cell, text,
        queued: queued.current.get(selected.draftId),
        onQueued: (commit) => {
          queued.current.set(selected.draftId, commit)
          setQueuedVersion((version) => version + 1)
        },
        checkLock: () => locks.current.has(focusLockKey(selected.cellId, lane)),
        isCurrent: () => scope !== null && scope === scopeRef.current,
      })
      queued.current.delete(selected.draftId)
      setQueuedVersion((version) => version + 1)
      await refresh()
      reviewedRef.current?.()
      return true
    } catch (error) {
      const commit = queued.current.get(selected.draftId)
      if (commit && error instanceof DraftReviewError && (error.code === "stale" || error.code === "rejected")) {
        const stillQueued = await getOutboxRecords([commit.eventId, ...(commit.validationEventId ? [commit.validationEventId] : [])])
        if (stillQueued.length === 0) {
          queued.current.delete(selected.draftId)
          setQueuedVersion((version) => version + 1)
        }
      }
      setWriteError(error)
      return false
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  const navigate = (nextIndex: number) => {
    setWriteError(null)
    setCursor(pending[nextIndex]?.cellId ?? null)
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4" aria-label={t("agentDraftReview.title")} aria-busy={loading}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button variant="ghost" size="sm" onClick={onBack} disabled={busy}>
          <ArrowLeft data-icon="inline-start" />{t("agentWorkspace.backToConversation")}
        </Button>
        <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={loading || busy}>
          {t("common.refresh")}
        </Button>
      </div>
      <header className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold">{t("agentDraftReview.title")}</h2>
        <p className="text-sm text-muted-foreground">{snapshot?.file.name || fileName || (loading ? t("common.loading") : t("common.file"))} · {lane || t("agentDraftReview.defaultLane")}</p>
        <p className="text-sm text-muted-foreground">{t("agentDraftReview.scope")}</p>
        {!loading && !loadError && <p role="status">{t("agentDraftReview.pending", { count: pending.length })}</p>}
      </header>
      {loadError ? <p role="alert">{t("agentDraftReview.loadFailed", { message: errorText(loadError) })}</p> : null}
      {loading && !snapshot ? <div role="status" aria-label={t("common.loading")}><Skeleton className="h-40 w-full" /></div> : null}
      {snapshot && !loading && !loadError && pending.length === 0 ? (
        <EmptyState title={t("agentDraftReview.empty")} description={t("agentDraftReview.emptyHelp")} />
      ) : null}
      {selected && snapshot ? (
        <>
          <nav aria-label={t("agentDraftReview.title")} className="flex flex-wrap items-center justify-between gap-2">
            <Button variant="outline" size="sm" onClick={() => navigate(index - 1)} disabled={index <= 0 || busy}>
              <ChevronLeft data-icon="inline-start" />{t("agentDraftReview.previous")}
            </Button>
            <p aria-live="polite">{t("agentDraftReview.position", { position: index + 1, total: pending.length })}</p>
            <Button variant="outline" size="sm" onClick={() => navigate(index + 1)} disabled={index >= pending.length - 1 || busy}>
              {t("agentDraftReview.next")}<ChevronRight data-icon="inline-end" />
            </Button>
          </nav>
          {!canWrite ? <p>{t("agentDraftReview.readOnly")}</p> : null}
          {locked ? <p role="status">{t("agentDraftReview.locked")}</p> : null}
          <div className="grid items-start gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>{t("agentDraftReview.source")}</CardTitle>
                <CardDescription>{cell?.cellLabel || selected.cellId}{selected.spanLabel ? ` · ${selected.spanLabel}` : ""}</CardDescription>
              </CardHeader>
              <CardContent>
                {cell?.sourceEventId ? <p className="whitespace-pre-wrap break-words" dir={snapshot.file.sourceTextDirection ?? "auto"} data-testid="draft-review-source">
                  {cellTextForDisplay(effectiveSourceText(cell))}
                </p> : <p role="alert">{t("agentDraftReview.sourceMissing")}</p>}
              </CardContent>
            </Card>
            <div className="flex flex-col gap-4">
              <Card>
                <CardHeader><CardTitle>{t("agentDraftReview.stored")}</CardTitle></CardHeader>
                <CardContent><p className="whitespace-pre-wrap break-words" dir="auto">
                  {cell?.translated ? cellTextForDisplay(cell.translated) : t("agentDraftReview.noTranslation")}
                </p></CardContent>
              </Card>
              <Card>
                <CardHeader><CardTitle>{t("agentDraftReview.suggestion")}</CardTitle></CardHeader>
                <CardContent className="flex flex-col gap-3">
                  <ContextualDraftCard
                    key={draftKey} projectId={projectId} fileId={run.fileId} targetLang={lane}
                    cellId={selected.cellId} editable={ready && edits[draftKey] === undefined}
                    dir={!lane ? snapshot.file.targetTextDirection ?? undefined : undefined}
                    onAccept={accept}
                  />
                  {canWrite && edits[draftKey] === undefined ? <Button variant="outline" size="sm" disabled={!ready}
                    onClick={() => setEdits((current) => ({ ...current, [draftKey]: selected.text }))}>
                    {t("agentDraftReview.edit")}
                  </Button> : null}
                  {canWrite && edits[draftKey] !== undefined ? (
                    <>
                      <Field>
                        <FieldLabel htmlFor="draft-review-edit">{t("agentDraftReview.editLabel")}</FieldLabel>
                        <Textarea id="draft-review-edit" dir="auto" value={edits[draftKey]} disabled={!ready}
                          onChange={(event) => setEdits((current) => ({ ...current, [draftKey]: event.target.value }))} />
                        <FieldDescription>{t("agentDraftReview.editHelp")}</FieldDescription>
                      </Field>
                      <div className="flex flex-wrap gap-2">
                        <Button disabled={!ready} onClick={() => void accept(edits[draftKey])}>{t("agentDraftReview.acceptEdited")}</Button>
                        <Button variant="ghost" disabled={busy || Boolean(waiting)} onClick={() => setEdits((current) => {
                          const next = { ...current }; delete next[draftKey]; return next
                        })}>{t("common.cancel")}</Button>
                      </div>
                    </>
                  ) : null}
                  {waiting ? <div className="flex flex-col gap-2">
                    <p role="status">{t("agentDraftReview.queued")}</p>
                    <Button variant="outline" disabled={busy || locked || !canWrite} onClick={() => void accept(waiting.value)}>
                      {t("agentDraftReview.retrySync")}
                    </Button>
                  </div> : null}
                  {writeError ? <p role="alert">{t("agentDraftReview.writeFailed", { message: errorText(writeError) })}</p> : null}
                </CardContent>
              </Card>
            </div>
          </div>
        </>
      ) : null}
    </section>
  )
}
