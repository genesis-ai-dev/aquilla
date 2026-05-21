import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"
import { importFile, importEBible, type EBibleProgress } from "@/lib/import"
import type { FileReference } from "@/lib/parsers/types"
import {
  fetchTranslationsList,
  type EBibleTranslation,
} from "@/lib/parsers/ebible"

type Tab = "upload" | "ebible"

interface ImportDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: string
  username: string
  sourceLanguage: string
  targetLanguage: string
  /** Mints a sync-token scoped to (projectId, fileId) for the bulk upload. */
  getToken: (fileId: string) => Promise<string | null>
  onImported: (refs: FileReference[]) => void | Promise<void>
}

export function ImportDialog({
  open,
  onOpenChange,
  projectId,
  username,
  sourceLanguage,
  targetLanguage,
  getToken,
  onImported,
}: ImportDialogProps) {
  const [tab, setTab] = useState<Tab>("upload")

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Import Files</DialogTitle>
        </DialogHeader>

        <div className="mb-4 inline-flex rounded-md border p-0.5 text-sm">
          <button
            type="button"
            onClick={() => setTab("upload")}
            className={cn(
              "rounded px-3 py-1 transition-colors",
              tab === "upload"
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            Upload files
          </button>
          <button
            type="button"
            onClick={() => setTab("ebible")}
            className={cn(
              "rounded px-3 py-1 transition-colors",
              tab === "ebible"
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            eBible Corpus
          </button>
        </div>

        {tab === "upload" ? (
          <UploadPanel
            projectId={projectId}
            username={username}
            sourceLanguage={sourceLanguage}
            targetLanguage={targetLanguage}
            getToken={getToken}
            onImported={async (refs) => {
              await onImported(refs)
              onOpenChange(false)
            }}
          />
        ) : (
          <EBiblePanel
            projectId={projectId}
            username={username}
            sourceLanguage={sourceLanguage}
            targetLanguage={targetLanguage}
            getToken={getToken}
            onImported={async (ref) => {
              await onImported([ref])
              onOpenChange(false)
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

interface UploadPanelProps {
  projectId: string
  username: string
  sourceLanguage: string
  targetLanguage: string
  getToken: (fileId: string) => Promise<string | null>
  onImported: (refs: FileReference[]) => void | Promise<void>
}

function UploadPanel({ projectId, username, sourceLanguage, targetLanguage, getToken, onImported }: UploadPanelProps) {
  const [importing, setImporting] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [phase, setPhase] = useState<string>("")
  const [progress, setProgress] = useState<{ count: number; total: number } | null>(null)

  const handleFiles = useCallback(
    async (files: FileList | File[]) => {
      setImporting(true)
      setError(null)
      setProgress(null)
      const allRefs: FileReference[] = []

      try {
        const list = Array.from(files)
        for (const file of list) {
          setPhase(`Parsing ${file.name}…`)
          setProgress(null)
          const refs = await importFile(file, {
            projectId,
            author: username,
            sourceLanguage,
            targetLanguage,
            getToken,
            onCellEnqueued: (count, total) => {
              setPhase(`Uploading ${file.name}`)
              setProgress({ count, total })
            },
          })
          allRefs.push(...refs)
        }
        setPhase("Finishing up…")
        await onImported(allRefs)
      } catch (err) {
        setError(err instanceof Error ? err.message : "Import failed")
      } finally {
        setImporting(false)
        setProgress(null)
        setPhase("")
      }
    },
    [projectId, username, sourceLanguage, targetLanguage, getToken, onImported]
  )

  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    setDragOver(false)
    if (e.dataTransfer.files.length > 0) {
      handleFiles(e.dataTransfer.files)
    }
  }

  function handleFileInput(e: React.ChangeEvent<HTMLInputElement>) {
    if (e.target.files && e.target.files.length > 0) {
      handleFiles(e.target.files)
    }
  }

  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center rounded-lg border-2 border-dashed p-8 transition-colors",
        dragOver ? "border-primary bg-primary/5" : "border-muted"
      )}
      onDragOver={(e) => {
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
    >
      {importing ? (
        <div className="w-full max-w-sm text-center">
          <p className="text-sm font-medium">{phase || "Importing…"}</p>
          {progress && progress.total > 0 ? (
            <>
              <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full bg-primary transition-all"
                  style={{ width: `${Math.round((progress.count / progress.total) * 100)}%` }}
                />
              </div>
              <p className="mt-1.5 text-xs text-muted-foreground">
                {progress.count.toLocaleString()} / {progress.total.toLocaleString()} cells
              </p>
            </>
          ) : (
            <p className="mt-2 text-xs text-muted-foreground">Working…</p>
          )}
        </div>
      ) : (
        <>
          <p className="mb-2 text-sm text-muted-foreground">
            Drag & drop files here, or
          </p>
          <Button variant="outline" size="sm" render={<label className="cursor-pointer" />}>
            Choose Files
            <input
              type="file"
              multiple
              className="hidden"
              accept=".md,.markdown,.docx,.pptx,.txt,.vtt,.srt,.usfm,.sfm"
              onChange={handleFileInput}
            />
          </Button>
          <p className="mt-2 text-xs text-muted-foreground">
            Supported: MD, DOCX, PPTX, TXT, VTT, SRT, USFM
          </p>
        </>
      )}
      {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
    </div>
  )
}

interface EBiblePanelProps {
  projectId: string
  username: string
  sourceLanguage: string
  targetLanguage: string
  getToken: (fileId: string) => Promise<string | null>
  onImported: (ref: FileReference) => void | Promise<void>
}

function EBiblePanel({ projectId, username, sourceLanguage, targetLanguage, getToken, onImported }: EBiblePanelProps) {
  const [translations, setTranslations] = useState<EBibleTranslation[] | null>(null)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [query, setQuery] = useState("")
  const [selected, setSelected] = useState<EBibleTranslation | null>(null)
  const [progress, setProgress] = useState<EBibleProgress | null>(null)
  const [importing, setImporting] = useState(false)
  const [importErr, setImportErr] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  // Load on first mount
  useEffect(() => {
    let cancelled = false
    fetchTranslationsList()
      .then((list) => {
        if (!cancelled) setTranslations(list)
      })
      .catch((err) => {
        if (!cancelled) setLoadErr(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [])

  const filtered = useMemo(() => {
    if (!translations) return []
    const q = query.trim().toLowerCase()
    if (!q) return translations.slice(0, 200)
    return translations
      .filter(
        (t) =>
          t.id.toLowerCase().includes(q) ||
          t.title.toLowerCase().includes(q) ||
          t.languageNameInEnglish.toLowerCase().includes(q) ||
          t.languageName.toLowerCase().includes(q)
      )
      .slice(0, 200)
  }, [translations, query])

  async function handleImport() {
    if (!selected || importing) return
    setImporting(true)
    setImportErr(null)
    setProgress({ phase: "download", received: 0, total: 0 })
    abortRef.current = new AbortController()

    try {
      const ref = await importEBible(
        selected,
        {
          projectId,
          author: username,
          sourceLanguage,
          targetLanguage,
          getToken,
        },
        setProgress,
        abortRef.current.signal
      )
      await onImported(ref)
    } catch (err) {
      setImportErr(err instanceof Error ? err.message : "Import failed")
    } finally {
      setImporting(false)
      abortRef.current = null
    }
  }

  // Cancel any in-flight download when panel unmounts (e.g. dialog closed)
  useEffect(() => {
    return () => abortRef.current?.abort()
  }, [])

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">
        Import a Bible translation directly from the{" "}
        <a
          href="https://github.com/BibleNLP/ebible"
          target="_blank"
          rel="noreferrer"
          className="underline"
        >
          BibleNLP/ebible corpus
        </a>
        . Only redistributable translations are included.
      </p>

      <Input
        placeholder="Search by language, title, or id (e.g. 'eng', 'KJV')"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        disabled={!translations || importing}
      />

      {loadErr ? (
        <p className="text-sm text-destructive">Failed to load list: {loadErr}</p>
      ) : !translations ? (
        <p className="text-sm text-muted-foreground">Loading translations...</p>
      ) : (
        <ScrollArea className="h-72 rounded-md border">
          <ul className="divide-y">
            {filtered.length === 0 && (
              <li className="p-3 text-sm text-muted-foreground">No matches.</li>
            )}
            {filtered.map((t) => {
              const isSelected = selected?.id === t.id
              return (
                <li key={t.id}>
                  <button
                    type="button"
                    disabled={importing}
                    onClick={() => setSelected(t)}
                    className={cn(
                      "flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left text-sm transition-colors hover:bg-accent",
                      isSelected && "bg-accent"
                    )}
                  >
                    <div className="flex w-full items-center justify-between gap-2">
                      <span className="font-medium">{t.title}</span>
                      <span className="shrink-0 font-mono text-xs text-muted-foreground">
                        {t.id}
                      </span>
                    </div>
                    <span className="text-xs text-muted-foreground">
                      {t.languageNameInEnglish || t.languageName}
                      {t.otBooks + t.ntBooks > 0 && (
                        <> · {t.otBooks} OT · {t.ntBooks} NT</>
                      )}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        </ScrollArea>
      )}

      {selected && (
        <div className="rounded-md border bg-muted/30 p-3 text-xs">
          <div className="font-medium text-sm">{selected.title}</div>
          <div className="text-muted-foreground">{selected.copyright || "No copyright info."}</div>
        </div>
      )}

      {progress && (
        <div className="text-xs text-muted-foreground">
          <p>
            {progress.phase === "download"
              ? `Downloading ${selected?.id ?? ""}… ${formatProgress(progress.received, progress.total)}`
              : progress.phase === "parse"
                ? "Parsing verses…"
                : progress.cellsTotal
                  ? `Uploading verses: ${(progress.cellsEnqueued ?? 0).toLocaleString()} / ${progress.cellsTotal.toLocaleString()}`
                  : "Uploading to project…"}
          </p>
          {progress.phase === "save" && progress.cellsTotal ? (
            <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full bg-primary transition-all"
                style={{
                  width: `${Math.round(((progress.cellsEnqueued ?? 0) / progress.cellsTotal) * 100)}%`,
                }}
              />
            </div>
          ) : null}
        </div>
      )}
      {importErr && <p className="text-sm text-destructive">{importErr}</p>}

      <div className="flex justify-end">
        <Button onClick={handleImport} disabled={!selected || importing}>
          {importing ? "Importing..." : "Import"}
        </Button>
      </div>
    </div>
  )
}

function formatProgress(received: number | undefined, total: number | undefined): string {
  if (!received) return "0 MB"
  const mb = (received / (1024 * 1024)).toFixed(1)
  if (!total) return `${mb} MB`
  const totalMb = (total / (1024 * 1024)).toFixed(1)
  const pct = Math.round((received / total) * 100)
  return `${mb} / ${totalMb} MB (${pct}%)`
}
