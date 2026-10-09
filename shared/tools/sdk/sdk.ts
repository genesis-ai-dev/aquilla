/**
 * The Aquilla extension SDK (`window.aq`): a high-level layer INSIDE the
 * sandboxed frame, on top of the `aquilla.*` bridge (which stays the
 * low-level escape hatch). Live data hooks, Aquilla-styled components (the
 * built-in editor's own row, list, source text, translation editor,
 * validation control, chapter picker …), a UI kit and high-level actions —
 * so an extension that looks and behaves like Aquilla is a few lines.
 *
 * It holds no privilege: it is plain ES2020 that calls only `aquilla.*`, so
 * every read is scoped and every write goes through the host's pipeline with
 * tool provenance, exactly as hand-written extension code would. The host
 * injects it (style + script, after the bridge runtime) into frames whose
 * manifest declares `sdk: 1` (apiRev 4); see srcdoc.ts.
 *
 * Versioning: AQ_SDK_VERSION is "major.minor". A manifest pins the major
 * (`sdk: 1`); minors only add. A future major ships next to this one.
 */

import { SDK_ACTIONS } from "./sdk-actions"
import { SDK_API } from "./sdk-api"
import { SDK_CELLS } from "./sdk-cells"
import { SDK_CORE } from "./sdk-core"
import { SDK_DATA } from "./sdk-data"
import { SDK_EDIT } from "./sdk-edit"
import { SDK_ICONS } from "./sdk-icons"
import { SDK_KIT, SDK_KIT_STYLE } from "./sdk-kit"
import { SDK_LIST } from "./sdk-list"
import { SDK_ROW } from "./sdk-row"
import { SDK_EDITOR_STYLE } from "./sdk-style-editor"
import { stringKeysOf } from "./string-keys"

export const AQ_SDK_VERSION = "1.0"
/** SDK majors this host can inject (manifest.sdk). */
export const AQ_SDK_MAJORS: readonly number[] = [1]

const PARTS = [SDK_CORE, SDK_DATA, SDK_LIST, SDK_EDIT, SDK_ACTIONS, SDK_CELLS, SDK_ROW, SDK_KIT, SDK_API]

const MILESTONE_VOCABS = ["chapter", "slide", "story", "section", "timeRange", "part", "group", "milestone"]
const MILESTONE_KEYS = MILESTONE_VOCABS.flatMap((v) =>
  ["previous", "next", "current", "findPlaceholder", "find", "empty"].map((k) => `editor.milestone.${v}.${k}`),
)


/** Every app string key the SDK's components use (asked of the host once). */
export const AQ_SDK_STRING_KEYS: readonly string[] = [...new Set([...stringKeysOf(PARTS.join("\n")), ...MILESTONE_KEYS])].sort()

/** Strings the built-in editor hardcodes in English (no catalog key). */
const SDK_FALLBACK: Record<string, string> = {
  "sdk.openDetails": "Open cell details",
  "sdk.remoteChanged": "Someone else changed this cell while you were editing.",
  "sdk.discardReload": "Discard and reload",
  "sdk.readOnly": "Read-only",
  "sdk.voice": "Voice this line",
  "sdk.viewTerm": "View term",
  "sdk.allDone": "Every cell is translated and validated.",
  "sdk.replace.title": "Replace existing translation?",
  "sdk.replace.validatedTitle": "Replace validated translation?",
  "sdk.replace.desc": "Replace the existing translation? The current text is preserved in cell history and can be recovered.",
  "sdk.replace.validatedDesc":
    "This cell is validated — replacing it clears the validation. The current text is preserved in cell history and can be recovered.",
  "sdk.replace.action": "Replace",
  "sdk.openRule": "Open rule",
}

/** The SDK's public surface (window.aq), for the capability-twin test and
 *  the builder prompt. Dotted names are members of a namespace. */
export const AQ_SDK_EXPORTS: readonly string[] = [
  "version", "h", "icon", "t", "strings", "mount", "Layout",
  "useFile", "useCells", "useCell", "useSelection", "usePresence",
  "actions.commit", "actions.validate", "actions.unvalidate", "actions.draft", "actions.regenerate", "actions.draftParagraph",
  "actions.openHistory", "actions.openComments", "actions.openAttachments", "actions.openRule", "actions.openTerm",
  "actions.playAudio", "actions.stopAudio", "actions.recordAudio", "actions.generateVoice", "actions.backtranslate", "actions.saveBacktranslation",
  "actions.suggestNext", "actions.nextUnfinished", "actions.goNextUnfinished", "actions.edit", "actions.reveal", "actions.select", "actions.addFootnote",
  "CellList", "CellRow", "SourceText", "TargetEditor", "ValidateButton", "CommentBadge", "AudioBadge", "StatusBadges", "CellNumber", "SelectBox",
  "HealthRibbon", "PresenceStack", "CellNotes", "FootnoteLine", "VoiceCard", "DraftButton", "DraftActions", "CellMenu", "cellMenuItems",
  "ChapterPicker", "Toolbar", "ColumnHeader", "ReadOnlyBanner",
  "ui.Page", "ui.Panel", "ui.Card", "ui.Stack", "ui.Heading", "ui.Text", "ui.Button", "ui.IconButton", "ui.Badge", "ui.Stat", "ui.Progress",
  "ui.Tabs", "ui.Input", "ui.Textarea", "ui.Checkbox", "ui.Select", "ui.Spinner", "ui.Empty", "ui.Avatar", "ui.Kbd", "ui.Divider", "ui.Menu",
  "ui.popover", "ui.closePopover", "ui.tooltip", "ui.dialog", "ui.confirm", "ui.toast",
  "cell.state", "cell.refresh", "cell.ref", "cell.number", "cell.plain", "cell.words", "cell.isStructural", "cell.toggleDetails", "cell.scrollTo", "cell.focusRow",
]

export const AQ_SDK_SCRIPT = `
(function () {
  "use strict";
  var SDK_VERSION = ${JSON.stringify(AQ_SDK_VERSION)};
  var ICONS = ${JSON.stringify(SDK_ICONS)};
  var SDK_STRING_KEYS = ${JSON.stringify(AQ_SDK_STRING_KEYS)};
${PARTS.join("\n")}
  Object.assign(FALLBACK, ${JSON.stringify(SDK_FALLBACK)});
})();
`

export const AQ_SDK_STYLE = `${SDK_EDITOR_STYLE}
  .aq-layout { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; }
${SDK_KIT_STYLE}`
