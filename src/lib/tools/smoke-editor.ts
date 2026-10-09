/**
 * The smoke render's stub for the apiRev 3 editor surfaces: plausible, static
 * answers (a two-chapter file, one issue, one peer typing, a back-translation)
 * so a candidate editor extension renders every branch before it is saved.
 * No writes, no panels, no network.
 */

import type { ToolEditorHostData } from "./host-handlers-editor"
import type { ToolBacktranslation, ToolCellSignals, ToolEditorConfig, ToolTermMatch } from "../../../shared/tools/editor-api"

const EMPTY_SIGNALS: ToolCellSignals = {
  stale: [], upstreamStale: [], assignments: {}, repetition: {}, issues: {}, health: {}, ai: {}, backtranslating: [], remoteChanged: [],
}

export function smokeEditorConfig(populated: boolean): ToolEditorConfig {
  return {
    fileId: populated ? "f1" : "",
    fileName: populated ? "MAT" : "",
    sourceLabel: "English",
    targetLabel: "Español",
    lanes: [{ tag: "", label: "Español", code: "es" }, { tag: "fr", label: "Français", code: "fr" }],
    activeLane: "",
    validationRequirement: 1,
    canManageLanes: true,
    canEdit: true,
    canValidate: true,
    autoValidatesOwnEdits: false,
    sourceFontSize: 14,
    targetFontSize: 14,
    sourceDirection: "ltr",
    targetDirection: "ltr",
    lineNumbers: true,
    cellLabels: false,
    ai: { configured: true, available: true },
    backtranslation: { configured: true },
    health: true,
    footnotes: "inline",
    lens: "text",
    lenses: ["text", "audio", "agent"],
    panels: ["history", "comments", "attachments", "rule", "term", "recorder"],
  }
}

export function stubEditorData(populated: boolean): ToolEditorHostData {
  const yes = async () => true
  return {
    editorConfig: async () => smokeEditorConfig(populated),
    setLane: yes,
    setLens: yes,
    openSettings: yes,
    sections: async (fileId) =>
      populated && fileId === "f1"
        ? [
            { key: "MAT 1", kind: "chapter", description: "Verses 1–2", label: "Matthew 1", shortLabel: "1", firstCellId: "c1", cellIds: ["c1", "c2"], translated: 2, validated: 1, total: 2, subsections: [] },
            { key: "MAT 2", kind: "chapter", description: "Verses 1–2", label: "Matthew 2", shortLabel: "2", firstCellId: "c3", cellIds: ["c3", "c4"], translated: 1, validated: 0, total: 2, subsections: [] },
          ]
        : [],
    signals: async (fileId) =>
      populated && fileId === "f1"
        ? {
            ...EMPTY_SIGNALS,
            stale: ["c2"],
            repetition: { c1: 2 },
            issues: { c2: [{ ruleId: "r1", ruleName: "Key terms", message: "Use the approved rendering", severity: "warning", spans: [{ side: "target", start: 0, end: 7 }], waived: false }] },
            health: { c1: { point: 92, major: false, issue: false }, c2: { point: 40, major: false, issue: true } },
            ai: { c3: { phase: "generating", preview: "Jesús nació", error: null } },
          }
        : EMPTY_SIGNALS,
    settle: yes,
    pericopes: async (fileId) => (populated && fileId === "f1" ? [{ key: "p1", label: "Matthew 2:1–2:3", detail: "12 of 20 Bibles break here", cellId: "c3" }] : []),
    termMatches: async (fileId, cellIds): Promise<Record<string, ToolTermMatch[]>> =>
      populated && fileId === "f1" && cellIds.includes("c1")
        ? { c1: [{ side: "source", start: 29, end: 34, term: "Jesus", conceptId: "t1", renderings: ["Jesús"] }] }
        : {},
    openTerm: yes,
    draft: yes,
    draftParagraph: yes,
    listBacktranslations: async (fileId): Promise<Record<string, ToolBacktranslation>> =>
      populated && fileId === "f1"
        ? { c1: { cellId: "c1", text: "Book of the genealogy of Jesus Christ", stale: false, polished: true, author: null, error: null } }
        : {},
    runBacktranslation: yes,
    saveBacktranslation: yes,
    openHistory: yes,
    openAttachments: yes,
    openRule: yes,
    listPeers: async () =>
      populated ? [{ username: "someone", color: "#7c3aed", cellId: "c3", editing: true, draftText: "Jesús n", caret: { anchor: 7, head: 7 } }] : [],
    typing: yes,
    viewing: yes,
    recordAudio: yes,
    generateAudio: yes,
    setSelection: yes,
    suggest: async () => (populated ? [{ id: "s1", text: " de David", source: "forecast" }] : []),
    suggestionFeedback: yes,
  }
}
