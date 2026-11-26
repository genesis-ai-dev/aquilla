import { describe, it, expect } from "vitest";
import fs from "fs";
import JSZip from "jszip";
import {
    mergeBibleHeadingStylesIntoStudyStylesXml,
    retargetFootnoteCharacterFonts,
    stampPortugueseHyphenationLanguage,
} from "../headingStyleMerge";

const studyStyles = `<?xml version="1.0"?>
<idPkg:Styles>
	<RootParagraphStyleGroup Self="u78">
		<ParagraphStyle Self="ParagraphStyle/#base.text" Name="#base.text">
			<Properties>
				<BasedOn type="string">$ID/[No paragraph style]</BasedOn>
				<AppliedFont type="string">Charis SIL</AppliedFont>
			</Properties>
		</ParagraphStyle>
		<ParagraphStyle Self="ParagraphStyle/#base.title" Name="#base.title" FontStyle="Italic">
			<Properties>
				<BasedOn type="object">ParagraphStyle/#base.text</BasedOn>
				<AppliedFont type="string">Myriad Pro</AppliedFont>
			</Properties>
		</ParagraphStyle>
		<ParagraphStyleGroup Self="ParagraphStyleGroup/$ID/title" Name="$ID/title">
			<ParagraphStyle Self="ParagraphStyle/title%3amt1" Name="title:mt1">
				<Properties>
					<BasedOn type="object">ParagraphStyle/#base.title</BasedOn>
				</Properties>
			</ParagraphStyle>
		</ParagraphStyleGroup>
	</RootParagraphStyleGroup>
</idPkg:Styles>`;

const bibleStyles = `<?xml version="1.0"?>
<idPkg:Styles>
	<RootParagraphStyleGroup Self="u79">
		<ParagraphStyle Self="ParagraphStyle/#base.text" Name="#base.text">
			<Properties>
				<BasedOn type="string">$ID/[No paragraph style]</BasedOn>
				<AppliedFont type="string">Charis SIL</AppliedFont>
			</Properties>
		</ParagraphStyle>
		<ParagraphStyle Self="ParagraphStyle/#base.title" Name="#base.title" FontStyle="Italic">
			<Properties>
				<BasedOn type="object">ParagraphStyle/#base.text</BasedOn>
				<AppliedFont type="string">Source Sans 3</AppliedFont>
			</Properties>
		</ParagraphStyle>
		<ParagraphStyleGroup Self="ParagraphStyleGroup/$ID/title" Name="$ID/title">
			<ParagraphStyle Self="ParagraphStyle/title%3as1" Name="title:s1" FontStyle="Regular" PointSize="8.25">
				<Properties>
					<BasedOn type="object">ParagraphStyle/#base.title</BasedOn>
					<AllNestedStyles type="list">
						<ListItem type="record">
							<AppliedCharacterStyle type="object">CharacterStyle/#base.bd</AppliedCharacterStyle>
							<Delimiter type="enumeration">EndNestedStyle</Delimiter>
						</ListItem>
					</AllNestedStyles>
				</Properties>
			</ParagraphStyle>
			<ParagraphStyle Self="ParagraphStyle/title%3as2" Name="title:s2">
				<Properties>
					<BasedOn type="object">ParagraphStyle/title%3as1</BasedOn>
				</Properties>
			</ParagraphStyle>
			<ParagraphStyle Self="ParagraphStyle/title%3amt1" Name="title:mt1">
				<Properties>
					<BasedOn type="object">ParagraphStyle/#base.title</BasedOn>
				</Properties>
			</ParagraphStyle>
		</ParagraphStyleGroup>
	</RootParagraphStyleGroup>
</idPkg:Styles>`;

describe("mergeBibleHeadingStylesIntoStudyStylesXml", () => {
    it("copies missing title:s1 with the Bible font and nested Semibold style", () => {
        const merged = mergeBibleHeadingStylesIntoStudyStylesXml(studyStyles, bibleStyles);

        expect(merged).toContain('Self="ParagraphStyle/title%3as1"');
        expect(merged).toContain('Self="ParagraphStyle/title%3as2"');
        expect(merged).toContain("Source Sans 3");
        expect(merged).toContain("CharacterStyle/#base.bd");
        expect((merged.match(/Self="ParagraphStyle\/title%3amt1"/g) || []).length).toBe(1);
        expect(merged).toContain("title:mt1");

        const s1 = merged.match(
            /<ParagraphStyle Self="ParagraphStyle\/title%3as1"[\s\S]*?<\/ParagraphStyle>/
        )?.[0];
        expect(s1).toContain('<AppliedFont type="string">Source Sans 3</AppliedFont>');
        expect(s1).toContain("CharacterStyle/#base.bd");
        expect(s1).toContain('FontStyle="Regular"');
        expect(s1).toContain('BalanceRaggedLines="Off"');

        const veeStudy = studyStyles.replace(
            "</RootParagraphStyleGroup>",
            '<ParagraphStyle Self="ParagraphStyle/title%3as1" Name="title:s1" BalanceRaggedLines="VeeShape"></ParagraphStyle></RootParagraphStyleGroup>'
        );
        const patched = mergeBibleHeadingStylesIntoStudyStylesXml(veeStudy, bibleStyles);
        const existing = patched.match(
            /<ParagraphStyle Self="ParagraphStyle\/title%3as1"[^>]*>/
        )?.[0];
        expect(existing).toContain('BalanceRaggedLines="Off"');
    });

    it("stamps Portuguese on a hyphenating English paragraph style", () => {
        const sheet = [
            '<ParagraphStyle Self="ParagraphStyle/notes%3af" AppliedLanguage="$ID/English: UK" Hyphenation="true"></ParagraphStyle>',
            '<ParagraphStyle Self="ParagraphStyle/text%3ap" AppliedLanguage="$ID/English: USA" Hyphenation="false"></ParagraphStyle>',
            '<ParagraphStyle Self="ParagraphStyle/text%3ap_pt" AppliedLanguage="$ID/Portuguese: Brazilian" Hyphenation="true"></ParagraphStyle>',
        ].join("");
        const stamped = stampPortugueseHyphenationLanguage(sheet);
        expect(stamped).toContain(
            'Self="ParagraphStyle/notes%3af" AppliedLanguage="$ID/Portuguese: Brazilian"'
        );
        expect(stamped).toContain('AppliedLanguage="$ID/English: USA"');
        expect(stamped).toContain(
            'Self="ParagraphStyle/text%3ap_pt" AppliedLanguage="$ID/Portuguese: Brazilian"'
        );
    });

    it("stamps the English base when a descendant hyphenates through it", () => {
        const sheet = [
            '<ParagraphStyle Self="ParagraphStyle/$ID/[No paragraph style]" AppliedLanguage="$ID/Portuguese: Brazilian" Hyphenation="true"></ParagraphStyle>',
            '<ParagraphStyle Self="ParagraphStyle/#base.text" AppliedLanguage="$ID/English: UK"><BasedOn type="string">$ID/[No paragraph style]</BasedOn></ParagraphStyle>',
            '<ParagraphStyle Self="ParagraphStyle/#base.note"><BasedOn type="object">ParagraphStyle/#base.text</BasedOn></ParagraphStyle>',
            '<ParagraphStyle Self="ParagraphStyle/notes%3af"><BasedOn type="object">ParagraphStyle/#base.note</BasedOn></ParagraphStyle>',
            '<ParagraphStyle Self="ParagraphStyle/text%3aq" Hyphenation="false"><BasedOn type="object">ParagraphStyle/#base.text</BasedOn></ParagraphStyle>',
            '<ParagraphStyle Self="ParagraphStyle/text%3aq1" Hyphenation="true"><BasedOn type="object">ParagraphStyle/text%3aq</BasedOn></ParagraphStyle>',
            '<ParagraphStyle Self="ParagraphStyle/text%3ap" AppliedLanguage="$ID/English: USA" Hyphenation="false"></ParagraphStyle>',
        ].join("");
        const stamped = stampPortugueseHyphenationLanguage(sheet);
        expect(stamped).toContain(
            'Self="ParagraphStyle/#base.text" AppliedLanguage="$ID/Portuguese: Brazilian"'
        );
        expect(stamped).toContain('AppliedLanguage="$ID/English: USA"');
        expect(stamped).not.toContain('Self="ParagraphStyle/notes%3af" AppliedLanguage');
        expect(stamped).not.toContain('Self="ParagraphStyle/text%3aq1" AppliedLanguage');
    });

    it("points the footnote space and drop-cap call at the note fonts", () => {
        const sheet = [
            '<CharacterStyle Self="CharacterStyle/notes%3af" AppliedFont="Myriad Pro"></CharacterStyle>',
            '<CharacterStyle Self="CharacterStyle/notes%3afr_sp" AppliedFont="Charis SIL"></CharacterStyle>',
            '<CharacterStyle Self="CharacterStyle/notes%3af_call" AppliedFont="Karmina"></CharacterStyle>',
            '<CharacterStyle Self="CharacterStyle/notes%3af_call_dc" AppliedFont="Source Sans 3"></CharacterStyle>',
        ].join("");
        const retargeted = retargetFootnoteCharacterFonts(sheet);
        expect(retargeted).toContain(
            'Self="CharacterStyle/notes%3afr_sp" AppliedFont="Myriad Pro"'
        );
        expect(retargeted).toContain(
            'Self="CharacterStyle/notes%3af_call_dc" AppliedFont="Karmina"'
        );
        expect(retargeted).toContain(
            'Self="CharacterStyle/notes%3af" AppliedFont="Myriad Pro"'
        );
        expect(retargeted).not.toContain("Charis SIL");
        expect(retargeted).not.toContain("Source Sans 3");
    });

    it("does not rewrite a Study stylesheet that already has the heading styles", () => {
        const alreadyHas = mergeBibleHeadingStylesIntoStudyStylesXml(bibleStyles, bibleStyles);
        expect(alreadyHas).toBe(bibleStyles);
    });

    it("leaves the Study stylesheet alone when the Bible has no heading-role titles", () => {
        const merged = mergeBibleHeadingStylesIntoStudyStylesXml(studyStyles, studyStyles);
        expect(merged).toBe(studyStyles);
    });

    it("stamps Source Sans 3 onto Portuguese title:s1 using the real GEN-DEU packages", async () => {
        const studyPath =
            "C:/Users/marti/Desktop/FrontierRnD/Test Files/Biblica Global Publishing/English IDML/GEN-DEU.idml";
        const biblePath =
            "C:/Users/marti/Desktop/FrontierRnD/Test Files/Biblica Global Publishing/BIBLE Files/Portuguese Full Bible/01GEN-05DEU_portuguese.idml";
        if (!fs.existsSync(studyPath) || !fs.existsSync(biblePath)) {
            return;
        }

        const [studyZip, bibleZip] = await Promise.all([
            JSZip.loadAsync(fs.readFileSync(studyPath)),
            JSZip.loadAsync(fs.readFileSync(biblePath)),
        ]);
        const studyXml = await studyZip.file("Resources/Styles.xml")!.async("string");
        const bibleXml = await bibleZip.file("Resources/Styles.xml")!.async("string");
        const merged = mergeBibleHeadingStylesIntoStudyStylesXml(studyXml, bibleXml);

        const s1 = merged.match(
            /<ParagraphStyle Self="ParagraphStyle\/title%3as1"[\s\S]*?<\/ParagraphStyle>/
        )?.[0];
        expect(s1).toBeTruthy();
        expect(s1).toContain('<AppliedFont type="string">Source Sans 3</AppliedFont>');
        expect(s1).toContain("CharacterStyle/#base.bd");

        const baseTitle = merged.match(
            /<ParagraphStyle Self="ParagraphStyle\/#base.title"[\s\S]*?<\/ParagraphStyle>/
        )?.[0];
        expect(baseTitle).toContain('<AppliedFont type="string">Myriad Pro</AppliedFont>');
    });
});
