import { defineNamespace } from "./types"

/**
 * `bibleParticipants` namespace (AQU-1699): Bible data check pack B, about
 * participants and consistency across verses. It covers names (P1–P6), "you"
 * singular and plural (P8), inclusive and exclusive "we" (P9), dual, trial and
 * paucal forms (P10), κύριος and πνεῦμα (P14), capitals for God (P15),
 * repeated quotations (X3) and recorded decisions (X4). Their rows in Rules →
 * Built-in checks, what each waits for, and each finding's explanation and
 * evidence are keyed from reason codes in
 * src/lib/bible-data/check-messages-pack-b.ts. P8's name is
 * `agent.finding.bibleCheck.youNumber`, which autopilot already shows.
 *
 * Bible check pack A (numbers, negation, structure) stays in `bibleChecks.*`.
 */
export const bibleParticipants = defineNamespace({
  keys: {
    // ── Rows in Rules → Built-in checks ──
    "bibleParticipants.p1.name": "Names kept",
    "bibleParticipants.p1.description":
      "Where the source names someone, the translation has their agreed name: a decision such as render.person.Peter, or a terminology entry.",
    "bibleParticipants.p2.name": "One name across the file",
    "bibleParticipants.p2.description":
      "Each person, group or place has the same name in every verse that uses the same form of the name in the source. Runs in Check file.",
    "bibleParticipants.p3.name": "Namesakes told apart",
    "bibleParticipants.p3.description":
      "Where the source names one of several people with the same name (six Marys, nine Simons), the translation uses that person's name, not a namesake's.",
    "bibleParticipants.p4.name": "Name form kept",
    "bibleParticipants.p4.description":
      "Where the source uses one form of a name (Cephas, not Simon) and the project has a name for each form, the translation uses the name for that form.",
    "bibleParticipants.p5.name": "No names the source lacks",
    "bibleParticipants.p5.description":
      "The translation names nobody that the source of the verse does not mention, by name, as a pronoun or as the subject of a verb. The subject of the verse before or after also counts.",
    "bibleParticipants.p6.name": "Implied subject named correctly",
    "bibleParticipants.p6.description":
      "Where the source names nobody and only implies who acts (“he says”), a name that the translation adds is the name of that person.",
    "bibleParticipants.p8.description":
      "Where every “you” in the source speaks to one person, or every one speaks to several, the translation uses a “you” of that number from the Language profile, and none of the other.",
    "bibleParticipants.p9.name": "Inclusive or exclusive “we”",
    "bibleParticipants.p9.description":
      "Where “we” includes the people spoken to, or leaves them out, the translation uses the inclusive or exclusive “we” from the Language profile.",
    "bibleParticipants.p10.name": "Dual, trial and paucal forms",
    "bibleParticipants.p10.description":
      "Where a pronoun refers to two, three or a few people, the translation uses the form for that number from the Language profile.",
    "bibleParticipants.p14.name": "Lord and Spirit",
    "bibleParticipants.p14.description":
      "Where κύριος means Jesus or God, or πνεῦμα means the Holy Spirit, the translation uses the project's rendering for each.",
    "bibleParticipants.p15.name": "Capitals for God",
    "bibleParticipants.p15.description":
      "Where the house style capitalizes pronouns for God, Jesus and the Holy Spirit, those pronouns start with a capital letter.",
    "bibleParticipants.x3.name": "Repeated quotations alike",
    "bibleParticipants.x3.description":
      "Where the source repeats a quotation in the file, the translation renders it in the same way each time. Runs in Check file.",
    "bibleParticipants.x4.name": "Decisions kept",
    "bibleParticipants.x4.description":
      "Where the project has decided whether “we” in a passage includes the listener (a clusivity decision), every “we” in that passage uses the decided form.",

    // ── What a dormant check waits for ──
    "bibleParticipants.needs.agreedNames": "Needs: agreed names, from decisions (render.…) or terminology entries",
    "bibleParticipants.needs.nameForms": "Needs: a decision for two forms of one name (render.….form.…)",
    "bibleParticipants.needs.secondPersonForms": "Needs: singular and plural “you” forms in Language profile",
    "bibleParticipants.needs.secondPersonSame": "Not used: in Language profile, “you” is the same for one person and for several",
    "bibleParticipants.needs.clusivityForms": "Needs: inclusive and exclusive “we” forms in Language profile",
    "bibleParticipants.needs.clusivitySame": "Not used: in Language profile, “we” is the same with or without the listener",
    "bibleParticipants.needs.groupNumberForms": "Needs: dual, trial or paucal forms in Language profile",
    "bibleParticipants.needs.groupNumberNone": "Not used: Language profile has no dual, trial or paucal",
    "bibleParticipants.needs.divineNames": "Needs: renderings of κύριος in Language profile (Divine names) or as decisions",
    "bibleParticipants.needs.deityCapitals": "Needs: the capitals rule for God in Language profile (Divine names)",
    "bibleParticipants.needs.deityCapitalsOff": "Not used: the house style keeps pronouns for God in lowercase",
    "bibleParticipants.needs.alignment": "Needs: word alignment between the Greek and the translation, which this project does not have",
    "bibleParticipants.needs.clusivityDecisions": "Needs: a decision about “we” in a passage (clusivity.…)",

    // ── One finding, explained ──
    "bibleParticipants.reason.nameMissing":
      "The source names {name} here, but the translation has none of the agreed names ({renderings}).",
    "bibleParticipants.reason.nameMissingPronoun":
      "The source names {name} here, but the translation has none of the agreed names ({renderings}). A pronoun can be correct here, because the context already names this person.",
    "bibleParticipants.reason.nameVariantDifferent":
      "The translation calls {name} “{found}” here, but in the rest of the file the same name in the source is “{usual}”.",
    "bibleParticipants.reason.nameVariantNone":
      "The source names {name} here, but the translation does not have “{usual}”, the name that the rest of the file uses.",
    "bibleParticipants.reason.homonymName":
      "The source names {name} here, but the translation has “{found}”, which is the name of {other}.",
    "bibleParticipants.reason.nameFormMissing":
      "The source calls {name} “{form}” here. The project renders that form “{rendering}”, and the translation does not have it.",
    "bibleParticipants.reason.nameNotInSource":
      "The translation names “{found}” ({name}), but the source does not mention them in this verse or as the subject next to it.",
    "bibleParticipants.reason.subjectNameWrong":
      "The source does not name who acts here, and the Bible data says that it is {name}. But the translation names “{found}”.",
    "bibleParticipants.reason.youSingularMissing":
      "Every “you” in the source of this verse speaks to one person, but the translation has no singular “you” from the Language profile.",
    "bibleParticipants.reason.youPluralMissing":
      "Every “you” in the source of this verse speaks to several people, but the translation has no plural “you” from the Language profile.",
    "bibleParticipants.reason.youSingularWrong":
      "Every “you” in the source of this verse speaks to one person, but the translation has a plural “you”.",
    "bibleParticipants.reason.youPluralWrong":
      "Every “you” in the source of this verse speaks to several people, but the translation has a singular “you”.",
    "bibleParticipants.reason.inclusiveMissing":
      "Here “we” includes the people spoken to, but the translation has no inclusive “we” from the Language profile.",
    "bibleParticipants.reason.exclusiveMissing":
      "Here “we” does not include the people spoken to, but the translation has no exclusive “we” from the Language profile.",
    "bibleParticipants.reason.inclusiveWrong":
      "Here “we” includes the people spoken to, but the translation has the exclusive “we”.",
    "bibleParticipants.reason.exclusiveWrong":
      "Here “we” does not include the people spoken to, but the translation has the inclusive “we”.",
    "bibleParticipants.reason.dualMissing":
      "A pronoun here refers to two people ({name}), but the translation has no dual form from the Language profile.",
    "bibleParticipants.reason.trialMissing":
      "A pronoun here refers to three people ({name}), but the translation has no trial form from the Language profile.",
    "bibleParticipants.reason.paucalMissing":
      "A pronoun here refers to a few people ({name}), but the translation has no paucal form from the Language profile.",
    "bibleParticipants.reason.kyriosJesusMissing":
      "Here κύριος (“Lord”) means Jesus, but the translation does not have “{rendering}”.",
    "bibleParticipants.reason.kyriosGodMissing":
      "Here κύριος (“Lord”) means God, but the translation does not have “{rendering}”.",
    "bibleParticipants.reason.holySpiritMissing":
      "Here πνεῦμα (“Spirit”) means the Holy Spirit, but the translation does not have “{rendering}”.",
    "bibleParticipants.reason.kyriosJesusSwapped":
      "Here κύριος (“Lord”) means Jesus, but the translation has “{found}”, which is the project's rendering for God.",
    "bibleParticipants.reason.kyriosGodSwapped":
      "Here κύριος (“Lord”) means God, but the translation has “{found}”, which is the project's rendering for Jesus.",
    "bibleParticipants.reason.deityPronounLowercase":
      "A pronoun here refers to God, Jesus or the Holy Spirit and starts with a small letter, but the house style capitalizes it.",
    "bibleParticipants.reason.quotationDiffers":
      "The source repeats here the words it quotes in {other}, but the translation renders them differently (word overlap {similarity}).",

    // ── Where a finding's fact comes from ──
    "bibleParticipants.evidence.mention": "{dataset}: {ref} word {word} names {name}",
    "bibleParticipants.evidence.mentionSubject": "{dataset}: in {ref}, word {word} has {name} as its implied subject",
    "bibleParticipants.evidence.noMention": "{dataset}: {refs} does not mention {name}",
    "bibleParticipants.evidence.secondPersonSingular": "{dataset}: every “you” in {refs} is singular",
    "bibleParticipants.evidence.secondPersonPlural": "{dataset}: every “you” in {refs} is plural",
    "bibleParticipants.evidence.clusivity": "{dataset}: {ref} word {word}. “We”: {referents}. Spoken to: {addressees}.",
    "bibleParticipants.evidence.decision": "Decision: {key}",
    "bibleParticipants.evidence.group": "{dataset}: {ref} word {word} refers to {name}, a group of {size}",
    "bibleParticipants.evidence.divineName": "{dataset}: {ref} word {word}",
    "bibleParticipants.evidence.alignment": "Word alignment: {refs}",
    "bibleParticipants.evidence.nameVariants": "{dataset}: {refs} names {name}",
    "bibleParticipants.evidence.repeatedQuotation": "{dataset}: the quotation in {refs} repeats the one in {other}",
    "bibleParticipants.evidence.fromDecision": "Agreed name: decision {key}",
    "bibleParticipants.evidence.fromTerminology": "Agreed name: terminology entry",
  },
  context: {
    _context: {
      description:
        "Bible data checks, third set: they compare a translation with facts from the Bible Knowledge Pack about " +
        "who each verse names and refers to (people, groups, places, God), the number of 'you', inclusive or " +
        "exclusive 'we', and quotations that the source repeats. A project's 'agreed name' is how it has decided to " +
        "render a name. Names and descriptions appear in Rules → Built-in checks; reasons and evidence lines explain " +
        "one finding in the Issues tab, the Check file results and autopilot's review. Greek words (κύριος, πνεῦμα), " +
        "decision keys (render.person.Peter, clusivity.…) and 'Language profile' are names: never translate them.",
    },
    keys: {
      "bibleParticipants.p1.description": {
        description: "Explanation under the check's name. 'render.person.Peter' is a decision key: never translate it.",
      },
      "bibleParticipants.p2.description": {
        description: "Explanation under the check's name. 'Check file' is the name of a menu command.",
      },
      "bibleParticipants.p8.description": {
        description: "Explanation under the name of the check that 'you' is singular or plural as in the source.",
      },
      "bibleParticipants.x3.description": {
        description: "Explanation under the check's name. 'Check file' is the name of a menu command.",
      },
      "bibleParticipants.needs.agreedNames": {
        description: "Shown under a check while it cannot run because the project has no agreed names yet.",
      },
      "bibleParticipants.needs.secondPersonSame": {
        description: "Shown under a check that does not apply because the language has one 'you' for one person and for several.",
      },
      "bibleParticipants.needs.clusivitySame": {
        description: "Shown under a check that does not apply because the language has one 'we' whether or not the listener is included.",
      },
      "bibleParticipants.needs.alignment": {
        description: "Shown under a check that needs to know which word of the translation renders which Greek word.",
      },
      "bibleParticipants.reason.nameMissing": {
        description: "Explains a finding: the source names someone and the translation lacks their agreed name.",
        placeholders: {
          name: "The person's name in the Bible data, in English, e.g. 'Peter'. Not translated.",
          renderings: "The project's agreed names for that person, separated by '|'. Not translated.",
        },
      },
      "bibleParticipants.reason.nameMissingPronoun": {
        description: "Explains a finding like nameMissing, where a pronoun can be correct because the person was just named.",
        placeholders: {
          name: "The person's name in the Bible data, in English, e.g. 'Peter'. Not translated.",
          renderings: "The project's agreed names for that person, separated by '|'. Not translated.",
        },
      },
      "bibleParticipants.reason.nameVariantDifferent": {
        description: "Explains a finding: the translation uses a different name for someone than the rest of the file.",
        placeholders: {
          name: "The person's name in the Bible data, in English. Not translated.",
          found: "The name the translation uses here. Not translated.",
          usual: "The name the rest of the file uses. Not translated.",
        },
      },
      "bibleParticipants.reason.nameVariantNone": {
        description: "Explains a finding: the translation does not use the name the rest of the file uses for someone.",
        placeholders: {
          name: "The person's name in the Bible data, in English. Not translated.",
          usual: "The name the rest of the file uses. Not translated.",
        },
      },
      "bibleParticipants.reason.homonymName": {
        description: "Explains a finding: the translation uses the name of another person with the same name in the source.",
        placeholders: {
          name: "The person's name in the Bible data, in English, e.g. 'Mary Magdalene'. Not translated.",
          found: "The name the translation uses here. Not translated.",
          other: "The other person's name in the Bible data, in English, e.g. 'Mary (of Bethany)'. Not translated.",
        },
      },
      "bibleParticipants.reason.nameFormMissing": {
        description: "Explains a finding: the source uses one form of a name, and the translation lacks that form's agreed rendering.",
        placeholders: {
          name: "The person's name in the Bible data, in English. Not translated.",
          form: "The Greek or Hebrew form of the name, e.g. 'Κηφᾶς'. Not translated.",
          rendering: "The project's rendering of that form. Not translated.",
        },
      },
      "bibleParticipants.reason.nameNotInSource": {
        description: "Explains a finding: the translation names someone that the source verse does not mention.",
        placeholders: {
          found: "The name in the translation. Not translated.",
          name: "Whose name that is, in the Bible data, in English. Not translated.",
        },
      },
      "bibleParticipants.reason.subjectNameWrong": {
        description: "Explains a finding: the translation names the wrong person as the one who acts.",
        placeholders: {
          name: "Who acts according to the Bible data, in English. Not translated.",
          found: "The name in the translation. Not translated.",
        },
      },
      "bibleParticipants.reason.dualMissing": {
        description: "Explains a finding: a pronoun refers to two people and the translation lacks the dual form.",
        placeholders: { name: "The two people, in English, from the Bible data, e.g. 'Andrew, Philip'. Not translated." },
      },
      "bibleParticipants.reason.trialMissing": {
        description: "Explains a finding: a pronoun refers to three people and the translation lacks the trial form.",
        placeholders: { name: "The three people, in English, from the Bible data. Not translated." },
      },
      "bibleParticipants.reason.paucalMissing": {
        description: "Explains a finding: a pronoun refers to a few people and the translation lacks the paucal form.",
        placeholders: { name: "The people, in English, from the Bible data. Not translated." },
      },
      "bibleParticipants.reason.kyriosJesusMissing": {
        description: "Explains a finding: the Greek word κύριος refers to Jesus, and the translation lacks the project's rendering.",
        placeholders: { rendering: "The project's rendering of κύριος for Jesus, e.g. 'Lord'. Not translated." },
      },
      "bibleParticipants.reason.kyriosGodMissing": {
        description: "Explains a finding: the Greek word κύριος refers to God, and the translation lacks the project's rendering.",
        placeholders: { rendering: "The project's rendering of κύριος for God, e.g. 'the LORD'. Not translated." },
      },
      "bibleParticipants.reason.holySpiritMissing": {
        description: "Explains a finding: the Greek word πνεῦμα refers to the Holy Spirit, and the translation lacks the project's rendering.",
        placeholders: { rendering: "The project's rendering, e.g. 'Holy Spirit'. Not translated." },
      },
      "bibleParticipants.reason.kyriosJesusSwapped": {
        description: "Explains a finding: κύριος refers to Jesus, but the translation uses the rendering the project keeps for God.",
        placeholders: { found: "The rendering in the translation. Not translated." },
      },
      "bibleParticipants.reason.kyriosGodSwapped": {
        description: "Explains a finding: κύριος refers to God, but the translation uses the rendering the project keeps for Jesus.",
        placeholders: { found: "The rendering in the translation. Not translated." },
      },
      "bibleParticipants.reason.quotationDiffers": {
        description: "Explains a finding: the source repeats a quotation, and the translation renders the two differently.",
        placeholders: {
          other: "The verse of the earlier quotation, e.g. 'MAT 6:2'. Not translated.",
          similarity: "How many words the two renderings share, from 0 to 1, e.g. '0.36'.",
        },
      },
      "bibleParticipants.evidence.mention": {
        description: "Where the source names someone, e.g. 'ACAI: JHN 1:42 word 13 names Peter'.",
        placeholders: {
          dataset: "Name of a data source, e.g. 'ACAI'. Not translated.",
          ref: "A verse reference, e.g. 'JHN 1:42'. Not translated.",
          word: "Position of the word in the verse, as a number.",
          name: "The person's name in the Bible data, in English. Not translated.",
        },
      },
      "bibleParticipants.evidence.mentionSubject": {
        description: "Where a Greek verb implies who acts, e.g. 'Macula: in JHN 4:16, word 1 has Jesus as its implied subject'.",
        placeholders: {
          dataset: "Name of a data source, e.g. 'Macula'. Not translated.",
          ref: "A verse reference. Not translated.",
          word: "Position of the word in the verse, as a number.",
          name: "The person's name in the Bible data, in English. Not translated.",
        },
      },
      "bibleParticipants.evidence.noMention": {
        description: "Why a name is not in the source, e.g. 'ACAI: JHN 4:16 does not mention Peter'.",
        placeholders: {
          dataset: "Name of a data source, e.g. 'ACAI'. Not translated.",
          refs: "Verse references. Not translated.",
          name: "The person's name in the Bible data, in English. Not translated.",
        },
      },
      "bibleParticipants.evidence.secondPersonSingular": {
        description: "Where the source's 'you' is singular, e.g. 'Macula: every “you” in JHN 4:16 is singular'.",
        placeholders: { dataset: "Name of a data source. Not translated.", refs: "Verse references. Not translated." },
      },
      "bibleParticipants.evidence.secondPersonPlural": {
        description: "Where the source's 'you' is plural, e.g. 'Macula: every “you” in JHN 4:22 is plural'.",
        placeholders: { dataset: "Name of a data source. Not translated.", refs: "Verse references. Not translated." },
      },
      "bibleParticipants.evidence.clusivity": {
        description: "Who 'we' is and who is spoken to, from the Bible data, e.g. '“We”: Jews, Jesus. Spoken to: Samaritan woman.'",
        placeholders: {
          dataset: "Name of a data source. Not translated.",
          ref: "A verse reference. Not translated.",
          word: "Position of the word in the verse, as a number.",
          referents: "Who 'we' is, in English, from the Bible data. Not translated.",
          addressees: "Who is spoken to, in English, from the Bible data. Not translated.",
        },
      },
      "bibleParticipants.evidence.decision": {
        description: "The project's decision that this finding enforces.",
        placeholders: { key: "The decision's key, e.g. 'clusivity.ACT.16.10-17'. Never translated." },
      },
      "bibleParticipants.evidence.group": {
        description: "Which group a pronoun refers to, e.g. 'ACAI: JHN 12:22 word 13 refers to Andrew, Philip, a group of 2'.",
        placeholders: {
          dataset: "Name of a data source. Not translated.",
          ref: "A verse reference. Not translated.",
          word: "Position of the word in the verse, as a number.",
          name: "The group's members, in English. Not translated.",
          size: "How many people, as a number.",
        },
      },
      "bibleParticipants.evidence.divineName": {
        description: "Where κύριος or πνεῦμα is in the source, e.g. 'Macula: JHN 20:2 word 15'.",
        placeholders: {
          dataset: "Name of a data source. Not translated.",
          ref: "A verse reference. Not translated.",
          word: "Position of the word in the verse, as a number.",
        },
      },
      "bibleParticipants.evidence.alignment": {
        description: "The verses whose word alignment located the pronoun.",
        placeholders: { refs: "Verse references. Not translated." },
      },
      "bibleParticipants.evidence.nameVariants": {
        description: "Where the source names someone, e.g. 'ACAI: GAL 2:9 names Peter'.",
        placeholders: {
          dataset: "Name of a data source. Not translated.",
          refs: "Verse references. Not translated.",
          name: "The person's name in the Bible data, in English. Not translated.",
        },
      },
      "bibleParticipants.evidence.repeatedQuotation": {
        description: "Which quotation repeats which, e.g. 'OpenText: the quotation in MAT 6:16 repeats the one in MAT 6:2'.",
        placeholders: {
          dataset: "Name of a data source. Not translated.",
          refs: "Verse references. Not translated.",
          other: "A verse reference. Not translated.",
        },
      },
      "bibleParticipants.evidence.fromDecision": {
        description: "Says that the agreed name comes from a project decision.",
        placeholders: { key: "The decision's key, e.g. 'render.person.Peter'. Never translated." },
      },
    },
  },
  surfaces: [],
})
