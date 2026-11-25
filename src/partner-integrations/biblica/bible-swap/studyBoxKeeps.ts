/**
 * Study boxes (`intro:imi`) are one shaded paragraph. The style inherits
 * "keep the first line", so a box can start a page turn with a single line
 * and finish on the next page.
 *
 * A box that fits in the column is kept whole, and InDesign moves it to the
 * next page instead of leaving that line behind. A box taller than the column
 * still has to split; the keep then refuses a break inside the first or last
 * three lines.
 *
 * The column is about 540 pt and the box leading is 10 pt, so 50 lines fit.
 * The 115-character measure over-counts the composed Genesis–Deuteronomy
 * boxes (a 17-line box, a 43-line box, a 90-line box), and 60 is the estimate
 * at which a box still fits after that over-count.
 */

import { getParagraphIndex } from "./paragraphIndex";

const CHARACTERS_PER_LINE = 115;
const LINES_ON_A_PAGE = 50;
const FITS_ON_A_PAGE = 60;
const SPLIT_KEEP_LINES = 3;

function isStudyBoxParagraphStyle(style: string): boolean {
    const name = style.replace(/^ParagraphStyle\//, "");
    return /(?:^|\/)intro(?:%3a|:)imi$/.test(name);
}

/** Wrapped lines, counting each forced break as its own line. */
export function estimateStudyBoxLines(bodyXml: string): number {
    const text = bodyXml
        .replace(/<Br\s*\/>/g, "\n")
        .replace(/<[^>]+>/g, "")
        .replace(/\u00ad/g, "")
        .replace(/\u00a0/g, " ");
    let lines = 0;
    for (const part of text.split("\n")) {
        const segment = part.trim();
        if (!segment) continue;
        lines += Math.max(1, Math.ceil(segment.length / CHARACTERS_PER_LINE));
    }
    return lines;
}

function keepLinesForBox(estimatedLines: number): number {
    if (estimatedLines > FITS_ON_A_PAGE) return SPLIT_KEEP_LINES;
    return LINES_ON_A_PAGE;
}

function withBoxKeep(openTag: string, lines: number): string {
    let tag = openTag;
    for (const name of [
        "KeepLinesTogether",
        "KeepAllLinesTogether",
        "KeepFirstLines",
        "KeepLastLines",
    ]) {
        tag = tag.replace(new RegExp(`\\s${name}="[^"]*"`), "");
    }
    const attrs = ` KeepLinesTogether="true" KeepAllLinesTogether="false" KeepFirstLines="${lines}" KeepLastLines="${lines}"`;
    return tag.replace(/\s*\/?>$/, (end) => `${attrs}${end}`);
}

/** Keep each study box from leaving one or two lines on the previous page. */
export function keepStudyBoxesTogether(storyXml: string): string {
    const paras = getParagraphIndex(storyXml);
    const edits: Array<{ start: number; end: number; tag: string }> = [];
    for (const para of paras) {
        if (!isStudyBoxParagraphStyle(para.appliedParagraphStyle)) continue;
        const estimated = estimateStudyBoxLines(storyXml.slice(para.bodyStart, para.bodyEnd));
        if (estimated === 0) continue;
        const tag = storyXml.slice(para.fullStart, para.bodyStart);
        const next = withBoxKeep(tag, keepLinesForBox(estimated));
        if (next !== tag) edits.push({ start: para.fullStart, end: para.bodyStart, tag: next });
    }
    if (edits.length === 0) return storyXml;
    let xml = storyXml;
    for (let i = edits.length - 1; i >= 0; i--) {
        const edit = edits[i];
        xml = xml.slice(0, edit.start) + edit.tag + xml.slice(edit.end);
    }
    return xml;
}
