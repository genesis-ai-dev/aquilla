// Door43 (DCS) catalog browser (spec §9.1). Filter released Resource Containers
// by language / subject / owner / stage against the DCS Catalog search, list the
// matches, and hand the chosen entry back to the caller. The caller (ImportDialog)
// runs importDcsResource + persists the cursor — this component is search + pick
// only, so it stays reusable for the aligned-target flow too.

import { useCallback, useEffect, useRef, useState } from "react"
import { Search, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { DcsClient, type CatalogSearchParams } from "@/lib/dcs/catalog"
import type { DcsCatalogEntry } from "@/lib/dcs/types"

// Sentinel for "any" in the Select — Base UI/Radix selects can't carry an empty
// string value, so we map this back to `undefined` when building the query.
const ANY = "__any__"

/** Owners users start from most often. `unfoldingWord` is the English upstream
 *  author; the rest are the largest Gateway-Language orgs. Free-text owner is
 *  also allowed via the input below. */
const OWNER_OPTIONS = ["unfoldingWord", "Door43-Catalog", "STR", "es-419_gl", "ru_gl"]

/** Subjects we surface as first-class filters. The catalog holds more, but these
 *  cover the v1 resource stack (spec §4). "Any" leaves the filter off. */
const SUBJECT_OPTIONS = [
  "Aligned Bible",
  "Bible",
  "Greek New Testament",
  "Hebrew Old Testament",
  "Open Bible Stories",
  "TSV Translation Notes",
  "TSV Translation Questions",
  "Translation Words",
  "Translation Academy",
]

/** Release stages (spec §6 — track prod releases by default). */
const STAGE_OPTIONS: { value: string; label: string }[] = [
  { value: "prod", label: "Released (prod)" },
  { value: "preprod", label: "Pre-release" },
  { value: "latest", label: "Latest (HEAD)" },
]

export interface DcsCatalogBrowserProps {
  /** Called with the picked catalog entry. The parent runs the import. */
  onPick: (entry: DcsCatalogEntry) => void
  /** Injected in tests to mock the network; defaults to a real DcsClient. */
  client?: DcsClient
  /** Pre-seed the language filter (e.g. the project's source language). */
  defaultLang?: string
}

function formatReleased(iso: string): string {
  if (!iso) return ""
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ""
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })
}

export function DcsCatalogBrowser({ onPick, client, defaultLang }: DcsCatalogBrowserProps) {
  // A stable client instance across renders (real network unless injected).
  const clientRef = useRef<DcsClient>(client ?? new DcsClient())

  const [lang, setLang] = useState(defaultLang ?? "en")
  const [owner, setOwner] = useState<string>("unfoldingWord")
  const [ownerText, setOwnerText] = useState("")
  const [subject, setSubject] = useState<string>(ANY)
  const [stage, setStage] = useState<string>("prod")

  const [results, setResults] = useState<DcsCatalogEntry[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Guards against a slow search overwriting a newer one (AD-3 read pattern).
  const searchSeq = useRef(0)

  const runSearch = useCallback(async () => {
    const seq = ++searchSeq.current
    setLoading(true)
    setError(null)
    const effectiveOwner = ownerText.trim() || (owner === ANY ? "" : owner)
    const params: CatalogSearchParams = {
      ...(lang.trim() ? { lang: lang.trim() } : {}),
      ...(effectiveOwner ? { owner: effectiveOwner } : {}),
      ...(subject !== ANY ? { subject } : {}),
      ...(stage ? { stage } : {}),
      limit: 100,
    }
    try {
      const rows = await clientRef.current.searchCatalog(params)
      if (seq !== searchSeq.current) return // a newer search superseded us
      setResults(rows)
    } catch (err) {
      if (seq !== searchSeq.current) return
      setError(err instanceof Error ? err.message : "Catalog search failed")
      setResults([])
    } finally {
      if (seq === searchSeq.current) setLoading(false)
    }
  }, [lang, owner, ownerText, subject, stage])

  // Run an initial search on mount so the panel isn't empty.
  useEffect(() => {
    void runSearch()
    // Only on mount — subsequent searches are user-triggered via the button /
    // Enter key. runSearch is stable enough; deps intentionally omitted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="flex flex-col gap-3 py-1">
      <p className="text-xs text-muted-foreground">
        Browse released resources on{" "}
        <a
          href="https://git.door43.org"
          target="_blank"
          rel="noreferrer"
          className="underline"
        >
          Door43
        </a>
        . Importing pins the project to the chosen release; you can pull later
        changes from the project&apos;s settings. Bible (USFM) resources import today;
        more resource types are rolling out.
      </p>

      {/* Filters */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">Language</span>
          <Input
            value={lang}
            onChange={(e) => setLang(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void runSearch() }}
            placeholder="en, es-419, hbo…"
            aria-label="Language code"
            className="h-8 text-sm"
          />
        </label>

        <label className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">Owner</span>
          <Select
            value={ownerText.trim() ? ANY : owner}
            onValueChange={(v) => { setOwner(v ?? ANY); setOwnerText("") }}
          >
            <SelectTrigger className="h-8 text-sm" aria-label="Owner">
              <SelectValue placeholder="Any owner" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>Any owner</SelectItem>
              {OWNER_OPTIONS.map((o) => (
                <SelectItem key={o} value={o}>{o}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>

        <label className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">Subject</span>
          <Select value={subject} onValueChange={(v) => setSubject(v ?? ANY)}>
            <SelectTrigger className="h-8 text-sm" aria-label="Subject">
              <SelectValue placeholder="Any subject" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>Any subject</SelectItem>
              {SUBJECT_OPTIONS.map((s) => (
                <SelectItem key={s} value={s}>{s}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>

        <label className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">Stage</span>
          <Select value={stage} onValueChange={(v) => setStage(v ?? "prod")}>
            <SelectTrigger className="h-8 text-sm" aria-label="Stage">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STAGE_OPTIONS.map((s) => (
                <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
      </div>

      <div className="flex items-center gap-2">
        <Input
          value={ownerText}
          onChange={(e) => setOwnerText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void runSearch() }}
          placeholder="…or type any owner (overrides the picker)"
          aria-label="Custom owner"
          className="h-8 flex-1 text-sm"
        />
        <Button size="sm" onClick={() => void runSearch()} disabled={loading}>
          {loading ? <Spinner className="size-4" /> : <Search className="size-4" />}
          Search
        </Button>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {/* Results — native scroll (ScrollArea's size-full viewport can't resolve
          against a max-h-only root; long lists would paint past the border). */}
      <div className="max-h-72 overflow-y-auto rounded border">
        {loading && results === null ? (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
            <Spinner className="size-4" /> Loading catalog…
          </div>
        ) : results && results.length > 0 ? (
          <ul className="divide-y">
            {results.map((entry) => (
              <li key={`${entry.fullName}@${entry.ref}`}>
                <button
                  type="button"
                  onClick={() => onPick(entry)}
                  className="flex w-full flex-col items-start gap-1 px-3 py-2 text-left hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
                >
                  <div className="flex w-full items-baseline gap-2">
                    <span className="truncate text-sm font-medium">{entry.fullName}</span>
                    {entry.ref && (
                      <Badge variant="secondary" className="shrink-0 px-1.5 py-0 text-[10px]">
                        {entry.ref}
                      </Badge>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                    {entry.subject && <span>{entry.subject}</span>}
                    {entry.language && <span>· {entry.languageTitle || entry.language}</span>}
                    {entry.released && <span>· {formatReleased(entry.released)}</span>}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <div className="flex flex-col items-center gap-1 py-8 text-center text-sm text-muted-foreground">
            <RefreshCw className="size-4 opacity-60" />
            <p>No released resources match these filters.</p>
            <p className="text-xs">Try a broader language, owner, or subject.</p>
          </div>
        )}
      </div>
    </div>
  )
}
