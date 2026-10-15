/**
 * AQU-1959 — the divine name (YHWH, "Lᴏʀᴅ" in small caps) must keep its
 * small-caps character formatting through the Bible Swap export.
 */
import { describe, it, expect } from "vitest";
import {
    applySurgicalSwapToStudyXml,
    buildBibleVerseIndex,
    isDivineNameCharacterStyle,
    mergeBibleSmallCapsCharacterStylesIntoStudyStylesXml,
    verseKey,
} from "../index";

const NO_STYLE = "CharacterStyle/$ID/[No character style]";
const ND_STYLE = "CharacterStyle/cv%3and";

function bookPara(book: string): string {
    return `<ParagraphStyleRange AppliedParagraphStyle="ParagraphStyle/meta%3abk">
  <CharacterStyleRange AppliedCharacterStyle="${NO_STYLE}"><Content>${book}</Content></CharacterStyleRange>
</ParagraphStyleRange>`;
}

function chapterPara(chapter: string): string {
    return `<ParagraphStyleRange AppliedParagraphStyle="ParagraphStyle/text%3ap">
  <CharacterStyleRange AppliedCharacterStyle="CharacterStyle/meta%3ac"><Content>${chapter}</Content></CharacterStyleRange>
</ParagraphStyleRange>`;
}

/**
 * One verse split as the Biblica packages really do it: plain prose, a
 * divine-name run in its own small-caps CSR, then plain prose again.
 */
function verseWithDivineName(
    verse: string,
    before: string,
    divine: string,
    after: string,
    options?: { ndStyle?: string }
): string {
    const nd = options?.ndStyle ?? ND_STYLE;
    return `<ParagraphStyleRange AppliedParagraphStyle="ParagraphStyle/text%3ap">
  <CharacterStyleRange AppliedCharacterStyle="CharacterStyle/meta%3av"><Content>${verse}</Content></CharacterStyleRange>
  <CharacterStyleRange AppliedCharacterStyle="${NO_STYLE}"><Content>${before}</Content></CharacterStyleRange>
  <CharacterStyleRange AppliedCharacterStyle="${nd}"><Content>${divine}</Content></CharacterStyleRange>
  <CharacterStyleRange AppliedCharacterStyle="${NO_STYLE}"><Content>${after}</Content></CharacterStyleRange>
  <CharacterStyleRange AppliedCharacterStyle="CharacterStyle/meta%3av"><Content>${verse}</Content></CharacterStyleRange>
</ParagraphStyleRange>`;
}

function plainVerse(verse: string, text: string): string {
    return `<ParagraphStyleRange AppliedParagraphStyle="ParagraphStyle/text%3ap">
  <CharacterStyleRange AppliedCharacterStyle="CharacterStyle/meta%3av"><Content>${verse}</Content></CharacterStyleRange>
  <CharacterStyleRange AppliedCharacterStyle="${NO_STYLE}"><Content>${text}</Content></CharacterStyleRange>
  <CharacterStyleRange AppliedCharacterStyle="CharacterStyle/meta%3av"><Content>${verse}</Content></CharacterStyleRange>
</ParagraphStyleRange>`;
}

function story(body: string): string {
    return `<?xml version="1.0"?><Story>${bookPara("GEN")}${chapterPara("2")}${body}</Story>`;
}

describe("isDivineNameCharacterStyle", () => {
    it("recognizes the \\nd character style under every prefix the packages use", () => {
        for (const style of [
            "CharacterStyle/nd",
            "CharacterStyle/cv%3and",
            "CharacterStyle/cv:nd",
            "CharacterStyle/char%3and",
            "CharacterStyle/text%3and_sp",
            "nd",
        ]) {
            expect(isDivineNameCharacterStyle(style)).toBe(true);
        }
    });

    it("leaves unrelated styles alone", () => {
        for (const style of [
            NO_STYLE,
            "CharacterStyle/meta%3av",
            "CharacterStyle/cv%3av",
            "CharacterStyle/cv%3adc",
            "CharacterStyle/ndx",
            "CharacterStyle/second",
            "",
        ]) {
            expect(isDivineNameCharacterStyle(style)).toBe(false);
        }
    });
});

describe("surgical swap — divine-name runs (AQU-1959)", () => {
    it("indexes the Bible's divine-name run apart from its prose", () => {
        const index = buildBibleVerseIndex(
            story(verseWithDivineName("4", "Quando o ", "SENHOR", " Deus fez"))
        );
        const entry = index.get(verseKey("GEN", "2", "4"));
        expect(entry?.divineSegments).toEqual(["SENHOR"]);
        expect(entry?.segments).toEqual(["Quando o ", " Deus fez"]);
    });

    it("replaces the study's divine-name run with the Bible's, keeping the small-caps style", () => {
        const studyXml = story(
            verseWithDivineName("4", "When the ", "LORD", " God made")
        );
        const bibleXml = story(
            verseWithDivineName("4", "Quando o ", "SENHOR", " Deus fez")
        );

        const { xml, stats } = applySurgicalSwapToStudyXml(
            studyXml,
            buildBibleVerseIndex(bibleXml)
        );

        // The translated divine name lands inside the study's own nd CSR …
        expect(xml).toContain(
            `<CharacterStyleRange AppliedCharacterStyle="${ND_STYLE}"><Content>SENHOR</Content></CharacterStyleRange>`
        );
        // … and the English one is gone from the output entirely.
        expect(xml).not.toContain("LORD");
        expect(xml).toContain("Quando o ");
        expect(stats.divineNamesReplaced).toBe(1);
        expect(stats.divineNamesUnmatched ?? []).toEqual([]);
    });

    it("keeps the small-caps run out of the prose slot mapping", () => {
        // Regression guard: if the nd run were treated as a prose segment the
        // study's two prose slots would receive "Quando o" + "SENHOR" and the
        // translated verse would read with the divine name in the wrong place.
        const { xml } = applySurgicalSwapToStudyXml(
            story(verseWithDivineName("4", "When the ", "LORD", " God made")),
            buildBibleVerseIndex(
                story(verseWithDivineName("4", "Quando o ", "SENHOR", " Deus fez"))
            )
        );
        expect(xml).toContain("<Content>Quando o </Content>");
        expect(xml).toContain("<Content> Deus fez</Content>");
    });

    it("leaves the runs untouched and reports the verse when the two sides disagree on run count", () => {
        const studyXml = story(
            verseWithDivineName("4", "When the ", "LORD", " God made")
        );
        // The translation does not mark a divine name in this verse.
        const bibleXml = story(plainVerse("4", "Quando o Senhor Deus fez"));

        const { xml, stats } = applySurgicalSwapToStudyXml(
            studyXml,
            buildBibleVerseIndex(bibleXml)
        );

        expect(stats.divineNamesReplaced ?? 0).toBe(0);
        expect(stats.divineNamesUnmatched).toEqual([
            { book: "GEN", chapter: "2", verse: "4", studyRuns: 1, bibleRuns: 0 },
        ]);
        // Untouched rather than guessed at: the study's own run is still there.
        expect(xml).toContain(
            `<CharacterStyleRange AppliedCharacterStyle="${ND_STYLE}"><Content>LORD</Content></CharacterStyleRange>`
        );
    });

    it("pairs several divine-name runs in one verse by position", () => {
        const twoRuns = (
            first: string,
            second: string,
            lead: string
        ): string => `<ParagraphStyleRange AppliedParagraphStyle="ParagraphStyle/text%3ap">
  <CharacterStyleRange AppliedCharacterStyle="CharacterStyle/meta%3av"><Content>5</Content></CharacterStyleRange>
  <CharacterStyleRange AppliedCharacterStyle="${NO_STYLE}"><Content>${lead}</Content></CharacterStyleRange>
  <CharacterStyleRange AppliedCharacterStyle="${ND_STYLE}"><Content>${first}</Content></CharacterStyleRange>
  <CharacterStyleRange AppliedCharacterStyle="${NO_STYLE}"><Content> and </Content></CharacterStyleRange>
  <CharacterStyleRange AppliedCharacterStyle="${ND_STYLE}"><Content>${second}</Content></CharacterStyleRange>
  <CharacterStyleRange AppliedCharacterStyle="CharacterStyle/meta%3av"><Content>5</Content></CharacterStyleRange>
</ParagraphStyleRange>`;

        const { xml, stats } = applySurgicalSwapToStudyXml(
            story(twoRuns("LORD", "GOD", "the ")),
            buildBibleVerseIndex(story(twoRuns("SENHOR", "DEUS", "o ")))
        );

        expect(stats.divineNamesReplaced).toBe(2);
        expect(xml).toContain("<Content>SENHOR</Content>");
        expect(xml).toContain("<Content>DEUS</Content>");
        expect(xml).not.toContain("<Content>LORD</Content>");
        expect(xml).not.toContain("<Content>GOD</Content>");
    });

    it("escapes XML in a translated divine name", () => {
        const { xml } = applySurgicalSwapToStudyXml(
            story(verseWithDivineName("4", "When the ", "LORD", " God made")),
            buildBibleVerseIndex(
                story(verseWithDivineName("4", "Quando o ", "SENHOR & DEUS", " fez"))
            )
        );
        expect(xml).toContain("<Content>SENHOR &amp; DEUS</Content>");
    });
});

describe("surgical swap — a removed verse (AQU-1959)", () => {
    it("empties the divine-name run along with the verse's prose", async () => {
        const { buildVersificationPlanFromIndices, scanStudyStoryForSwap } = await import(
            "../index"
        );
        const studyXml = story(
            verseWithDivineName("4", "When the ", "LORD", " God made") +
                plainVerse("5", "and no plant")
        );
        // The Bible has only verse 5, so the plan removes the study's verse 4.
        const bibleXml = story(plainVerse("5", "e nenhuma planta"));
        const studyScan = scanStudyStoryForSwap(studyXml);
        const index = buildBibleVerseIndex(bibleXml);
        const plan = buildVersificationPlanFromIndices(
            studyXml,
            studyScan.studyIndex,
            index
        );
        expect(plan.verseMap.get(verseKey("GEN", "2", "4"))?.action).toBe("remove");

        const { xml } = applySurgicalSwapToStudyXml(studyXml, index, {
            versificationPlan: plan,
            studyScan,
        });
        expect(xml).not.toContain("LORD");
        expect(xml).not.toContain("When the ");
    });
});

describe("mergeBibleSmallCapsCharacterStylesIntoStudyStylesXml (AQU-1959)", () => {
    const studyStyles = `<?xml version="1.0"?><idPkg:Styles xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging">
  <RootCharacterStyleGroup Self="u1">
    <CharacterStyle Self="CharacterStyle/$ID/[No character style]" Name="$ID/[No character style]" />
  </RootCharacterStyleGroup></idPkg:Styles>`;

    const bibleStyles = `<?xml version="1.0"?><idPkg:Styles xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging">
  <RootCharacterStyleGroup Self="u2">
    <CharacterStyle Self="CharacterStyle/$ID/[No character style]" Name="$ID/[No character style]" />
    <CharacterStyle Self="CharacterStyle/#base.sc" Name="#base.sc" Capitalization="SmallCaps" />
    <CharacterStyle Self="CharacterStyle/cv%3and" Name="cv:nd"><Properties><BasedOn type="object">CharacterStyle/#base.sc</BasedOn></Properties></CharacterStyle>
    <CharacterStyle Self="CharacterStyle/cv%3adc" Name="cv:dc" FontStyle="Italic" />
  </RootCharacterStyleGroup></idPkg:Styles>`;

    it("copies the divine-name style and the small-caps parent it is based on", () => {
        const merged = mergeBibleSmallCapsCharacterStylesIntoStudyStylesXml(
            studyStyles,
            bibleStyles
        );
        expect(merged).toContain('Self="CharacterStyle/cv%3and"');
        expect(merged).toContain('Self="CharacterStyle/#base.sc"');
        expect(merged).toContain("</RootCharacterStyleGroup>");
    });

    it("leaves unrelated Bible character styles out", () => {
        const merged = mergeBibleSmallCapsCharacterStylesIntoStudyStylesXml(
            studyStyles,
            bibleStyles
        );
        expect(merged).not.toContain('Self="CharacterStyle/cv%3adc"');
    });

    it("is a no-op when the study already defines the style", () => {
        expect(
            mergeBibleSmallCapsCharacterStylesIntoStudyStylesXml(bibleStyles, bibleStyles)
        ).toBe(bibleStyles);
    });
});
