// Bible data checks as built-in checks (AQU-1688).
//
// They sit in Rules → Built-in checks beside the ten text checks, with the same
// switch and severity (`algorithmicChecks`), but they run from pack facts:
// `run` is never called for them. The rule engine sends them to
// db/shared/bible-checks/evaluate.ts with the cell's compiled expectation
// (src/lib/rules/bible-check-rules.ts). They exist only while the project's
// Bible data checks enrichment is on (`resolveBuiltinRules`).
//
// i18n-exempt, as in builtin-registry.ts: `name`/`description` are the English
// copy of the `bibleData.check.*` keys, and every renderer translates them
// through `translateRuleName`/`translateRuleDescription`.

import type { BuiltinCheckDefinition } from "./builtin-registry"
import {
  BIBLE_CHECK_DEFAULT_SEVERITY,
  BIBLE_CHECK_IDS,
  type BibleCheckId,
} from "../../../db/shared/bible-checks/types"

const COPY: Readonly<Record<BibleCheckId, { name: string; description: string }>> = {
  "bkp:V1": {
    name: "Quotation opens",
    description: "Where a speech starts in a verse, the translation has the opening quotation mark for its level.",
  },
  "bkp:V2": {
    name: "Quotation closes",
    description:
      "Where a speech ends in a verse, the translation closes the quotation there, before any narration that follows.",
  },
  "bkp:V3": {
    name: "Quotation continues",
    description: "Where a speech goes on into the next verse, the translation does not close the quotation early.",
  },
  "bkp:V5": {
    name: "Nested quotation marks",
    description: "A quotation inside a quotation uses the marks the Language profile sets for its level.",
  },
  "bkp:V7": {
    name: "Quotation marks without speech",
    description: "Flags quotation marks in a verse where nobody speaks. Short titles and scare quotes are allowed.",
  },
  "bkp:V8": {
    name: "Interrupted quotation",
    description: "Where the narrator interrupts a speech, the quotation closes before the interruption and reopens after it.",
  },
  "bkp:V9": {
    name: "Speaker's own framing",
    description: "Words a speaker introduces with “I tell you that …” are part of that speech and need no extra quotation level.",
  },
  "bkp:M1": {
    name: "Question kept",
    description: "Where the source asks a question, the translation has a question mark.",
  },
}

export const BIBLE_BUILTIN_CHECK_IDS: readonly BibleCheckId[] = BIBLE_CHECK_IDS

export const BIBLE_BUILTIN_CHECKS = Object.fromEntries(
  BIBLE_CHECK_IDS.map((id): [BibleCheckId, BuiltinCheckDefinition] => [
    id,
    {
      id,
      ...COPY[id],
      // Design-doc W and I map onto the project's major and minor.
      defaultSeverity: BIBLE_CHECK_DEFAULT_SEVERITY[id] === "warning" ? "major" : "minor",
      defaultEnabled: true,
      // An empty translation is the empty-translation check's finding, not a quotation problem.
      runsOnEmptyTarget: false,
      run: () => null,
      message: "",
    },
  ]),
) as Record<BibleCheckId, BuiltinCheckDefinition>
