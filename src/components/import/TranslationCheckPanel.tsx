/**
 * AQU-1365: "Is this a translation?" On the New source text path, an upload
 * whose book is already in the project, or whose header says it is in the
 * target language, stops here before any cell is created. On the Siberian
 * Tatar pilot exactly such a file became a second Jonah source file.
 *
 * Layouts (see `translationCheckLayout`):
 *  - One file, its book in exactly one project file: put it into that file as
 *    its translation, update that file's source text, or import it separately.
 *  - One file, its book in several files: choose the file it translates, or
 *    import it separately.
 *  - One file holding several books: import it separately (a translation goes
 *    into one file at a time).
 *  - One file, only its language: choose the file it translates, or import it
 *    as a new source text.
 *  - Several files: leave the flagged ones out, or import them all.
 *
 * The dialog's title carries the question and a back arrow to the upload;
 * this panel is the body and the answers.
 */

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { useI18n } from "@/lib/i18n/I18nProvider"
import { formatList } from "@/lib/i18n/format"
import { isFileTargetFileName } from "@/lib/import/translation-destination"
import type { TranslationCheckChoice, TranslationCheckLayout } from "@/lib/import/translation-signals"

interface TranslationCheckPanelProps {
  layout: TranslationCheckLayout
  /** How many files were uploaded together (flagged or not). */
  fileCount: number
  /** False when this person can't import a translation (role), so the
   *  answers that lead there are not offered. */
  canImportTranslation: boolean
  onChoose: (choice: TranslationCheckChoice) => void
}

export function TranslationCheckPanel({ layout, fileCount, canImportTranslation, onChoose }: TranslationCheckPanelProps) {
  const { t, locale } = useI18n()
  // One answer per question: the import it starts takes a moment to show.
  const [chosen, setChosen] = useState(false)
  const choose = (choice: TranslationCheckChoice) => {
    if (chosen) return
    setChosen(true)
    onChoose(choice)
  }
  const signal = layout.kind === "many" ? null : layout.signal
  // The review reads USFM, spreadsheets and subtitles; another format can
  // only be imported as source text.
  const canHandOff = canImportTranslation && signal !== null && isFileTargetFileName(signal.fileName)
  const languageToo = signal?.language
    ? t("importExport.translationCheck.languageToo", { language: signal.language })
    : null

  let body: string[]
  let answers: { choice: TranslationCheckChoice; label: string }[]
  switch (layout.kind) {
    case "sameBook": {
      const book = layout.book.file.name
      body = [
        t("importExport.translationCheck.sameBookBody", { fileName: layout.signal.fileName, book }),
        ...(languageToo ? [languageToo] : []),
      ]
      answers = [
        ...(canHandOff ? [{ choice: "translation" as const, label: t("importExport.translationCheck.putInto", { book }) }] : []),
        { choice: "update", label: t("importExport.translationCheck.update", { book }) },
        { choice: "separate", label: t("importExport.translationCheck.separate") },
      ]
      break
    }
    case "sameBookAmbiguous":
      body = [
        t("importExport.translationCheck.severalSameBook", { fileName: layout.signal.fileName, book: layout.bookName }),
        ...(languageToo ? [languageToo] : []),
      ]
      answers = [
        ...(canHandOff ? [{ choice: "choose-file" as const, label: t("importExport.translationCheck.chooseFile") }] : []),
        { choice: "separate", label: t("importExport.translationCheck.separate") },
      ]
      break
    case "multiBook": {
      const books = [...new Set(layout.signal.sameBook.flatMap((match) => match.files.map((file) => file.name)))]
      body = [
        t("importExport.translationCheck.multiBookBody", {
          fileName: layout.signal.fileName,
          books: formatList(books, locale, { type: "conjunction" }),
        }),
        ...(languageToo ? [languageToo] : []),
      ]
      answers = [{ choice: "separate", label: t("importExport.translationCheck.separate") }]
      break
    }
    case "language":
      body = [t("importExport.translationCheck.languageBody", {
        fileName: layout.signal.fileName,
        language: layout.signal.language ?? "",
      })]
      answers = [
        ...(canHandOff ? [{ choice: "choose-file" as const, label: t("importExport.translationCheck.chooseFile") }] : []),
        { choice: "separate", label: t("importExport.translationCheck.importAsSource") },
      ]
      break
    case "many": {
      const count = layout.signals.length
      body = [t("importExport.translationCheck.manyBody", {
        count,
        files: formatList(layout.signals.map((flagged) => flagged.fileName), locale, { type: "conjunction" }),
      })]
      answers = [
        ...(count < fileCount
          ? [{ choice: "leave-out" as const, label: t("importExport.translationCheck.leaveOut", { count }) }]
          : []),
        { choice: "import-all", label: t("importExport.translationCheck.importAll") },
      ]
      break
    }
  }

  return (
    <div className="flex flex-col gap-4 py-2" data-testid="translation-check">
      <div className="space-y-2">
        {body.map((paragraph) => (
          <p key={paragraph} className="text-sm leading-relaxed text-muted-foreground">{paragraph}</p>
        ))}
      </div>
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:justify-end">
        {answers.map((answer, index) => (
          <Button
            key={answer.choice}
            type="button"
            variant={index === 0 ? "default" : "outline"}
            disabled={chosen}
            onClick={() => choose(answer.choice)}
          >
            {answer.label}
          </Button>
        ))}
      </div>
    </div>
  )
}
