import { defineNamespace, plural } from "./types"

export const smartEdits = defineNamespace({
  keys: {
    "smartEdits.flagLabel": "Smart edits",
    "smartEdits.flagDescription":
      "Underline wordings your team has corrected elsewhere in this project, and suggest the same change. Suggestions come from your team's own edits; no AI model writes them.",
    "smartEdits.llmFlagLabel": "Smart edits: AI wording",
    "smartEdits.llmFlagDescription":
      "When smart edits have no suggestion of their own, let you ask an AI model for one. Each request uses AI credits.",
    "smartEdits.popoverTitle": "Suggested edit",
    "smartEdits.accept": "Accept",
    "smartEdits.dismiss": "Dismiss",
    "smartEdits.evidence": plural({
      one: "Your team made this change in {count} other place.",
      other: "Your team made this change in {count} other places.",
    }),
    "smartEdits.evidenceVerified": "Checked against this verse's source by Jev.",
    "smartEdits.fromAiDraft": "Corrected from an AI draft",
    "smartEdits.exampleBefore": "Before",
    "smartEdits.exampleAfter": "After",
    "smartEdits.askAi": "Ask AI for edits",
    "smartEdits.askingAi": "Asking AI for edits",
    "smartEdits.noLlmEdits": "No edits suggested",
    "smartEdits.llmFailed": "Couldn't get suggestions",
    "smartEdits.allowanceReached": "AI allowance reached",
    "smartEdits.fromAi": "Suggested by AI. Check it against the source before accepting.",
  },
  context: {
    _context: {
      description:
        "Smart edits: dotted underlines in the target editor on wordings that other " +
        "translators on the same project have corrected elsewhere. Clicking one opens a " +
        "small popover with the suggested replacement, an example of the earlier " +
        "correction, and Accept / Dismiss. The two flag strings appear as toggles in " +
        "Project settings → Experimental.",
    },
    keys: {
      "smartEdits.flagLabel": { description: "Toggle label in Project settings → Experimental.", maxLength: 32 },
      "smartEdits.llmFlagLabel": { description: "Toggle label in Project settings → Experimental.", maxLength: 40 },
      "smartEdits.popoverTitle": { description: "Heading of the popover opened from an underline.", maxLength: 32 },
      "smartEdits.accept": { description: "Button: apply the suggested wording to the cell.", maxLength: 16 },
      "smartEdits.dismiss": { description: "Button: hide this suggestion and count it as unhelpful.", maxLength: 16 },
      "smartEdits.evidence": {
        description:
          "Line in the suggestion card saying how many other cells the team made the same correction in.",
        placeholders: { count: "How many other cells in the project had this same edit made by a translator." },
      },
      "smartEdits.askAi": { description: "Small button inside the active cell editor, shown only when the opt-in AI wording setting is on and the cell has no suggestions. Clicking it spends AI credits.", maxLength: 24 },
      "smartEdits.askingAi": { description: "Screen-reader name of the progress bar shown while waiting for the AI." },
      "smartEdits.noLlmEdits": { description: "Brief status after asking the AI when it suggested nothing.", maxLength: 28 },
      "smartEdits.llmFailed": { description: "Brief status when the AI request failed.", maxLength: 28 },
      "smartEdits.allowanceReached": { description: "Brief status when the workspace's AI credits/allowance are used up.", maxLength: 28 },
      "smartEdits.evidenceVerified": {
        description: "Small note when a second check (a fast classifier model named Jev) confirmed the suggestion fits this verse. Keep the name Jev untranslated.",
      },
    },
  },
  surfaces: [],
})
