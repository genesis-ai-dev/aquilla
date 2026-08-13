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
    "fileDetails.imported": "Imported",
    "fileDetails.progress": "Progress",
    "fileDetails.progressValue": "{translated}% translated · {validated}% validated",
  },
  context: {
    _context: {
      description:
        "The 'File details' modal, opened from a file row's overflow (⋯) or " +
        "right-click menu in the workspace sidebar. Shows a metadata table " +
        "(label on the left, value on the right). File actions stay on the row menu.",
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
    },
  },
  surfaces: [],
})
