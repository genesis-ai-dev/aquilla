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

function statusVariant(status: KnowledgeDocument["indexStatus"]) {
  if (status === "failed") return "destructive" as const
  if (status === "pending") return "outline" as const
  return "secondary" as const
}

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

  const load = useCallback(async () => {
    if (!jwt) {
      setDocs([])
      setLoading(false)
      return
    }
    setLoading(true)
    setLoadFailed(false)
    try {
      setDocs(await listKnowledgeDocuments(stableScope, jwt))
    } catch {
      setLoadFailed(true)
    } finally {
      setLoading(false)
    }
  }, [jwt, stableScope])

  useEffect(() => {
    void load()
  }, [load])

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
      setDocs((current) => [doc, ...current.filter((item) => item.id !== doc.id)])
      toast.add({ type: "success", title: t("knowledgeBase.uploadSuccess", { name: file.name }) })
    } catch {
      toast.add({ type: "error", priority: "high", title: t("knowledgeBase.uploadError", { name: file.name }) })
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
      setDocs((current) => current.map((item) =>
        item.id === doc.id ? { ...item, indexStatus: "pending" } : item,
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
                        <Badge variant={statusVariant(doc.indexStatus)}>
                          {t(`knowledgeBase.status.${doc.indexStatus}`)}
                        </Badge>
                      </div>
                    </CardAction>
                  </CardHeader>
                  {doc.docSummary || inherited ? (
                    <CardContent className="flex flex-col gap-2">
                      {doc.docSummary ? <p className="text-sm text-muted-foreground">{doc.docSummary}</p> : null}
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
                    {manageable && doc.indexStatus === "failed" ? (
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
