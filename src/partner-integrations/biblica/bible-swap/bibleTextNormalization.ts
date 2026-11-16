/**
 * Character fixes applied to Bible text before it is spliced into a study Bible.
 *
 * The two documents are typeset with different fonts, so a codepoint that is
 * ordinary in the Bible can be missing from the study Bible's fonts and print
 * as a hollow box.
 */

/** Quotation dash (U+2015). Portuguese Bibles open dialogue with it. */
const QUOTATION_DASH = "\u2015";

/** Em dash (U+2014), the study Bible's own long dash. */
const EM_DASH = "\u2014";

/** En quad. The Portuguese footnote space draws this as a wide gap in Charis. */
const EN_QUAD = "\u2000";

/** Soft hyphen already present in the Portuguese Bible text. */
const SOFT_HYPHEN = "\u00AD";

/** Non-breaking hyphen. InDesign will not break the line after it. */
const NON_BREAKING_HYPHEN = "\u2011";

const NBSP = "\u00A0";

const CONTENT_ELEMENT = /<Content>([\s\S]*?)<\/Content>/g;

/**
 * Swap the Bible's quotation dash for the em dash.
 *
 * The English study Bibles never use U+2015 — they set every long dash as
 * U+2013 or U+2014 — so their fonts were never exercised on that glyph and it
 * falls back to a hollow box. The Portuguese Bibles use it heavily for dialogue
 * (around 5,200 occurrences across the six volumes), and every one of them
 * reaches the export through the swap. U+2014 is the conventional codepoint for
 * the Portuguese travessão and is already in use on both sides, so the dash
 * reads the same and prints.
 *
 * Only `<Content>` text is touched, never markup or style names.
 */
function normalizeContentText(text: string): string {
    let next = text;
    if (next.includes(QUOTATION_DASH)) {
        next = next.split(QUOTATION_DASH).join(EM_DASH);
    }
    if (next.includes(EN_QUAD)) {
        next = next.split(EN_QUAD).join(" ");
    }
    if (next.includes(SOFT_HYPHEN)) {
        next = next.split(`${SOFT_HYPHEN}-`).join(`${SOFT_HYPHEN}${NON_BREAKING_HYPHEN}`);
    }
    return next;
}

/**
 * A non-breaking space at the end of one run plus a following run that is
 * only a normal space draws as a double space. The single non-breaking word
 * spaces stay.
 */
function dropSpaceRunAfterNbsp(xml: string): string {
    const runs: Array<{ start: number; end: number; text: string }> = [];
    for (const match of xml.matchAll(CONTENT_ELEMENT)) {
        if (match.index === undefined) continue;
        runs.push({
            start: match.index,
            end: match.index + match[0].length,
            text: match[1],
        });
    }
    const drop = new Set<number>();
    for (let i = 0; i < runs.length - 1; i++) {
        if (runs[i].text.endsWith(NBSP) && runs[i + 1].text === " ") {
            drop.add(i + 1);
        }
    }
    if (drop.size === 0) return xml;
    let out = "";
    let cursor = 0;
    for (let i = 0; i < runs.length; i++) {
        if (!drop.has(i)) continue;
        let start = runs[i].start;
        let end = runs[i].end;
        const csrOpen = xml.lastIndexOf("<CharacterStyleRange", start);
        const csrClose = xml.indexOf("</CharacterStyleRange>", end);
        if (csrOpen >= cursor && csrClose >= end) {
            const openEnd = xml.indexOf(">", csrOpen);
            const insideBefore = xml.slice(openEnd + 1, start);
            const insideAfter = xml.slice(end, csrClose);
            if (!insideBefore.includes("<Content>") && !insideAfter.includes("<Content>")) {
                start = csrOpen;
                end = csrClose + "</CharacterStyleRange>".length;
            }
        }
        out += xml.slice(cursor, start);
        cursor = end;
    }
    return out + xml.slice(cursor);
}

export function normalizeBibleStoryXmlGlyphs(bibleStoryXml: string): string {
    const needsNormalization =
        bibleStoryXml.includes(QUOTATION_DASH) ||
        bibleStoryXml.includes(EN_QUAD) ||
        bibleStoryXml.includes(SOFT_HYPHEN) ||
        bibleStoryXml.includes(NBSP);
    if (!needsNormalization) return bibleStoryXml;

    const normalized = bibleStoryXml.replace(CONTENT_ELEMENT, (match, text: string) => {
        const next = normalizeContentText(text);
        return next === text ? match : `<Content>${next}</Content>`;
    });
    return dropSpaceRunAfterNbsp(normalized);
}
