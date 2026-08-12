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
}
