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

interface Props {
  open: boolean
  /** The file whose lines gain characters — named so it is obvious which. */
  textFileName: string
  /** That file's cells, for timestamp keying. */
  cells: readonly KeyableCell[]
  /** How many already carry a cast name; drives the replacing wording. */
  existingCount: number
  onConfirm(plan: CharacterAssignmentPlan): void
  onCancel(): void
}

interface Picked {
  fileName: string
  sheets: SpreadsheetSheet[]
  sheetIndex: number
}

export function ImportCharactersDialog({
  open,
  textFileName,
  cells,
  existingCount,
  onConfirm,
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
  const plan =
    sheet && columns
      ? planCharacterAssignments({ rows: readCharacterRows(sheet.rows, columns), cells })
      : null
  // THE refusal. A row that matches no line means this sheet is not this
  // episode's — going ahead would put hundreds of characters on lines they do
  // not belong to, silently. A CELL with no row is the opposite and is fine.
  const mismatched = plan != null && plan.unmatchedRows.length > 0

  const handleFile = async (file: File) => {
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
      setPicked({ fileName: file.name, sheets, sheetIndex: 0 })
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
            ) : mismatched ? (
              <div
                data-testid="import-characters-mismatch"
                className="rounded-md border border-red-500/40 bg-red-500/5 p-3 text-xs"
              >
                <p>
                  <span className="font-medium">
                    {plan!.unmatchedRows.length} of this sheet's rows match no line in "
                    {textFileName}"
                  </span>{" "}
                  — starting at row {plan!.unmatchedRows[0]}. That normally means the spreadsheet
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
                    {plan!.assignments.length} lines get a character
                  </span>
                  , {plan!.distinctCharacters} people in all. Camera state comes across with
                  them.
                </p>
                {plan!.blankRows > 0 && (
                  <p className="mt-1 text-muted-foreground">
                    {plan!.blankRows} rows have no character and are skipped — screen text and
                    the like.
                  </p>
                )}
                {plan!.cellsWithoutRow > 0 && (
                  <p className="mt-1 text-muted-foreground">
                    {plan!.cellsWithoutRow} lines are not in the sheet and keep whatever they
                    have.
                  </p>
                )}
                {plan!.cameraDisagreements > 0 && (
                  <p
                    data-testid="import-characters-camera-warning"
                    className="mt-1 text-amber-600 dark:text-amber-400"
                  >
                    In {plan!.cameraDisagreements} rows the Camera column and the angle written
                    into the name disagree. The column wins.
                  </p>
                )}
              </div>
            )}
          </div>
        ) : (
          <div className="flex flex-col items-center gap-2 rounded-lg border-2 border-dashed border-muted p-6 text-center">
            <label>
              <span className="inline-flex cursor-pointer items-center rounded-md border border-input bg-background px-3 py-1.5 text-xs font-medium transition-colors hover:bg-accent">
                Choose spreadsheet
              </span>
              <input
                type="file"
                accept=".xlsx,.csv"
                className="sr-only"
                data-testid="import-characters-input"
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  // Clear so picking the SAME file again re-fires change — the
                  // usual second attempt after a refusal.
                  e.target.value = ""
                  if (file) void handleFile(file)
                }}
              />
            </label>
            <p className="text-xs text-muted-foreground">
              The episode's character spreadsheet — .xlsx or .csv.
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
            disabled={!plan || mismatched || plan.assignments.length === 0}
            onClick={() => { if (plan && !mismatched) onConfirm(plan) }}
          >
            {plan && !mismatched && plan.assignments.length > 0
              ? `Assign ${plan.assignments.length} characters`
              : "Assign characters"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
