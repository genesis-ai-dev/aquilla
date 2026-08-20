import type { BuiltinCheckId, InfractionSpan } from "@/lib/parsers/types"
import * as emptyTarget from "./check-functions/empty-target"
import * as targetEqualsSource from "./check-functions/target-equals-source"
import * as placeholderIntegrity from "./check-functions/placeholder-integrity"
import * as numberIntegrity from "./check-functions/number-integrity"
import * as endPunctuationMismatch from "./check-functions/end-punctuation-mismatch"
import * as punctuationIntegrity from "./check-functions/punctuation-integrity"
import * as doubleSpace from "./check-functions/double-space"
import * as repeatedWord from "./check-functions/repeated-word"
import * as unpairedSymbols from "./check-functions/unpaired-symbols"
import * as abbreviationMismatch from "./check-functions/abbreviation-mismatch"

export interface BuiltinCheckDefinition {
  id: BuiltinCheckId
  name: string
  description: string
  defaultSeverity: "major" | "minor"
  defaultEnabled: boolean
  /** True if the check should run even when target is empty. */
  runsOnEmptyTarget: boolean
  run: (source: string, target: string) => InfractionSpan[] | null
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
    id: "empty-target",
    name: "Empty translation",
    description: "Source has content but the translation is blank or whitespace-only.",
    defaultSeverity: "major",
    defaultEnabled: true,
    runsOnEmptyTarget: true,
    run: emptyTarget.runCheck,
    message: emptyTarget.MESSAGE,
  },
  "target-equals-source": {
    id: "target-equals-source",
    name: "Identical to source",
    description: "Translation matches the source verbatim — likely untranslated.",
    defaultSeverity: "major",
    defaultEnabled: true,
    runsOnEmptyTarget: false,
    run: targetEqualsSource.runCheck,
    message: targetEqualsSource.MESSAGE,
  },
  "placeholder-integrity": {
    id: "placeholder-integrity",
    name: "Placeholder integrity",
    description: "Tokens like {name}, <tag>, %s, \\n in source must appear in target.",
    defaultSeverity: "major",
    defaultEnabled: true,
    runsOnEmptyTarget: false,
    run: placeholderIntegrity.runCheck,
    message: placeholderIntegrity.buildMessage,
  },
  "number-integrity": {
    id: "number-integrity",
    name: "Number integrity",
    description: "Numerals in source must appear in target (locale separators are tolerated).",
    defaultSeverity: "major",
    defaultEnabled: true,
    runsOnEmptyTarget: false,
    run: numberIntegrity.runCheck,
    message: numberIntegrity.MESSAGE,
  },
  "end-punctuation-mismatch": {
    id: "end-punctuation-mismatch",
    name: "End punctuation",
    description: "Source ends in ?/!/. — translation should end the same way.",
    defaultSeverity: "minor",
    defaultEnabled: true,
    runsOnEmptyTarget: false,
    run: endPunctuationMismatch.runCheck,
    message: endPunctuationMismatch.MESSAGE,
  },
  "punctuation-integrity": {
    id: "punctuation-integrity",
    name: "Punctuation integrity",
    description: "Clause punctuation (: or ;) in the source should also appear in the translation — catches mid-cell drops the end-punctuation check misses.",
    defaultSeverity: "minor",
    defaultEnabled: true,
    runsOnEmptyTarget: false,
    run: punctuationIntegrity.runCheck,
    message: punctuationIntegrity.MESSAGE,
  },
  "double-space": {
    id: "double-space",
    name: "Extra whitespace",
    description: "Multiple consecutive spaces or leading/trailing whitespace.",
    defaultSeverity: "minor",
    defaultEnabled: true,
    runsOnEmptyTarget: false,
    run: doubleSpace.runCheck,
    message: doubleSpace.MESSAGE,
  },
  "repeated-word": {
    id: "repeated-word",
    name: "Repeated word",
    description: "Same word appears twice in a row, unless the source does the same.",
    defaultSeverity: "minor",
    defaultEnabled: true,
    runsOnEmptyTarget: false,
    run: repeatedWord.runCheck,
    message: repeatedWord.MESSAGE,
  },
  "unpaired-symbols": {
    id: "unpaired-symbols",
    name: "Unpaired brackets",
    description: "Mismatched parentheses, brackets, or braces in translation.",
    defaultSeverity: "minor",
    defaultEnabled: true,
    runsOnEmptyTarget: false,
    run: unpairedSymbols.runCheck,
    message: unpairedSymbols.MESSAGE,
  },
  "abbreviation-mismatch": {
    id: "abbreviation-mismatch",
    name: "Abbreviation pass-through",
    description: "ALL-CAPS abbreviations from source missing in translation.",
    defaultSeverity: "minor",
    defaultEnabled: false,
    runsOnEmptyTarget: false,
    run: abbreviationMismatch.runCheck,
    message: abbreviationMismatch.MESSAGE,
  },
}

export const BUILTIN_CHECK_IDS: BuiltinCheckId[] = [
  "empty-target",
  "target-equals-source",
  "placeholder-integrity",
  "number-integrity",
  "end-punctuation-mismatch",
  "punctuation-integrity",
  "double-space",
  "repeated-word",
  "unpaired-symbols",
  "abbreviation-mismatch",
]
