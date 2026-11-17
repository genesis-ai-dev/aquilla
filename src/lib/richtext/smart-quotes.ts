// Smart quotes for the translation editor: typing " or ' turns into curly
// quotes as you type, the way Word's AutoFormat does. On unless the project
// turns `smartQuotes` off.
//
// Only typed characters are converted. Pasted, imported and already-stored
// text is never touched, so an untouched cell exports byte-identical.
//
// The " key follows the project: the quotation marks recorded in its Language
// profile when it has them, otherwise the target language's usual marks. The
// ' key always types ‘ ’ because the same key types apostrophes, and an
// apostrophe is ’ in every language that uses this key for one: a German
// closing ‘ or a French › would turn "geht's" into "geht‘s".
//
// Cmd/Ctrl+Z or Backspace right after a conversion restores the straight
// quote. That is the only way to keep one (an inch mark) while this is on.

import { Extension } from "@tiptap/core"
import { Plugin, PluginKey } from "@tiptap/pm/state"
import type { ResolvedPos } from "@tiptap/pm/model"
import { normalizeLanguageTag } from "@/lib/language-normalize"
import type { QuoteMarksProfile } from "../../../db/shared/language-profile"

export interface DoubleQuoteMarks {
  open: string
  close: string
}

/** What the " key and the ' key type. */
export interface SmartQuoteMarks {
  double: DoubleQuoteMarks
  single: DoubleQuoteMarks
}

const ENGLISH: DoubleQuoteMarks = { open: "“", close: "”" }
const SINGLE: DoubleQuoteMarks = { open: "‘", close: "’" }

/** Primary double quotation marks (CLDR delimiters), keyed by ISO 639-3. */
const DOUBLE_QUOTES: Record<string, DoubleQuoteMarks> = {
  fra: { open: "«", close: "»" },
  spa: { open: "«", close: "»" },
  ita: { open: "«", close: "»" },
  rus: { open: "«", close: "»" },
  ukr: { open: "«", close: "»" },
  nor: { open: "«", close: "»" },
  ell: { open: "«", close: "»" },
  deu: { open: "„", close: "“" },
  ces: { open: "„", close: "“" },
  bul: { open: "„", close: "“" },
  hrv: { open: "„", close: "“" },
  lit: { open: "„", close: "“" },
  pol: { open: "„", close: "”" },
  hun: { open: "„", close: "”" },
  ron: { open: "„", close: "”" },
  swe: { open: "”", close: "”" },
  fin: { open: "”", close: "”" },
  jpn: { open: "「", close: "」" },
}

/** The double quotes for a target language; English “ ” when unknown or unset. */
export function doubleQuoteMarks(lang: string | undefined | null): DoubleQuoteMarks {
  return knownDoubleQuoteMarks(lang) ?? ENGLISH
}

/** AQU-1688: the table's own entry for a language, or null where `doubleQuoteMarks` falls back to English. */
export function knownDoubleQuoteMarks(lang: string | undefined | null): DoubleQuoteMarks | null {
  return DOUBLE_QUOTES[normalizeLanguageTag(lang)] ?? null
}

/** Marks the ' key already covers, so a profile level made of them is not what the " key types. */
const SINGLE_SHAPED = "‘’‚‹›"

/**
 * The marks to type for a project. The " key takes the first level of the
 * project's recorded quotation marks that is not single-shaped (a project that
 * quotes ‘ ’ first and “ ” inside still gets “ ” from the " key), and the
 * target language's marks when the project has recorded none.
 */
export function smartQuoteMarks(
  lang: string | undefined | null,
  profile?: QuoteMarksProfile | null,
): SmartQuoteMarks {
  const level = profile?.levels.find((l) => l.open && l.close && !SINGLE_SHAPED.includes(l.open))
  return {
    double: level ? { open: level.open, close: level.close } : doubleQuoteMarks(lang),
    single: SINGLE,
  }
}

/** Marks that open a quotation in some language, so a quote typed right after one opens a nested quotation. */
const OPENING_MARKS = "‘“«„‚「『‹"

/** An unfinished XML-ish inline tag before the caret: its attribute quotes must stay straight. */
const INSIDE_TAG = /<\/?[a-zA-Z][^<>]*$/

/** Finished inline tags right before the caret. The quote is judged by the text before them. */
const TRAILING_TAGS = /(?:<\/?[a-zA-Z][^<>]*>)+$/

/**
 * The character a typed straight quote becomes, or null to leave it straight.
 * `before` is the text of the block up to the caret.
 *
 * Opening at the start of the text, after whitespace, after an opening bracket
 * and after another opening quote; closing everywhere else, which is also what
 * makes an apostrophe inside a word ’. Inline tags typed as text are looked
 * past, like the editor's atoms: <b>" opens and word</b>" closes.
 */
export function smartQuoteFor(typed: string, before: string, marks: SmartQuoteMarks): string | null {
  if (typed !== '"' && typed !== "'") return null
  if (INSIDE_TAG.test(before)) return null
  const pair = typed === '"' ? marks.double : marks.single
  const prev = before.replace(TRAILING_TAGS, "").slice(-1)
  const opensQuote = OPENING_MARKS.includes(prev) || prev === marks.double.open
  // A mark that closes this project's quotations never opens one: German “
  // closes, though it opens in English.
  const closesQuote = prev === marks.double.close
  const opening = prev === "" || /[\s([{<"']/.test(prev) || (opensQuote && !closesQuote)
  return opening ? pair.open : pair.close
}

/**
 * The text of the caret's block up to the caret. A line break counts as
 * whitespace; other atoms (footnotes, inline tokens) contribute nothing, so a
 * quote after a footnote closes the word before it and a quote after a leading
 * token still opens.
 */
function textBeforeCaret($from: ResolvedPos): string {
  let text = ""
  $from.parent.nodesBetween(0, $from.parentOffset, (node, pos) => {
    if (node.isText) text += (node.text ?? "").slice(0, Math.max(0, $from.parentOffset - pos))
    else if (node.type.name === "hardBreak") text += "\n"
    return true
  })
  return text
}

/** The conversion the very next key can take back. */
interface Undoable {
  from: number
  to: number
  typed: string
}

const smartQuotesKey = new PluginKey<Undoable | null>("smartQuotes")

/**
 * The typing rule. `getMarks` is read on every keystroke, so a change to the
 * project setting takes effect without remounting the editor; null means off.
 */
export function createSmartQuotesExtension(getMarks: () => SmartQuoteMarks | null) {
  return Extension.create({
    name: "smartQuotes",
    // Ahead of the history's Mod-z and the base keymap's Backspace.
    priority: 1000,

    addProseMirrorPlugins() {
      return [
        new Plugin<Undoable | null>({
          key: smartQuotesKey,
          state: {
            init: () => null,
            apply: (tr, prev) => {
              const converted = tr.getMeta(smartQuotesKey) as Undoable | undefined
              if (converted) return converted
              return tr.docChanged || tr.selectionSet ? null : prev
            },
          },
          props: {
            handleTextInput(view, from, to, text) {
              const marks = getMarks()
              if (!marks || view.composing) return false
              const $from = view.state.doc.resolve(from)
              const inCode =
                $from.parent.type.spec.code ||
                ($from.nodeBefore ?? $from.nodeAfter)?.marks.some((mark) => mark.type.spec.code)
              if (inCode) return false
              const mark = smartQuoteFor(text, textBeforeCaret($from), marks)
              if (mark === null) return false
              const tr = view.state.tr.insertText(mark, from, to)
              tr.setMeta(smartQuotesKey, { from, to: from + mark.length, typed: text })
              view.dispatch(tr)
              return true
            },
          },
        }),
      ]
    },

    addKeyboardShortcuts() {
      const restore = () => {
        const { state, view } = this.editor
        const undoable = smartQuotesKey.getState(state)
        if (!undoable) return false
        // Not a history step of its own: the next undo then removes the
        // straight quote instead of bringing the curly one back.
        const tr = state.tr.insertText(undoable.typed, undoable.from, undoable.to)
        view.dispatch(tr.setMeta("addToHistory", false))
        return true
      }
      return { "Mod-z": restore, Backspace: restore }
    },
  })
}
