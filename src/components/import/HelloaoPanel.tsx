import { useEffect, useMemo, useRef, useState } from "react"
import { Search } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { ScrollArea } from "@/components/ui/scroll-area"
import { SegmentTabs } from "@/components/ui/tabs"
import { importHelloao, type EBibleProgress } from "@/lib/import"
import { formatBytesProgress as formatProgress } from "@/lib/format-bytes"
import { useI18n } from "@/lib/i18n/I18nProvider"
import { formatNumber } from "@/lib/i18n/format"
import type { FileReference } from "@/lib/parsers/types"
import { fetchHelloaoTranslations, fetchHelloaoBooks, type HelloaoTranslation, type HelloaoBook } from "@/lib/parsers/helloao"
import { getTestament } from "@/lib/codex-editor/bible-books"
import { ImportDialogBackButton } from "./ImportDialogBackButton"

interface HelloaoPanelProps {
  projectId: string
  username: string
  sourceLanguage: string
  targetLanguage: string
  getToken: (fileId: string) => Promise<string | null>
  onImported: (ref: FileReference, inferredLanguages?: { sourceLanguage?: string; targetLanguage?: string }) => void | Promise<void>
}

export function HelloaoPanel({ projectId, username, sourceLanguage, targetLanguage, getToken, onImported }: HelloaoPanelProps) {
  const { locale } = useI18n()
  const [translations, setTranslations] = useState<HelloaoTranslation[] | null>(null)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [query, setQuery] = useState("")
  const [selected, setSelected] = useState<HelloaoTranslation | null>(null)

  // Book-selection step: loaded when a translation is chosen.
  const [books, setBooks] = useState<HelloaoBook[] | null>(null)
  const [booksErr, setBooksErr] = useState<string | null>(null)
  const [checkedBooks, setCheckedBooks] = useState<Set<string>>(new Set())
  const [bookPreset, setBookPreset] = useState<"all" | "OT" | "NT">("all")

  const [progress, setProgress] = useState<EBibleProgress | null>(null)
  const [importing, setImporting] = useState(false)
  const [importErr, setImportErr] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    let cancelled = false
    fetchHelloaoTranslations()
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

  // Cancel any in-flight download when panel unmounts (e.g. dialog closed)
  useEffect(() => {
    return () => abortRef.current?.abort()
  }, [])

  const filtered = useMemo(() => {
    if (!translations) return []
    const q = query.trim().toLowerCase()
    if (!q) return translations.slice(0, 200)
    return translations
      .filter(
        (t) =>
          t.id.toLowerCase().includes(q) ||
          t.name.toLowerCase().includes(q) ||
          t.englishName.toLowerCase().includes(q) ||
          t.languageEnglishName.toLowerCase().includes(q) ||
          t.languageName.toLowerCase().includes(q)
      )
      .slice(0, 200)
  }, [translations, query])

  function handleSelect(t: HelloaoTranslation) {
    setSelected(t)
    setBooks(null)
    setBooksErr(null)
    setCheckedBooks(new Set())
    setBookPreset("all")
    fetchHelloaoBooks(t.id)
      .then((list) => {
        setBooks(list)
        // Default: everything selected (whole bible).
        setCheckedBooks(new Set(list.map((b) => b.id)))
        setBookPreset("all")
      })
      .catch((err) => {
        setBooksErr(err instanceof Error ? err.message : String(err))
      })
  }

  function applyPreset(preset: "all" | "OT" | "NT") {
    if (!books) return
    setBookPreset(preset)
    if (preset === "all") {
      setCheckedBooks(new Set(books.map((b) => b.id)))
    } else {
      setCheckedBooks(new Set(books.filter((b) => getTestament(b.id) === preset).map((b) => b.id)))
    }
  }

  function toggleBook(id: string) {
    setCheckedBooks((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function handleImport() {
    if (!selected || !books || checkedBooks.size === 0 || importing) return
    setImporting(true)
    setImportErr(null)
    setProgress({ phase: "download", received: 0, total: 0 })
    abortRef.current = new AbortController()

    try {
      // Whole-bible selection passes null so the parser skips no books.
      const selection = checkedBooks.size === books.length ? null : checkedBooks
      const ref = await importHelloao(
        selected,
        selection,
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
      await onImported(ref, { sourceLanguage: selected.language || undefined })
    } catch (err) {
      setImportErr(err instanceof Error ? err.message : "Import failed")
    } finally {
      setImporting(false)
      abortRef.current = null
    }
  }

  const selectedVerseCount = useMemo(() => {
    if (!books) return 0
    return books.reduce((sum, b) => sum + (checkedBooks.has(b.id) ? b.totalNumberOfVerses : 0), 0)
  }, [books, checkedBooks])

  // ── Book-selection step ─────────────────────────────────────────────────────
  if (selected) {
    return (
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <ImportDialogBackButton
            disabled={importing}
            onClick={() => setSelected(null)}
            label="Back to translation list"
          />
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{selected.englishName || selected.name}</p>
            <p className="text-xs text-muted-foreground">
              {selected.languageEnglishName || selected.languageName} ·{" "}
              <a href={selected.licenseUrl} target="_blank" rel="noreferrer" className="underline">
                license
              </a>
            </p>
          </div>
        </div>

        {booksErr ? (
          <p className="text-sm text-destructive">Failed to load books: {booksErr}</p>
        ) : !books ? (
          <p className="text-sm text-muted-foreground">Loading books…</p>
        ) : (
          <>
            <div className="flex items-center gap-1.5">
              <SegmentTabs
                aria-label="Book selection preset"
                value={bookPreset}
                onValueChange={(preset) => {
                  if (!importing) applyPreset(preset)
                }}
                options={[
                  { value: "all", label: "Whole bible", disabled: importing },
                  { value: "OT", label: "Old Testament", disabled: importing },
                  { value: "NT", label: "New Testament", disabled: importing },
                ]}
              />
              <span className="ms-auto text-xs text-muted-foreground">
                {checkedBooks.size} of {books.length} books
              </span>
            </div>

            <ScrollArea className="h-64 rounded-md border">
              <ul className="grid grid-cols-2 gap-x-2 p-2 sm:grid-cols-3">
                {books.map((b) => (
                  <li key={b.id}>
                    <label className="flex items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-accent">
                      <Checkbox
                        checked={checkedBooks.has(b.id)}
                        disabled={importing}
                        onCheckedChange={() => toggleBook(b.id)}
                      />
                      <span className="truncate">{b.commonName || b.name}</span>
                    </label>
                  </li>
                ))}
              </ul>
            </ScrollArea>
          </>
        )}

        {progress && (
          <div className="text-xs text-muted-foreground">
            <p>
              {progress.phase === "download"
                ? `Downloading ${selected.id}… ${formatProgress(progress.received, progress.total, locale)}`
                : progress.phase === "parse"
                  ? "Parsing verses…"
                  : progress.cellsTotal
                    ? `Uploading verses: ${formatNumber(progress.cellsEnqueued ?? 0, locale)} / ${formatNumber(progress.cellsTotal, locale)}`
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

        <div className="flex items-center justify-end gap-3">
          {books && checkedBooks.size > 0 && (
            <span className="text-xs text-muted-foreground">
              ~{formatNumber(selectedVerseCount, locale)} verses
            </span>
          )}
          <Button onClick={handleImport} disabled={!books || checkedBooks.size === 0 || importing}>
            {importing ? "Importing..." : "Import"}
          </Button>
        </div>
      </div>
    )
  }

  // ── Translation picker step ─────────────────────────────────────────────────
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">
        Import a Bible translation from the{" "}
        <a href="https://bible.helloao.org/docs/" target="_blank" rel="noreferrer" className="underline">
          Free Use Bible API
        </a>{" "}
        — over 1,000 versions with section headings and formatting. You can import the whole
        bible, a single testament, or individual books.
      </p>

      <InputGroup>
        <InputGroupAddon>
          <Search />
        </InputGroupAddon>
        <InputGroupInput
          placeholder="Search by language, name, or id (e.g. 'eng', 'BSB')"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          disabled={!translations}
          aria-label="Search Bible translations"
        />
      </InputGroup>

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
            {filtered.map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  onClick={() => handleSelect(t)}
                  className="flex w-full flex-col items-start gap-0.5 px-3 py-2 text-start text-sm transition-colors hover:bg-accent"
                >
                  <div className="flex w-full items-center justify-between gap-2">
                    <span className="font-medium">{t.englishName || t.name}</span>
                    <span className="shrink-0 font-mono text-xs text-muted-foreground">
                      {t.id}
                    </span>
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {t.languageEnglishName || t.languageName} · {t.numberOfBooks} books
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </ScrollArea>
      )}
    </div>
  )
}
