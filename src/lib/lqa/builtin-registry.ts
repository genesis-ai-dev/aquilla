import type { BuiltinCheckId, InfractionSpan } from "@/lib/parsers/types"
import * as emptyTarget from "./check-functions/empty-target"
import * as targetEqualsSource from "./check-functions/target-equals-source"
import * as placeholderIntegrity from "./check-functions/placeholder-integrity"
import * as numberIntegrity from "./check-functions/number-integrity"
import * as endPunctuationMismatch from "./check-functions/end-punctuation-mismatch"
import * as doubleSpace from "./check-functions/double-space"
import * as repeatedWord from "./check-functions/repeated-word"
import * as unpairedSymbols from "./check-functions/unpaired-symbols"
import * as abbreviationMismatch from "./check-functions/abbreviation-mismatch"
import * as usfmMarkerIntegrity from "./check-functions/usfm-marker-integrity"

/** Optional rich-text context threaded to HTML-aware checks (e.g. USFM inline
 *  marker integrity). Plain-text checks ignore it. */
export interface BuiltinCheckContext {
  sourceHtml?: string
  targetHtml?: string
}

export interface BuiltinCheckDefinition {
  id: BuiltinCheckId
  name: string
  description: string
  defaultSeverity: "major" | "minor"
  defaultEnabled: boolean
  /** True if the check should run even when target is empty. */
  runsOnEmptyTarget: boolean
  run: (source: string, target: string, ctx?: BuiltinCheckContext) => InfractionSpan[] | null
  message: string
}

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
    message: placeholderIntegrity.MESSAGE,
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
  "usfm-marker-integrity": {
    id: "usfm-marker-integrity",
    name: "Inline markup integrity",
    description:
      "Inline formatting (\\nd, \\bd, \\wj…) and footnotes/cross-refs in the source should be preserved in the translation. Formatting can be auto-restored; footnotes are flagged only.",
    defaultSeverity: "minor",
    defaultEnabled: true,
    runsOnEmptyTarget: false,
    run: usfmMarkerIntegrity.runCheck,
    message: usfmMarkerIntegrity.MESSAGE,
  },
}

export const BUILTIN_CHECK_IDS: BuiltinCheckId[] = [
  "empty-target",
  "target-equals-source",
  "placeholder-integrity",
  "number-integrity",
  "end-punctuation-mismatch",
  "double-space",
  "repeated-word",
  "unpaired-symbols",
  "abbreviation-mismatch",
  "usfm-marker-integrity",
]
