import { useEffect, useMemo, useState } from "react"
import { Search } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { ScrollArea } from "@/components/ui/scroll-area"
import { prepareParatextProject, commitParatextProject, importParatextAsTarget, type ParatextPlan, type ParatextImportProgress } from "@/lib/import"
import { useI18n } from "@/lib/i18n/I18nProvider"
import { formatNumber } from "@/lib/i18n/format"
import type { FileReference } from "@/lib/parsers/types"
import { type ProjectEntry } from "@/lib/parsers/paratext-project"
import { usfmDisplayText } from "@/lib/parsers/usfm-display"
import type { SourceVerse } from "@/lib/parsers/paratext-pairing"
import { fetchTranslationsList, fetchTranslationText, parseEBibleCorpus, type EBibleTranslation } from "@/lib/parsers/ebible"
import { detectCollisions, type CollisionResult } from "@/lib/import-collision"
import posthog from "@/lib/posthog"
import { IMPORT_FAILED } from "@/lib/event-names"
import type { CollisionResolution } from "./import-dialog-types"

interface ParatextChoiceProps {
  entries: ProjectEntry[]
  bookCount: number
  projectId: string
  username: string
  sourceLanguage: string
  targetLanguage: string
  targetLang?: string
  getToken: (fileId: string) => Promise<string | null>
  /** AQU-277: third argument carries skipped books from a partial import so the
   *  parent can show the result screen before closing. */
  onImported: (refs: FileReference[], inferredLanguages?: { sourceLanguage?: string; targetLanguage?: string }, skipped?: { book: string; reason: string }[]) => void | Promise<void>
  onCancel: () => void
  /** AQU-287: files already in the project; used for collision detection. */
  existingFiles?: { id?: string; name: string; bookCode?: string }[]
  /** AQU-287: called when collisions are detected before running the import. */
  onCollision?: (collisions: CollisionResult[], proceed: (resolution: CollisionResolution) => void | Promise<void>) => void
  /** AQU-634: per-project USFM front-matter opt-out (forwarded to
   *  prepareParatextProject). */
  excludeFrontMatter?: boolean
}

/** Preview + source-vs-target choice for a detected Paratext project (AQU-310:
 *  everything parses client-side up front; nothing uploads until the user
 *  confirms). Source imports the books as a reference text; target pairs the
 *  consultant's in-progress translation against an eBible source picked here
 *  (aligned by verse ref). */
export function ParatextChoice({
  entries, bookCount, projectId, username, sourceLanguage, targetLanguage, targetLang, getToken, onImported, onCancel,
  existingFiles, onCollision, excludeFrontMatter,
}: ParatextChoiceProps) {
  const { locale } = useI18n()
  const [mode, setMode] = useState<"choose" | "pickSource" | "importing">("choose")
  const [plan, setPlan] = useState<ParatextPlan | null>(null)
  const [phase, setPhase] = useState("")
  const [progress, setProgress] = useState<{ count: number; total: number; bookLabel: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [translations, setTranslations] = useState<EBibleTranslation[] | null>(null)
  const [query, setQuery] = useState("")
  // Books the user unchecked in the preview (uppercase bookIds → skipKeys).
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(new Set())
  const [expandedBook, setExpandedBook] = useState<string | null>(null)

  const ctx = { projectId, author: username, sourceLanguage, targetLanguage, targetLang, getToken }

  // AQU-310: parse the whole project client-side on mount — fast (no network),
  // so the preview appears immediately and the user confirms before any upload.
  useEffect(() => {
    let cancelled = false
    prepareParatextProject(entries, { excludeFrontMatter })
      .then((p) => { if (!cancelled) setPlan(p) })
      .catch((err) => {
        if (cancelled) return
        posthog.captureException(err, { import_stage: "paratext-parse", project_id: projectId })
        posthog.capture(IMPORT_FAILED, {
          import_stage: "paratext-parse",
          project_id: projectId,
          error_message: err instanceof Error ? err.message : String(err),
        })
        setError(err instanceof Error ? err.message : "Couldn't read the project")
      })
    return () => { cancelled = true }
  }, [entries, projectId, excludeFrontMatter])

  function onProgress(p: ParatextImportProgress) {
    const bookLabel = p.book
      ? `${p.book} · book ${Math.min(p.booksDone + 1, p.booksTotal)} of ${p.booksTotal}`
      : `${p.booksDone} / ${p.booksTotal} books`
    setPhase(p.book ? `Uploading ${p.book}…` : "Uploading…")
    // Prefer the per-chunk cell counts (smooth bar); fall back to books.
    if (p.cellsTotal != null && p.cellsTotal > 0) {
      setProgress({ count: p.cellsDone ?? 0, total: p.cellsTotal, bookLabel })
    } else {
      setProgress({ count: p.booksDone, total: p.booksTotal, bookLabel })
    }
  }

  /** Preview exclusions + collision-prompt skips, merged. */
  function mergedSkipKeys(collisionSkips: ReadonlySet<string>): ReadonlySet<string> {
    return new Set([...excluded, ...collisionSkips])
  }

  /** Collision candidates: included books only, from the parsed plan. */
  function detectPlanCollisions(p: ParatextPlan): CollisionResult[] {
    if (!existingFiles || existingFiles.length === 0) return []
    const incoming = p.books
      .filter((b) => !excluded.has(b.book.bookId.toUpperCase()))
      .map((b) => ({ name: b.book.displayName, bookCode: b.book.bookId }))
    return detectCollisions(incoming, existingFiles)
  }

  async function runSourceWithResolution(resolution: CollisionResolution) {
    if (!plan) return
    setMode("importing"); setError(null); setPhase("Uploading…"); setProgress(null)
    try {
      const { refs, settings, skipped } = await commitParatextProject(plan, {
        ...ctx,
        skipKeys: mergedSkipKeys(resolution.skipKeys),
        reimportFileIds: resolution.reimportFileIds,
      }, onProgress)
      const inferredLang = settings.languageIsoCode || settings.language
      await onImported(refs, inferredLang ? { sourceLanguage: inferredLang } : undefined, skipped.length ? skipped : undefined)
    } catch (err) {
      posthog.captureException(err, { import_stage: "paratext-upload", project_id: projectId })
      posthog.capture(IMPORT_FAILED, {
        import_stage: "paratext-upload",
        project_id: projectId,
        error_message: err instanceof Error ? err.message : String(err),
      })
      setError(err instanceof Error ? err.message : "Import failed"); setMode("choose")
    }
  }

  async function runSource() {
    if (!plan) return
    // AQU-287: collision check before running the import.
    if (onCollision) {
      const collisions = detectPlanCollisions(plan)
      if (collisions.length > 0) {
        onCollision(collisions, runSourceWithResolution)
        return
      }
    }
    await runSourceWithResolution({ skipKeys: new Set(), reimportFileIds: new Map() })
  }

  async function startTarget() {
    setMode("pickSource"); setError(null)
    if (!translations) {
      try {
        setTranslations(await fetchTranslationsList())
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't load the source list")
      }
    }
  }

  async function runTargetWithResolution(sel: EBibleTranslation, resolution: CollisionResolution) {
    if (!plan) return
    setMode("importing"); setError(null); setPhase(`Fetching source: ${sel.title}…`); setProgress(null)
    try {
      const corpus = await fetchTranslationText(sel.id, () => {})
      const sourceVerses: SourceVerse[] = parseEBibleCorpus(corpus).map((s) => ({
        ref: s.globalReferences?.[0] ?? s.context,
        text: s.original,
      }))
      const selSourceLang = sel.languageCode || sel.id
      const { refs, settings, skipped } = await importParatextAsTarget(plan, sourceVerses, {
        ...ctx,
        sourceLanguage: selSourceLang,
        skipKeys: mergedSkipKeys(resolution.skipKeys),
        reimportFileIds: resolution.reimportFileIds,
      }, onProgress)
      const inferredTargetLang = settings.languageIsoCode || settings.language
      await onImported(
        refs,
        { sourceLanguage: selSourceLang, targetLanguage: inferredTargetLang || undefined },
        skipped.length ? skipped : undefined,
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed"); setMode("pickSource")
    }
  }

  async function runTarget(sel: EBibleTranslation) {
    if (!plan) return
    // AQU-287: collision check before fetching source corpus.
    if (onCollision) {
      const collisions = detectPlanCollisions(plan)
      if (collisions.length > 0) {
        onCollision(collisions, (resolution) => runTargetWithResolution(sel, resolution))
        return
      }
    }
    await runTargetWithResolution(sel, { skipKeys: new Set(), reimportFileIds: new Map() })
  }

  const filtered = useMemo(() => {
    if (!translations) return []
    const q = query.trim().toLowerCase()
    const base = q
      ? translations.filter(
          (t) =>
            t.id.toLowerCase().includes(q) ||
            t.title.toLowerCase().includes(q) ||
            t.languageNameInEnglish.toLowerCase().includes(q),
        )
      : translations
    return base.slice(0, 200)
  }, [translations, query])

  if (mode === "importing") {
    return (
      <div className="mx-auto w-full max-w-sm py-8 text-center">
        <p className="text-sm font-medium">{phase || "Importing…"}</p>
        {progress && progress.total > 0 && (
          <>
            <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-muted">
              <div className="h-full bg-primary transition-all" style={{ width: `${Math.round((progress.count / progress.total) * 100)}%` }} />
            </div>
            <p className="mt-1.5 text-xs text-muted-foreground">
              {formatNumber(progress.count, locale)} / {formatNumber(progress.total, locale)} cells · {progress.bookLabel}
            </p>
          </>
        )}
        {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
      </div>
    )
  }

  if (mode === "pickSource") {
    return (
      <div className="flex flex-col gap-3 py-2">
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium">Pick a source Bible to align against</p>
          <Button variant="ghost" size="sm" onClick={() => setMode("choose")}>Back</Button>
        </div>
        <p className="text-xs text-muted-foreground">
          It just needs to be close — verses align by reference (e.g. MAT 1:1). Verses missing on either side stay blank.
        </p>
        <InputGroup>
          <InputGroupAddon>
            <Search />
          </InputGroupAddon>
          <InputGroupInput
            placeholder="Search translations (language, name, code)…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search translations"
          />
        </InputGroup>
        <ScrollArea className="h-64 rounded border">
          {!translations ? (
            <p className="p-3 text-sm text-muted-foreground">Loading source list…</p>
          ) : filtered.length === 0 ? (
            <p className="p-3 text-sm text-muted-foreground">No matches.</p>
          ) : (
            <ul className="divide-y">
              {filtered.map((t) => (
                <li key={t.id}>
                  <button type="button" onClick={() => runTarget(t)} className="flex w-full flex-col items-start px-3 py-2 text-start hover:bg-accent">
                    <span className="text-sm">{t.title}</span>
                    <span className="text-xs text-muted-foreground">{t.languageNameInEnglish} · {t.id}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </ScrollArea>
        {error && <p className="text-sm text-destructive">{error}</p>}
      </div>
    )
  }

  // Preview screen (AQU-310): everything below is parsed, nothing is uploaded.
  const includedBooks = plan?.books.filter((b) => !excluded.has(b.book.bookId.toUpperCase())) ?? []
  const includedCells = includedBooks.reduce((n, b) => n + b.cellCount, 0)
  const language = plan ? (plan.project.settings.language || plan.project.settings.languageIsoCode || "") : ""

  function toggleBook(bookId: string) {
    const key = bookId.toUpperCase()
    setExcluded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  return (
    <div className="flex flex-col gap-3 py-2">
      <div>
        <p className="text-sm font-medium">
          Paratext project detected — {plan ? plan.books.length : bookCount} book{(plan ? plan.books.length : bookCount) === 1 ? "" : "s"}
        </p>
        <p className="text-xs text-muted-foreground">
          {plan
            ? <>{language && <>Language: {language} · </>}{formatNumber(includedCells, locale)} cells parsed in your browser — review, then choose how to bring it in.</>
            : "Reading project…"}
        </p>
      </div>
      {plan && (
        // Native overflow scroll: ScrollArea's size-full viewport can't resolve
        // against a max-h-only root, so long book lists paint past the border.
        <div className="max-h-56 overflow-y-auto rounded border">
          <ul className="divide-y">
            {plan.books.map((b) => {
              const key = b.book.bookId.toUpperCase()
              const included = !excluded.has(key)
              const expanded = expandedBook === key
              return (
                <li key={key}>
                  <div className="flex items-center gap-2 px-3 py-1.5">
                    <Checkbox
                      checked={included}
                      onCheckedChange={() => toggleBook(b.book.bookId)}
                      aria-label={`Include ${b.book.displayName}`}
                    />
                    <button
                      type="button"
                      onClick={() => setExpandedBook(expanded ? null : key)}
                      className="flex min-w-0 flex-1 items-baseline gap-2 text-start"
                      aria-label="Show the first parsed cells"
                    >
                      <span className={`truncate text-sm ${included ? "" : "text-muted-foreground line-through"}`}>{b.book.displayName}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {b.book.bookId} · {formatNumber(b.cellCount, locale)} cells
                        {b.duplicateRefs.length > 0 && <span className="text-amber-600"> · {b.duplicateRefs.length} duplicate ref{b.duplicateRefs.length === 1 ? "" : "s"}</span>}
                      </span>
                    </button>
                  </div>
                  {expanded && (
                    <ul className="space-y-1 px-3 pb-2 ps-9">
                      {b.strings.slice(0, 4).map((s) => (
                        <li key={s.id} className="truncate text-xs text-muted-foreground">
                          {/* AQU-580: Paratext books are raw USFM — strip the
                              intra-cell markers (\add, \nd, \f…\f*, \w…\w*, …)
                              for the preview so translators never see backslash
                              codes. Stored cell text (s.original) is untouched;
                              only this display is cleaned. */}
                          <span className="font-medium">{s.context}</span> {usfmDisplayText(s.original)}
                        </li>
                      ))}
                      {b.strings.length > 4 && (
                        <li className="text-xs text-muted-foreground/70">… {formatNumber(b.strings.length - 4, locale)} more</li>
                      )}
                    </ul>
                  )}
                </li>
              )
            })}
          </ul>
        </div>
      )}
      <p className="text-xs text-muted-foreground">How should we bring it in?</p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <button type="button" onClick={runSource} disabled={!plan || includedBooks.length === 0} className="rounded-lg border p-3 text-start transition-colors hover:border-primary hover:bg-primary/5 disabled:cursor-not-allowed disabled:opacity-50">
          <p className="text-sm font-medium">Source text</p>
          <p className="mt-1 text-xs text-muted-foreground">A reference Bible to translate from. Books import as source cells.</p>
        </button>
        <button type="button" onClick={startTarget} disabled={!plan || includedBooks.length === 0} className="rounded-lg border p-3 text-start transition-colors hover:border-primary hover:bg-primary/5 disabled:cursor-not-allowed disabled:opacity-50">
          <p className="text-sm font-medium">Translation in progress</p>
          <p className="mt-1 text-xs text-muted-foreground">Your team's target text. We'll pair it with a source Bible by verse.</p>
        </button>
      </div>
      <div>
        <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  )
}
