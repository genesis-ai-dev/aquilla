/**
 * Same-English-different-meaning exceptions for the no-duplicates guard
 * (AQU-511 / AQU-832).
 *
 * The guard in `no-duplicates.test.ts` compares English strings, so it cannot
 * see meaning — but identical English does not always mean identical
 * translation. A breadcrumb's overflow affordance and a menu's overflow
 * affordance are both "More" in English and are routinely different words
 * elsewhere, so collapsing them onto one key would force one translation to
 * be wrong. That is the exact failure this catalog exists to prevent, so the
 * exception is real.
 *
 * Pulled into its own module (AQU-832 relaxation) so the exceptions are a
 * reviewable artifact in their own right rather than inline test fixture —
 * see docs/I18N-CONTEXT-CATALOG.md "why this changed".
 *
 * Default is deny: adding an entry here is a deliberate, reviewed act and the
 * reason must say why the two strings cannot share a translation. If the
 * reason is only "they happen to differ in code", reuse the shared key
 * instead. It is never a reason that the English differs in case — three of
 * the four target locales have no letter case at all, so a case-only split is
 * pure duplicate work. What does count is a difference the target language
 * must be free to express: a nominalized heading against an imperative
 * button, an accessible name that must not carry a continuation mark, a term
 * of art against an everyday verb.
 *
 * A trailing ellipsis/colon alone is NOT a reason either, as of the
 * `normalize()` fix below: `no-duplicates.test.ts` used to strip a trailing
 * `…`/`:` before comparing, which meant an aria-label and its own
 * placeholder ("Search" vs "Search…") collided on nothing but that mark and
 * needed an exception to stay apart. `normalize()` no longer strips it, so
 * those pairs simply don't collide anymore — 20 of the 30 entries this file
 * used to carry existed only for that reason and were removed rather than
 * left to rot (see "keeps every documented exception real" in
 * `no-duplicates.test.ts`, which rejects a stale entry for a key that no
 * longer collides). The 10 that remain are genuine meaning splits.
 */
export const DUPLICATE_EXCEPTIONS: Record<string, string> = {
  "nav.sidebarSection.more":
    "Expands a collapsed sidebar section. common.moreBreadcrumbs is screen-reader " +
    "text for a truncated breadcrumb path — 'more of this path' vs 'expand this " +
    "group' are different acts and diverge in most target languages.",
  "audio.library.moreTooltip":
    "Overflow-menu tooltip in the voice library, i.e. 'more actions'. Distinct " +
    "from common.moreBreadcrumbs ('more of this path') for the same reason.",
  "nav.outbox.eventEdit":
    "Names a queued operation in the outbox feed, beside noun-phrase siblings " +
    "('New cell', 'Delete comment', 'Attach audio'). common.edit is the imperative " +
    "button that starts editing. Languages that nominalize operation names would " +
    "write these differently, and one of them would be wrong.",
  "nav.historyControls.back":
    "Accessible name of the browser-style back arrow in the app header: return to " +
    "the previously visited page. common.back is the 'previous step' button inside a " +
    "dialog or wizard. Navigation history and step order are separate senses and " +
    "take different words in many languages.",
  "nav.outbox.eventValidate":
    "Names a queued operation in the outbox feed, in the same noun-phrase register " +
    "as its siblings. editor.selection.validate is the imperative toolbar button " +
    "that performs the sign-off. Operation name vs command; they diverge wherever " +
    "operation names are nominalized.",
  "audio.newVoice.mmsLanguageLabel":
    "Names the spoken language the MMS engine should synthesize. common.language " +
    "labels the switcher that changes the language of the interface itself. Two " +
    "unrelated referents that happen to share one English word; conflating them " +
    "would mislabel one of the two controls.",
  "editor.state.empty":
    "A cell-status word read mid-phrase inside the editor's accessible name ('… " +
    "empty'), alongside 'draft' and 'validated'. audio.recordingModal.emptySource " +
    "is a standalone placeholder meaning 'this line has no source text'. A status " +
    "adjective in a list and a standalone sentence fragment inflect differently.",
  "editor.expansion.recording":
    "The NAME of the tab holding a line's audio — a noun, 'the recording'. " +
    "audio.recordingModal.recordingStatus is the present participle shown beside a " +
    "pulsing dot while the microphone is live. Noun vs progressive verb: English " +
    "spells both 'Recording', almost nothing else does.",
  "auth.login.submitDefault":
    "The submit button of the sign-in form. auth.login.title is the heading naming " +
    "the whole form. Languages that nominalize headings ('Anmeldung') while keeping " +
    "buttons imperative ('Anmelden') need both, and English's coincidence hides it.",
  "search.mode.replace":
    "Names the find-and-replace mode, a term of art paired with 'Find' and usually " +
    "fixed by local software convention. audio.clone.replaceButton is an everyday " +
    "imperative that swaps an attached reference clip for another file.",
  "editor.milestone.vocab.startLabel":
    "Names the synthetic first division in the milestone navigator — a noun for " +
    "'the beginning of the file'. audio.recordingModal.startButton is the " +
    "imperative button that begins recording. Noun vs verb; several target " +
    "languages spell the two differently even though English collapses them.",
  "editor.sync.paused":
    "The app pausing an idle websocket connection while the tab is hidden, and " +
    "resuming it automatically. autopilot.status.paused is a person deliberately " +
    "pausing an autopilot run. Automatic vs deliberate pausing are different " +
    "concepts a translator would render with different verbs in most languages.",
  "nav.fileMenu.applying":
    "Transient state of the file-options-menu 'Diarize' item while its speaker-" +
    "detection results are being written back to cells. search.replace.applying " +
    "is the transient state of the unrelated find-and-replace panel's Apply " +
    "button while it rewrites matched cells. Two independent async operations " +
    "that happen to share an English gerund; nothing ties their wording together.",
  "nav.lens.audio":
    "Standalone tab label of the header Text/Audio segmented lens switch — a " +
    "primary navigation control read on its own, alongside its sibling 'Text'. " +
    "nav.outbox.previewAudio is a one-word fallback preview for an audio-attach " +
    "event row deep in the outbox diagnostics popover, standing in for a missing " +
    "text body among noun-phrase siblings like 'edit {id}'. A standalone control " +
    "name and a placeholder noun in a technical log read as different parts of " +
    "speech in languages that mark that distinction; the English capitalization " +
    "difference is incidental, not the reason (a case-only split alone would not " +
    "justify this entry).",
  "importExport.landing.badgeBeta":
    "Per-format maturity pill on one import-option card on the landing screen " +
    "('this specific importer is beta'). nav.beta.badge is the app-chrome pill " +
    "for the whole product ('Aquilla itself is in beta') that opens a heads-up " +
    "dialog when clicked. A language that marks the scope of 'beta' (a single " +
    "feature vs. the whole application) would render these two differently.",
  "importExport.dialog.scopeLegend":
    "Field-group legend above the file/project scope toggle on the Export " +
    "dialog. dialog.assign.scopeLabel is the unrelated cast/voice-assignment " +
    "modal's scope selector (which camera angles an assignment applies to). " +
    "Two independent 'what does this apply to' concepts that only share the " +
    "English noun; a language that names the axis being scoped would diverge.",
  "importExport.landing.tn.title":
    "Import-format option title on the landing screen ('choose Translation " +
    "Notes as your import source'). editor.tn.title is the reference-panel " +
    "heading shown beside the cell being translated, once notes already exist " +
    "in the project. A picker label and a reading-pane heading are different " +
    "grammatical roles many languages would not render identically.",
  "importExport.dialog.andMore":
    "Truncation notice at the end of the export inline-style fidelity-warnings " +
    "list. editor.ebible.andMore is the unrelated truncation notice at the end " +
    "of the eBible target-import book preview list. Two independent 'n more' " +
    "counters in unrelated flows that only happen to share English wording.",
  "importExport.upload.categorySubtitles":
    "Format-category label ('Subtitles') in the main Upload files panel's " +
    "supported-formats legend. editor.timeline.laneSubtitle names the subtitle " +
    "track in the audio timeline editor. A format-picker category and a " +
    "timeline lane name are different parts of the UI that happen to share " +
    "the English noun.",
  "importExport.paratext.sourceTextTitle":
    "Card title on the Paratext preview screen offering 'import as source' " +
    "('Source text'). editor.source.textAria is the unrelated accessible name " +
    "for the source-column text region inside the cell editor. A choice-card " +
    "heading and an accessibility name for an existing pane serve different " +
    "purposes and different audiences (sighted vs. screen-reader users).",
  "importExport.dialog.voiceLegend":
    "Field-group legend above the cast-voice export filter on the Export " +
    "dialog ('Voice: <select>'). editor.navTitle.voice is the unrelated tab " +
    "title for the Voices panel in the editor's left dock. A filter-field " +
    "legend and a navigation-tab title are different UI roles.",
  "importExport.direction.targetLabel":
    "Form-field label on the post-import direction prompt, where the user " +
    "types the project's target language. autopilot.inspector.details." +
    "targetLanguage is the unrelated read-only detail-row label in the " +
    "autopilot run inspector. An editable field label and a read-only detail " +
    "row are different grammatical roles many languages would not share.",
}
