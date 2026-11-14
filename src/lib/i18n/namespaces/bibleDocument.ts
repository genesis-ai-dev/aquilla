import { defineNamespace, plural } from "./types"

/** AQU-2559: a Bible book as one continuous document, with a live export preview. */
export const bibleDocument = defineNamespace({
  keys: {
    "bibleDocument.view.switchLabel": "Editor layout",
    "bibleDocument.view.table": "Table",
    "bibleDocument.view.document": "Document",
    "bibleDocument.pane.source": "Source",
    "bibleDocument.pane.translation": "Your translation",
    "bibleDocument.pane.preview": "Export preview",
    "bibleDocument.toolbar.linkedScroll": "Scroll together",
    "bibleDocument.toolbar.heading": "Add heading",
    "bibleDocument.toolbar.paragraphStyle": "Paragraph style",
    "bibleDocument.style.p": "Paragraph",
    "bibleDocument.style.m": "Paragraph, no indent",
    "bibleDocument.style.pi": "Indented paragraph",
    "bibleDocument.style.q1": "Poetry line",
    "bibleDocument.style.q2": "Poetry line, second level",
    "bibleDocument.style.q3": "Poetry line, third level",
    "bibleDocument.style.li1": "List item",
    "bibleDocument.style.pc": "Centered",
    "bibleDocument.status.saving": "Saving…",
    "bibleDocument.status.saved": "Saved",
    "bibleDocument.status.failed": plural({ one: "{count} verse not saved", other: "{count} verses not saved" }),
    "bibleDocument.status.locked": "Someone else is editing that verse.",
    "bibleDocument.status.readOnly": "You can read this book but not edit it.",
    "bibleDocument.tooLong": "This file has too many verses to open as one document. Use the table.",
    "bibleDocument.editorLabel": "Translation of this book",
    "bibleDocument.preview.summary": "{translated} of {total} translated",
    "bibleDocument.preview.lossy": plural({
      one: "{count} verse replaces notes or styles in the source",
      other: "{count} verses replace notes or styles in the source",
    }),
    "bibleDocument.preview.hint": "The USFM file an export writes now. Marked lines carry your translation.",
    "bibleDocument.preview.forbidden": "Your role cannot export this project, so there is no export preview.",
    "bibleDocument.preview.unsupported": "There is no export preview for this file.",
    "bibleDocument.preview.error": "The export preview could not load.",
  },
  context: {
    _context: {
      description:
        "The Document layout of the editor for a Bible book: the source and the translation side by side as flowing text, edited like a word processor, with a live preview of the exported USFM file. 'USFM' is a file format name and stays untranslated. A 'verse' is one numbered Bible verse.",
    },
    keys: {
      "bibleDocument.view.switchLabel": { description: "Accessible name of the two-button switch between the Table and Document layouts." },
      "bibleDocument.view.table": { description: "Switch option: the editor as a table of rows.", maxLength: 12 },
      "bibleDocument.view.document": { description: "Switch option: the editor as one continuous document.", maxLength: 12 },
      "bibleDocument.toolbar.linkedScroll": { description: "Toggle button: when on, scrolling one side moves the other to the same verse.", maxLength: 20 },
      "bibleDocument.toolbar.heading": { description: "Button that inserts a section heading before a verse.", maxLength: 16 },
      "bibleDocument.status.failed": { description: "Status text when some verses could not be saved.", placeholders: { count: "Number of verses." } },
      "bibleDocument.preview.summary": { description: "Count above the export preview.", placeholders: { translated: "Number of translated verses and headings.", total: "Number of verses and headings in the book." } },
      "bibleDocument.preview.lossy": { description: "Warning above the export preview: footnotes or character styles inside these source verses are not in the translation.", placeholders: { count: "Number of verses." } },
    },
  },
  surfaces: [],
})
