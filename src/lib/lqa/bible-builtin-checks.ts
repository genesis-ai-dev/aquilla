// Bible data checks as built-in checks (AQU-1688).
//
// They sit in Rules → Built-in checks beside the ten text checks, with the same
// switch and severity (`algorithmicChecks`), but they run from pack facts:
// `run` is never called for them. The rule engine sends them to
// db/shared/bible-checks/evaluate.ts with the cell's compiled expectation
// (src/lib/rules/bible-check-rules.ts); S1 and S8 need the whole file and run
// in "Check file" only (db/shared/bible-checks/scans.ts), and so do P2 and X3
// (AQU-1699, db/shared/bible-checks/scans-pack-b.ts). They exist only
// while the project's Bible data checks enrichment is on (`resolveBuiltinRules`).
//
// i18n-exempt, as in builtin-registry.ts: `name`/`description` are the English
// copy of the `bibleData.check.*` keys, and every renderer translates them
// through `translateRuleName`/`translateRuleDescription`.

import type { BuiltinCheckDefinition } from "./builtin-registry"
import { BIBLE_CHECK_IDS, type BibleCheckId } from "../../../db/shared/bible-checks/types"
import { BIBLE_CHECK_META } from "../../../db/shared/builtin-checks"

const COPY: Readonly<Record<BibleCheckId, { description: string }>> = {
  "bkp:V1": {
    description: "Where a speech starts in a verse, the translation has the opening quotation mark for its level.",
  },
  "bkp:V2": {
    description:
      "Where a speech ends in a verse, the translation closes the quotation there, before any narration that follows.",
  },
  "bkp:V3": {
    description: "Where a speech goes on into the next verse, the translation does not close the quotation early.",
  },
  "bkp:V5": {
    description: "A quotation inside a quotation uses the marks the Language profile sets for its level.",
  },
  "bkp:V7": {
    description: "Flags quotation marks in a verse where nobody speaks. Short titles and scare quotes are allowed.",
  },
  "bkp:V8": {
    description: "Where the narrator interrupts a speech, the quotation closes before the interruption and reopens after it.",
  },
  "bkp:V9": {
    description: "Words a speaker introduces with “I tell you that …” are part of that speech and need no extra quotation level.",
  },
  "bkp:M1": {
    description: "Where the source asks a question, the translation has a question mark or a question marker.",
  },
  // AQU-1697: check pack A. Copy of the `bibleChecks.*` keys (M3's name is
  // `agent.finding.bibleCheck.negation`).
  "bkp:N1": {
    description:
      "Where the source states a number, the translation has it too, as digits or as a number word from the Language profile.",
  },
  "bkp:N2": {
    description:
      "Where the source says “the third day” or “the sixth hour”, a translation that writes numbers in digits has the same number.",
  },
  "bkp:M3": {
    description:
      "Where the source says “not” or “never”, the translation has one of the negative words from the Language profile.",
  },
  "bkp:S1": {
    description: "Each passage starts with a section heading, and no heading stands inside a passage. Runs in Check file.",
  },
  "bkp:S3": {
    description:
      "Where the source sentence goes on into the next verse, the translation does not end its sentence at the end of the verse.",
  },
  "bkp:S6": {
    description:
      "Verses such as Matthew 17:21, which the oldest manuscripts leave out, follow the Language profile: left out, in brackets or in a footnote.",
  },
  "bkp:S7": {
    description: "John 7:53–8:11 and Mark 16:9–20 follow the Language profile: left out, in brackets or with a footnote.",
  },
  "bkp:S8": {
    description:
      "The file has a cell for each verse the Bible data has, and none it lacks, so its facts reach the right cells. Runs in Check file.",
  },
  // AQU-1699: check pack B. Copy of the `bibleParticipants.*` keys (P8's name
  // is `agent.finding.bibleCheck.youNumber`).
  "bkp:P1": {
    description:
      "Where the source names someone, the translation has their agreed name: a decision such as render.person.Peter, or a terminology entry.",
  },
  "bkp:P2": {
    description:
      "Each person, group or place has the same name in every verse that uses the same form of the name in the source. Runs in Check file.",
  },
  "bkp:P3": {
    description:
      "Where the source names one of several people with the same name (six Marys, nine Simons), the translation uses that person's name, not a namesake's.",
  },
  "bkp:P4": {
    description:
      "Where the source uses one form of a name (Cephas, not Simon) and the project has a name for each form, the translation uses the name for that form.",
  },
  "bkp:P5": {
    description:
      "The translation names nobody that the source of the verse does not mention, by name, as a pronoun or as the subject of a verb. The subject of the verse before or after also counts.",
  },
  "bkp:P6": {
    description: "Where the source names nobody and only implies who acts (“he says”), a name that the translation adds is the name of that person.",
  },
  "bkp:P8": {
    description:
      "Where every “you” in the source speaks to one person, or every one speaks to several, the translation uses a “you” of that number from the Language profile, and none of the other.",
  },
  "bkp:P9": {
    description:
      "Where “we” includes the people spoken to, or leaves them out, the translation uses the inclusive or exclusive “we” from the Language profile.",
  },
  "bkp:P10": {
    description: "Where a pronoun refers to two, three or a few people, the translation uses the form for that number from the Language profile.",
  },
  "bkp:P14": {
    description: "Where κύριος means Jesus or God, or πνεῦμα means the Holy Spirit, the translation uses the project's rendering for each.",
  },
  "bkp:P15": {
    description: "Where the house style capitalizes pronouns for God, Jesus and the Holy Spirit, those pronouns start with a capital letter.",
  },
  "bkp:X3": {
    description: "Where the source repeats a quotation in the file, the translation renders it in the same way each time. Runs in Check file.",
  },
  "bkp:X4": {
    description:
      "Where the project has decided whether “we” in a passage includes the listener (a clusivity decision), every “we” in that passage uses the decided form.",
  },
}

export const BIBLE_BUILTIN_CHECK_IDS: readonly BibleCheckId[] = BIBLE_CHECK_IDS

export const BIBLE_BUILTIN_CHECKS = Object.fromEntries(
  BIBLE_CHECK_IDS.map((id): [BibleCheckId, BuiltinCheckDefinition] => [
    id,
    {
      ...BIBLE_CHECK_META[id],
      ...COPY[id],
      // An empty translation is the empty-translation check's finding, not a quotation problem.
      runsOnEmptyTarget: false,
      run: () => null,
      message: "",
    },
  ]),
) as Record<BibleCheckId, BuiltinCheckDefinition>
