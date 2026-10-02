/**
 * AQU-1365: the Import dialog's "A translation" screen. The person says which
 * project file the translation belongs to (the open file is preselected) and
 * drops the file; the dialog then opens that file and hands the drop to the
 * existing target-import review.
 *
 * Choosing is the dialog's state, not this screen's, so Back from the review
 * lands here with the same file chosen and the same upload held.
 *
 * A dropped USFM file names its book on its `\id` line. While the person has
 * not chosen a file themselves, that book picks the file (see
 * `pickTranslationDestination`). With nothing chosen and nothing picked, the
 * upload is held until a file is chosen, and only Continue starts it: a held
 * file never starts on its own, so what happens next is always the person's
 * click.
 */

import { useState } from "react"
import { ChevronDown, FileText } from "lucide-react"
import { Button } from "@/components/ui/button"
import { LaneCombobox, type LaneComboboxOption } from "@/components/LaneCombobox"
import { useT } from "@/lib/i18n/I18nProvider"
import { decodeImportText } from "@/lib/import/ai-recipe"
import {
  FILE_TARGET_ACCEPT,
  isFileTargetFileName,
  isUsfmFileName,
  pickTranslationDestination,
  usfmBookIds,
  type TranslationDestination,
} from "@/lib/import/translation-destination"

export interface TranslationStartOptions {
  /** True when the upload's own book chose the file, not the person. */
  autoPicked: boolean
}

interface TranslationChooserProps {
  /** Project files, in sidebar order. */
  files: readonly TranslationDestination[]
  /** The chosen file, or null. */
  value: string | null
  /** The person chose a file (this counts as their choice for auto-pick). */
  onValueChange: (fileId: string) => void
  /** True once the person has chosen a file in this dialog. */
  touched: boolean
  /** Name of the language the translation is in, when known. */
  languageLabel: string | null
  /** An upload waiting for a file to be chosen (or for Continue). */
  heldFile: File | null
  onHeldFileChange: (file: File | null) => void
  onStart: (file: File, fileId: string, options: TranslationStartOptions) => void
  /** A message from the dialog to show above the drop zone, e.g. that the
   *  chosen file was deleted while it was being opened. */
  notice?: string | null
}

export function TranslationChooser({
  files,
  value,
  onValueChange,
  touched,
  languageLabel,
  heldFile,
  onHeldFileChange,
  onStart,
  notice,
}: TranslationChooserProps) {
  const t = useT()
  const [error, setError] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const chosen = value !== null ? files.find((file) => file.id === value) ?? null : null
  const options: LaneComboboxOption[] = files.map((file) => ({ value: file.id, label: file.name }))

  async function receive(list: File[]) {
    setError(null)
    if (list.length === 0) return
    if (list.length > 1) {
      setError(t("importExport.translation.oneFileAtATime"))
      return
    }
    const file = list[0]
    if (!isFileTargetFileName(file.name)) {
      setError(t("importExport.fileTarget.unsupportedFileType"))
      return
    }
    const bookIds = isUsfmFileName(file.name)
      ? usfmBookIds(decodeImportText(await file.arrayBuffer(), file.name))
      : []
    const pick = pickTranslationDestination({ files, current: value, touched, uploadBookIds: bookIds })
    if (pick) {
      onStart(file, pick.id, { autoPicked: pick.autoPicked })
    } else {
      onHeldFileChange(file)
    }
  }

  if (files.length === 0) {
    return (
      <p className="rounded-lg border border-dashed px-3 py-4 text-sm text-muted-foreground">
        {t("importExport.intent.translation.noFiles")}
      </p>
    )
  }

  return (
    <div className="space-y-3" data-testid="translation-chooser">
      <div className="space-y-1.5">
        <p className="text-sm font-medium">{t("importExport.translation.destinationLabel")}</p>
        <LaneCombobox
          options={options}
          value={value ?? ""}
          onValueChange={onValueChange}
          searchPlaceholder={t("importExport.translation.searchPlaceholder")}
          searchAriaLabel={t("importExport.translation.searchPlaceholder")}
          emptyText={t("importExport.translation.noMatches")}
          trigger={
            <Button
              type="button"
              variant="outline"
              className="w-full justify-between font-normal sm:w-72"
              aria-label={t("importExport.translation.destinationLabel")}
              data-testid="translation-destination"
            >
              <span className={chosen ? "min-w-0 truncate" : "min-w-0 truncate text-muted-foreground"}>
                {chosen ? chosen.name : t("importExport.translation.destinationPlaceholder")}
              </span>
              <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
            </Button>
          }
        />
        <p className="text-xs leading-relaxed text-muted-foreground">
          {languageLabel
            ? t("importExport.translation.fillsLanguage", { language: languageLabel })
            : t("importExport.translation.fillsNoLanguage")}
        </p>
      </div>

      {notice && <p className="text-xs text-amber-700 dark:text-amber-400">{notice}</p>}

      <div
        data-testid="translation-drop-zone"
        className={
          "flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-6 text-center transition-colors " +
          (dragOver ? "border-primary bg-primary/5" : "border-muted")
        }
        onDragOver={(e) => {
          e.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragOver(false)
          void receive(Array.from(e.dataTransfer.files))
        }}
      >
        <div className="flex flex-wrap items-center justify-center gap-1.5 text-sm text-muted-foreground">
          <span>{t("importExport.fileTarget.dropZoneHint")}</span>
          <label>
            <span className="inline-flex cursor-pointer items-center rounded-md border border-input bg-background px-3 py-1.5 text-xs font-medium transition-colors hover:bg-accent">
              {t("editor.video.chooseFile")}
            </span>
            <input
              type="file"
              accept={FILE_TARGET_ACCEPT}
              className="sr-only"
              onChange={(e) => {
                const picked = Array.from(e.target.files ?? [])
                // Clear so choosing the same file again still fires a change.
                e.target.value = ""
                void receive(picked)
              }}
            />
          </label>
        </div>
        <p className="text-xs text-muted-foreground">{t("importExport.fileTarget.acceptedFormats")}</p>
      </div>

      {heldFile && (
        <div className="space-y-2 rounded-lg border bg-muted/30 px-3 py-2.5" data-testid="translation-held-file">
          <div className="flex items-center gap-2 text-sm">
            <FileText className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate font-medium">{heldFile.name}</span>
            <Button type="button" variant="link" size="sm" className="h-auto p-0" onClick={() => onHeldFileChange(null)}>
              {t("importExport.translation.removeHeld")}
            </Button>
          </div>
          {!chosen && (
            <p className="text-xs text-muted-foreground">
              {t("importExport.translation.heldNeedsFile", { fileName: heldFile.name })}
            </p>
          )}
          <div className="flex justify-end">
            <Button
              type="button"
              size="sm"
              disabled={!chosen}
              onClick={() => {
                if (chosen) onStart(heldFile, chosen.id, { autoPicked: false })
              }}
            >
              {t("importExport.translation.continue")}
            </Button>
          </div>
        </div>
      )}

      {error && <p className="text-xs text-destructive" role="alert">{error}</p>}
    </div>
  )
}
