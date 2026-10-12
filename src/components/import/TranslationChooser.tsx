/**
 * AQU-1365: the Import dialog's "A translation" screen. The person says which
 * project file the translation belongs to (the open file is preselected) and
 * drops the file; the dialog then opens that file and hands the drop to the
 * existing target-import review.
 *
 * Choosing is the dialog's state, not this screen's, so Back from the review
 * lands here with the same file chosen and the same upload held.
 *
 * The import follows the person, never the upload (Sam, PR 3 pass: "We should
 * be following the user while informing them, not leading them."). With a
 * file chosen, a drop starts on that file, and the review says when the
 * upload is for another book, with a link to that book's file. With nothing
 * chosen, the upload is held, whatever its format. The held box says which
 * book the upload is for and offers the one file holding it as a button
 * ("Import into Jonah"); otherwise the picker and Continue start it. Nothing
 * opens, matches or starts until one of those is clicked.
 *
 * Below the drop zone, "Other ways to bring in a translation" offers the two
 * importers that only ever fill a file's translation: eBible (matched by verse)
 * and a paired source + translation spreadsheet. Both read the chosen file's
 * lines, so they wait for a file to be chosen and go through the same opening
 * as a dropped file.
 *
 * AQU-1631: on a project with more than one target language, "Fill which
 * language" chooses the lane the translation goes into, defaulted to the lane
 * open in the editor. Choosing one moves the editor's lane with it (the host
 * points `onLaneChange` at the editor's own lane setter), because the review
 * reads each line's current translation and commit parent from the OPEN lane's
 * cells: the lane filled and the lane read have to be the same one. A switch
 * re-derives the open file's lines from rows already loaded; when it does have
 * to load, a drop waits on the dialog's opening gate like any other file.
 */

import { useEffect, useState } from "react"
import { ArrowLeftRight, ChevronDown, FileText, Library, type LucideIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { LaneCombobox, type LaneComboboxOption } from "@/components/LaneCombobox"
import { FileTargetLanePicker } from "@/components/import/FileTargetLanePicker"
import { getBookName } from "@/lib/file-labeling/bible-book-names"
import { useT } from "@/lib/i18n/I18nProvider"
import {
  FILE_TARGET_ACCEPT,
  isFileTargetFileName,
  suggestTranslationDestination,
  uploadBookIds,
  type TranslationDestination,
} from "@/lib/import/translation-destination"

/** AQU-1365: the importers that only bring in a translation, besides a dropped
 *  file. */
export type TranslationOtherWay = "ebible" | "paired"

export interface TranslationStartOptions {
  /** True when the person took the held upload's suggested file (the one
   *  file holding the upload's book) rather than choosing one in the picker. */
  suggested: boolean
}

interface TranslationChooserProps {
  /** Project files, in sidebar order. */
  files: readonly TranslationDestination[]
  /** The chosen file, or null. */
  value: string | null
  /** The person chose a file in the picker. */
  onValueChange: (fileId: string) => void
  /** Name of the language the translation is in, when known. */
  languageLabel: string | null
  /** An upload waiting for a file to be chosen (or for Continue). */
  heldFile: File | null
  onHeldFileChange: (file: File | null) => void
  onStart: (file: File, fileId: string, options: TranslationStartOptions) => void
  /** A message from the dialog to show above the drop zone, e.g. that the
   *  chosen file was deleted while it was being opened. */
  notice?: string | null
  /** Starts one of the other ways into the chosen file. Absent, the section
   *  is not shown. */
  onOtherWay?: (way: TranslationOtherWay) => void
  /** AQU-1631: the lanes this import may fill, in registry order. Fewer than
   *  two (or absent) hides the language picker: there is nothing to choose. */
  laneOptions?: readonly LaneComboboxOption[]
  /** The lane the import fills: the editor's open lane. */
  lane?: string
  /** Moves the editor to another lane, which is what the import then fills. */
  onLaneChange?: (lane: string) => void
}

const OTHER_WAYS: {
  id: TranslationOtherWay
  icon: LucideIcon
  titleKey: "importExport.landing.ebible.title" | "importExport.landing.paired.title"
  descriptionKey: "importExport.landing.ebible.description" | "importExport.landing.paired.description"
}[] = [
  { id: "ebible", icon: Library, titleKey: "importExport.landing.ebible.title", descriptionKey: "importExport.landing.ebible.description" },
  { id: "paired", icon: ArrowLeftRight, titleKey: "importExport.landing.paired.title", descriptionKey: "importExport.landing.paired.description" },
]

export function TranslationChooser({
  files,
  value,
  onValueChange,
  languageLabel,
  heldFile,
  onHeldFileChange,
  onStart,
  notice,
  onOtherWay,
  laneOptions,
  lane = "",
  onLaneChange,
}: TranslationChooserProps) {
  const t = useT()
  const [error, setError] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const chosen = value !== null ? files.find((file) => file.id === value) ?? null : null
  const options: LaneComboboxOption[] = files.map((file) => ({ value: file.id, label: file.name }))
  // AQU-1631: the picker hides itself below two lanes, so the same test
  // decides where the sentence naming the language goes.
  const showLanePicker = Boolean(laneOptions && onLaneChange && laneOptions.length >= 2)
  const fillsSentence = (
    <p className="text-xs leading-relaxed text-muted-foreground">
      {languageLabel
        ? t("importExport.translation.fillsLanguage", { language: languageLabel })
        : t("importExport.translation.fillsNoLanguage")}
    </p>
  )

  // The books the held upload names, read once per upload. Null while that
  // read is in flight, so the box doesn't say one thing and then another.
  const [heldBooks, setHeldBooks] = useState<{ file: File; bookIds: string[] } | null>(null)
  useEffect(() => {
    if (!heldFile) return
    let current = true
    void uploadBookIds(heldFile).then((bookIds) => {
      if (current) setHeldBooks({ file: heldFile, bookIds })
    })
    return () => {
      current = false
    }
  }, [heldFile])
  const heldBookIds = heldFile && heldBooks?.file === heldFile ? heldBooks.bookIds : null
  const suggestion = heldBookIds ? suggestTranslationDestination(files, heldBookIds) : null
  // The file the upload's book is in, offered as a button unless it is the
  // file already chosen (Continue does that).
  const offer = suggestion?.kind === "file" && suggestion.file.id !== chosen?.id ? suggestion.file : null
  const bookName = suggestion ? getBookName(suggestion.bookCode) ?? suggestion.bookCode : ""
  const heldNote = !heldFile || heldBookIds === null
    ? null
    : offer
      ? t("importExport.translation.heldForBook", { book: bookName })
      : chosen
        ? null
        : suggestion?.kind === "several"
          ? t("importExport.translation.heldSeveralForBook", { book: bookName })
          : suggestion?.kind === "none"
            ? t("importExport.translation.heldNoFileForBook", { book: bookName })
            : t("importExport.translation.heldNeedsFile", { fileName: heldFile.name })

  function receive(list: File[]) {
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
    // The chosen file, whatever the upload's book: the review says when it is
    // for another book and offers that book's file.
    if (chosen) onStart(file, chosen.id, { suggested: false })
    else onHeldFileChange(file)
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
        {!showLanePicker && fillsSentence}
      </div>

      {/* AQU-1631: which language it fills, after which file. The sentence
          naming that language follows the picker, so it reads as its result. */}
      {showLanePicker && laneOptions && onLaneChange && (
        <div className="space-y-1.5">
          <FileTargetLanePicker
            options={laneOptions}
            value={lane}
            onValueChange={(next) => {
              if (next === lane) return
              setError(null)
              onLaneChange(next)
            }}
            size="default"
            triggerClassName="sm:w-72"
          />
          {fillsSentence}
        </div>
      )}

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
          receive(Array.from(e.dataTransfer.files))
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
                receive(picked)
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
          {heldNote && <p className="text-xs text-muted-foreground">{heldNote}</p>}
          <div className="flex flex-wrap justify-end gap-2">
            {offer && (
              <Button
                type="button"
                size="sm"
                // Leads while nothing is chosen; once the person picks another
                // file, Continue (their choice) leads and this stays on offer.
                variant={chosen ? "outline" : "default"}
                data-testid="translation-held-suggestion"
                onClick={() => onStart(heldFile, offer.id, { suggested: true })}
              >
                {t("importExport.translation.heldImportInto", { fileName: offer.name })}
              </Button>
            )}
            <Button
              type="button"
              size="sm"
              variant={offer && !chosen ? "outline" : "default"}
              disabled={!chosen}
              onClick={() => {
                if (chosen) onStart(heldFile, chosen.id, { suggested: false })
              }}
            >
              {t("importExport.translation.continue")}
            </Button>
          </div>
        </div>
      )}

      {error && <p className="text-xs text-destructive" role="alert">{error}</p>}

      {onOtherWay && (
        <section className="space-y-2 pt-2" aria-labelledby="translation-other-ways" data-testid="translation-other-ways">
          <h3 id="translation-other-ways" className="px-0.5 text-xs font-medium text-muted-foreground/70">
            {t("importExport.translation.otherWays")}
          </h3>
          {!chosen && <p className="px-0.5 text-xs text-muted-foreground">{t("importExport.translation.chooseFileFirst")}</p>}
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {OTHER_WAYS.map(({ id, icon: Icon, titleKey, descriptionKey }) => (
              <button
                key={id}
                type="button"
                disabled={!chosen}
                onClick={() => onOtherWay(id)}
                className="flex items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-55 disabled:hover:bg-transparent"
              >
                <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                  <Icon className="size-3.5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium leading-tight">{t(titleKey)}</span>
                  <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">{t(descriptionKey)}</span>
                </span>
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
