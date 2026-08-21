/**
 * Importing the client's character spreadsheet onto a file's lines.
 * (AQU-646 stage 6)
 *
 * Deliberately NOT folded into LabelImportPanel, which does almost all of this
 * already. That one round-trips a template WE generate, keyed by our own cell
 * refs — "download, fill in, re-upload". This takes a FOREIGN file the client
 * authored, keyed by timestamp. The two differ in exactly one step, and merging
 * them would thread a "where did this file come from?" branch through the whole
 * flow for no gain. Everything after the row→cell match is shared:
 * `splitCastName`, `emitCastAssign`, and the camera state it carries.
 *
 * TWO STEPS ON PURPOSE, like the audio-VTT dialog: the file is parsed and its
 * effect reported BEFORE anything is written. 650 cast assignments are not a
 * thing to discover after the fact.
 */

import { useEffect, useState } from "react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { parseCsvToSheet, parseXlsxToSheets, type SpreadsheetSheet } from "@/lib/parsers/spreadsheet"
import { decodeImportText, MAX_UNKNOWN_TEXT_BYTES } from "@/lib/import/ai-recipe"
import {
  guessCharacterColumns,
  planCharacterAssignments,
  readCharacterRows,
  type CharacterAssignmentPlan,
  type KeyableCell,
} from "@/lib/import/character-sheet"
import {
  planAudioCharacterAssignments,
  type AlignableCue,
  type AudioCharacterPlan,
} from "@/lib/import/audio-character-sheet"
import { useT } from "@/lib/i18n/I18nProvider"
import { RichMessage } from "@/lib/i18n/RichMessage"

/**
 * Which of the client's two character spreadsheets this is.
 *
 * They are keyed to opposite sides of the same script — one row per SUBTITLE
 * line, or one row per HEARD line — and either can be imported first. Whichever
 * exists reaches the other side through the links; both together are compared.
 */
export type CharacterSheetKind = "subtitle" | "audio"

interface Props {
  open: boolean
  /** The file whose lines gain characters — named so it is obvious which. */
  textFileName: string
  /** That file's cells, for timestamp keying. */
  cells: readonly KeyableCell[]
  /** The audio cues, when the file has them. Absent ⇒ only the subtitle sheet
   *  can be imported, because there is nothing for an audio sheet to key to. */
  audioCues?: readonly AlignableCue[]
  /** How many already carry a cast name; drives the replacing wording. */
  existingCount: number
  /** …and how many CUES do. The two counts are separate because the two sheets
   *  are, and replacing one must not claim to be replacing the other. */
  existingAudioCount?: number
  onConfirm(plan: CharacterAssignmentPlan): void
  onConfirmAudio?(plan: AudioCharacterPlan): void
  /**
   * How many lines a CLEAR would actually touch, per side — a wider set than
   * `existingCount`, which counts only the named ones. The drawer can leave a
   * camera angle on a line with no name, and a clear takes those too.
   *
   * SEPARATE FROM `existingCount` ON PURPOSE, rather than replacing it: the two
   * numbers answer different questions. The dialog opens by saying how many
   * lines CARRY a character; the confirmation says how many WILL CHANGE. Fold
   * them together and one of the two sentences starts lying. Absent falls back
   * to the named count, which is right for every file imported from a sheet.
   */
  clearableCount?: number
  clearableAudioCount?: number
  /** Take a sheet back off, per side. Absent => not offered, either because
   *  there is nothing there or because this user is not a project lead — the
   *  same convention the audio-VTT dialog uses for its own removal. */
  onClearSubtitles?(): void
  onClearAudio?(): void
  onCancel(): void
}

interface Picked {
  fileName: string
  sheets: SpreadsheetSheet[]
  sheetIndex: number
  /** Which button was used. The file is then checked against it. */
  kind: CharacterSheetKind
}

export function ImportCharactersDialog({
  open,
  textFileName,
  cells,
  audioCues,
  existingCount,
  existingAudioCount = 0,
  clearableCount,
  clearableAudioCount,
  onConfirm,
  onConfirmAudio,
  onClearSubtitles,
  onClearAudio,
  onCancel,
}: Props) {
  const t = useT()
  const [picked, setPicked] = useState<Picked | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** Clearing asks twice, in place. It empties hundreds of lines and takes hand
   *  corrections with them, so it does not get to be one click beside Cancel.
   *  Holds WHICH side is being confirmed, since the two are independent. */
  const [clearing, setClearing] = useState<CharacterSheetKind | null>(null)

  useEffect(() => {
    if (open) {
      setPicked(null)
      setError(null)
      setClearing(null)
    }
  }, [open])

  const anyImported = existingCount > 0 || existingAudioCount > 0
  // What the confirmations promise, and what decides whether a clear is offered
  // at all: a side holding nothing but stray camera angles still has something
  // to clear, even though nothing on it "carries a character".
  const clearableSubtitles = clearableCount ?? existingCount
  const clearableAudio = clearableAudioCount ?? existingAudioCount
  /** "637 subtitle lines and 548 heard lines" — only the sides that have one,
   *  because claiming a side that was never imported reads as a bug. The
   *  conjunction is its own catalog string rather than a hardcoded " and ", so
   *  a translator owns both the word and the order the two counts appear in. */
  const importedParts = [
    existingCount > 0
      ? t("editor.timeline.charactersSubtitleLines", { count: existingCount })
      : null,
    existingAudioCount > 0
      ? t("editor.timeline.charactersHeardLines", { count: existingAudioCount })
      : null,
  ].filter((part): part is string => part !== null)
  const importedSummary =
    importedParts.length === 2
      ? t("editor.timeline.charactersBothSides", {
          subtitle: importedParts[0],
          audio: importedParts[1],
        })
      : (importedParts[0] ?? "")

  const sheet = picked?.sheets[picked.sheetIndex]
  const columns = sheet ? guessCharacterColumns(sheet.rows[0] ?? []) : null
  const rows = sheet && columns ? readCharacterRows(sheet.rows, columns) : null

  // BOTH READINGS, ALWAYS — which is also how the wrong button is caught.
  //
  // Header sniffing looked tempting and is wrong: the subtitle sheet's "Source"
  // column holds its own copy of the line, so "has the text" does not separate
  // them. What does separate them is the only thing that matters anyway —
  // WHICH SIDE THE SHEET ACTUALLY FITS. A sheet keyed to the heard lines aligns
  // to the cues and matches almost nothing among the subtitles, and vice versa.
  //
  // Worth catching before the refusal below, which would otherwise report "this
  // sheet matches no line" — true, and useless, when the real answer is that it
  // belongs under the other button.
  const asSubtitle = rows ? planCharacterAssignments({ rows, cells }) : null
  const asAudio =
    rows && audioCues?.length ? planAudioCharacterAssignments({ rows, cues: audioCues }) : null

  const fitsSubtitle = asSubtitle ? asSubtitle.assignments.length : 0
  const fitsAudio = asAudio ? asAudio.assignments.length : 0
  const wrongKind =
    picked != null &&
    (picked.kind === "audio" ? fitsSubtitle > fitsAudio * 2 : fitsAudio > fitsSubtitle * 2)

  const plan = !wrongKind && picked?.kind === "subtitle" ? asSubtitle : null
  const audioPlan = !wrongKind && picked?.kind === "audio" ? asAudio : null
  const active: { assignments: unknown[]; unmatchedRows: number[] } | null = plan ?? audioPlan
  // THE refusal. A row that matches no line means this sheet is not this
  // episode's — going ahead would put hundreds of characters on lines they do
  // not belong to, silently. A CELL with no row is the opposite and is fine.
  const mismatched = active != null && active.unmatchedRows.length > 0

  const handleFile = async (file: File, kind: CharacterSheetKind) => {
    setPicked(null)
    setError(null)
    if (file.size === 0) return setError(t("editor.timeline.importFileEmpty"))
    if (file.size > MAX_UNKNOWN_TEXT_BYTES) {
      return setError(t("editor.timeline.importTooLargeSheet", { fileName: file.name }))
    }
    try {
      const sheets = /\.csv$/i.test(file.name)
        ? [parseCsvToSheet(decodeImportText(await file.arrayBuffer(), file.name), file.name)]
        : await parseXlsxToSheets(await file.arrayBuffer())
      if (sheets.length === 0 || (sheets[0].rows.length ?? 0) < 2) {
        return setError(t("editor.timeline.charactersNoRows"))
      }
      setPicked({ fileName: file.name, sheets, sheetIndex: 0, kind })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onCancel() }}>
      <DialogContent data-testid="import-characters-dialog">
        <DialogHeader>
          {/* Titled for what this is a home for, not only for what it was
              built to do first. It gained two ways to take a sheet back off,
              and "Replace the characters" would be a door labelled with half
              of what is behind it. */}
          <DialogTitle>
            {anyImported
              ? t("editor.timeline.charactersTitle")
              : t("editor.timeline.charactersImportTitle")}
          </DialogTitle>
          <DialogDescription>
            {anyImported
              ? t("editor.timeline.charactersImportedSummary", { summary: importedSummary })
              : t("editor.timeline.charactersImportHint", { fileName: textFileName })}
          </DialogDescription>
        </DialogHeader>

        {picked && sheet ? (
          <div className="flex flex-col gap-2 text-sm">
            <p className="font-medium">{picked.fileName}</p>

            {picked.sheets.length > 1 && (
              <label className="flex items-center gap-2 text-xs">
                {t("editor.timeline.charactersSheet")}
                <select
                  data-testid="import-characters-sheet"
                  className="rounded-md border border-input bg-background px-2 py-1"
                  value={picked.sheetIndex}
                  onChange={(e) => setPicked({ ...picked, sheetIndex: Number(e.target.value) })}
                >
                  {picked.sheets.map((s, i) => (
                    <option key={s.name} value={i}>{s.name}</option>
                  ))}
                </select>
              </label>
            )}

            {!columns ? (
              <p data-testid="import-characters-nocolumn" className="text-xs text-red-600 dark:text-red-400">
                {t("editor.timeline.charactersNoColumn")}
              </p>
            ) : wrongKind ? (
              <div
                data-testid="import-characters-wrongkind"
                className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-xs"
              >
                {/* One key per direction rather than a frame with three holes
                    in it: which sheet this is, which one it is not, and which
                    side its rows landed on all move together, and a language
                    that reorders the clause needs the whole sentence. */}
                <p>
                  <RichMessage
                    k={
                      picked!.kind === "audio"
                        ? "editor.timeline.charactersWrongKindAudio"
                        : "editor.timeline.charactersWrongKindSubtitle"
                    }
                    values={{
                      sheet: (
                        <span className="font-medium">
                          {picked!.kind === "audio"
                            ? t("editor.timeline.charactersSubtitleSheet")
                            : t("editor.timeline.charactersAudioSheet")}
                        </span>
                      ),
                    }}
                  />
                </p>
              </div>
            ) : mismatched ? (
              <div
                data-testid="import-characters-mismatch"
                className="rounded-md border border-red-500/40 bg-red-500/5 p-3 text-xs"
              >
                <p>
                  <RichMessage
                    k="editor.timeline.charactersMismatch"
                    values={{
                      lead: (
                        <span className="font-medium">
                          {t(
                            picked!.kind === "audio"
                              ? "editor.timeline.charactersMismatchLeadAudio"
                              : "editor.timeline.charactersMismatchLeadSubtitle",
                            {
                              count: active!.unmatchedRows.length,
                              fileName: textFileName,
                            },
                          )}
                        </span>
                      ),
                      row: active!.unmatchedRows[0],
                    }}
                  />
                </p>
              </div>
            ) : (
              <div
                data-testid="import-characters-summary"
                className="rounded-md border border-emerald-500/40 bg-emerald-500/5 p-3 text-xs"
              >
                <p>
                  <RichMessage
                    k="editor.timeline.charactersAssignedSummary"
                    values={{
                      lead: (
                        <span className="font-medium">
                          {t(
                            picked!.kind === "audio"
                              ? "editor.timeline.charactersAssignedLeadAudio"
                              : "editor.timeline.charactersAssignedLeadSubtitle",
                            { count: active!.assignments.length },
                          )}
                        </span>
                      ),
                      people: (plan ?? audioPlan)!.distinctCharacters,
                    }}
                  />
                </p>
                {(plan ?? audioPlan)!.blankRows > 0 && (
                  <p className="mt-1 text-muted-foreground">
                    {t("editor.timeline.charactersBlankRows", {
                      count: (plan ?? audioPlan)!.blankRows,
                    })}
                  </p>
                )}
                {(plan?.cellsWithoutRow ?? audioPlan?.cuesWithoutRow ?? 0) > 0 && (
                  <p className="mt-1 text-muted-foreground">
                    {t(
                      picked!.kind === "audio"
                        ? "editor.timeline.charactersWithoutRowAudio"
                        : "editor.timeline.charactersWithoutRowSubtitle",
                      { count: plan?.cellsWithoutRow ?? audioPlan?.cuesWithoutRow ?? 0 },
                    )}
                  </p>
                )}
                {(plan ?? audioPlan)!.filledByPosition > 0 && (
                  <p
                    data-testid="import-characters-drift"
                    className="mt-1 text-muted-foreground"
                  >
                    {t("editor.timeline.charactersFilledByPosition", {
                      count: (plan ?? audioPlan)!.filledByPosition,
                    })}
                  </p>
                )}
                {(plan ?? audioPlan)!.cameraDisagreements > 0 && (
                  <p
                    data-testid="import-characters-camera-warning"
                    className="mt-1 text-amber-600 dark:text-amber-400"
                  >
                    {t("editor.timeline.charactersCameraDisagreements", {
                      count: (plan ?? audioPlan)!.cameraDisagreements,
                    })}
                  </p>
                )}
              </div>
            )}
          </div>
        ) : (
          <div className="flex flex-col items-center gap-3 rounded-lg border-2 border-dashed border-muted p-6 text-center">
            {/* TWO SHEETS, KEYED TO OPPOSITE SIDES of the same script — one row
                per subtitle line, one per heard line. Either can come first;
                whichever exists reaches the other side through the links, and
                both together get compared. The kind is chosen rather than
                sniffed, because the two files are not reliably distinguishable
                from their headers — the subtitle sheet carries the line's text
                too — and a person always knows which they downloaded. */}
            <div className="flex flex-wrap items-center justify-center gap-2">
              <label>
                <span className="inline-flex cursor-pointer items-center rounded-md border border-input bg-background px-3 py-1.5 text-xs font-medium transition-colors hover:bg-accent">
                  {t("editor.timeline.charactersPickSubtitle")}
                </span>
                <input
                  type="file"
                  accept=".xlsx,.csv"
                  className="sr-only"
                  data-testid="import-characters-input"
                  onChange={(e) => {
                    const file = e.target.files?.[0]
                    // Clear so picking the SAME file again re-fires change —
                    // the usual second attempt after a refusal.
                    e.target.value = ""
                    if (file) void handleFile(file, "subtitle")
                  }}
                />
              </label>
              {audioCues && audioCues.length > 0 && (
                <label>
                  <span className="inline-flex cursor-pointer items-center rounded-md border border-input bg-background px-3 py-1.5 text-xs font-medium transition-colors hover:bg-accent">
                    {t("editor.timeline.charactersPickAudio")}
                  </span>
                  <input
                    type="file"
                    accept=".xlsx,.csv"
                    className="sr-only"
                    data-testid="import-characters-audio-input"
                    onChange={(e) => {
                      const file = e.target.files?.[0]
                      e.target.value = ""
                      if (file) void handleFile(file, "audio")
                    }}
                  />
                </label>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              {t("editor.timeline.charactersPickHint", { fileName: textFileName })}
              {anyImported ? (
                <>
                  {" "}
                  <span className="text-foreground">
                    {t("editor.timeline.charactersAlreadyHave", { summary: importedSummary })}
                  </span>
                </>
              ) : null}
            </p>
          </div>
        )}

        {error && (
          <p data-testid="import-characters-error" className="text-xs text-red-600 dark:text-red-400">
            {error}
          </p>
        )}

        {/* PRONOUNCED THROUGH SPECIFICS, not through volume (Sam: "very
            pronounced and very clear and very simple so that people actually
            read it"). Every sentence is a count or a named consequence; there
            is nothing here to skim past. It says outright that hand
            corrections go too, because "remove" means CLEAR — this is not an
            undo of the import, and promising one we cannot deliver would be
            worse than the blunt truth. */}
        {/* i18n-exempt "subtitle" is a CharacterSheetKind tag, not copy */}
        {clearing === "subtitle" && onClearSubtitles && (
          <div
            data-testid="import-characters-clear-subtitle-confirm"
            className="flex flex-col gap-2 rounded-md border border-red-500/40 bg-red-500/5 p-3 text-xs"
          >
            <p className="font-medium">{t("editor.timeline.charactersClearSubtitleTitle")}</p>
            <p>
              {t("editor.timeline.charactersClearSubtitleBody", { count: clearableSubtitles })}
              {/* The links only carry names ONE WAY — a cue reads off the
                  subtitles, never the reverse — so emptying this side empties
                  the heard lines with it unless they have names of their own. */}
              {existingAudioCount === 0 && (audioCues?.length ?? 0) > 0 && (
                <> {t("editor.timeline.charactersClearSubtitleAlsoAudio")}</>
              )}
            </p>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="destructive"
                data-testid="import-characters-clear-subtitle-go"
                onClick={onClearSubtitles}
              >
                {t("editor.timeline.charactersClearGo")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                data-testid="import-characters-clear-cancel"
                onClick={() => setClearing(null)}
              >
                {t("editor.timeline.keepThem")}
              </Button>
            </div>
          </div>
        )}

        {/* i18n-exempt "audio" is a CharacterSheetKind tag, not copy */}
        {clearing === "audio" && onClearAudio && (
          <div
            data-testid="import-characters-clear-audio-confirm"
            className="flex flex-col gap-2 rounded-md border border-red-500/40 bg-red-500/5 p-3 text-xs"
          >
            <p className="font-medium">{t("editor.timeline.charactersClearAudioTitle")}</p>
            <p>
              {t("editor.timeline.charactersClearAudioBody", { count: clearableAudio })}{" "}
              {existingCount > 0
                ? t("editor.timeline.charactersClearAudioToSubtitles")
                : t("editor.timeline.charactersClearAudioNone")}
            </p>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="destructive"
                data-testid="import-characters-clear-audio-go"
                onClick={onClearAudio}
              >
                {t("editor.timeline.charactersClearGo")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                data-testid="import-characters-clear-cancel"
                onClick={() => setClearing(null)}
              >
                {t("editor.timeline.keepThem")}
              </Button>
            </div>
          </div>
        )}

        <DialogFooter>
          {/* Pushed away from the confirming pair so neither can be hit for the
              other, and hidden while a confirmation is up so the question on
              screen is the only one being asked. */}
          {!clearing && (onClearSubtitles || onClearAudio) && (
            <div className="mr-auto flex gap-1">
              {onClearSubtitles && clearableSubtitles > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  data-testid="import-characters-clear-subtitle"
                  onClick={() => setClearing("subtitle")}
                  className="text-red-600 hover:bg-red-500/10 hover:text-red-600 dark:text-red-400 dark:hover:text-red-400"
                >
                  {t("editor.timeline.charactersClearSubtitles")}
                </Button>
              )}
              {onClearAudio && clearableAudio > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  data-testid="import-characters-clear-audio"
                  onClick={() => setClearing("audio")}
                  className="text-red-600 hover:bg-red-500/10 hover:text-red-600 dark:text-red-400 dark:hover:text-red-400"
                >
                  {t("editor.timeline.charactersClearHeardLines")}
                </Button>
              )}
            </div>
          )}
          <Button variant="outline" data-testid="import-characters-cancel" onClick={onCancel}>
            {t("common.cancel")}
          </Button>
          <Button
            data-testid="import-characters-confirm"
            disabled={!active || mismatched || wrongKind || active.assignments.length === 0}
            onClick={() => {
              if (mismatched || wrongKind) return
              if (plan) onConfirm(plan)
              else if (audioPlan) onConfirmAudio?.(audioPlan)
            }}
          >
            {active && !mismatched && !wrongKind && active.assignments.length > 0
              ? t("editor.timeline.charactersAssignCount", { count: active.assignments.length })
              : t("editor.timeline.charactersAssign")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
