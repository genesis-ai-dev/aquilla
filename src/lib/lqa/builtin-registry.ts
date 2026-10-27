import type { BuiltinCheckId, InfractionSpan } from "@/lib/parsers/types"
import type { BuiltinCheckRunContext } from "./builtin-run-context"
import * as emptyTarget from "./check-functions/empty-target"
import * as targetEqualsSource from "./check-functions/target-equals-source"
import * as placeholderIntegrity from "./check-functions/placeholder-integrity"
import * as numberIntegrity from "./check-functions/number-integrity"
import * as numberIntegrityExtra from "./check-functions/number-integrity-extra"
import * as endPunctuationMismatch from "./check-functions/end-punctuation-mismatch"
import * as punctuationIntegrity from "./check-functions/punctuation-integrity"
import * as doubleSpace from "./check-functions/double-space"
import * as repeatedWord from "./check-functions/repeated-word"
import * as unpairedSymbols from "./check-functions/unpaired-symbols"
import * as abbreviationMismatch from "./check-functions/abbreviation-mismatch"
import { BIBLE_BUILTIN_CHECKS } from "./bible-builtin-checks"
import { TEXT_CHECK_IDS, TEXT_CHECK_META } from "../../../db/shared/builtin-checks"
import * as usfmStructure from "./check-functions/usfm-structure"
import * as capitalization from "./check-functions/capitalization"
import * as footnoteQuoteMismatch from "./check-functions/footnote-quote-mismatch"
import * as corruptedCharacters from "./check-functions/corrupted-characters"
import * as unpairedQuotes from "./check-functions/unpaired-quotes"
import * as untranslatedFragment from "./check-functions/untranslated-fragment"
import * as lengthRatio from "./check-functions/length-ratio"

export interface BuiltinCheckDefinition {
  id: BuiltinCheckId
  name: string
  description: string
  defaultSeverity: "major" | "minor"
  defaultEnabled: boolean
  /** True if the check should run even when target is empty. */
  runsOnEmptyTarget: boolean
  /**
   * AQU-1906: `context` carries the per-LANE inputs a check may read (the
   * target language's punctuation conventions today). Every existing check
   * ignores it; the two punctuation checks read `context.punctuation`.
   */
  run: (source: string, target: string, context?: BuiltinCheckRunContext) => InfractionSpan[] | null
  /** Static copy, or a builder that derives copy from the offending spans
   *  (e.g. placeholder-integrity names the missing token). Dead field as of
   *  AQU-832 — no consumer reads it (rule-engine.ts uses only `run` and
   *  `runsOnEmptyTarget`); kept for the type shape / builtin-registry.test.ts. */
  message: string | ((spans: InfractionSpan[]) => string)
}

/**
 * i18n-exempt (AQU-832 WS-H): `name`/`description` below are never rendered
 * untranslated. `resolveBuiltinRules()` (builtin-resolver.ts) copies them
 * onto a `TranslationRule`, but every renderer reads that rule's display
 * text through `translateRuleName`/`translateRuleDescription`
 * (builtin-resolver.ts), which detects the `builtin:` id prefix and resolves
 * `rules.builtin.<id>.name`/`.description` from `src/lib/i18n/namespaces/rules.ts`
 * instead — these English strings are only the (untranslated, English-only)
 * default-locale text those catalog keys were copied from, plus the shape
 * `TranslationRule` requires. Do NOT wrap these in `t()`: this is a
 * module-scope const table, and `t()` is a hook (see rules.ts's header for
 * the full mechanism this already extends).
 */
export const BUILTIN_CHECKS: Record<BuiltinCheckId, BuiltinCheckDefinition> = {
  "empty-target": {
    ...TEXT_CHECK_META["empty-target"],
    description: "Source has content but the translation is blank or whitespace-only.",
    runsOnEmptyTarget: true,
    run: emptyTarget.runCheck,
    message: emptyTarget.MESSAGE,
  },
  "target-equals-source": {
    ...TEXT_CHECK_META["target-equals-source"],
    description: "Translation matches the source verbatim — likely untranslated.",
    runsOnEmptyTarget: false,
    run: targetEqualsSource.runCheck,
    message: targetEqualsSource.MESSAGE,
  },
  "placeholder-integrity": {
    ...TEXT_CHECK_META["placeholder-integrity"],
    description: "Tokens like {name}, <tag>, %s, \\n in source must appear in target.",
    runsOnEmptyTarget: false,
    run: placeholderIntegrity.runCheck,
    message: placeholderIntegrity.buildMessage,
  },
  "number-integrity": {
    ...TEXT_CHECK_META["number-integrity"],
    description: "Numerals in source must appear in target (locale separators are tolerated).",
    runsOnEmptyTarget: false,
    run: numberIntegrity.runCheck,
    message: numberIntegrity.MESSAGE,
  },
  // AQU-1761: the other direction, as its own check so it has its own switch
  // and severity. Minor by default: an added number is sometimes legitimate.
  "number-integrity-extra": {
    ...TEXT_CHECK_META["number-integrity-extra"],
    description: "Numerals in the translation should also appear in the source — catches a number the translator added.",
    runsOnEmptyTarget: false,
    run: numberIntegrityExtra.runCheck,
    message: numberIntegrityExtra.MESSAGE,
  },
  "end-punctuation-mismatch": {
    ...TEXT_CHECK_META["end-punctuation-mismatch"],
    description: "Source ends in ?/!/. — translation should end the same way.",
    runsOnEmptyTarget: false,
    run: endPunctuationMismatch.runCheck,
    message: endPunctuationMismatch.MESSAGE,
  },
  "punctuation-integrity": {
    ...TEXT_CHECK_META["punctuation-integrity"],
    description: "Clause punctuation (: or ;) in the source should also appear in the translation — catches mid-cell drops the end-punctuation check misses.",
    runsOnEmptyTarget: false,
    run: punctuationIntegrity.runCheck,
    message: punctuationIntegrity.MESSAGE,
  },
  "double-space": {
    ...TEXT_CHECK_META["double-space"],
    description: "Multiple consecutive spaces or leading/trailing whitespace.",
    runsOnEmptyTarget: false,
    run: doubleSpace.runCheck,
    message: doubleSpace.MESSAGE,
  },
  "repeated-word": {
    ...TEXT_CHECK_META["repeated-word"],
    description: "Same word appears twice in a row, unless the source does the same.",
    runsOnEmptyTarget: false,
    run: repeatedWord.runCheck,
    message: repeatedWord.MESSAGE,
  },
  "unpaired-symbols": {
    ...TEXT_CHECK_META["unpaired-symbols"],
    description: "Mismatched parentheses, brackets, or braces in translation.",
    runsOnEmptyTarget: false,
    run: unpairedSymbols.runCheck,
    message: unpairedSymbols.MESSAGE,
  },
  "abbreviation-mismatch": {
    ...TEXT_CHECK_META["abbreviation-mismatch"],
    description: "ALL-CAPS abbreviations from source missing in translation.",
    runsOnEmptyTarget: false,
    run: abbreviationMismatch.runCheck,
    message: abbreviationMismatch.MESSAGE,
  },
  // AQU-1688: the Bible data checks. Not in BUILTIN_CHECK_IDS: they become
  // rules only while the project's Bible data checks enrichment is on.
  ...BIBLE_BUILTIN_CHECKS,
  "usfm-structure": {
    ...TEXT_CHECK_META["usfm-structure"],
    description: "Markers in the translation must be recognized and closed (\\f … \\f*).",
    runsOnEmptyTarget: false,
    run: usfmStructure.runCheck,
    message: usfmStructure.MESSAGE,
  },
  "capitalization": {
    ...TEXT_CHECK_META["capitalization"],
    description: "A lowercase letter where a capital is expected — opening a sentence, or opening a paragraph or heading after its marker.",
    runsOnEmptyTarget: false,
    run: capitalization.runCheck,
    message: capitalization.MESSAGE,
  },
  "footnote-quote-mismatch": {
    ...TEXT_CHECK_META["footnote-quote-mismatch"],
    description:
      "Text a footnote or cross-reference quotes from the verse (\\fq, \\fk, \\xq, \\xk) must appear in that verse's translation.",
    runsOnEmptyTarget: false,
    run: footnoteQuoteMismatch.runCheck,
    message: footnoteQuoteMismatch.MESSAGE,
  },
  // The four below fill gaps in MQM coverage (https://www.w3.org/community/mqmcg/):
  // character encoding, unpaired marks, partial untranslated text, and a
  // length signal for omission/addition. Each is pure per cell and linear in
  // the cell's length, so incremental-infractions re-runs only the edited cell.
  "corrupted-characters": {
    ...TEXT_CHECK_META["corrupted-characters"],
    description: "Replacement characters (\uFFFD), stray control characters or garbled text such as \"Ã©\" that the source doesn't have.",
    runsOnEmptyTarget: false,
    run: corruptedCharacters.runCheck,
    message: corruptedCharacters.MESSAGE,
  },
  "unpaired-quotes": {
    ...TEXT_CHECK_META["unpaired-quotes"],
    description: "An opening or closing quotation mark without its partner, unless the source leaves a quotation open too.",
    runsOnEmptyTarget: false,
    run: unpairedQuotes.runCheck,
    message: unpairedQuotes.MESSAGE,
  },
  "untranslated-fragment": {
    ...TEXT_CHECK_META["untranslated-fragment"],
    description: "A word copied from the source in the source's script, when the translation is written in a different script.",
    runsOnEmptyTarget: false,
    run: untranslatedFragment.runCheck,
    message: untranslatedFragment.MESSAGE,
  },
  "length-ratio": {
    ...TEXT_CHECK_META["length-ratio"],
    description: "Translation is under 40% or over 250% of the source's length — a sign of a dropped or added clause. Off by default: normal length varies by language pair.",
    runsOnEmptyTarget: false,
    run: lengthRatio.runCheck,
    message: lengthRatio.MESSAGE,
  },
}

/** The text checks every project has. Bible data checks: BIBLE_BUILTIN_CHECK_IDS. */
export const BUILTIN_CHECK_IDS: BuiltinCheckId[] = [...TEXT_CHECK_IDS]
