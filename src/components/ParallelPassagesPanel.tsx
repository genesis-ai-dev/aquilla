// Phase v1.x: ParallelPassagesPanel — project-wide FTS5-backed search dialog.
//
// Replace mode (AQU-177): inline diff preview before applying.
// Scope toggle works: "file" filters client-side on the activeFileId after
// the project-wide fetch; "project" returns all hits.

import { useState, useEffect, useRef, useCallback, type ReactNode } from "react"
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import { Checkbox } from "@/components/ui/checkbox"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { Skeleton } from "@/components/ui/skeleton"
import { AppTooltip } from "@/components/ui/tooltip"
import { Button } from "@/components/ui/button"
import { TableEmptyState } from "@/components/ui/empty"
import { PageHeader } from "@/components/ui/page"
import { SegmentTabs } from "@/components/ui/tabs"
import type { WorkspaceSearchResult, SearchOptions, FindToggles } from "@/lib/search/workspace-index"
import { assignMatchPlaces, type AssignedMatchPlace } from "@/lib/search/match-location"
import { computeReplaceDiffs, type CellReplaceDiff } from "@/lib/search/replace-action"
import { FindOptionToggles, PreserveCaseToggle } from "@/components/search/FindOptionToggles"
import {
  findPatternError,
  findTextMatches,
  replacementForMatch,
  type TextReplaceOptions,
} from "../../db/shared/find-pattern"
import { useI18n } from "@/lib/i18n/I18nProvider"
import { formatCount } from "@/lib/i18n/format"
import type { TFunction } from "@/lib/i18n/I18nProvider"
import { Replace, Search } from "lucide-react"
import { toast } from "@/components/ui/toast"

export type ParallelPanelMode = "search" | "passages" | "replace"
export type ParallelPanelScope = "file" | "project"
export type ParallelPanelSide = "both" | "source" | "target"

/**
 * Called when the user confirms Replace All.
 * Carries the computed diffs so the caller (ProjectWorkspace) can look up
 * parentId/sourceEventId from its `cells` state and emit target.cell.commit
 * events. The panel does not own the commit path — it owns the preview only.
 *
 * SWARM-TODO (ProjectWorkspace.tsx): Add `onReplaceAll` prop to the
 * <ParallelPassagesPanel> call site (around line 2828) and wire it to a
 * `handleReplaceAll` function that:
 *   1. Maps each diff.cellId → cells.find(c => c.id === diff.cellId) to get
 *      the current parentId (c.currentEventId) and sourceEventId (c.sourceEventId).
 *   2. Calls emitTargetCellCommit for each diff with searchQuery=findQuery,
 *      replaceString=replaceQuery.
 *   3. Calls revalidateCells() after all commits are enqueued, then onAfterReplace?.().
 */
export interface ReplaceAllPayload {
  diffs: CellReplaceDiff[]
  totalReplaced: number
  totalSkipped: number
  findQuery: string
  replaceQuery: string
  /**
   * Always false — the "Retain my validations" checkbox was removed (AQU-286).
   * Replacing text advances the cell's chain head; per Q25 (event-anchored
   * validation) prior validations drop automatically and must be re-reviewed.
   * Field kept for backward compat with the ProjectWorkspace call site.
   */
  retainValidations: false
}

interface ParallelPassagesPanelProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  mode: ParallelPanelMode
  scope: ParallelPanelScope
  onScopeChange?: (s: ParallelPanelScope) => void
  onModeChange?: (m: ParallelPanelMode) => void

  activeFileId?: string | null
  activeFileName?: string | null
  activeDoc?: unknown

  loading?: boolean
  ready?: boolean
  results?: WorkspaceSearchResult[]
  onReady?: () => void | Promise<void>
  onSearch?: (query: string, options: SearchOptions) => void | Promise<void>
  /** Called when in "passages" mode — routes to searchParallelPassages. */
  onSearchPassages?: (query: string) => void
  onClear?: () => void
  /** Called by ProjectWorkspace to clear results (synonym for onClear). */
  onClearResults?: () => void
  onSelect?: (result: WorkspaceSearchResult, query: string) => void | Promise<void>

  /**
   * AQU-177: Replace mode commit handler. Called when the user clicks
   * "Replace All" or "Replace this cell". The panel has computed the diffs;
   * the caller owns the actual event-emit path.
   *
   * SWARM-TODO: wire this in ProjectWorkspace.tsx ~line 2828.
   */
  onReplaceAll?: (payload: ReplaceAllPayload) => Promise<void> | void

  /**
   * Query to seed when the dialog opens, so Find & Replace continues the
   * dock search instead of making the reviewer retype it.
   */
  initialQuery?: string
  /** Find-widget toggles seeded with `initialQuery` when the dialog opens. */
  initialFind?: FindToggles

  /** Passed from ProjectWorkspace for role-gating the Replace button. */
  isReadOnly?: boolean

  [extraProp: string]: unknown
}

// ---------------------------------------------------------------------------
// Snippet renderer: preserves <mark> HTML from FTS5 by splitting on tags.
// The server only ever emits <mark>...</mark> — no other tags are injected.
// We walk the string manually so no raw HTML is set on the DOM.
// ---------------------------------------------------------------------------
function Snippet({ html }: { html: string }) {
  const parts = html.split(/(<mark>.*?<\/mark>)/g)
  return (
    <span>
      {parts.map((part, i) => {
        const match = part.match(/^<mark>(.*)<\/mark>$/)
        if (match) {
          return (
            <mark
              key={i}
              className="bg-yellow-200 dark:bg-yellow-800/80 text-inherit rounded-[3px] px-0.5 not-italic"
            >
              {match[1]}
            </mark>
          )
        }
        return <span key={i}>{part}</span>
      })}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Inline replace preview, drawn inside a find result the way VS Code draws a
// replacement: the matched word stays in the sentence, struck through, and
// the replacement sits immediately after it.
// ---------------------------------------------------------------------------
function InlineReplacePreview({
  text,
  needle,
  replacement,
  options,
}: {
  text: string
  needle: string
  replacement: string
  options: TextReplaceOptions
}) {
  const plain = text.replace(/<\/?mark>/g, "")
  if (!needle || findPatternError(needle, options)) return <Snippet html={text} />
  const nodes: ReactNode[] = []
  let cursor = 0
  for (const match of findTextMatches(plain, needle, options)) {
    const index = match.index
    const word = match.text
    if (index < cursor) continue
    if (index > cursor) nodes.push(<span key={nodes.length}>{plain.slice(cursor, index)}</span>)
    if (/<|>/.test(word)) {
      nodes.push(<span key={nodes.length}>{word}</span>)
    } else {
      const next = replacementForMatch(match, replacement, options)
      nodes.push(
        <mark
          key={nodes.length}
          className="rounded-[3px] bg-red-200 px-0.5 text-inherit line-through decoration-red-600 dark:bg-red-900/70 dark:decoration-red-400"
        >
          {word}
        </mark>,
      )
      if (next) {
        nodes.push(
          <mark
            key={nodes.length}
            className="rounded-[3px] bg-emerald-200 px-0.5 text-inherit not-italic dark:bg-emerald-800/70"
          >
            {next}
          </mark>,
        )
      }
    }
    cursor = index + word.length
  }
  if (nodes.length === 0) return <Snippet html={text} />
  if (cursor < plain.length) nodes.push(<span key={nodes.length}>{plain.slice(cursor)}</span>)
  return <span className="whitespace-pre-wrap wrap-break-word">{nodes}</span>
}

/** The place printed above a match, and spoken as its name. Never a raw id. */
function formatMatchPlace(assigned: AssignedMatchPlace, t: TFunction): string {
  const place = assigned.place
  const base =
    place.kind === "filePosition"
      ? t("search.replace.filePosition", { fileName: place.fileName, position: place.position })
      : place.kind === "line"
        ? t("search.replace.linePosition", { position: place.position })
        : place.kind === "unnamed"
          ? t("search.replace.unnamedPlace")
          : place.text
  const location = t("search.replace.cellLocation", { location: base })
  return assigned.index != null && assigned.total != null
    ? t("search.replace.samePlace", { location, index: assigned.index, total: assigned.total })
    : location
}

// ---------------------------------------------------------------------------
// Result row content (search mode — rendered inside CommandItem)
// ---------------------------------------------------------------------------
function SearchResultContent({
  result,
  t,
  replaceMode = false,
  replaceNeedle = "",
  replaceValue = "",
  replaceOptions,
  matchCount = 0,
  selected = false,
  onToggleInclude,
  location,
}: {
  result: WorkspaceSearchResult
  t: TFunction
  replaceMode?: boolean
  replaceNeedle?: string
  replaceValue?: string
  replaceOptions?: TextReplaceOptions
  matchCount?: number
  selected?: boolean
  onToggleInclude?: (cellId: string) => void
  location: string
}) {
  const isSourceHit = result.original !== ""
  const showInlineDiff = replaceMode && !isSourceHit && replaceNeedle.trim() !== ""
  const body = result.snippet || result.original || result.translated
  const hasPaired = result.paired != null && result.paired !== ""
  const showBothSides = replaceMode || hasPaired
  const targetBody = isSourceHit ? (hasPaired ? result.paired : "") : body
  const sourceBody = isSourceHit ? body : hasPaired ? result.paired : ""
  return (
    <div className="flex w-full items-start gap-2">
      {onToggleInclude && (
        <div
          className="pt-0.5"
          onClick={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <Checkbox
            checked={selected}
            onCheckedChange={() => onToggleInclude(result.cellId)}
            aria-label={t("search.replace.includeCellAriaLabel", { location })}
          />
        </div>
      )}
      <div className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-foreground">
          {location}
        </span>
        <div className={showBothSides ? "mt-1 flex w-full flex-col gap-2 p-0" : "mt-1"}>
          {(!isSourceHit || showBothSides) && (
            <div className="min-w-0 p-0">
              <div className="text-xs text-muted-foreground">{t("editor.column.target")}</div>
              <div className="mt-0.5 text-sm leading-snug">
                {showInlineDiff ? (
                  <InlineReplacePreview
                    text={body}
                    needle={replaceNeedle}
                    replacement={replaceValue}
                    options={replaceOptions ?? {}}
                  />
                ) : targetBody ? (
                  isSourceHit ? (
                    <span className="whitespace-pre-wrap wrap-break-word">{targetBody}</span>
                  ) : (
                    <Snippet html={targetBody} />
                  )
                ) : null}
              </div>
              {showInlineDiff && matchCount > 1 && (
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {t("search.replace.matchCount", { count: matchCount })}
                </p>
              )}
            </div>
          )}
          {(isSourceHit || showBothSides) && (
            <div className="min-w-0 p-0">
              <div className="text-xs text-muted-foreground">{t("editor.column.source")}</div>
              <div className="mt-0.5 text-sm leading-snug">
                {sourceBody ? (
                  isSourceHit ? (
                    <Snippet html={sourceBody} />
                  ) : (
                    <span className="whitespace-pre-wrap wrap-break-word">{sourceBody}</span>
                  )
                ) : replaceMode && !isSourceHit ? (
                  <span className="text-xs text-muted-foreground">{t("search.replace.noSource")}</span>
                ) : null}
              </div>
              {replaceMode && isSourceHit && (
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {t("search.replace.sourceMatchNotReplaced")}
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Loading skeletons
// ---------------------------------------------------------------------------
function ResultsLoadingSkeleton({ t }: { t: TFunction }) {
  return (
    <div role="status" aria-label={t("common.searching")}>
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="space-y-1.5 px-2 py-1.5">
          <Skeleton className="h-3.5 w-1/3" />
          <Skeleton className="h-3.5 w-full" />
          <Skeleton className="h-3 w-2/3" />
        </div>
      ))}
      <span className="sr-only">{t("common.searching")}</span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Replace draft — the field and notes live above the find results. The diff
// itself is drawn on those results, so this hook only owns the replacement
// string, which cells are included, and the apply action.
// ---------------------------------------------------------------------------
function useCellReplaceDraft({
  query,
  results,
  options,
  isReadOnly,
  onAfterReplace,
}: {
  query: string
  results: WorkspaceSearchResult[]
  options: TextReplaceOptions
  isReadOnly: boolean
  onAfterReplace?: (payload: ReplaceAllPayload) => Promise<void> | void
}) {
  const { t } = useI18n()
  const [replaceValue, setReplaceValue] = useState("")
  const [applying, setApplying] = useState(false)

  const candidates = results
    .filter((r) => !r.original)
    .map((r) => ({
      cellId: r.cellId,
      fileId: r.fileId,
      rawValue: r.translated,
      parentId: null,
      sourceEventId: null,
      sourceText: r.paired ?? null,
    }))

  const { diffs, totalReplaced, totalSkipped } =
    query.trim() && replaceValue !== undefined
      ? computeReplaceDiffs(candidates, query, replaceValue, options)
      : { diffs: [], totalReplaced: 0, totalSkipped: 0 }

  const [selected, setSelected] = useState<Set<string>>(new Set(diffs.map((d) => d.cellId)))

  useEffect(() => {
    setSelected(new Set(diffs.map((d) => d.cellId)))
  }, [diffs.length, query, replaceValue, options.matchCase, options.wholeWord, options.useRegexp]) // eslint-disable-line react-hooks/exhaustive-deps

  function toggleCell(cellId: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(cellId)) next.delete(cellId)
      else next.add(cellId)
      return next
    })
  }

  const selectedDiffs = diffs.filter((d) => selected.has(d.cellId))
  const matchCountByCell = new Map(diffs.map((diff) => [diff.cellId, diff.matchCount]))

  async function handleApply() {
    if (!selectedDiffs.length || applying || isReadOnly) return
    setApplying(true)
    const payload: ReplaceAllPayload = {
      diffs: selectedDiffs,
      totalReplaced,
      totalSkipped,
      findQuery: query,
      replaceQuery: replaceValue,
      retainValidations: false,
    }
    try {
      await onAfterReplace?.(payload)
      const replaced = selectedDiffs.reduce((n, d) => n + d.matchCount, 0)
      toast.add({
        type: "success",
        title:
          totalSkipped > 0
            ? t("search.replace.appliedResultWithSkipped", {
                count: replaced,
                skipped: totalSkipped,
              })
            : t("search.replace.appliedResult", { count: replaced }),
      })
    } finally {
      setApplying(false)
    }
  }

  return {
    replaceValue,
    setReplaceValue,
    diffs,
    totalSkipped,
    selected,
    toggleCell,
    matchCountByCell,
    selectedDiffs,
    applying,
    handleApply,
    selectAll: () => setSelected(new Set(diffs.map((d) => d.cellId))),
    selectNone: () => setSelected(new Set()),
  }
}

function ReplaceField({
  value,
  onChange,
  preserveCase,
  onPreserveCaseChange,
  disabled,
  t,
}: {
  value: string
  onChange: (value: string) => void
  preserveCase: boolean
  onPreserveCaseChange: (next: boolean) => void
  disabled: boolean
  t: TFunction
}) {
  return (
    <div data-slot="command-input-wrapper" className="w-full">
      <InputGroup className="w-full bg-card shadow-none has-disabled:bg-card has-disabled:opacity-100 has-[>[data-align=inline-end]]:[&>input]:pe-2! dark:bg-input/30 dark:has-disabled:bg-input/30">
        <InputGroupAddon>
          <Replace />
        </InputGroupAddon>
        <InputGroupInput
          placeholder={t("search.replace.placeholder")}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          aria-label={t("search.replace.ariaLabel")}
          disabled={disabled}
          className="text-sm"
        />
        <InputGroupAddon
          align="inline-end"
          className="cursor-default ps-0! pe-1.5 me-0!"
          onClick={(event) => {
            if ((event.target as HTMLElement).closest("button")) return
            event.preventDefault()
          }}
        >
          <PreserveCaseToggle
            pressed={preserveCase}
            disabled={disabled}
            onPressedChange={onPreserveCaseChange}
          />
        </InputGroupAddon>
      </InputGroup>
    </div>
  )
}

function PanelEmpty({ children }: { children: ReactNode }) {
  return <TableEmptyState icon={Search} title={children} />
}

/**
 * Teams directory search field (`TABLE_SEARCH_GROUP_CLASS` in data-table.tsx):
 * a bordered `bg-card` input, capped at `max-w-xs`, with an icon addon.
 */
const TEAM_SEARCH_FIELD = [
  "w-full max-w-xs min-w-0",
  "[&_[data-slot=command-input-wrapper]]:p-0",
  "[&_[data-slot=input-group]]:h-8! [&_[data-slot=input-group]]:w-full [&_[data-slot=input-group]]:max-w-none",
  "[&_[data-slot=input-group]]:rounded-lg! [&_[data-slot=input-group]]:border! [&_[data-slot=input-group]]:border-input!",
  "[&_[data-slot=input-group]]:bg-card! [&_[data-slot=input-group]]:shadow-none!",
  "dark:[&_[data-slot=input-group]]:bg-input/30!",
  "[&_[data-slot=input-group]]:has-disabled:bg-card [&_[data-slot=input-group]]:has-disabled:opacity-100",
  "dark:[&_[data-slot=input-group]]:has-disabled:bg-input/30",
].join(" ")

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------
const DEBOUNCE_MS = 250

export function ParallelPassagesPanel(props: ParallelPassagesPanelProps) {
  const { t, locale } = useI18n()
  const {
    open,
    onOpenChange,
    mode,
    scope,
    onScopeChange,
    onModeChange,
    activeFileId,
    activeFileName,
    loading = false,
    results = [],
    onSearch,
    onSearchPassages,
    onClear,
    onClearResults,
    onSelect,
    onReplaceAll,
    isReadOnly = false,
    onAfterReplace,
    initialQuery = "",
    initialFind,
  } = props

  // onAfterReplace is the old name passed by ProjectWorkspace (already in the
  // call site as an extra prop); onReplaceAll is the new typed prop. Prefer
  // the typed one; fall back to the extra-prop version.
  const replaceHandler = (onReplaceAll as ((p: ReplaceAllPayload) => Promise<void> | void) | undefined) ?? (onAfterReplace as ((p: ReplaceAllPayload) => Promise<void> | void) | undefined)

  const clearResults = onClearResults ?? onClear

  const [query, setQuery] = useState(initialQuery)
  const [side, setSide] = useState<ParallelPanelSide>("both")
  const [matchCase, setMatchCase] = useState(initialFind?.caseSensitive ?? false)
  const [wholeWord, setWholeWord] = useState(initialFind?.matchWord ?? false)
  const [useRegexp, setUseRegexp] = useState(initialFind?.useRegexp ?? false)
  const [preserveCase, setPreserveCase] = useState(false)
  const find: FindToggles = { caseSensitive: matchCase, matchWord: wholeWord, useRegexp }
  const replaceOptions: TextReplaceOptions = {
    matchCase,
    wholeWord,
    useRegexp,
    preserveCase,
  }
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [wasOpen, setWasOpen] = useState(false)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setMatchCase(initialFind?.caseSensitive ?? false)
      setWholeWord(initialFind?.matchWord ?? false)
      setUseRegexp(initialFind?.useRegexp ?? false)
      const seeded = initialQuery.trim()
      if (seeded) setQuery(seeded)
    } else {
      setQuery("")
    }
  }

  const triggerSearch = useCallback(
    (
      q: string,
      currentScope: ParallelPanelScope,
      currentMode: ParallelPanelMode,
      currentSide: ParallelPanelSide,
      flags: FindToggles,
    ) => {
      if (!q.trim()) {
        clearResults?.()
        return
      }
      if (currentMode === "passages") {
        onSearchPassages?.(q)
        return
      }
      if (findPatternError(q, { matchCase: flags.caseSensitive, wholeWord: flags.matchWord, useRegexp: flags.useRegexp })) {
        clearResults?.()
        return
      }
      const searchSide = currentMode === "replace" ? "target" : currentSide
      const opts: SearchOptions = {
        scope: currentScope === "file" ? "file" : "project",
        fileId: currentScope === "file" ? (activeFileId ?? undefined) : undefined,
        side: searchSide === "both" ? undefined : searchSide,
        ...(flags.caseSensitive ? { caseSensitive: true } : {}),
        ...(flags.matchWord ? { matchWord: true } : {}),
        ...(flags.useRegexp ? { useRegexp: true } : {}),
      }
      return onSearch?.(q, opts)
    },
    [activeFileId, clearResults, onSearch, onSearchPassages],
  )

  useEffect(() => {
    if (!open) {
      clearResults?.()
      return
    }
    const seeded = initialQuery.trim()
    if (!seeded) return
    triggerSearch(seeded, scope, mode, side, {
      caseSensitive: initialFind?.caseSensitive ?? false,
      matchWord: initialFind?.matchWord ?? false,
      useRegexp: initialFind?.useRegexp ?? false,
    })
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleQueryChange = (v: string) => {
    setQuery(v)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      triggerSearch(v, scope, mode, side, find)
    }, DEBOUNCE_MS)
  }

  const handleScopeChange = (s: ParallelPanelScope) => {
    onScopeChange?.(s)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    triggerSearch(query, s, mode, side, find)
  }

  const handleModeChange = (m: ParallelPanelMode) => {
    onModeChange?.(m)
    // Re-run the current query under the new mode immediately.
    if (query.trim()) {
      if (debounceRef.current) clearTimeout(debounceRef.current)
      triggerSearch(query, scope, m, side, find)
    }
  }

  const handleSideChange = (s: ParallelPanelSide) => {
    if (mode === "replace") return
    setSide(s)
    if (query.trim()) {
      if (debounceRef.current) clearTimeout(debounceRef.current)
      triggerSearch(query, scope, mode, s, find)
    }
  }

  const handleFindChange = (next: FindToggles) => {
    setMatchCase(next.caseSensitive)
    setWholeWord(next.matchWord)
    setUseRegexp(next.useRegexp)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    triggerSearch(query, scope, mode, side, next)
  }

  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      if (debounceRef.current) clearTimeout(debounceRef.current)
      triggerSearch(query, scope, mode, side, find)
    }
  }

  const dialogTitle =
    mode === "passages"
      ? t("search.dialog.titlePassages")
      : mode === "replace"
        ? t("search.dialog.titleReplace")
        : t("nav.search")

  const scopeLabel =
    scope === "file"
      ? activeFileName
        ? t("search.dialog.scopeFile", { fileName: activeFileName })
        : t("search.dialog.scopeCurrentFile")
      : t("search.dialog.scopeEntireProject")

  const patternError =
    mode !== "passages" && query.trim() !== ""
      ? findPatternError(query, replaceOptions)
      : null

  const isEmpty = !loading && results.length === 0 && query.trim() !== "" && !patternError
  const isIdle = !loading && results.length === 0 && query.trim() === ""

  const replaceDraft = useCellReplaceDraft({
    query,
    results,
    options: replaceOptions,
    isReadOnly: isReadOnly as boolean,
    onAfterReplace: async (payload) => {
      await replaceHandler?.(payload)
      // The list is still the pre-replace search. Run it again so rows that
      // no longer match drop out instead of inviting another replace.
      await triggerSearch(query, scope, mode, side, find)
    },
  })
  const allAffectedSelected =
    replaceDraft.diffs.length > 0
    && replaceDraft.diffs.every((diff) => replaceDraft.selected.has(diff.cellId))
  const someAffectedSelected = replaceDraft.selected.size > 0 && !allAffectedSelected

  const inputPlaceholder =
    mode === "passages"
      ? t("search.dialog.placeholderPassages")
      : mode === "replace"
        ? scope === "file"
          ? t("search.dialog.placeholderReplaceScoped", { scope: scopeLabel.toLowerCase() })
          : t("search.dialog.placeholderReplaceProject")
        : scope === "file"
          ? t("search.dialog.placeholderScoped", { scope: scopeLabel.toLowerCase() })
          : t("search.placeholderProject")

  // Distinct from inputPlaceholder: the placeholder keys above end in an
  // ellipsis ("…"), which must not be read aloud as part of the field's
  // accessible name (AQU-511 wave-3 finding 6).
  const inputAriaLabel =
    mode === "passages"
      ? t("search.dialog.ariaLabelPassages")
      : mode === "replace"
        ? scope === "file"
          ? t("search.dialog.ariaLabelReplaceScoped", { scope: scopeLabel.toLowerCase() })
          : t("search.dialog.ariaLabelReplaceProject")
        : scope === "file"
          ? t("search.dialog.ariaLabelScoped", { scope: scopeLabel.toLowerCase() })
          : t("search.ariaLabelProject")

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`${dialogTitle} — ${scope === "file" ? scopeLabel : "entire project"}`}
      description={inputPlaceholder}
      showCloseButton
      className="flex max-h-[46rem] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl"
    >
      <Command
        shouldFilter={false}
        className="flex max-h-[46rem] min-h-0 w-full flex-col gap-3 overflow-hidden rounded-none bg-transparent p-4"
      >
        <PageHeader title={dialogTitle} inset={false} className="mb-0 shrink-0 pe-8" />
        {/* pe-8 reserves clearance for the absolute-positioned close button */}
        <div
          className="flex shrink-0 flex-wrap items-center gap-3 pe-8"
          aria-label={t("search.dialog.controlsAriaLabel")}
        >
          <SegmentTabs<ParallelPanelScope>
            value={scope}
            aria-label={t("search.scope.label")}
            options={[
              { label: t("common.project"), value: "project" },
              {
                label: t("common.file"),
                value: "file",
                disabled: !activeFileId,
              },
            ]}
            onValueChange={handleScopeChange}
          />
          <SegmentTabs<ParallelPanelMode>
            value={mode}
            aria-label={t("search.dialog.modeLabel")}
            options={[
              { label: t("nav.search"), value: "search" },
              { label: t("search.mode.passages"), value: "passages" },
              { label: t("search.mode.replace"), value: "replace" },
            ]}
            onValueChange={handleModeChange}
          />
          <SegmentTabs<ParallelPanelSide>
            value={mode === "replace" ? "target" : side}
            aria-label={t("search.dialog.contentSideLabel")}
            options={[
              { label: t("search.side.both"), value: "both", disabled: mode === "replace" },
              { label: t("editor.column.source"), value: "source", disabled: mode === "replace" },
              { label: t("editor.column.target"), value: "target" },
            ]}
            onValueChange={handleSideChange}
          />
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-3">
          <div className={TEAM_SEARCH_FIELD}>
            <CommandInput
              placeholder={inputPlaceholder}
              value={query}
              onValueChange={handleQueryChange}
              onKeyDown={handleSearchKeyDown}
              aria-label={inputAriaLabel}
              aria-busy={loading}
              aria-invalid={patternError ? true : undefined}
              trailing={
                mode === "passages" ? undefined : (
                  <FindOptionToggles
                    matchCase={matchCase}
                    wholeWord={wholeWord}
                    useRegexp={useRegexp}
                    onMatchCaseChange={(next) => handleFindChange({ ...find, caseSensitive: next })}
                    onWholeWordChange={(next) => handleFindChange({ ...find, matchWord: next })}
                    onUseRegexpChange={(next) => handleFindChange({ ...find, useRegexp: next })}
                  />
                )
              }
            />
          </div>
          {mode === "replace" && (
            <div className={TEAM_SEARCH_FIELD}>
              <ReplaceField
                value={replaceDraft.replaceValue}
                onChange={replaceDraft.setReplaceValue}
                preserveCase={preserveCase}
                onPreserveCaseChange={setPreserveCase}
                disabled={(isReadOnly as boolean) || replaceDraft.applying}
                t={t}
              />
            </div>
          )}
        </div>
        {patternError ? (
          <p className="text-sm text-destructive" role="alert">
            {t("search.find.invalidRegexp")}
          </p>
        ) : null}

        {scope === "file" && !activeFileId && (
          <p className="text-sm text-muted-foreground" role="note">
            {t("search.dialog.openFileHint")}
          </p>
        )}

        {mode === "replace" && (
          <div className="flex shrink-0 flex-col gap-2">
            <p className="text-sm text-muted-foreground" role="note">
              {t("search.replace.clearsValidation")}
            </p>
            <p className="text-sm text-muted-foreground" role="note">
              {t("search.replace.targetOnlyReason")}
            </p>
            {replaceDraft.totalSkipped > 0 && (
              <p className="text-sm text-amber-600 dark:text-amber-400" role="note">
                {t("search.replace.skippedNotice", { count: replaceDraft.totalSkipped })}
              </p>
            )}
            <div className="flex items-center justify-between gap-2">
              {replaceDraft.diffs.length > 0 && (
                <Checkbox
                  checked={allAffectedSelected}
                  indeterminate={someAffectedSelected}
                  onCheckedChange={(checked) => {
                    if (checked === true) replaceDraft.selectAll()
                    else replaceDraft.selectNone()
                  }}
                  aria-label={allAffectedSelected ? t("search.replace.selectNone") : t("common.selectAll")}
                />
              )}
              <div className="ms-auto flex items-center gap-2">
                {/* Why it is greyed out opens on a click on it (AQU-2260). */}
                <AppTooltip
                  content={
                    (isReadOnly as boolean)
                      ? t("search.replace.readOnlyTooltip")
                      : !replaceHandler
                        ? t("search.replace.notWiredTooltip")
                        : ""
                  }
                >
                    <Button
                      type="button"
                      disabled={
                        !replaceDraft.selectedDiffs.length
                        || replaceDraft.applying
                        || (isReadOnly as boolean)
                        || !replaceHandler
                      }
                      onClick={replaceDraft.handleApply}
                      aria-busy={replaceDraft.applying}
                    >
                      {replaceDraft.applying
                        ? t("search.replace.applying")
                        : replaceDraft.selectedDiffs.length > 0
                          ? t("search.replace.applyButtonCount", { count: replaceDraft.selectedDiffs.length })
                          : t("search.replace.applyButtonAll")}
                    </Button>
                </AppTooltip>
              </div>
            </div>
          </div>
        )}

        <div className="-ms-2 -me-4 flex min-h-0 flex-1 flex-col overflow-hidden">
        <CommandList className="max-h-[46rem] min-h-0 flex-1 overflow-y-auto overscroll-contain pe-4 scrollbar-thin">
          {loading && <ResultsLoadingSkeleton t={t} />}

          {!loading && isIdle && (
            <CommandEmpty aria-live="polite" className="py-0">
              <PanelEmpty>
                {mode === "passages"
                  ? t("search.dialog.idlePassages")
                  : mode === "replace"
                    ? t("search.dialog.idleReplace")
                    : scope === "file"
                      ? t("search.dialog.idleSearchFile")
                      : t("search.dialog.idleSearchProject")}
              </PanelEmpty>
            </CommandEmpty>
          )}

          {!loading && isEmpty && (
            <CommandEmpty aria-live="polite" className="py-0">
              <PanelEmpty>
                {t("search.dialog.noResultsFor")}{" "}
                <span>&ldquo;{query}&rdquo;</span>.
              </PanelEmpty>
            </CommandEmpty>
          )}

          {!loading && results.length > 0 && (
            <CommandGroup className="p-0">
              {assignMatchPlaces(results).map((place, index) => {
                const r = results[index]
                const columnLabel = r.original
                  ? t("editor.column.source")
                  : t("editor.column.target")
                const itemKey = `${r.fileId}:${r.cellId}:${r.original ? "src" : "tgt"}`
                const location = formatMatchPlace(place, t)
                return (
                  <CommandItem
                    key={itemKey}
                    value={itemKey}
                    aria-label={`${location} — ${columnLabel}`}
                    className={
                      mode === "replace"
                        ? "flex w-full flex-col items-start rounded-md! px-2 py-1 in-data-[slot=dialog-content]:rounded-md! hover:bg-accent/40! data-selected:bg-transparent! data-selected:hover:bg-accent/40! [&>svg]:hidden"
                        : "flex w-full flex-col items-start rounded-md! px-2 py-1 in-data-[slot=dialog-content]:rounded-md! hover:bg-accent/40 data-selected:bg-accent/40! [&>svg]:hidden"
                    }
                    onSelect={() => onSelect?.(r, query)}
                  >
                    <SearchResultContent
                      result={r}
                      t={t}
                      replaceMode={mode === "replace"}
                      replaceNeedle={query}
                      replaceValue={replaceDraft.replaceValue}
                      replaceOptions={replaceOptions}
                      matchCount={replaceDraft.matchCountByCell.get(r.cellId) ?? 0}
                      selected={replaceDraft.selected.has(r.cellId)}
                      onToggleInclude={
                        mode === "replace" && !r.original ? replaceDraft.toggleCell : undefined
                      }
                      location={location}
                    />
                  </CommandItem>
                )
              })}
            </CommandGroup>
          )}
        </CommandList>

        <div className="-mb-4 flex shrink-0 items-center justify-between ps-2 pe-4 py-4">
          <span className="text-[11px] tabular-nums text-muted-foreground">
            {(results.length > 0 || (query.trim() !== "" && !loading))
              ? t("search.resultCount", { count: formatCount(results.length, locale) })
              : null}
          </span>
          <span className="max-w-[60%] truncate text-end text-[11px] text-muted-foreground">
            {scopeLabel}
          </span>
        </div>
        </div>
      </Command>
    </CommandDialog>
  )
}
