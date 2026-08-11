import { describe, expect, it } from "vitest"
import { NAMESPACES } from "./index"
import { isPluralMessage, PLURAL_CATEGORIES, type MessageValue } from "../plurals"

const normalize = (s: string) => s.trim().toLowerCase().replace(/[…:]+$/, "")

/**
 * Every English string a catalog value contributes. A count-governed key holds
 * one string per plural category, and a duplicate hiding in the `other` form is
 * still a duplicate a translator pays for.
 */
const stringsOf = (value: MessageValue): string[] =>
  isPluralMessage(value)
    ? PLURAL_CATEGORIES.flatMap((c) => {
        const form = value.forms[c]
        return form === undefined ? [] : [form]
      })
    : [value]

/** (key, string) pairs for the whole catalog, flattening plural forms. */
const allEntries = (): Array<[string, string]> =>
  NAMESPACES.flatMap((ns) =>
    Object.entries(ns.keys).flatMap(([key, value]) =>
      stringsOf(value).map((s) => [key, s] as [string, string]),
    ),
  )

/** normalized English → the distinct keys that render it. */
function groupsByEnglish(): Map<string, { keys: string[]; sample: string }> {
  const groups = new Map<string, { keys: string[]; sample: string }>()
  for (const [key, value] of allEntries()) {
    const norm = normalize(value)
    const group = groups.get(norm)
    if (!group) {
      groups.set(norm, { keys: [key], sample: value })
    } else if (!group.keys.includes(key)) {
      group.keys.push(key)
    }
  }
  return groups
}

/**
 * Same-English-different-meaning exceptions.
 *
 * The guard compares English strings, so it cannot see meaning — but identical
 * English does not always mean identical translation. A breadcrumb's overflow
 * affordance and a menu's overflow affordance are both "More" in English and are
 * routinely different words elsewhere, so collapsing them onto one key would
 * force one translation to be wrong. That is the exact failure this catalog
 * exists to prevent, so the exception is real.
 *
 * Default is deny: adding an entry here is a deliberate, reviewed act and the
 * reason must say why the two strings cannot share a translation. If the reason
 * is only "they happen to differ in code", reuse the shared key instead. It is
 * never a reason that the English differs in case or in a trailing ellipsis —
 * three of the four target locales have no letter case at all, so a case-only
 * split is pure duplicate work. What does count is a difference the target
 * language must be free to express: a nominalized heading against an imperative
 * button, an accessible name that must not carry a continuation mark, a term of
 * art against an everyday verb.
 */
const DISTINCT_MEANING: Record<string, string> = {
  "nav.sidebarSection.more":
    "Expands a collapsed sidebar section. common.moreBreadcrumbs is screen-reader " +
    "text for a truncated breadcrumb path — 'more of this path' vs 'expand this " +
    "group' are different acts and diverge in most target languages.",
  "audio.library.moreTooltip":
    "Overflow-menu tooltip in the voice library, i.e. 'more actions'. Distinct " +
    "from common.moreBreadcrumbs ('more of this path') for the same reason.",
  "common.loadingSpinner":
    "Accessible name of a bare spinner, announced once. common.loading is visible " +
    "status text and must carry the language's own continuation mark (…), which a " +
    "screen reader would read out as punctuation. The two differ by exactly that " +
    "mark, which normalization strips, so only an exception can keep them apart.",
  "nav.outbox.eventEdit":
    "Names a queued operation in the outbox feed, beside noun-phrase siblings " +
    "('New cell', 'Delete comment', 'Attach audio'). common.edit is the imperative " +
    "button that starts editing. Languages that nominalize operation names would " +
    "write these differently, and one of them would be wrong.",
  "nav.outbox.editsNoun":
    "The bare noun after a separately-styled count in the outbox summary ('3 " +
    "edits'), so it is count-governed and must take whatever form follows a number. " +
    "common.edit is the imperative button that starts editing. A counted noun and a " +
    "command are different parts of speech; English spelling both 'edit' is the " +
    "coincidence, not the rule.",
  "nav.outbox.commentsNoun":
    "The bare noun after a separately-styled count in the outbox summary ('3 " +
    "comments'). common.comments is the standalone heading over a thread list. " +
    "Arabic and many other languages inflect a noun differently after a numeral " +
    "than they do standing alone as a heading, so one key cannot serve both.",
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
  "nav.outbox.eventEditComment":
    "Names a queued operation in the outbox feed (noun-phrase register, like its " +
    "siblings). comments.composer.editPlaceholder is prompt text inside a textarea " +
    "and carries the continuation mark; an operation name must not.",
  // `auth.join.projectLabel` was excused here until the invite summary became
  // whole-sentence keys (AQU-511 wave-4b, finding 3). The label and its separator
  // now live inside `auth.join.summarySingle`, which no longer collides with
  // `common.project`, and this test's third case rejects a stale exception — so it
  // was removed rather than left to rot.
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
  "auth.join.joiningInProgress":
    "Transient status beside a spinner while the accept-invite request is in " +
    "flight, carrying the language's continuation mark. auth.join.joiningTitle is " +
    "the card heading naming the state; a heading must not carry that mark.",
  "search.mode.replace":
    "Names the find-and-replace mode, a term of art paired with 'Find' and usually " +
    "fixed by local software convention. audio.clone.replaceButton is an everyday " +
    "imperative that swaps an attached reference clip for another file.",
  "editor.milestone.find":
    "Accessible name of the division-picker's search field. " +
    "editor.milestone.findPlaceholder is the visible prompt in the same field and " +
    "ends with the language's continuation mark; an accessible name must not, " +
    "because screen readers announce the punctuation.",
  "editor.lane.changeTargetLanguage":
    "Accessible name of the control once a target language is set. " +
    "changeTargetLanguageItem is the menu item, whose trailing mark promises a " +
    "further dialog. The mark is the whole difference and normalization strips it.",
  "editor.source.placeholder":
    "Prompt inside the empty source-text editor, carrying the continuation mark. " +
    "editor.source.textAria is the accessible name of the read-only source column " +
    "and must not carry it — same reason as editor.milestone.find.",
  "search.ariaLabelProject":
    "Accessible name of the project-scope search box in the full dialog. " +
    "search.placeholderProject is the visible prompt in the same field and carries " +
    "the continuation mark; an accessible name must not, because a screen reader " +
    "announces the punctuation as part of the field's name — same reason as " +
    "editor.milestone.find (AQU-511 wave-3 finding 6).",
  "search.bible.searchAriaLabel":
    "Accessible name of the Bible-resources search box. " +
    "search.bible.searchPlaceholder is the visible prompt in the same field and " +
    "carries the continuation mark; an accessible name must not — same reason as " +
    "editor.milestone.find (AQU-511 wave-3 finding 6).",
  "search.replace.ariaLabel":
    "Accessible name of the 'replace with' text input in the full dialog's Replace " +
    "mode. search.replace.placeholder is the visible prompt in the same field and " +
    "carries the continuation mark; an accessible name must not — same reason as " +
    "editor.milestone.find (AQU-511 wave-3 finding 6).",
  "search.dialog.ariaLabelPassages":
    "Accessible name of the search box in the full dialog's parallel-passages " +
    "mode. search.dialog.placeholderPassages is the visible prompt in the same " +
    "field and carries the continuation mark; an accessible name must not — same " +
    "reason as editor.milestone.find (AQU-511 wave-3 finding 6).",
  "search.dialog.ariaLabelScoped":
    "Accessible name of the search box in the full dialog's plain Search mode " +
    "when scoped to a file. search.dialog.placeholderScoped is the visible prompt " +
    "in the same field and carries the continuation mark; an accessible name must " +
    "not — same reason as editor.milestone.find (AQU-511 wave-3 finding 6).",
  "search.dialog.ariaLabelReplaceProject":
    "Accessible name of the find box in the full dialog's Replace mode when scope " +
    "is the whole project. search.dialog.placeholderReplaceProject is the visible " +
    "prompt in the same field and carries the continuation mark; an accessible " +
    "name must not — same reason as editor.milestone.find (AQU-511 wave-3 finding 6).",
  "search.dialog.ariaLabelReplaceScoped":
    "Accessible name of the find box in the full dialog's Replace mode when " +
    "scoped to a file. search.dialog.placeholderReplaceScoped is the visible " +
    "prompt in the same field and carries the continuation mark; an accessible " +
    "name must not — same reason as editor.milestone.find (AQU-511 wave-3 finding 6).",
}

describe("catalog has no duplicate English strings (AQU-511)", () => {
  it("does not give two keys the same English string, in any namespace", () => {
    // Widened in AQU-511 wave 4: this used to compare each namespace against
    // `common.*` only, which made nine sibling namespaces duplicating EACH OTHER
    // invisible — the exact blind spot of a fan-out where no agent could see the
    // others' work. It hid 48 duplicate groups over 109 keys.
    const offenders: string[] = []
    for (const { keys, sample } of groupsByEnglish().values()) {
      const unexcused = keys.filter((k) => !(k in DISTINCT_MEANING))
      if (unexcused.length > 1) {
        offenders.push(`${JSON.stringify(sample)} — ${unexcused.join(", ")}`)
      }
    }
    // Every unjustified duplicate is a string a human translator is asked to
    // translate twice, in four locales. Promote it to `common.*`, reuse the key
    // that already owns the concept, or document the distinction in
    // DISTINCT_MEANING above.
    expect(offenders).toEqual([])
  })

  it("keeps every documented exception real and justified", () => {
    const groups = groupsByEnglish()
    const allKeys = new Set(allEntries().map(([key]) => key))
    for (const [key, reason] of Object.entries(DISTINCT_MEANING)) {
      // A stale exception silently re-opens the hole it was granted for, so an
      // entry for a key that no longer exists — or no longer collides — is a
      // failure, not a harmless leftover.
      expect(allKeys, `exception for missing key ${key}`).toContain(key)
      const collides = [...groups.values()].some(
        (g) => g.keys.includes(key) && g.keys.length > 1,
      )
      expect(collides, `${key} no longer collides — drop its exception`).toBe(true)
      expect(reason.length, `exception for ${key} needs a real reason`).toBeGreaterThan(60)
    }
  })

  it("does not let one exception excuse a second unrelated collision", () => {
    // An exception is granted per key, not per English string: if three keys
    // share a string and only two are excused, the remaining pair is still a
    // duplicate and must still be reported.
    const groups = groupsByEnglish()
    for (const { keys, sample } of groups.values()) {
      const unexcused = keys.filter((k) => !(k in DISTINCT_MEANING))
      expect(
        unexcused.length,
        `${JSON.stringify(sample)} leaves ${unexcused.join(", ")} colliding`,
      ).toBeLessThan(2)
    }
  })

  it("has no two namespaces claiming the same key", () => {
    const seen = new Set<string>()
    const collisions: string[] = []
    for (const ns of NAMESPACES) {
      for (const key of Object.keys(ns.keys)) {
        if (seen.has(key)) collisions.push(key)
        seen.add(key)
      }
    }
    // A collision means one namespace's spread silently overwrites another's.
    expect(collisions).toEqual([])
  })
})
