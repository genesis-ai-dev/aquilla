import { defineNamespace } from "./types"

export const fileDetails = defineNamespace({
  keys: {
    "fileDetails.menuItem": "File details",
    "fileDetails.importedAs": "Imported as {name}",
    "fileDetails.type": "Type",
    "fileDetails.corpus": "Corpus",
    "fileDetails.bookCode": "Book code",
    "fileDetails.segments": "Segments",
    "fileDetails.ordering": "Ordering",
    "fileDetails.orderingTimeline": "Timeline (timecodes)",
    "fileDetails.orderingSequence": "Sequence",
    "fileDetails.languages": "Languages",
    "fileDetails.sourceLanguage": "Declared source language",
    "fileDetails.targetLanguage": "Declared target language",
    "fileDetails.imported": "Imported",
    "fileDetails.progress": "Progress",
    "fileDetails.progressValue": "{translated}% translated · {validated}% validated",
    "fileDetails.rename": "Rename",
    "fileDetails.renameDialogTitle": "Rename file",
    "fileDetails.moveToCorpus": "Move to corpus…",
    "fileDetails.downloadOriginal": "Download original",
    "fileDetails.deleteRequiresRole":
      "Deleting files requires the Project Lead role or above.",
  },
  context: {
    _context: {
      description:
        "The 'File details' modal, opened from a file row's overflow (⋯) menu in the " +
        "workspace sidebar. Shows a metadata table (label on the left, value on the " +
        "right) followed by a column of file action buttons; actions the user lacks " +
        "permission for are disabled with an explanatory sentence underneath.",
    },
    keys: {
      "fileDetails.menuItem": {
        description:
          "Menu item in the file row's overflow menu that opens the File details modal. " +
          "Noun phrase naming what will be shown, not an action verb.",
        maxLength: 24,
      },
      "fileDetails.importedAs": {
        description:
          "Subtitle under the modal heading, shown when the file was renamed after " +
          "import; tells the user the file's original name.",
        placeholders: {
          name: "The file's original name at import time, verbatim. Do not translate.",
        },
      },
      "fileDetails.type": {
        description:
          "Metadata row label for the file's source format (value is an acronym like " +
          "USFM or DOCX). Short noun.",
        maxLength: 20,
      },
      "fileDetails.corpus": {
        description:
          "Metadata row label for the corpus group the file belongs to (e.g. OT/NT for " +
          "biblical books). 'Corpus' is a product term for a named group of files.",
        maxLength: 20,
      },
      "fileDetails.bookCode": {
        description:
          "Metadata row label for the file's stable scripture book code (e.g. GEN). " +
          "Only shown for scripture files.",
        maxLength: 20,
      },
      "fileDetails.segments": {
        description:
          "Metadata row label for the number of translatable segments (cells) in the " +
          "file. Plural noun; the value is a bare number.",
        maxLength: 20,
      },
      "fileDetails.ordering": {
        description:
          "Metadata row label for how the file's segments are ordered. The value is " +
          "one of the two ordering names below.",
        maxLength: 20,
      },
      "fileDetails.orderingTimeline": {
        description:
          "Ordering value for time-based files (audio/video/subtitles): segments sort " +
          "by their timecodes. The parenthetical clarifies the mechanism.",
      },
      "fileDetails.orderingSequence": {
        description:
          "Ordering value for text files: segments sort by their intrinsic sequence " +
          "(e.g. verse order). Single noun.",
      },
      "fileDetails.languages": {
        description:
          "Metadata row label for the file's language pair. The value is rendered as " +
          "'source → target' language codes.",
        maxLength: 20,
      },
      "fileDetails.sourceLanguage": {
        description:
          "Metadata row label for the source language this file DECLARED at import — " +
          "what the file says about itself, which may disagree with the language of the " +
          "lane its rows are in. The value is a language name or code. Translate " +
          "'declared' as 'stated' / 'as claimed by the file', not as a setting the user " +
          "chose. Shown next to the declared target language (AQU-1596).",
        maxLength: 32,
      },
      "fileDetails.targetLanguage": {
        description:
          "Metadata row label for the target language this file DECLARED at import — " +
          "what the file says about itself, which may disagree with the lane its rows " +
          "are in. The value is a language name or code. Translate 'declared' as " +
          "'stated' / 'as claimed by the file'. It is import information, not the " +
          "lane's language (AQU-1596).",
        maxLength: 32,
      },
      "fileDetails.imported": {
        description:
          "Metadata row label for the date the file was imported. Past participle used " +
          "as a label; the value is a locale-formatted date.",
        maxLength: 20,
      },
      "fileDetails.progress": {
        description:
          "Metadata row label for the file's translation progress. The value is the " +
          "progressValue string below.",
        maxLength: 20,
      },
      "fileDetails.progressValue": {
        description:
          "Progress row value combining two percentages, separated by a middle dot. " +
          "'Translated' counts segments with a draft; 'validated' counts segments " +
          "approved by a reviewer.",
        placeholders: {
          translated: "Whole number 0–100: percentage of segments with a translation.",
          validated: "Whole number 0–100: percentage of segments validated by a reviewer.",
        },
      },
      "fileDetails.rename": {
        description:
          "Action button that closes the modal and starts inline renaming of the file " +
          "in the sidebar. Imperative verb.",
        maxLength: 24,
      },
      "fileDetails.renameDialogTitle": {
        description:
          "Title of the dialog opened from the chapter-row File options menu to rename the current file.",
      },
      "fileDetails.moveToCorpus": {
        description:
          "Action button that opens a dialog to move the file into a different corpus " +
          "(named file group). Ends with an ellipsis because a dialog follows.",
        maxLength: 30,
      },
      "fileDetails.downloadOriginal": {
        description:
          "Sidebar and overview action that downloads the exact original file that was imported, " +
          "without injecting translations. Imperative verb plus noun.",
        maxLength: 28,
      },
      "fileDetails.deleteRequiresRole": {
        description:
          "Sentence under the disabled delete button explaining the required project " +
          "role. 'Project Lead' is a role name shown elsewhere in the app; translate it " +
          "consistently with the members page.",
      },
    },
  },
  surfaces: [],
})
