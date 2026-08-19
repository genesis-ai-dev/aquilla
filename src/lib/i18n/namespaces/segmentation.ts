import { defineNamespace } from "./types"

export const segmentation = defineNamespace({
  keys: {
    "segmentation.menuItem": "Segmentation…",
    "segmentation.title": "Segmentation",
    "segmentation.description":
      "How this file is divided into passages. The AI translator drafts one passage at a time and reads the passages around it for context, so where the divisions fall shapes every draft.",
    "segmentation.currentHeading": "Now",
    "segmentation.currentSummary": "{spanCount} passages across {cellCount} segments",
    "segmentation.sourceAuto": "From the file's own structure",
    "segmentation.sourceFixed": "Every {size} segments",
    "segmentation.sourceExplicit": "A saved passage list",
    "segmentation.staleWarning":
      "The source has changed since these passages were saved. They are still used, but may no longer line up.",
    "segmentation.strategyHeading": "Divide this file",
    "segmentation.autoLabel": "Automatically",
    "segmentation.autoHelp":
      "Follow the file's own structure — chapter and verse where it has them, paragraph breaks otherwise.",
    "segmentation.fixedLabel": "Every N segments",
    "segmentation.fixedHelp":
      "A fixed count, ignoring the file's structure. Use this when the automatic divisions are wrong.",
    "segmentation.fixedInputLabel": "Segments per passage",
    "segmentation.fixedRange": "Between {min} and {max}.",
    "segmentation.aiLabel": "Let AI find the passages",
    "segmentation.aiHelp":
      "Read the whole file and mark where each passage begins and ends, with a short title for each one.",
    "segmentation.aiNoteLabel": "Anything the AI should know (optional)",
    "segmentation.aiNotePlaceholder": "e.g. keep each parable in one passage",
    "segmentation.previewSpanCells": "{count} segments",
    "segmentation.previewTruncated": "and {count} more",
    "segmentation.aiRunning": "Reading the file…",
    "segmentation.aiDone": "Found {count} passages.",
    "segmentation.aiPartial": "Some of the file could not be read: {notes}",
    "segmentation.aiSlowHint":
      "This reads the whole file and can take a minute on a long one.",
    "segmentation.unavailable":
      "Segmentation settings are not available on this server yet.",
    "segmentation.loadFailed": "Could not load this file's segmentation.",
    "segmentation.saveFailed": "Could not save. {message}",
    "segmentation.readOnly":
      "Changing how a file is divided requires the Project Lead role or above.",
  },
  context: {
    _context: {
      description:
        "The Segmentation dialog, opened from a file row's overflow (⋯) menu in the " +
        "workspace sidebar. It shows how a file is currently divided into passages " +
        "(with a preview list), and lets a project lead choose a different division: " +
        "automatic, a fixed count, or AI-detected. IMPORTANT VOCABULARY: a 'segment' " +
        "is the app's smallest unit of translatable text (one verse, one subtitle " +
        "line, one paragraph — translated elsewhere in the app as the 'segment' of " +
        "the editor table). A 'passage' is a run of consecutive segments that the AI " +
        "translator treats as one scene. Keep the two words distinct in translation; " +
        "if the target language has no natural pair, prefer wording that makes " +
        "'passage' the larger of the two.",
    },
    keys: {
      "segmentation.menuItem": {
        description:
          "Menu item in the file row's overflow menu that opens this dialog. Noun, " +
          "not an action verb; the trailing ellipsis marks that a dialog follows and " +
          "should be kept.",
        maxLength: 24,
      },
      "segmentation.title": { description: "Dialog title. Noun.", maxLength: 24 },
      "segmentation.description": {
        description:
          "Paragraph under the dialog title explaining what segmentation affects and " +
          "why it matters. 'Passages' and 'segments' are the vocabulary defined in the " +
          "surface description above.",
      },
      "segmentation.currentHeading": {
        description:
          "Small heading over the summary of the file's CURRENT division. Adverb of " +
          "time ('as things stand'), not a noun.",
        maxLength: 16,
      },
      "segmentation.currentSummary": {
        description:
          "Summary line: how many passages the file is currently divided into, and how " +
          "many segments those passages contain in total. Both numbers are plural-" +
          "sensitive.",
        placeholders: {
          spanCount: "How many passages the file is currently divided into.",
          cellCount: "How many segments the file contains in total.",
        },
      },
      "segmentation.sourceAuto": {
        description:
          "Says the current division came from the file's own structure (chapter/verse " +
          "or paragraph breaks). Sentence fragment, shown beside the summary line.",
      },
      "segmentation.sourceFixed": {
        description:
          "Says the current division is a fixed count a person chose. Sentence fragment.",
        placeholders: { size: "How many segments each passage contains." },
      },
      "segmentation.sourceExplicit": {
        description:
          "Says the current division came from a saved list of passages rather than " +
          "being derived. Sentence fragment.",
      },
      "segmentation.staleWarning": {
        description:
          "Warning shown when the file's source text has been edited since the saved " +
          "passage list was written, so the saved boundaries may no longer match. Two " +
          "sentences; the second reassures that nothing is broken.",
      },
      "segmentation.strategyHeading": {
        description: "Heading over the three radio options. Imperative.",
        maxLength: 24,
      },
      "segmentation.autoLabel": {
        description: "Radio option label: derive the division from the file. Adverb.",
        maxLength: 24,
      },
      "segmentation.autoHelp": { description: "Help text under the 'Automatically' option." },
      "segmentation.fixedLabel": {
        description:
          "Radio option label: cut every N segments. 'N' is a placeholder for a number " +
          "the user types below, not a literal letter — render it the way a form label " +
          "in the target language would.",
        maxLength: 28,
      },
      "segmentation.fixedHelp": { description: "Help text under the fixed-count option." },
      "segmentation.fixedInputLabel": {
        description: "Label for the number input beside the fixed-count option.",
        maxLength: 28,
      },
      "segmentation.fixedRange": {
        description: "Sentence under the number input naming the allowed range.",
        placeholders: {
          min: "Smallest number of segments a passage may contain.",
          max: "Largest number of segments a passage may contain.",
        },
      },
      "segmentation.aiLabel": {
        description:
          "Radio option label: have the AI read the file and decide where passages " +
          "begin and end.",
        maxLength: 30,
      },
      "segmentation.aiHelp": { description: "Help text under the AI option." },
      "segmentation.aiNoteLabel": {
        description:
          "Label for an optional free-text box where the user adds an instruction for " +
          "the AI before it re-divides the file.",
      },
      "segmentation.aiNotePlaceholder": {
        description:
          "Placeholder inside that box showing an example instruction. 'Parable' is a " +
          "kind of short story in Scripture; substitute a natural example if the " +
          "literal word does not fit.",
      },
      "segmentation.aiRunning": {
        description:
          "Status shown on the confirm button and beside the AI option while the model " +
          "is reading the file. Verb, progressive.",
        maxLength: 28,
      },
      "segmentation.aiDone": {
        description:
          "Confirmation after the model finished, naming how many passages it found. " +
          "Plural-sensitive.",
        placeholders: { count: "How many passages the model found." },
      },
      "segmentation.aiPartial": {
        description:
          "Shown when the model finished but could not read part of the file — the " +
          "passages are still saved and still cover everything, but some boundaries " +
          "were not chosen by the model. The notes are English diagnostics from the " +
          "server and are not translated.",
        placeholders: {
          notes: "Server diagnostics naming which parts were not read; English, untranslated.",
        },
      },
      "segmentation.aiSlowHint": {
        description:
          "Sentence under the AI option warning that it is slow, so the user is not " +
          "surprised by the wait.",
      },
      "segmentation.previewSpanCells": {
        description:
          "How many segments one previewed passage contains, shown beside its label. " +
          "Plural-sensitive.",
        maxLength: 20,
        placeholders: { count: "Number of segments in this one passage." },
      },
      "segmentation.previewTruncated": {
        description:
          "Final row of the preview list when more passages exist than are shown. " +
          "Plural-sensitive.",
        placeholders: { count: "How many further passages are not listed." },
      },
      "segmentation.unavailable": {
        description:
          "Shown instead of the options when the server this app is talking to does not " +
          "serve the segmentation endpoint yet.",
      },
      "segmentation.loadFailed": {
        description: "Shown when the dialog could not fetch the file's segmentation.",
      },
      "segmentation.saveFailed": {
        description:
          "Shown when saving failed, wrapping the server's own explanation. Leave room " +
          "for a full sentence after the lead-in.",
        placeholders: {
          message: "The server's explanation of why the save failed; already a full sentence.",
        },
      },
      "segmentation.readOnly": {
        description:
          "Sentence shown to users below Project Lead explaining why the options are " +
          "disabled. 'Project Lead' is a role name shown elsewhere in the app; " +
          "translate it consistently with the members page.",
      },
    },
  },
  surfaces: [],
})
