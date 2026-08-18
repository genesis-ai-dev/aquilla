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
  onConfirm,
  onConfirmAudio,
  onCancel,
}: Props) {
  const [picked, setPicked] = useState<Picked | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setPicked(null)
      setError(null)
    }
  }, [open])

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
    if (file.size === 0) return setError("That file is empty.")
    if (file.size > MAX_UNKNOWN_TEXT_BYTES) {
      return setError(`"${file.name}" is larger than the 10 MB limit for imports.`)
    }
    try {
      const sheets = /\.csv$/i.test(file.name)
        ? [parseCsvToSheet(decodeImportText(await file.arrayBuffer(), file.name), file.name)]
        : await parseXlsxToSheets(await file.arrayBuffer())
      if (sheets.length === 0 || (sheets[0].rows.length ?? 0) < 2) {
        return setError("That spreadsheet has no rows.")
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
          <DialogTitle>
            {existingCount > 0 ? "Replace the characters" : "Import characters"}
          </DialogTitle>
          <DialogDescription>
            A spreadsheet with one row per line of "{textFileName}", saying who speaks it and
            whether the camera is on them. Rows are matched to lines by their timestamps.
            {existingCount > 0 && ` ${existingCount} lines already have a character.`}
          </DialogDescription>
        </DialogHeader>

        {picked && sheet ? (
          <div className="flex flex-col gap-2 text-sm">
            <p className="font-medium">{picked.fileName}</p>

            {picked.sheets.length > 1 && (
              <label className="flex items-center gap-2 text-xs">
                Sheet
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
                No character column found in this sheet. Expected a column named something like
                "Character Label", "Cast" or "Speaker".
              </p>
            ) : wrongKind ? (
              <div
                data-testid="import-characters-wrongkind"
                className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-xs"
              >
                <p>
                  This looks like the{" "}
                  <span className="font-medium">
                    {picked!.kind === "audio" ? "subtitle" : "audio"} character sheet
                  </span>
                  , not the {picked!.kind === "audio" ? "audio" : "subtitle"} one — its rows line
                  up with the {picked!.kind === "audio" ? "subtitles" : "heard lines"} instead.
                  Use the other button and it will import fine.
                </p>
              </div>
            ) : mismatched ? (
              <div
                data-testid="import-characters-mismatch"
                className="rounded-md border border-red-500/40 bg-red-500/5 p-3 text-xs"
              >
                <p>
                  <span className="font-medium">
                    {active!.unmatchedRows.length} of this sheet's rows match no{" "}
                    {picked!.kind === "audio" ? "heard line" : "line"} in "{textFileName}"
                  </span>{" "}
                  — starting at row {active!.unmatchedRows[0]}. That normally means the spreadsheet
                  belongs to a different episode. Nothing has been changed.
                </p>
              </div>
            ) : (
              <div
                data-testid="import-characters-summary"
                className="rounded-md border border-emerald-500/40 bg-emerald-500/5 p-3 text-xs"
              >
                <p>
                  <span className="font-medium">
                    {active!.assignments.length}{" "}
                    {picked!.kind === "audio" ? "heard lines" : "lines"} get a character
                  </span>
                  , {(plan ?? audioPlan)!.distinctCharacters} people in all. Camera state comes
                  across with them.
                </p>
                {(plan ?? audioPlan)!.blankRows > 0 && (
                  <p className="mt-1 text-muted-foreground">
                    {(plan ?? audioPlan)!.blankRows} rows have no character and are skipped —
                    screen text and the like.
                  </p>
                )}
                {(plan?.cellsWithoutRow ?? audioPlan?.cuesWithoutRow ?? 0) > 0 && (
                  <p className="mt-1 text-muted-foreground">
                    {plan?.cellsWithoutRow ?? audioPlan?.cuesWithoutRow}{" "}
                    {picked!.kind === "audio" ? "heard lines are" : "lines are"} not in the sheet
                    and keep whatever they have.
                  </p>
                )}
                {(plan ?? audioPlan)!.filledByPosition > 0 && (
                  <p
                    data-testid="import-characters-drift"
                    className="mt-1 text-muted-foreground"
                  >
                    {(plan ?? audioPlan)!.filledByPosition} rows do not quite match their line;
                    the lines either side pin them, so they are matched by position.
                  </p>
                )}
                {(plan ?? audioPlan)!.cameraDisagreements > 0 && (
                  <p
                    data-testid="import-characters-camera-warning"
                    className="mt-1 text-amber-600 dark:text-amber-400"
                  >
                    In {(plan ?? audioPlan)!.cameraDisagreements} rows the Camera column and the
                    angle written into the name disagree. The column wins.
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
                  Subtitle characters
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
                    Audio characters
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
              One row per line of "{textFileName}", or per heard line of its audio track.
              .xlsx or .csv.
              {existingCount > 0 || existingAudioCount > 0 ? (
                <>
                  {" "}
                  <span className="text-foreground">
                    {existingCount > 0 && `${existingCount} subtitle lines`}
                    {existingCount > 0 && existingAudioCount > 0 && " and "}
                    {existingAudioCount > 0 && `${existingAudioCount} heard lines`} already have a
                    character.
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

        <DialogFooter>
          <Button variant="outline" data-testid="import-characters-cancel" onClick={onCancel}>
            Cancel
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
              ? `Assign ${active.assignments.length} characters`
              : "Assign characters"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
