/**
 * Smart Extensions bridge API revisions.
 *
 * TOOLS_API_REV (manifest.ts) is the revision the host speaks today; a tool
 * records the revision it was built against. When a bridge call is removed,
 * bump TOOLS_API_REV, add a marker here, and raise TOOLS_MIN_API_REV if old
 * tools can no longer work. The in-frame runtime keeps a stub for every
 * removed call, and the host answers it with `api_removed` naming the
 * replacement — so an old extension fails loudly with a fix, and the host
 * offers "this extension is old → rebuild" (an edit_tool run carrying the
 * migration notes below).
 */

import { TOOLS_API_REV } from "./manifest"

/** Oldest revision the host still runs without the "rebuild" banner. */
export const TOOLS_MIN_API_REV = 1

export interface RemovedApi {
  /** Bridge method, e.g. "cells.save". */
  method: string
  /** First apiRev without it. */
  removedIn: number
  replacement: string
}

/** Removed-API markers. `cells.save` was the pre-release name of
 *  `cells.commit` (single edit, not batched); it is kept as the first marker
 *  so the mechanism is exercised end to end. */
export const REMOVED_APIS: readonly RemovedApi[] = [
  { method: "cells.save", removedIn: 1, replacement: "aquilla.cells.commit([{ fileId, cellId, value }])" },
]

/** Additive surfaces per revision (nothing here is removed or reshaped, so an
 *  older extension keeps working unchanged; it simply does not call them). */
export const API_REV_ADDITIONS: Readonly<Record<number, readonly string[]>> = {
  2: [
    "cells.page",
    "cells.get",
    "cells.unvalidate",
    "cells.list/page/get: sourceHtml, targetHtml, type, lastEditor, lastEditAt, aiDrafted",
    "cells.commit: optional html per edit (sanitized by the host)",
    "presence.list / presence.claim / presence.release + presence.changed event",
    "comments.counts / comments.open + comments.changed event (scope read:comments)",
    "audio.list / audio.play / audio.stop",
    "ui.hostKey (+ automatic forwarding of host shortcuts) and the editor.reveal event",
  ],
  3: [
    "editor.config / editor.setLane / editor.setLens (+ config.changed, editor.chrome events)",
    "cells.sections / cells.signals / cells.settle (+ signals.changed, cells.structure, cells.loaded events)",
    "editor-mount cell fields: validators, validationStatus, paragraphStart, label, context, footnotes, hasAudio, attachmentCount, hidden, waivedRuleIds, ribbon, numberLabel, paragraph",
    "terms.matches / terms.open",
    "ai.draft / ai.draftParagraph (scope ai:draft)",
    "backtranslation.list / backtranslation.run / backtranslation.save (+ backtranslation.changed)",
    "history.open / attachments.open / rules.open (host panels)",
    "presence.peers / presence.typing / presence.view (+ presence.peers event)",
    "audio.record / audio.generate (scope write:audio)",
    "selection.set (+ selection.changed): the host's bulk selection bar",
    "suggestions.get / suggestions.feedback: ghost text from host providers",
    "ui.strings: the app's UI strings in the user's language; theme adds color scheme + viewport; fonts event carries the app font bytes",
  ],
  4: [
    "audio.takes / audio.validate / audio.unvalidate: per-take audio validation (the audio column)",
    "audio.take / audio.trim / audio.voices / audio.assignVoice / audio.clone: the Audio lens's take, waveform peaks, trim, voice and cloning (+ audio.changed event)",
    "source.actions / source.commit / source.setHidden / source.insert / source.remove / source.retime: source editing and the cell menu (scope write:source)",
    "ai.examples / ai.contextual / ai.reviewContextual / ai.smartEdits / ai.smartEditFeedback: the AI surfaces beside a cell (+ contextual.changed event)",
    "terms.selection / terms.view / terms.add / agent.ask: the source selection toolbar",
    "manifest.sdk (1): the host injects the extension SDK as window.aq — live data hooks (useFile, useCells, useCell, useSelection, usePresence), Aquilla components (CellList, CellRow, SourceText, TargetEditor, ValidateButton, ChapterPicker, …), a UI kit (aq.ui) and actions (aq.actions); see AQ_SDK_EXPORTS",
  ],
}

export function removedApi(method: string): RemovedApi | null {
  return REMOVED_APIS.find((r) => r.method === method) ?? null
}

export function isToolStale(apiRev: number): boolean {
  return apiRev < TOOLS_MIN_API_REV || apiRev > TOOLS_API_REV
}

/** The instruction a "rebuild" sends to the builder (edit_tool). */
export function rebuildRequest(apiRev: number, extraFailure?: string): string {
  const removed = REMOVED_APIS.filter((r) => r.removedIn > apiRev || extraFailure?.includes(r.method))
  return [
    `Update this extension to the current aquilla bridge API (apiRev ${TOOLS_API_REV}); it was built for apiRev ${apiRev}.`,
    ...removed.map((r) => `- aquilla.${r.method} was removed in apiRev ${r.removedIn}; use ${r.replacement}.`),
    extraFailure ? `It failed at runtime with: ${extraFailure}` : "",
    "Keep its behaviour and UI otherwise unchanged.",
  ]
    .filter(Boolean)
    .join("\n")
}
