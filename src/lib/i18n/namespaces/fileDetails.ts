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
    "fileDetails.rename": "Rename",
    "fileDetails.moveToCorpus": "Move to corpus…",
    "fileDetails.exportSource": "Export source (.SFM)",
    "fileDetails.exportDisabledType": "Only USFM files support round-trip source export.",
    "fileDetails.exportDisabledPolicy":
      "Source export is disabled by your organization's export policy.",
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
      "fileDetails.moveToCorpus": {
        description:
          "Action button that opens a dialog to move the file into a different corpus " +
          "(named file group). Ends with an ellipsis because a dialog follows.",
        maxLength: 30,
      },
      "fileDetails.exportSource": {
        description:
          "Action button that downloads the file back in its source format. '.SFM' is " +
          "a file extension — keep it verbatim.",
        maxLength: 30,
      },
      "fileDetails.exportDisabledType": {
        description:
          "Sentence under the disabled export button explaining that only USFM-format " +
          "files can be exported. 'USFM' is a format name — keep it verbatim.",
      },
      "fileDetails.exportDisabledPolicy": {
        description:
          "Sentence under the disabled export button explaining that the user's " +
          "organization has turned off source export for members.",
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
