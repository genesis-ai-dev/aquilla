import { defineNamespace } from "./types"

/**
 * User-visible contract for the Knowledge Base client surface. The backend is
 * already present; keeping this namespace independent lets the forthcoming
 * Living Memory component consume typed keys from its first rendered line.
 */
export const knowledgeBase = defineNamespace({
  keys: {
    "knowledgeBase.title": "Knowledge base",
    "knowledgeBase.description":
      "Add style guides, cultural background, commentary, and other reference documents for this project.",
    "knowledgeBase.orgDescription":
      "Add reference documents that every project in this organization can use.",
    "knowledgeBase.useInDraftingLabel": "Use knowledge base in drafting",
    "knowledgeBase.useInDraftingDescription":
      "Use relevant passages from these documents when generating translations and predictions.",
    "knowledgeBase.upload": "Upload document",
    "knowledgeBase.uploading": "Uploading document…",
    "knowledgeBase.uploadSuccess": "Uploaded {name}.",
    "knowledgeBase.uploadError": "Could not upload {name}. Try again.",
    // AQU-1763: "up to 25 MB" was the only limit shown, but it is just the
    // upload cap (MAX_KB_ORIGINAL_BYTES). DOCX and PDF are additionally capped
    // at MAX_KB_EXTRACT_INPUT_BYTES (2 MB) by the extractor and rejected above
    // it, so a 5 MB DOCX failed against a dialog that had promised 25 MB. Both
    // limits belong here — keep them in step with db/shared/knowledge.ts.
    "knowledgeBase.acceptedFormats":
      "Markdown, TXT, DOCX, or PDF · up to 25 MB (DOCX and PDF up to 2 MB)",
    "knowledgeBase.emptyTitle": "No knowledge documents yet",
    "knowledgeBase.emptyDescription":
      "Upload reference material to make it available to this project and its agents.",
    "knowledgeBase.orgEmptyDescription":
      "Upload reference material to make it available to every project in this organization.",
    "knowledgeBase.searchPlaceholder": "Search knowledge documents",
    "knowledgeBase.noMatches": "No knowledge documents match your search.",
    "knowledgeBase.status.pending": "Indexing…",
    "knowledgeBase.status.ready": "Indexed",
    "knowledgeBase.status.failed": "Indexing failed",
    "knowledgeBase.status.stalled": "Indexing stalled",
    "knowledgeBase.open": "View document",
    "knowledgeBase.openOriginal": "Open original",
    "knowledgeBase.reindex": "Try indexing again",
    "knowledgeBase.reindexing": "Starting indexing…",
    "knowledgeBase.delete": "Delete document",
    "knowledgeBase.deleteTitle": "Delete {name}?",
    "knowledgeBase.deleteDescription":
      "This removes the document and its index. This action cannot be undone.",
    "knowledgeBase.deleteSuccess": "Deleted {name}.",
    "knowledgeBase.deleteError": "Could not delete {name}. Try again.",
    "knowledgeBase.loadError": "Could not load the knowledge base.",
    "knowledgeBase.extractedTextHeading": "Extracted text",
    "knowledgeBase.summaryHeading": "Summary",
    "knowledgeBase.noSummary": "A summary is not available yet.",
    "knowledgeBase.inheritedHelp":
      "This organization document is available to every project in the organization.",
    "knowledgeBase.readOnlyHelp": "Organization documents are managed in organization settings.",
  },
  context: {
    _context: {
      description:
        "Knowledge Base controls, document states, dialogs, and notifications in the Living Memory project-settings surface.",
    },
    keys: {
      "knowledgeBase.acceptedFormats": {
        description:
          "Help text under the knowledge-base upload control. States two "
          + "different limits: 25 MB is the upload cap for every accepted "
          + "format, and the 2 MB in parentheses is the lower cap that applies "
          + "to DOCX and PDF only, because those are unpacked to extract text.",
      },
      "knowledgeBase.status.stalled": {
        description:
          "Badge on a document whose indexing job never reported back, so it is "
          + "neither indexed nor formally failed. Distinct from "
          + "knowledgeBase.status.pending (\"Indexing…\", still running) and from "
          + "knowledgeBase.status.failed (the job reported an error). Shown with a "
          + "retry action.",
      },
      "knowledgeBase.uploadSuccess": {
        description: "Toast shown after a knowledge document upload succeeds.",
        placeholders: { name: "Uploaded document filename." },
      },
      "knowledgeBase.uploadError": {
        description: "Toast shown after a knowledge document upload fails.",
        placeholders: { name: "Document filename that failed to upload." },
      },
      "knowledgeBase.deleteTitle": {
        description: "Destructive confirmation-dialog title.",
        placeholders: { name: "Knowledge document filename." },
      },
      "knowledgeBase.deleteSuccess": {
        description: "Toast shown after a knowledge document is deleted.",
        placeholders: { name: "Deleted document filename." },
      },
      "knowledgeBase.deleteError": {
        description: "Toast shown after knowledge-document deletion fails.",
        placeholders: { name: "Document filename that could not be deleted." },
      },
    },
  },
  surfaces: [],
})
