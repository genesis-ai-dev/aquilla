/**
 * AQU-1365: "Is this a translation?" On the New source text path, an upload
 * whose book is already in the project, or whose header says it is in the
 * target language, stops here before any cell is created. On the Siberian
 * Tatar pilot exactly such a file became a second Jonah source file.
 *
 * Layouts (see `translationCheckLayout`):
 *  - One file, its book in exactly one project file: put it into that file as
 *    its translation, update that file's source text, or import it separately.
 *    Update is offered only when that file's book is known rather than
 *    guessed from its name, and is never the highlighted answer.
 *  - A file the translation review can't read (a .usx), or one in another
 *    lane's language, can only come in as source text; the question then
 *    says so instead of asking whether it is a translation.
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
  /** A language the check found, as the person knows it (the lane's name,
   *  not a bare tag like `ru`), and whether it is the lane a translation
   *  import fills right now. */
  describeLanguage: (language: string) => { name: string; active: boolean }
  onChoose: (choice: TranslationCheckChoice) => void
}

type Answer = { choice: TranslationCheckChoice; label: string }

export function TranslationCheckPanel({ layout, fileCount, canImportTranslation, describeLanguage, onChoose }: TranslationCheckPanelProps) {
  const { t, locale } = useI18n()
  // One answer per question: the import it starts takes a moment to show.
  const [chosen, setChosen] = useState(false)
  const choose = (choice: TranslationCheckChoice) => {
    if (chosen) return
    setChosen(true)
    onChoose(choice)
  }
  const signal = layout.kind === "many" ? null : layout.signal
  const language = signal?.language ? describeLanguage(signal.language) : null
  // A translation import fills the lane open in the editor. A file in
  // another lane's language must not be handed over to fill this one
  // (AQU-1365 review).
  const otherLane = language !== null && !language.active
  // The review reads USFM, spreadsheets and subtitles; another format can
  // only be imported as source text.
  const readable = signal !== null && isFileTargetFileName(signal.fileName)
  const canHandOff = canImportTranslation && readable && !otherLane
  const languageLine = !language
    ? null
    : otherLane
      ? t("importExport.translationCheck.otherLane", { language: language.name })
      : t("importExport.translationCheck.languageToo", { language: language.name })
  // Said only when a hand-off is otherwise on offer, so the question on
  // screen never asks for an answer that has no button.
  const formatLine = canImportTranslation && !readable && !otherLane
    ? t("importExport.translationCheck.formatSourceOnly")
    : null

  let body: string[]
  let answers: Answer[]
  switch (layout.kind) {
    case "sameBook": {
      const book = layout.book.file.name
      // Only a file whose book is known, not guessed from a few letters of
      // its name, is offered an in-place update of its source text, and that
      // is never the highlighted answer.
      const update: Answer[] = layout.book.file.bookCertain
        ? [{ choice: "update", label: t("importExport.translationCheck.update", { book }) }]
        : []
      const separate: Answer = { choice: "separate", label: t("importExport.translationCheck.separate") }
      if (canHandOff) {
        body = [
          t("importExport.translationCheck.sameBookBody", { fileName: layout.signal.fileName, book }),
          ...(languageLine ? [languageLine] : []),
        ]
        answers = [
          { choice: "translation", label: t("importExport.translationCheck.putInto", { book }) },
          ...update,
          separate,
        ]
      } else {
        body = [
          t("importExport.translationCheck.sameBookPlain", { fileName: layout.signal.fileName, book }),
          ...(languageLine ? [languageLine] : []),
          ...(formatLine ? [formatLine] : []),
        ]
        answers = [separate, ...update]
      }
      break
    }
    case "sameBookAmbiguous":
      body = [
        t(canHandOff ? "importExport.translationCheck.severalSameBook" : "importExport.translationCheck.severalSameBookPlain", {
          fileName: layout.signal.fileName,
          book: layout.bookName,
        }),
        ...(languageLine ? [languageLine] : []),
        ...(formatLine ? [formatLine] : []),
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
        ...(languageLine ? [languageLine] : []),
      ]
      answers = [{ choice: "separate", label: t("importExport.translationCheck.separate") }]
      break
    }
    case "language":
      body = otherLane
        ? [t("importExport.translationCheck.otherLaneBody", {
            fileName: layout.signal.fileName,
            language: language?.name ?? "",
          })]
        : [
            t("importExport.translationCheck.languageBody", {
              fileName: layout.signal.fileName,
              language: language?.name ?? "",
            }),
            ...(formatLine ? [formatLine] : []),
          ]
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
