/**
 * The smoke render's stub for the apiRev 4 surfaces: static, plausible answers
 * (one take awaiting validation, a voice take with a waveform, a menu with
 * every item, an exact translation-memory match, a contextual draft, a smart
 * edit) so a candidate extension renders every branch before it is saved.
 * No writes, no panels, no network.
 */

import type { ToolRev4HostData } from "./host-handlers-rev4"
import type { ToolAudioValidation, ToolContextualDraft } from "../../../shared/tools/editor-api-rev4"

export function stubRev4Data(populated: boolean): ToolRev4HostData {
  const yes = async () => true
  const on = (fileId: string) => populated && fileId === "f1"
  return {
    audioTakes: async (fileId): Promise<ToolAudioValidation> => on(fileId)
      ? { column: "on", requirement: 1, takes: { c1: [{ audioId: "a1", label: null, slot: "recording", validators: [], validatorCount: 0, isGenerated: false, canValidate: true, blockedReason: null, unrecorded: false }] } }
      : { column: "off", requirement: 1, takes: {} },
    validateAudio: yes,
    voiceTake: async (fileId, cellId) => on(fileId) && cellId === "c1"
      ? { audioId: "a1", durationMs: 4200, trimStartMs: null, trimEndMs: null, trimmable: true, peaks: Array.from({ length: 64 }, (_, i) => Math.abs(Math.sin(i / 5))), isGenerated: true, takeVoiceName: null }
      : null,
    trimAudio: yes,
    voices: async () => ({ voices: [{ id: "v1", name: "Narrator" }, { id: "v2", name: "Jesus" }], current: { c1: { id: "v1", name: "Narrator", explicit: false } }, canClone: true }),
    assignVoice: yes,
    cloneVoice: yes,
    sourceActions: async () => ({ edit: null, hide: { reason: null, hidden: false }, insertAbove: null, insertBelow: null, remove: null }),
    commitSource: yes,
    setCellHidden: yes,
    insertCell: yes,
    removeCell: yes,
    retimeCell: yes,
    examples: async (fileId, cellId) => on(fileId) && cellId === "c2"
      ? [{ band: "exact", percent: 100, source: "Abraham was the father of Isaac", target: "Abraham fue padre de Isaac", fileName: "GEN", isTranslationMemory: true, canInsert: true, diff: [{ kind: "equal", text: "Abraham was the father of Isaac" }] }]
      : [],
    contextualDrafts: async (fileId): Promise<Record<string, ToolContextualDraft>> => on(fileId) ? { c4: { draftId: "d1", text: "Los magos vinieron a adorar a Jesús", spanLabel: "MAT 2:1–2" } } : {},
    reviewContextual: yes,
    smartEdits: async (fileId, cellId) => on(fileId) && cellId === "c1"
      ? [{ id: "s1", start: 0, end: 5, old: "Libro", new: "El libro", tier: "memory", reason: null, flagOnly: false }]
      : [],
    smartEditFeedback: yes,
    termSelection: async (_f, _c, text) => ({ match: /jes/i.test(text), canAdd: true, blockedReason: null }),
    viewTerm: yes,
    addTerm: yes,
    askAi: yes,
  }
}
