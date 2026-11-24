import { describe, expect, it } from "vitest";
import { keepStudyBoxesTogether } from "../studyBoxKeeps";

function story(body: string): string {
    return `<?xml version="1.0"?><Story>${body}</Story>`;
}

function box(segments: string[]): string {
    const inner = segments
        .map(
            (text) =>
                `<CharacterStyleRange AppliedCharacterStyle="CharacterStyle/$ID/[No character style]"><Content>${text}</Content></CharacterStyleRange>`
        )
        .join("<Br />");
    return `<ParagraphStyleRange AppliedParagraphStyle="ParagraphStyle/intro%3aimi">${inner}</ParagraphStyleRange>`;
}

describe("keepStudyBoxesTogether", () => {
    it("keeps a box that fits on one page whole, and a taller box to three lines", () => {
        const cases = [
            {
                label: "short",
                segments: ["Graça: Gênesis 6.1 – 8.14.", "Salvador: Deus salvou os israelitas."],
                keep: "50",
            },
            {
                label: "tall",
                segments: Array.from({ length: 21 }, () => "Monte Sinai ".repeat(40).trim()),
                keep: "3",
            },
        ];
        for (const row of cases) {
            const xml = keepStudyBoxesTogether(
                story(
                    `${box(row.segments)}<ParagraphStyleRange AppliedParagraphStyle="ParagraphStyle/text%3ap"><Content>Verse.</Content></ParagraphStyleRange>`
                )
            );
            expect(xml, row.label).toContain(`KeepFirstLines="${row.keep}"`);
            expect(xml, row.label).toContain(`KeepLastLines="${row.keep}"`);
            expect(xml, row.label).toContain('KeepAllLinesTogether="false"');
            expect(xml.match(/KeepFirstLines=/g)?.length, row.label).toBe(1);
            const verse = xml.indexOf("text%3ap");
            expect(xml.slice(verse, xml.indexOf(">", verse)), row.label).not.toContain(
                "KeepFirstLines"
            );
        }

        const once = keepStudyBoxesTogether(story(box(["Graça: Gênesis 6.1 – 8.14."])));
        expect(keepStudyBoxesTogether(once)).toBe(once);

        const note = story(
            `<ParagraphStyleRange AppliedParagraphStyle="ParagraphStyle/intro%3aipi"><Content>A study note.</Content></ParagraphStyleRange>`
        );
        expect(keepStudyBoxesTogether(note)).toBe(note);
    });
});
