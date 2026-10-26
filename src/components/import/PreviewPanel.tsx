/**
 * AQU-310: Preview panel — shows parsed cells before the upload is committed.
 *
 * Displayed between "file selected" and "upload starts". The user sees:
 *  - file name(s) + cell count(s)
 *  - first N cell snippets (original text + canonical ref when present)
 *  - Confirm button → triggers the actual bulk upload
 *  - Cancel button → returns to the upload screen without any network calls
 *
 * AQU-430: After Confirm is clicked the panel switches to an in-progress view
 * that shows upload phase text and a progress bar (when counts are available).
 * The Confirm button is disabled and shows a spinner label so the import is
 * never mistaken for "doing nothing".
 */

import { useMemo, useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import type { ImportResult } from "@/lib/import"
import type { ReimportChangeCounts } from "@/lib/import/reimport-diff"
import { ReimportAnalysis } from "@/components/import/ReimportAnalysis"
import { UsfmStructureFindings } from "@/components/import/UsfmStructureFindings"
import {
  FramesAsHundredthsNotice,
  type FramesAsHundredthsChoice,
} from "@/components/import/FramesAsHundredthsNotice"
import { convertFramesAsHundredths, type FrameRateLabel } from "@/lib/parsers/frame-timecode"
import { formatBytesProgress } from "@/lib/format-bytes"
import {
  defaultEpubSkipMemberPaths,
  filterEpubStrings,
  type EpubSpineMember,
} from "@/lib/parsers/epub"
import { usfmDisplayText } from "@/lib/parsers/usfm-display"
import { useI18n, useT } from "@/lib/i18n/I18nProvider"
import { formatNumber } from "@/lib/i18n/format"

/**
 * Live upload progress surfaced from the importer. `count`/`total` are cells;
 * `bytesReceived`/`bytesTotal` (AQU-520) are the byte size of the import so the
 * UI can show a "X / Y MB" readout alongside the cell count.
 */
export interface ImportUploadProgress {
  count: number
  total: number
  bytesReceived?: number
  bytesTotal?: number
}

export interface PreviewConfirmOptions {
  skipMemberPaths?: ReadonlySet<string>
  reimportChoice?: "update" | "updated-copy" | "blank"
  /** AQU-2197: subtitle files (by result name) whose cue times the person
   *  chose to convert from frames-written-as-hundredths, and at which rate. */
  frameRates?: ReadonlyMap<string, FrameRateLabel>
}

export interface PreviewPanelProps {
  /** One entry per file; USFM may produce multiple results (one per book). */
  results: ImportResult[]
  /** Called when the user clicks Confirm — triggers the actual upload. */
  onConfirm: (options?: PreviewConfirmOptions) => void | Promise<void>
  /** Called when the user cancels — parent returns to the upload screen. */
  onCancel: () => void
  /**
   * AQU-430: Live upload phase string from the parent (e.g. "Uploading foo.docx…").
   * When provided, shown instead of a generic "Uploading…" label during in-flight.
   */
  uploadPhase?: string
  /**
   * AQU-430: Cell-level upload progress from the parent. Drives the progress bar.
   * When provided alongside a non-zero total, a determinate bar is rendered.
   */
  uploadProgress?: ImportUploadProgress | null
  /**
   * AQU-430 (fix): a commit error surfaced from the parent. When set, it is shown
   * above the actions so a failed import is never mistaken for success or a hang —
   * the Confirm/Cancel buttons remain so the user can retry or back out.
   */
  error?: string | null
  /** Sidebar re-import: the footer is the three choices instead of Confirm. */
  reimport?: boolean
  /** Added and updated counts for a sidebar re-import, once the file's cells have loaded. */
  reimportChanges?: ReimportChangeCounts | null
}

/** Max cells to show in the snippet list per result. */
const PREVIEW_LIMIT = 20

export function PreviewPanel({ results, onConfirm, onCancel, uploadPhase, uploadProgress, error, reimport = false, reimportChanges = null }: PreviewPanelProps) {
  const { locale } = useI18n()
  const t = useT()
  const [confirming, setConfirming] = useState(false)
  const epubMembers = useMemo(
    () => results.flatMap((result) => result.epubMembers ?? []),
    [results],
  )
  const [skipMemberPaths, setSkipMemberPaths] = useState<ReadonlySet<string>>(
    () => defaultEpubSkipMemberPaths(epubMembers),
  )

  // AQU-2197: one choice per subtitle file whose times are frames written as
  // hundredths, starting on the suggested rate. The preview's cue list shows
  // the times the import will actually write.
  const [frameChoices, setFrameChoices] = useState<ReadonlyMap<string, FramesAsHundredthsChoice>>(
    () => new Map(results.flatMap((r) => (r.framesAsHundredths ? [[r.name, r.framesAsHundredths.suggested] as const] : []))),
  )
  const frameRates = useMemo(
    () => new Map([...frameChoices].filter((entry): entry is [string, FrameRateLabel] => entry[1] !== "keep")),
    [frameChoices],
  )

  const visibleResults = useMemo(
    () => results.map((result) => {
      const rate = result.framesAsHundredths ? frameRates.get(result.name) : undefined
      const strings = rate ? convertFramesAsHundredths(result.strings, rate) : result.strings
      return result.epubMembers
        ? { ...result, strings: filterEpubStrings(strings, skipMemberPaths) }
        : strings === result.strings ? result : { ...result, strings }
    }),
    [results, skipMemberPaths, frameRates],
  )
  const totalCells = visibleResults.reduce((n, r) => n + r.strings.length, 0)

  function toggleMember(memberPath: string) {
    const key = memberPath.toLowerCase()
    setSkipMemberPaths((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  async function handleConfirm(choice?: PreviewConfirmOptions["reimportChoice"]) {
    if (confirming || totalCells === 0) return
    setConfirming(true)
    try {
      await onConfirm({
        ...(epubMembers.length > 0 ? { skipMemberPaths } : {}),
        ...(choice ? { reimportChoice: choice } : {}),
        ...(frameRates.size > 0 ? { frameRates } : {}),
      })
    } finally {
      setConfirming(false)
    }
  }

  // AQU-430: after Confirm is clicked, show an in-progress view so the upload is
  // never mistaken for doing nothing (the preview cell list disappears, replaced
  // by phase text + optional progress bar).
  if (confirming) {
    const phase = uploadPhase || t("common.uploading")
    const hasProgress = uploadProgress && uploadProgress.total > 0
    return (
      <div className="flex flex-col items-center gap-4 py-8 text-center">
        <p className="text-sm font-medium" data-testid="preview-upload-phase">{phase}</p>
        {hasProgress ? (
          <>
            <div className="w-full max-w-xs overflow-hidden rounded-full bg-muted h-2">
              <div
                className="h-full bg-primary transition-all"
                style={{ width: `${Math.round((uploadProgress.count / uploadProgress.total) * 100)}%` }}
                data-testid="preview-upload-progress-bar"
              />
            </div>
            <p className="text-xs text-muted-foreground">
              {t("importExport.upload.cellsProgress", {
                count: formatNumber(uploadProgress.count, locale),
                total: formatNumber(uploadProgress.total, locale),
              })}
              {uploadProgress.bytesTotal ? (
                <>
                  {" · "}
                  <span data-testid="preview-upload-bytes">
                    {formatBytesProgress(uploadProgress.bytesReceived, uploadProgress.bytesTotal, locale)}
                  </span>
                </>
              ) : null}
            </p>
          </>
        ) : (
          <p className="text-xs text-muted-foreground">{t("importExport.action.working")}</p>
        )}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4 py-2">
      <div>
        <p className="text-sm font-medium">
          {t("importExport.preview.headerSummary", {
            cells: t("common.cellCount", { count: formatNumber(totalCells, locale) }),
            files: t("search.expanded.fileCount", { count: results.length }),
          })}
        </p>
        <p className="text-xs text-muted-foreground">
          {t("importExport.preview.instructions")}
        </p>
      </div>

      {epubMembers.length > 0 && (
        <EpubChapterPicker
          members={epubMembers}
          skipMemberPaths={skipMemberPaths}
          onToggle={toggleMember}
        />
      )}

      {/* Native overflow scroll: ScrollArea's size-full viewport can't resolve
          against a max-h-only root, so content paints past the border. */}
      <div className="max-h-80 overflow-y-auto rounded-md border">
        <div className="divide-y">
          {visibleResults.map((r, ri) => {
            // AQU-580: USFM cell text is stored raw (lossless), so strip the
            // intra-cell markers for the preview — a translator should never
            // see backslash codes. Non-USFM formats are shown verbatim.
            const isUsfm = r.rawSourceFormat === "usfm"
            const previewText = (original: string) =>
              isUsfm ? usfmDisplayText(original) : original
            return (
            <div key={ri} className="p-3">
              <p className="mb-2 text-xs font-semibold text-foreground/80">
                {r.name}
                <span className="ms-2 font-normal normal-case text-muted-foreground">
                  {t("common.cellCount", { count: formatNumber(r.strings.length, locale) })}
                </span>
              </p>
              {r.importClassification ? (
                <div className="mb-3 rounded-md border bg-muted/40 px-3 py-2 text-xs" data-testid="ai-import-classification">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{t("importExport.preview.aiAssistedStructure")}</span>
                    <Badge variant="outline">
                      {r.importClassification.category}
                    </Badge>
                    <span className="text-muted-foreground">
                      {t("importExport.preview.confidencePercent", {
                        percent: Math.round(r.importClassification.confidence * 100),
                      })}
                    </span>
                    {r.importClassification.confidence < 0.7 ? (
                      <Badge variant="destructive">{t("importExport.preview.needsCarefulReview")}</Badge>
                    ) : null}
                  </div>
                  <p className="mt-1 text-muted-foreground">{r.importClassification.explanation}</p>
                  <p className="mt-1 text-muted-foreground">
                    {t("importExport.preview.recipeNote", { name: r.importClassification.recipe.name })}
                  </p>
                </div>
              ) : null}
              {r.structureFindings?.length ? (
                <UsfmStructureFindings findings={r.structureFindings} />
              ) : null}
              {r.framesAsHundredths ? (
                <FramesAsHundredthsNotice
                  finding={r.framesAsHundredths}
                  choice={frameChoices.get(r.name) ?? r.framesAsHundredths.suggested}
                  onChange={(choice) => setFrameChoices((prev) => new Map(prev).set(r.name, choice))}
                />
              ) : null}
              {r.importNotices?.length ? (
                <div className="mb-3 flex flex-col gap-1.5 rounded-md border bg-muted/40 px-3 py-2 text-xs" data-testid="import-preview-notices">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{t("importExport.preview.reviewBeforeImporting")}</span>
                    <Badge variant="outline">{r.importNotices.length}</Badge>
                  </div>
                  <ul className="flex list-disc flex-col gap-1 ps-4 text-muted-foreground">
                    {r.importNotices.map((notice, index) => (
                      <li key={`${notice.code}-${index}`}>{notice.message}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              <ul className="space-y-1">
                {r.strings.slice(0, PREVIEW_LIMIT).map((s, i) => (
                  <li key={i} className="flex items-start gap-2 text-xs">
                    {s.type === "heading" || s.type === "paratext" ? (
                      <span className="shrink-0 font-mono text-muted-foreground w-20 truncate" aria-label={t("importExport.preview.structuralContentAriaLabel")}>
                        —
                      </span>
                    ) : s.globalReferences?.[0] ? (
                      <span className="shrink-0 font-mono text-muted-foreground w-20 truncate">
                        {s.globalReferences[0]}
                      </span>
                    ) : (
                      <span className="shrink-0 font-mono text-muted-foreground w-20 truncate">
                        {s.context || `#${i + 1}`}
                      </span>
                    )}
                    <span className="truncate text-foreground/80">
                      {previewText(s.original) || <span className="italic text-muted-foreground">{t("editor.note.empty")}</span>}
                    </span>
                  </li>
                ))}
                {r.strings.length > PREVIEW_LIMIT && (
                  <li className="text-xs text-muted-foreground italic">
                    {t("importExport.dialog.andMore", {
                      count: formatNumber(r.strings.length - PREVIEW_LIMIT, locale),
                    })}
                  </li>
                )}
              </ul>
            </div>
            )
          })}
        </div>
      </div>

      {error && (
        <p
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
          role="alert"
          data-testid="preview-commit-error"
        >
          {t("importExport.preview.commitFailed", { error })}
        </p>
      )}

      <div className="flex flex-col items-end gap-2">
        {reimport && (
          <div className="flex w-full flex-col gap-2">
            {reimportChanges && <ReimportAnalysis changes={reimportChanges} />}
            <p className="text-xs text-muted-foreground">{t("importExport.reimport.hint")}</p>
          </div>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" onClick={onCancel} disabled={confirming}>
            {t("common.cancel")}
          </Button>
          {reimport ? (
            <>
              <Button variant="outline" onClick={() => { void handleConfirm("blank") }} disabled={confirming || totalCells === 0}>
                {t("importExport.reimport.blankCopy")}
              </Button>
              <Button variant="outline" onClick={() => { void handleConfirm("updated-copy") }} disabled={confirming || totalCells === 0}>
                {t("importExport.reimport.updatedCopy")}
              </Button>
              <Button onClick={() => { void handleConfirm("update") }} disabled={confirming || totalCells === 0}>
                {t("importExport.reimport.update")}
              </Button>
            </>
          ) : (
            <Button onClick={() => { void handleConfirm() }} disabled={confirming || totalCells === 0}>
              {t("importExport.preview.confirmImport")}
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

function EpubChapterPicker({
  members,
  skipMemberPaths,
  onToggle,
}: {
  members: EpubSpineMember[]
  skipMemberPaths: ReadonlySet<string>
  onToggle: (memberPath: string) => void
}) {
  const { locale } = useI18n()
  const t = useT()

  function roleLabel(role: EpubSpineMember["role"]) {
    switch (role) {
      case "chapter": return t("importExport.preview.epubRoleChapter")
      case "nav": return t("importExport.preview.epubRoleNavigation")
      case "cover": return t("importExport.preview.epubRoleCover")
      case "notes": return t("importExport.preview.epubRoleNotes")
      case "empty": return t("importExport.preview.epubRoleEmpty")
    }
  }

  return (
    <div className="rounded-md border" data-testid="epub-chapter-picker">
      <p className="border-b px-3 py-2 text-xs font-medium">
        {t("importExport.preview.epubChaptersTitle")}
      </p>
      <ul className="max-h-40 divide-y overflow-y-auto">
        {members.map((member) => {
          const included = !skipMemberPaths.has(member.memberPath.toLowerCase())
          return (
            <li key={member.memberPath} className="flex items-center gap-2 px-3 py-1.5">
              <Checkbox
                checked={included}
                disabled={member.cellCount === 0}
                onCheckedChange={() => onToggle(member.memberPath)}
                aria-label={t("importExport.preview.includeEpubMember", { title: member.title })}
              />
              <span className={`min-w-0 flex-1 truncate text-sm ${included ? "" : "text-muted-foreground line-through"}`}>
                {member.title}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {roleLabel(member.role)}
                {member.cellCount > 0
                  ? ` · ${t("common.cellCount", { count: formatNumber(member.cellCount, locale) })}`
                  : ""}
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
