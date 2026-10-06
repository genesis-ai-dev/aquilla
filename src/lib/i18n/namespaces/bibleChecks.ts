import { defineNamespace } from "./types"

/**
 * `bibleChecks` namespace (AQU-1697): Bible data check pack A — numbers (N1,
 * N2), negation (M3), passage headings (S1), sentences that run on into the
 * next verse (S3), verses some manuscripts leave out (S6, S7) and verse
 * numbering (S8). Their rows in Rules → Built-in checks, the Language-profile
 * slot each waits for, and each finding's explanation and evidence, keyed
 * from reason codes in src/lib/bible-data/check-messages.ts.
 *
 * The first checks (quotations V1–V9, questions M1) stay in `bibleData.check.*`.
 * M3's name is `agent.finding.bibleCheck.negation`, which autopilot already
 * shows for the same check.
 */
export const bibleChecks = defineNamespace({
  keys: {
    // ── Rows in Rules → Built-in checks ──
    "bibleChecks.n1.name": "Number kept",
    "bibleChecks.n1.description":
      "Where the source states a number, the translation has it too, as digits or as a number word from the Language profile.",
    "bibleChecks.n2.name": "Ordinal number kept",
    "bibleChecks.n2.description":
      "Where the source says “the third day” or “the sixth hour”, a translation that writes numbers in digits has the same number.",
    "bibleChecks.m3.description":
      "Where the source says “not” or “never”, the translation has one of the negative words from the Language profile.",
    "bibleChecks.s1.name": "Heading for each passage",
    "bibleChecks.s1.description":
      "Each passage starts with a section heading, and no heading stands inside a passage. Runs in Check file.",
    "bibleChecks.s3.name": "Sentence runs on",
    "bibleChecks.s3.description":
      "Where the source sentence goes on into the next verse, the translation does not end its sentence at the end of the verse.",
    "bibleChecks.s6.name": "Verses the oldest manuscripts lack",
    "bibleChecks.s6.description":
      "Verses such as Matthew 17:21, which the oldest manuscripts leave out, follow the Language profile: left out, in brackets or in a footnote.",
    "bibleChecks.s7.name": "Disputed passages",
    "bibleChecks.s7.description":
      "John 7:53–8:11 and Mark 16:9–20 follow the Language profile: left out, in brackets or with a footnote.",
    "bibleChecks.s8.name": "Verse numbering",
    "bibleChecks.s8.description":
      "The file has a cell for each verse the Bible data has, and none it lacks, so its facts reach the right cells. Runs in Check file.",
    "bibleChecks.needs.numberWords": "Needs: number words in Language profile",
    "bibleChecks.needs.negators": "Needs: negative words in Language profile",
    "bibleChecks.needs.headings": "Needs: section headings in Language profile",
    "bibleChecks.needs.textualVariants": "Needs: textual variants in Language profile",

    // ── One finding, explained (Issues tab, findings drawer, autopilot review) ──
    "bibleChecks.reason.numberMissing":
      "The source has the number {value} in this verse, but the translation has neither its digits nor its number word.",
    "bibleChecks.reason.numberMissingDigitsOnly":
      "The source has the number {value} in this verse, but the translation has no digits for it. With standard number words, this check reads digits only. To check numbers written as words, enter your number words in the Language profile.",
    "bibleChecks.reason.numberMissingUnlisted":
      "The source has the number {value} in this verse. The translation has no digits for it, and the Language profile has no word for it. If your translation writes it as a word, add the word to Number words.",
    "bibleChecks.reason.ordinalMissing":
      "The source has the ordinal number {value} in this verse, as in “the third day”. The translation writes numbers in digits but does not have this one.",
    "bibleChecks.reason.negationMissing":
      "The source makes a negative statement in this verse, but the translation has none of the negative words from the Language profile. Without one, the meaning can be the opposite.",
    "bibleChecks.reason.negationFewer":
      "The translation has fewer negative words ({found}) than the source has negations ({expected}) in this verse.",
    "bibleChecks.reason.sentenceEndsEarly":
      "The source sentence goes on into the next verse, but the translation ends its sentence here. Check that the two verses still read as one thought.",
    "bibleChecks.reason.variantNotOmitted":
      "The Language profile says to leave out verses that the oldest manuscripts lack, but this cell has text for {passage}.",
    "bibleChecks.reason.variantNotBracketed":
      "The Language profile says to keep {passage} in brackets, but this cell does not have the brackets.",
    "bibleChecks.reason.variantNoFootnote":
      "The Language profile says to give {passage} a footnote, but this cell has no footnote.",
    "bibleChecks.reason.headingMissing":
      "A passage starts here (“{title}”), but no section heading comes before it.",
    "bibleChecks.reason.headingInsidePericope":
      "This heading stands inside a passage (“{title}”), not where a passage starts.",
    "bibleChecks.reason.verseNotInPack":
      "The Bible data has no verse {refs}, so its facts do not reach this cell. The file can number verses in a different way.",
    "bibleChecks.reason.packVerseWithoutCell":
      "The Bible data has {refs} after this cell, but the file has no cell for it. The file can number verses in a different way.",
    "bibleChecks.evidence.number": "{dataset}: {ref} words {from}–{to}",
    "bibleChecks.evidence.numberWord": "{dataset}: {ref} word {from}",
    "bibleChecks.evidence.about": "The source says “about” before this number.",
    "bibleChecks.evidence.indefinite": "Here the source word for “one” can also mean “a” or “a certain”.",
    "bibleChecks.evidence.negation": "{dataset}: negation in {refs}",
    "bibleChecks.evidence.move": "{dataset}: the sentence in {refs} goes on into the next verse",
    "bibleChecks.evidence.absentVerse": "{passage}: not in the critical Greek text (NA28, SBLGNT)",
    "bibleChecks.evidence.disputedPassage": "{passage}: in double brackets in the critical Greek text (NA28, SBLGNT)",
    "bibleChecks.evidence.pericope": "{dataset}: the passage “{title}” starts at {refs}",
    "bibleChecks.evidence.pericopeInside": "{dataset}: {refs} is inside the passage “{title}”",
  },
  context: {
    _context: {
      description:
        "Bible data checks, second set: they compare a translation with facts from the Bible Knowledge Pack " +
        "about numbers, negation, passage headings, sentences across verses, verses that some manuscripts " +
        "leave out, and verse numbering. Names and descriptions appear in Rules → Built-in checks; reasons " +
        "and evidence lines explain one finding in the Issues tab, the Check file results and autopilot's review.",
    },
    keys: {
      "bibleChecks.n1.name": { description: "Name of the check that a number in the source is still in the translation." },
      "bibleChecks.n1.description": { description: "One-sentence explanation under the check's name." },
      "bibleChecks.n2.name": {
        description: "Name of the check that an ordinal number ('third', 'sixth') in the source is still in the translation.",
      },
      "bibleChecks.n2.description": { description: "One-sentence explanation under the check's name." },
      "bibleChecks.m3.description": {
        description: "One-sentence explanation under the name of the check that the translation keeps the source's negation.",
      },
      "bibleChecks.s1.name": { description: "Name of the check that each Bible passage has a section heading above it." },
      "bibleChecks.s1.description": {
        description: "Explanation under the check's name. 'Check file' is the name of a menu command.",
      },
      "bibleChecks.s3.name": {
        description: "Name of the check that a sentence that continues into the next verse is not ended early.",
      },
      "bibleChecks.s3.description": { description: "One-sentence explanation under the check's name." },
      "bibleChecks.s6.name": {
        description:
          "Name of the check for verses that the oldest Greek manuscripts do not have, such as Matthew 17:21.",
      },
      "bibleChecks.s6.description": {
        description:
          "Explanation under the check's name. The three options are the project's policy choices in the Language profile.",
      },
      "bibleChecks.s7.name": {
        description: "Name of the check for passages whose place in the Bible is disputed, such as John 7:53–8:11.",
      },
      "bibleChecks.s7.description": {
        description:
          "Explanation under the check's name. The three options are the project's policy choices in the Language profile.",
      },
      "bibleChecks.s8.name": {
        description: "Name of the check that the file's verse numbers match the verse numbers of the Bible data.",
      },
      "bibleChecks.s8.description": {
        description: "Explanation under the check's name. 'Check file' is the name of a menu command.",
      },
      "bibleChecks.needs.numberWords": {
        description:
          "Shown under a check while it cannot run, because the Language profile card has no number words saved. " +
          "'Language profile' is the name of that settings card.",
      },
      "bibleChecks.needs.negators": {
        description:
          "Shown under a check while it cannot run, because the Language profile card has no negative words " +
          "('not', 'never') saved. 'Language profile' is the name of that settings card.",
      },
      "bibleChecks.needs.headings": {
        description:
          "Shown under a check while it cannot run, because the Language profile card has no heading policy saved. " +
          "'Language profile' is the name of that settings card.",
      },
      "bibleChecks.needs.textualVariants": {
        description:
          "Shown under a check while it cannot run, because the Language profile card has no policy for verses " +
          "that some manuscripts leave out. 'Language profile' is the name of that settings card.",
      },
      "bibleChecks.reason.numberMissing": {
        description: "Explains a finding: a number in the source is missing from the translation.",
        placeholders: { value: "The number, in digits, e.g. 153." },
      },
      "bibleChecks.reason.numberMissingDigitsOnly": {
        description:
          "Explains a finding when the project uses the standard number words, which this check cannot read yet. " +
          "'Number words' and 'Language profile' are names of settings.",
        placeholders: { value: "The number, in digits, e.g. 153." },
      },
      "bibleChecks.reason.numberMissingUnlisted": {
        description:
          "Explains a finding when the project's own list of number words has no word for this number. " +
          "'Number words' and 'Language profile' are names of settings.",
        placeholders: { value: "The number, in digits, e.g. 153." },
      },
      "bibleChecks.reason.ordinalMissing": {
        description: "Explains a finding: an ordinal number ('third') in the source is missing from the translation.",
        placeholders: { value: "The ordinal's number, in digits: 3 for 'third'." },
      },
      "bibleChecks.reason.negationMissing": {
        description: "Explains a finding: the source says 'not' or 'never', and the translation has no negative word.",
      },
      "bibleChecks.reason.negationFewer": {
        description:
          "Explains a finding: the translation has fewer negative words than the source has negations.",
        placeholders: {
          found: "How many negative words the translation has, as a number.",
          expected: "How many negations the source has, as a number.",
        },
      },
      "bibleChecks.reason.sentenceEndsEarly": {
        description: "Explains a finding: the translation ends a sentence where the source sentence continues.",
      },
      "bibleChecks.reason.variantNotOmitted": {
        description: "Explains a finding: the project leaves these verses out, but the cell has text.",
        placeholders: { passage: "Verse references, e.g. 'MAT 17:21'. Not translated." },
      },
      "bibleChecks.reason.variantNotBracketed": {
        description: "Explains a finding: the project puts these verses in brackets, but the cell has none.",
        placeholders: { passage: "Verse references, e.g. 'JHN 7:53–8:11'. Not translated." },
      },
      "bibleChecks.reason.variantNoFootnote": {
        description: "Explains a finding: the project gives these verses a footnote, but the cell has none.",
        placeholders: { passage: "Verse references, e.g. 'MRK 16:9–20'. Not translated." },
      },
      "bibleChecks.reason.headingMissing": {
        description: "Explains a finding: a new Bible passage starts here without a section heading.",
        placeholders: { title: "The passage's title in the Bible data, in English, e.g. 'The Wedding at Cana'." },
      },
      "bibleChecks.reason.headingInsidePericope": {
        description: "Explains a finding: a section heading interrupts a Bible passage.",
        placeholders: { title: "The passage's title in the Bible data, in English, e.g. 'The Wedding at Cana'." },
      },
      "bibleChecks.reason.verseNotInPack": {
        description: "Explains a finding: the file has a verse that the Bible data does not number.",
        placeholders: { refs: "Verse references, e.g. '2CO 13:14'. Not translated." },
      },
      "bibleChecks.reason.packVerseWithoutCell": {
        description: "Explains a finding: the Bible data has a verse that the file has no cell for.",
        placeholders: { refs: "Verse references, e.g. '3JN 1:15'. Not translated." },
      },
      "bibleChecks.evidence.number": {
        description: "Where a number is in the source, e.g. 'Macula: JHN 21:11 words 15–17'.",
        placeholders: {
          dataset: "Name of a data source, e.g. 'Macula'. Not translated.",
          ref: "A verse reference, e.g. 'JHN 21:11'. Not translated.",
          from: "Position of the first word in the verse, as a number.",
          to: "Position of the last word in the verse, as a number.",
        },
      },
      "bibleChecks.evidence.numberWord": {
        description: "Where a one-word number is in the source, e.g. 'Macula: JHN 4:18 word 1'.",
        placeholders: {
          dataset: "Name of a data source, e.g. 'Macula'. Not translated.",
          ref: "A verse reference, e.g. 'JHN 4:18'. Not translated.",
          from: "Position of the word in the verse, as a number.",
        },
      },
      "bibleChecks.evidence.about": {
        description: "Extra line under a number finding: the source gives the number as approximate.",
      },
      "bibleChecks.evidence.indefinite": {
        description: "Extra line under a number finding: the source word for 'one' can mean 'a', so 'one' may be missing on purpose.",
      },
      "bibleChecks.evidence.negation": {
        description: "Where the source's negation is, e.g. 'Macula: negation in JHN 3:18'.",
        placeholders: {
          dataset: "Name of a data source, e.g. 'Macula'. Not translated.",
          refs: "Verse references, e.g. 'JHN 3:18'. Not translated.",
        },
      },
      "bibleChecks.evidence.move": {
        description: "Where the source sentence continues, e.g. 'OpenText: the sentence in EPH 1:3 goes on into the next verse'.",
        placeholders: {
          dataset: "Name of a data source, e.g. 'OpenText'. Not translated.",
          refs: "Verse references, e.g. 'EPH 1:3'. Not translated.",
        },
      },
      "bibleChecks.evidence.absentVerse": {
        description: "Why a verse is a textual variant. NA28 and SBLGNT are names of Greek New Testament editions.",
        placeholders: { passage: "Verse references, e.g. 'MAT 17:21'. Not translated." },
      },
      "bibleChecks.evidence.disputedPassage": {
        description: "Why a passage is disputed. NA28 and SBLGNT are names of Greek New Testament editions.",
        placeholders: { passage: "Verse references, e.g. 'JHN 7:53–8:11'. Not translated." },
      },
      "bibleChecks.evidence.pericope": {
        description: "Where a passage starts in the Bible data, e.g. 'OpenText: the passage “The Wedding at Cana” starts at JHN 2:1'.",
        placeholders: {
          dataset: "Name of a data source, e.g. 'OpenText'. Not translated.",
          title: "The passage's title in the Bible data, in English.",
          refs: "Verse references, e.g. 'JHN 2:1'. Not translated.",
        },
      },
      "bibleChecks.evidence.pericopeInside": {
        description: "Where a heading stands in the Bible data's passages, e.g. 'OpenText: JHN 2:5 is inside the passage “The Wedding at Cana”'.",
        placeholders: {
          dataset: "Name of a data source, e.g. 'OpenText'. Not translated.",
          refs: "Verse references, e.g. 'JHN 2:5'. Not translated.",
          title: "The passage's title in the Bible data, in English.",
        },
      },
    },
  },
  surfaces: [],
})
