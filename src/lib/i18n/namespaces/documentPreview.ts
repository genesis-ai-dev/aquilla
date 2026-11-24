import { defineNamespace, plural } from "./types"

/** A Word, PowerPoint or InDesign file previewed beside the editor. */
export const documentPreview = defineNamespace({
  keys: {
    "documentPreview.hide": "Hide preview",
    "documentPreview.resize": "Resize the preview panel",
    "documentPreview.frameTitle": "Preview of this document with your translation",
    "documentPreview.hint.docx": "The Word document an export writes now. Untranslated lines still show the source.",
    "documentPreview.hint.pptx": "The slides an export writes now. Untranslated lines still show the source.",
    "documentPreview.hint.idml": "The text an InDesign export writes now, in reading order with its paragraph styles. Page layout, pictures and fonts are not shown.",
    "documentPreview.page": "Page {name}",
    "documentPreview.behind": "Some lines cannot be exported as they are, so the preview shows the last version that can. Open Export to see which.",
    "documentPreview.approximated": plural({
      one: "{count} line is not in its style segments yet. The preview shows it in the first one.",
      other: "{count} lines are not in their style segments yet. The preview shows each in its first one.",
    }),
    "documentPreview.updating": "Updating…",
    "documentPreview.forbidden": "Your role cannot export this project, so there is no preview.",
    "documentPreview.missing": "The original of this file is not stored, so there is no preview. Import the file again to get one.",
    "documentPreview.error": "The preview could not load.",
    "documentPreview.renderError": "This file could not be drawn. The export is not affected.",
  },
  context: {
    _context: {
      description:
        "A side panel of the editor that shows a Word document or a PowerPoint deck laid out as pages or slides, or the text of an Adobe InDesign file, with the translation typed so far in place of the source text. It redraws as the translator types. 'InDesign' is a product name and stays untranslated.",
    },
    keys: {
      "documentPreview.page": { description: "Small label above the first text of a page in the InDesign preview.", placeholders: { name: "The page's name in the file, usually a number." } },
      "documentPreview.behind": { description: "Notice above the preview when the file cannot be exported with the text as it is now. 'Export' is the name of the export dialog." },
      "documentPreview.approximated": { description: "Notice above the InDesign preview. A line of an InDesign file can have several differently styled segments; a translation typed as one sentence has not been divided between them yet. Use the same words for 'style segments' as the editor's 'Pass to style segments' action.", placeholders: { count: "Number of lines." } },
      "documentPreview.updating": { description: "Small status text while the preview redraws after an edit.", maxLength: 16 },
      "documentPreview.renderError": { description: "Shown when the file was built but the browser could not draw it. The downloaded export still works." },
    },
  },
  surfaces: [],
})
