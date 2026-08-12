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

  // AQU-832 (WS-14 project-settings/creation/sharing wave): each entry below
  // pairs a projectSettings.* key against a key in a namespace this wave is
  // forbidden to edit (audio/autopilot/editor/fileDetails/nav/search), so the
  // duplicate can only be resolved on this side. Within projectSettings itself
  // the equivalent same-string duplicates were consolidated onto one shared
  // key instead of excepted — see the namespace file's "AQU-832" comments.
  "projectSettings.sourceLink.modeClone":
    "Badge naming the AD-9 link-mode ('Clone' vs 'Live') on a linked project's " +
    "Source Link card, and reused for the same radio option in the create-project " +
    "dialog. audio.library.cloneEngineLabel names a voice-cloning TTS engine in " +
    "the Voice Studio's engine picker. A project-linking term of art and an " +
    "audio-engine brand-ish label that happen to share the English word 'Clone'.",
  "projectSettings.section.experimental":
    "Section/nav-group heading for this project's device-local experimental " +
    "feature flags. autopilot.settings.experimentalTitle is the same heading for " +
    "the unrelated Autopilot agent's own experimental-flags card. Two different " +
    "features' settings panels that both happen to be called 'Experimental'.",
  "projectSettings.info.targetLanguageLabel":
    "Field label on the Project Info card (and reused by the create-project " +
    "dialog) for the project's target language. autopilot.inspector.details." +
    "targetLanguage is a read-only detail row in the Autopilot run inspector " +
    "showing which language a specific run drafted into. A settings input label " +
    "vs a report-style detail-row label for the same underlying value read very " +
    "differently in languages that distinguish an editable field from a fact.",
  "projectSettings.decay.summary":
    "Collapsed-details summary for this project's AD-14 confidence-propagation " +
    "tuning (max hops / attention threshold). editor.expansion.retrievalSupport " +
    "is the cell-level badge shown on an individual cell's expansion panel. A " +
    "settings-panel heading and a per-cell status badge naming the same feature " +
    "at two different granularities read as different parts of speech.",
  "projectSettings.share.tabMembers":
    "Tab label in the Share dialog switching to the per-project member list. " +
    "editor.navTitle.members is the breadcrumb/nav title for the standalone " +
    "Members page. A tab within a dialog and a full page's nav title are " +
    "different UI roles that happen to share the plain noun 'Members'.",
  "projectSettings.breadcrumbEditor":
    "Breadcrumb trail segment in Project Settings linking back to the workspace " +
    "editor. editor.navTitle.editor is the editor's own nav-title/tab label when " +
    "it is the active surface. A link naming a DIFFERENT page vs a page naming " +
    "ITSELF are different grammatical roles in languages that mark that split.",
  "projectSettings.pageTitle":
    "Page heading of the Project Settings index. editor.navTitle.projectSettings " +
    "is the breadcrumb/nav label used while inside the editor to link TO " +
    "settings. A page naming itself vs a link naming its destination.",
  "projectSettings.section.voice":
    "Card heading for this project's Voice/TTS API-key configuration. " +
    "editor.navTitle.voice is the editor's own audio-lens tab label. A settings " +
    "card and a workspace lens switch that happen to share the word 'Voice'.",
  "projectSettings.sourceLink.modeLive":
    "Badge naming the AD-9 link-mode ('Live' vs 'Clone') on a linked project's " +
    "Source Link card, and reused for the same radio option in the create-project " +
    "dialog. editor.sync.live is the websocket-connection status indicator in " +
    "the editor's sync badge. A project-linking term of art vs a connectivity " +
    "status word that happen to share the English word 'Live'.",
  "projectSettings.section.languages":
    "Card heading for this project's target-language lanes. fileDetails.languages " +
    "is a plain data label in a file-info panel naming which languages a file " +
    "covers. A settings-card heading vs a file-metadata field label.",
  "projectSettings.backLinkLabel":
    "Back-link label returning from a settings sub-pane to the settings index, " +
    "and the breadcrumb trail's terminal 'Settings' crumb. nav.settings is the " +
    "left-sidebar navigation entry that opens settings in the first place. A " +
    "'go back to X' affordance and 'X' the sidebar destination read differently " +
    "in languages that distinguish a navigation link from the place it leads.",
  "projectSettings.section.terminology":
    "Card heading linking to this project's Terminology Library from within " +
    "Project Settings. nav.sidebarSection.terminology is the left-sidebar's own " +
    "top-level entry for the same destination. A settings-card link and the " +
    "primary nav entry it duplicates read as different UI roles.",
  "projectSettings.section.import":
    "Section heading for this project's USFM-import front-matter preference. " +
    "nav.workspaceActions.import is the imperative 'Import' button that starts a " +
    "new file import. A settings-card noun heading vs an action-triggering verb " +
    "button — languages that nominalize headings but keep buttons imperative " +
    "need both spelled differently even though English collapses them.",
  "projectSettings.share.copied":
    "Transient confirmation after copying a minted invite link's URL in the " +
    "Share dialog. nav.report.copied is the equivalent confirmation for the " +
    "unrelated diagnostics-report copy action. Two independent copy-to-clipboard " +
    "confirmations that happen to share the same short exclamation.",
  "projectSettings.section.bibleResources":
    "Card heading toggling this project's Bible-resources (bibletranslation.org) " +
    "integration on/off. search.mode.bibleTooltip is the tooltip on the search " +
    "panel's Bible-resources search-mode toggle. A settings on/off card heading " +
    "vs a tooltip naming a search filter mode for the same underlying dataset.",
}
