import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  BookOpen,
  ExternalLink,
  FileText,
  RefreshCw,
  RotateCcw,
  Search,
  Trash2,
  TriangleAlert,
  Upload,
} from "lucide-react"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { EmptyState } from "@/components/ui/empty"
import { Field, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Section, SettingsGroup, SettingsRow } from "@/components/ui/page"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { toast } from "@/components/ui/toast"
import { DateTooltip } from "@/components/ui/date-tooltip"
import { formatNumber } from "@/lib/i18n/format"
import { useI18n, useT } from "@/lib/i18n/I18nProvider"
import {
  deleteKnowledgeDocument,
  getKnowledgeDocument,
  getKnowledgeDocumentContent,
  getKnowledgeDocumentOriginal,
  isKnowledgeIndexStalled,
  KnowledgeBaseApiError,
  listKnowledgeDocuments,
  reindexKnowledgeDocument,
  uploadKnowledgeDocument,
  type KnowledgeDocument,
  type KnowledgeScope,
} from "@/lib/frontier/knowledge-base"

interface KnowledgeBaseSurfaceProps {
  scope: KnowledgeScope
  jwt: string | null
  canManage: boolean
  showTitle?: boolean
  drafting?: {
    checked: boolean
    disabled: boolean
    onCheckedChange: (checked: boolean) => Promise<void> | void
  }
}

interface ViewerState {
  doc: KnowledgeDocument
  content: string | null
  loading: boolean
  failed: boolean
}

function formatBytes(bytes: number, locale: string): string {
  if (bytes < 1024) return `${formatNumber(bytes, locale)} B`
  if (bytes < 1024 * 1024) return `${formatNumber(bytes / 1024, locale, { maximumFractionDigits: 1 })} KB`
  return `${formatNumber(bytes / (1024 * 1024), locale, { maximumFractionDigits: 1 })} MB`
}

/** A stalled doc reads as a failure, because that is what it is — the job that
 *  owned it is gone (AQU-1376). A doc indexed without its summaries is not a
 *  failure and must not read as one (AQU-2002) — it is searchable and
 *  navigable — but it isn't the clean "Indexed" either, so it gets the neutral
 *  outline and the reason underneath. */
function statusVariant(doc: KnowledgeDocument, stalled: boolean) {
  if (doc.indexStatus === "failed" || stalled) return "destructive" as const
  if (doc.indexStatus === "pending") return "outline" as const
  return doc.indexError ? "outline" as const : "secondary" as const
}

/** Which status message a row shows. `indexError` on a `ready` doc means the
 *  structure landed without summaries (AQU-2002). */
function statusKey(doc: KnowledgeDocument, stalled: boolean) {
  if (stalled) return "knowledgeBase.status.stalled" as const
  if (doc.indexStatus === "ready" && doc.indexError) return "knowledgeBase.status.partial" as const
  return `knowledgeBase.status.${doc.indexStatus}` as const
}

/** How often the open list re-reads itself while a doc is pending (AQU-2028).
 *  Indexing runs server-side and sends no event when it settles, so without
 *  this a row stayed on "Indexing…" until a reload — and then flipped to a
 *  false "stalled" once the AQU-1376 window passed. The same tick re-checks
 *  the stall, which also produces no event. */
const PENDING_POLL_MS = 5_000

export function KnowledgeBaseSurface({
  scope,
  jwt,
  canManage,
  showTitle = true,
  drafting,
}: KnowledgeBaseSurfaceProps) {
  const t = useT()
  const { locale } = useI18n()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const scopeKind = scope.kind
  const scopeId = scope.id
  const stableScope = useMemo<KnowledgeScope>(
    () => scopeKind === "project"
      ? { kind: "project", id: String(scopeId) }
      : { kind: "org", id: Number(scopeId) },
    [scopeId, scopeKind],
  )
  const [docs, setDocs] = useState<KnowledgeDocument[]>([])
  const [query, setQuery] = useState("")
  const [loading, setLoading] = useState(Boolean(jwt))
  const [loadFailed, setLoadFailed] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [reindexingId, setReindexingId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<KnowledgeDocument | null>(null)
  const [viewer, setViewer] = useState<ViewerState | null>(null)

  /**
   * AQU-2028: bumped by every list read and by every local change (upload,
   * re-index, delete). A read only lands if nothing has bumped it since it
   * started, so a re-read that left before an upload can't drop the new row,
   * and one that left before a re-index can't put the old status back.
   */
  const listGenRef = useRef(0)
  /** A pending-doc re-read still in flight; the next tick skips rather than stacks. */
  const pollInFlightRef = useRef(false)

  const load = useCallback(async () => {
    const gen = ++listGenRef.current
    if (!jwt) {
      setDocs([])
      setLoading(false)
      return
    }
    setLoading(true)
    setLoadFailed(false)
    try {
      const next = await listKnowledgeDocuments(stableScope, jwt)
      if (gen === listGenRef.current) setDocs(next)
    } catch {
      setLoadFailed(true)
    } finally {
      setLoading(false)
    }
  }, [jwt, stableScope])

  useEffect(() => {
    void load()
  }, [load])

  /** The quiet re-read behind the pending poll: no spinner, and a failure keeps
   *  the rows already on screen — the next tick simply tries again. */
  const refreshPending = useCallback(async () => {
    if (!jwt || pollInFlightRef.current) return
    pollInFlightRef.current = true
    const gen = ++listGenRef.current
    try {
      const next = await listKnowledgeDocuments(stableScope, jwt)
      if (gen === listGenRef.current) setDocs(next)
    } catch {
      // Keep what is shown; this is a background check, not a load.
    } finally {
      pollInFlightRef.current = false
    }
  }, [jwt, stableScope])

  // Only tick while something is actually pending; an all-settled list has
  // nothing to re-read or re-evaluate, so the poll stops with the last pending
  // row (AQU-2028).
  const hasPendingDoc = useMemo(() => docs.some((doc) => doc.indexStatus === "pending"), [docs])
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!hasPendingDoc) return
    // No synchronous first tick: a `now` left over from an earlier render is only
    // ever too *old*, which can delay the stalled badge by one interval but can
    // never flag a live job early — the direction to err in.
    const timer = window.setInterval(() => {
      setNow(Date.now())
      // A hidden tab has no one to show the badge to; it catches up on the
      // first tick after it is shown again.
      if (document.visibilityState !== "hidden") void refreshPending()
    }, PENDING_POLL_MS)
    return () => window.clearInterval(timer)
  }, [hasPendingDoc, refreshPending])

  const visibleDocs = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase(locale)
    if (!needle) return docs
    return docs.filter((doc) => doc.name.toLocaleLowerCase(locale).includes(needle))
  }, [docs, locale, query])

  async function handleUpload(file: File) {
    if (!jwt || !canManage) return
    setUploading(true)
    try {
      const doc = await uploadKnowledgeDocument(stableScope, jwt, file)
      listGenRef.current++
      setDocs((current) => [doc, ...current.filter((item) => item.id !== doc.id)])
      toast.add({ type: "success", title: t("knowledgeBase.uploadSuccess", { name: file.name }) })
    } catch (err) {
      // AQU-1499: show the server's reason when it sent one. "Try again" is
      // actively misleading for a rejection that no retry can clear (a .docx
      // whose word/document.xml is too bloated to read) — the reason names the
      // fix, so the uploader is not left guessing.
      const reason = err instanceof KnowledgeBaseApiError ? err.serverMessage : undefined
      toast.add({
        type: "error",
        priority: "high",
        title: t("knowledgeBase.uploadError", { name: file.name }),
        ...(reason ? { description: reason } : {}),
      })
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ""
    }
  }

  async function handleOpen(doc: KnowledgeDocument) {
    if (!jwt) return
    setViewer({ doc, content: null, loading: true, failed: false })
    try {
      const [detail, content] = await Promise.all([
        getKnowledgeDocument(stableScope, jwt, doc.id),
        getKnowledgeDocumentContent(stableScope, jwt, doc.id),
      ])
      setViewer({ doc: detail.doc, content, loading: false, failed: false })
    } catch {
      setViewer((current) => current ? { ...current, loading: false, failed: true } : null)
    }
  }

  async function handleOpenOriginal(doc: KnowledgeDocument) {
    if (!jwt) return
    try {
      const blob = await getKnowledgeDocumentOriginal(stableScope, jwt, doc.id)
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement("a")
      anchor.href = url
      anchor.target = "_blank"
      anchor.rel = "noopener noreferrer"
      anchor.click()
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
    } catch {
      toast.add({ type: "error", priority: "high", title: t("knowledgeBase.loadError") })
    }
  }

  async function handleReindex(doc: KnowledgeDocument) {
    if (!jwt || !canManage || doc.scope !== scopeKind) return
    setReindexingId(doc.id)
    try {
      await reindexKnowledgeDocument(stableScope, jwt, doc.id)
      listGenRef.current++
      // The server restarts updated_at along with the status (AQU-1376); mirror
      // that here or a retried doc would still read as stalled and keep
      // offering the button that just fired.
      setDocs((current) => current.map((item) =>
        item.id === doc.id
          // The server clears index_error along with the status (AQU-2002);
          // leaving it here would show the last run's reason against a run
          // that has only just started.
          ? { ...item, indexStatus: "pending", indexError: null, updatedAt: new Date().toISOString() }
          : item,
      ))
      toast.add({ type: "success", title: t("knowledgeBase.reindexing") })
    } catch {
      toast.add({ type: "error", priority: "high", title: t("knowledgeBase.loadError") })
    } finally {
      setReindexingId(null)
    }
  }

  async function handleDelete() {
    const doc = pendingDelete
    if (!doc || !jwt || !canManage || doc.scope !== scopeKind) return
    setDeletingId(doc.id)
    try {
      await deleteKnowledgeDocument(stableScope, jwt, doc.id)
      listGenRef.current++
      setDocs((current) => current.filter((item) => item.id !== doc.id))
      setPendingDelete(null)
      toast.add({ type: "success", title: t("knowledgeBase.deleteSuccess", { name: doc.name }) })
    } catch {
      toast.add({ type: "error", priority: "high", title: t("knowledgeBase.deleteError", { name: doc.name }) })
    } finally {
      setDeletingId(null)
    }
  }

  const description = scopeKind === "org"
    ? t("knowledgeBase.orgDescription")
    : t("knowledgeBase.description")

  const uploadButton = canManage ? (
    <>
      <input
        ref={fileInputRef}
        type="file"
        accept=".md,.txt,.docx,.pdf"
        className="sr-only"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0]
          if (file) void handleUpload(file)
        }}
        tabIndex={-1}
        aria-hidden="true"
      />
      <Button type="button" onClick={() => fileInputRef.current?.click()} disabled={uploading || !jwt}>
        {uploading ? <Spinner data-icon="inline-start" /> : <Upload data-icon="inline-start" />}
        {uploading ? t("knowledgeBase.uploading") : t("knowledgeBase.upload")}
      </Button>
    </>
  ) : null

  return (
    <div className="flex flex-col gap-6">
      {drafting ? (
        <SettingsGroup>
          <SettingsRow
            label={<label htmlFor="knowledge-base-drafting">{t("knowledgeBase.useInDraftingLabel")}</label>}
            description={t("knowledgeBase.useInDraftingDescription")}
            control={
              <Switch
                id="knowledge-base-drafting"
                checked={drafting.checked}
                onCheckedChange={(checked) => void drafting.onCheckedChange(checked)}
                disabled={drafting.disabled}
                aria-label={t("knowledgeBase.useInDraftingLabel")}
              />
            }
          />
        </SettingsGroup>
      ) : null}

      <Section
        title={showTitle ? t("knowledgeBase.title") : undefined}
        description={showTitle ? description : undefined}
        action={showTitle ? uploadButton : undefined}
        contentClassName="flex flex-col gap-4"
      >
        {!showTitle && uploadButton ? (
          <div className="flex justify-end">{uploadButton}</div>
        ) : null}

        {canManage ? (
          <p className="text-xs text-muted-foreground">{t("knowledgeBase.acceptedFormats")}</p>
        ) : (
          <p className="text-xs text-muted-foreground">{t("common.readOnly")}</p>
        )}

        {docs.length > 0 ? (
          <div className="flex items-center gap-2">
            <Field className="min-w-0 flex-1">
              <FieldLabel htmlFor={`knowledge-search-${scopeKind}`} className="sr-only">
                {t("knowledgeBase.searchPlaceholder")}
              </FieldLabel>
              <div className="relative">
                <Search className="pointer-events-none absolute top-1/2 start-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                <Input
                  id={`knowledge-search-${scopeKind}`}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={t("knowledgeBase.searchPlaceholder")}
                  className="ps-8"
                />
              </div>
            </Field>
            <Button type="button" variant="outline" size="icon" onClick={() => void load()} aria-label={t("common.refresh")}>
              <RefreshCw />
            </Button>
          </div>
        ) : null}

        {loading ? (
          <div className="flex flex-col gap-3" aria-label={t("common.loading")}>
            {Array.from({ length: 3 }).map((_, index) => (
              <Skeleton key={index} className="h-28 w-full" />
            ))}
          </div>
        ) : loadFailed ? (
          <EmptyState
            variant="inline"
            icon={TriangleAlert}
            title={t("knowledgeBase.loadError")}
            action={<Button variant="outline" onClick={() => void load()}>{t("common.retry")}</Button>}
          />
        ) : docs.length === 0 ? (
          <EmptyState
            variant="inline"
            icon={BookOpen}
            title={t("knowledgeBase.emptyTitle")}
            description={scopeKind === "org"
              ? t("knowledgeBase.orgEmptyDescription")
              : t("knowledgeBase.emptyDescription")}
          />
        ) : visibleDocs.length === 0 ? (
          <EmptyState variant="inline" icon={Search} title={t("knowledgeBase.noMatches")} />
        ) : (
          <div className="flex flex-col gap-3">
            {visibleDocs.map((doc) => {
              const inherited = scopeKind === "project" && doc.scope === "org"
              const manageable = canManage && !inherited
              const stalled = isKnowledgeIndexStalled(doc, now)
              return (
                <Card key={doc.id} size="sm">
                  <CardHeader>
                    <CardTitle className="flex min-w-0 items-center gap-2">
                      <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                      <span className="truncate">{doc.name}</span>
                    </CardTitle>
                    <CardDescription>
                      {doc.createdBy} · <DateTooltip value={doc.createdAt} label={t("common.date.created")} /> · {formatBytes(doc.sizeBytes, locale)}
                    </CardDescription>
                    <CardAction>
                      <div className="flex items-center gap-2">
                        {inherited ? <Badge variant="outline">{t("common.org")}</Badge> : null}
                        <Badge variant={statusVariant(doc, stalled)}>
                          {t(statusKey(doc, stalled))}
                        </Badge>
                      </div>
                    </CardAction>
                  </CardHeader>
                  {doc.docSummary || doc.indexError || inherited ? (
                    <CardContent className="flex flex-col gap-2">
                      {doc.docSummary ? <p className="text-sm text-muted-foreground">{doc.docSummary}</p> : null}
                      {/* AQU-2002: the server's own sentence, shown as sent. A
                          badge alone told the uploader nothing they could act
                          on — and "Try indexing again" on a document whose
                          model leg is out of credit is worse than nothing. */}
                      {doc.indexError ? (
                        <p className={doc.indexStatus === "failed"
                          ? "text-xs text-destructive"
                          // Missing summaries are a note, not an alarm: the
                          // document works, so the row must not read red.
                          : "text-xs text-muted-foreground"}>
                          {doc.indexError}
                        </p>
                      ) : null}
                      {inherited ? <p className="text-xs text-muted-foreground">{t("knowledgeBase.readOnlyHelp")}</p> : null}
                    </CardContent>
                  ) : null}
                  <CardFooter className="flex flex-wrap gap-2">
                    <Button variant="outline" size="sm" onClick={() => void handleOpen(doc)}>
                      <BookOpen data-icon="inline-start" />
                      {t("knowledgeBase.open")}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => void handleOpenOriginal(doc)}>
                      <ExternalLink data-icon="inline-start" />
                      {t("knowledgeBase.openOriginal")}
                    </Button>
                    {manageable && (doc.indexStatus === "failed" || stalled || doc.indexError) ? (
                      <Button variant="ghost" size="sm" onClick={() => void handleReindex(doc)} disabled={reindexingId === doc.id}>
                        {reindexingId === doc.id
                          ? <Spinner data-icon="inline-start" />
                          : <RotateCcw data-icon="inline-start" />}
                        {reindexingId === doc.id ? t("knowledgeBase.reindexing") : t("knowledgeBase.reindex")}
                      </Button>
                    ) : null}
                    {manageable ? (
                      <Button variant="destructive" size="sm" onClick={() => setPendingDelete(doc)}>
                        <Trash2 data-icon="inline-start" />
                        {t("knowledgeBase.delete")}
                      </Button>
                    ) : null}
                  </CardFooter>
                </Card>
              )
            })}
          </div>
        )}
      </Section>

      <Dialog open={viewer != null} onOpenChange={(open) => { if (!open) setViewer(null) }}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{viewer?.doc.name ?? t("knowledgeBase.open")}</DialogTitle>
            <DialogDescription>{viewer?.doc.docSummary ?? t("knowledgeBase.noSummary")}</DialogDescription>
          </DialogHeader>
          <DialogBody className="flex flex-col gap-5">
            {viewer?.loading ? (
              <div className="flex flex-col gap-3" aria-label={t("common.loading")}>
                <Skeleton className="h-4 w-1/3" />
                <Skeleton className="h-56 w-full" />
              </div>
            ) : viewer?.failed ? (
              <EmptyState variant="inline" icon={TriangleAlert} title={t("knowledgeBase.loadError")} />
            ) : viewer ? (
              <div className="flex flex-col gap-2">
                <h3 className="font-heading text-sm font-medium">{t("knowledgeBase.extractedTextHeading")}</h3>
                <pre className="max-h-[45dvh] overflow-auto whitespace-pre-wrap rounded-lg bg-muted p-4 font-mono text-xs leading-relaxed">
                  {viewer.content}
                </pre>
              </div>
            ) : null}
          </DialogBody>
          <DialogFooter>
            {viewer ? (
              <Button variant="outline" onClick={() => void handleOpenOriginal(viewer.doc)}>
                <ExternalLink data-icon="inline-start" />
                {t("knowledgeBase.openOriginal")}
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={pendingDelete != null} onOpenChange={(open) => { if (!open && !deletingId) setPendingDelete(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("knowledgeBase.deleteTitle", { name: pendingDelete?.name ?? "" })}
            </AlertDialogTitle>
            <AlertDialogDescription>{t("knowledgeBase.deleteDescription")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={Boolean(deletingId)}>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={Boolean(deletingId)} onClick={() => void handleDelete()}>
              {deletingId ? <Spinner data-icon="inline-start" /> : <Trash2 data-icon="inline-start" />}
              {t("knowledgeBase.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
