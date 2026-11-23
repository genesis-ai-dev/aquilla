/**
 * Structure swap: replace each Study chapter text span with the matching verse
 * range from the Bible chapter block so translated-language paragraph/character
 * styling is preserved. Handles study note blocks that split a chapter into
 * multiple spans (e.g. Job 1, Job 40).
 */

import {
    balanceParagraphStyleRanges,
    buildChapterBlockIndex,
    buildChapterSpanIndex,
    collapseRedundantProseInBlockXml,
    extractParagraphStyleRangeInner,
    extractSliceByVerseRange,
    preserveStudyChapterMarker,
    getVerseNumbersInRegion,
    iterateChapterMarkersInParagraph,
    collectPsalmChapterLabelXml,
    isSpeakerLabelParagraphStyle,
    isSectionHeadingParagraphStyle,
    isBlankSpacerParagraphStyle,
    splitLeadingSectionHeadings,
    readChapterTransitionFromParagraph,
    studyHasEnglishSubheaderBefore,
    rewriteRemappedChapterMarkersInStory,
    stripLeadingBibleSubheaderPsr,
    type BuildChapterBlockOptions,
} from "./chapterBlocks";
import { PSA_BOOK_CODE } from "./psalmVersification";
import {
    findParagraphAtPos,
    getParagraphIndex,
    paragraphsIntersecting,
    type IndexedParagraph,
} from "./paragraphIndex";
import { buildBibleVerseIndex, collectContentText, extractBookCode, isBookMarkerParagraphStyle, iterateContentAbs, iterateCsrAbs } from "./surgicalSwap";
import type {
    BibleVerseIndex,
    ChapterBlockIndex,
    ChapterTextSpan,
    SwapStats,
} from "./types";
import { verseKey } from "./types";
import type { BibleVerseSlice, VersificationPlan } from "./versificationPlan";
import {
    bibleSlicesForStudyRange,
    buildInsertSlicesFromRefs,
    extractBibleXmlForSlices,
    findStudyChapterInsertPosition,
} from "./versificationPlan";

export interface BlockSplice {
    absStart: number;
    absEnd: number;
    replacement: string;
    /** Study chapter this splice replaces (boundary coalesce ordering). */
    studyChapter?: string;
}

export interface StructureSwapBuildResult {
    splices: BlockSplice[];
    mergedSplices: BlockSplice[];
    stats: SwapStats;
}

function findParagraphAt(
    storyXml: string,
    pos: number
): { fullStart: number; fullEnd: number; bodyStart: number; bodyEnd: number } | null {
    return findParagraphAtPos(storyXml, pos);
}

function isIntroOrMetaParagraphStyle(style: string): boolean {
    return (
        /(?:^|\/)(?:intro|title|notes)%3a/.test(style) ||
        /(?:^|\/)(?:intro|title|notes):/.test(style) ||
        /(?:^|\/)meta%3a/.test(style) ||
        /(?:^|\/)meta:/.test(style)
    );
}

/** True when an intro/meta paragraph sits between two span byte ranges. */
function hasIntroBetween(
    studyStoryXml: string,
    afterAbs: number,
    beforeAbs: number
): boolean {
    for (const para of paragraphsIntersecting(studyStoryXml, afterAbs, beforeAbs)) {
        if (isIntroOrMetaParagraphStyle(para.appliedParagraphStyle)) {
            return true;
        }
    }
    return false;
}

function wrapStudyParagraphReplacement(
    studyStoryXml: string,
    paraStart: number,
    inner: string
): string {
    const para = findParagraphAt(studyStoryXml, paraStart);
    if (!para) return balanceParagraphStyleRanges(inner);
    const styleMatch = studyStoryXml
        .slice(para.fullStart, Math.min(para.fullStart + 200, para.fullEnd))
        .match(/AppliedParagraphStyle="([^"]+)"/);
    const style = styleMatch?.[1] ?? "ParagraphStyle/text%3ap";
    return `<ParagraphStyleRange AppliedParagraphStyle="${style}">${inner}</ParagraphStyleRange>`;
}

function isDropCapDigitStyle(style: string): boolean {
    return (
        /(?:^|\/)cv%3adc(?:_sp)?(?:$|\b)/.test(style) ||
        /(?:^|\/)cv:dc(?:_sp)?(?:$|\b)/.test(style)
    );
}

/** The study drop-cap digit and the space after it, kept when the body is replaced. */
function studyDropCapPrefix(studyStoryXml: string, paraStart: number): string {
    const para = findParagraphAt(studyStoryXml, paraStart);
    if (!para || !isChapterBoundaryParagraphAt(studyStoryXml, paraStart)) return "";
    let prefix = "";
    for (const csr of iterateCsrAbs(studyStoryXml, para.bodyStart, para.bodyEnd)) {
        if (!isDropCapDigitStyle(csr.appliedCharacterStyle)) continue;
        prefix += studyStoryXml.slice(csr.absFullStart, csr.absFullEnd);
    }
    return prefix;
}

/**
 * A drop-cap paragraph is one study paragraph. A Bible slice for its opening
 * verse can still start with a section heading. That heading has to stay its
 * own paragraph in front of the drop cap; the digit stays in the drop cap.
 */
function firstParagraphAndRest(xml: string): { first: string; rest: string } {
    const paras = getParagraphIndex(xml);
    if (paras.length === 0) return { first: "", rest: "" };
    const first = paras[0];
    return {
        first: xml.slice(first.fullStart, first.fullEnd),
        rest: xml.slice(first.fullEnd),
    };
}

function composeBoundaryParagraphReplacement(
    studyStoryXml: string,
    boundaryStart: number,
    boundaryEnd: number,
    ordered: BlockSplice[]
): string {
    const chapterNumbers = ordered.map((sp) => Number.parseInt(sp.studyChapter ?? "", 10));
    const distinctChapters = new Set(ordered.map((sp) => sp.studyChapter).filter(Boolean));
    const openingChapter =
        distinctChapters.size > 1
            ? String(Math.max(...chapterNumbers.filter((n) => !Number.isNaN(n))))
            : null;
    const filling = openingChapter
        ? ordered.filter((sp) => sp.studyChapter === openingChapter)
        : ordered;
    // The previous chapter's verses share this drop-cap paragraph. They have
    // to stay in their own paragraphs in front of it. Flattening them into
    // the drop cap is what dropped the chapter digit and repeated the heading.
    const before = openingChapter
        ? ordered
              .filter((sp) => sp.studyChapter !== openingChapter)
              .map((sp) => stripBoundaryDropCapDigits(sp.replacement))
              .join("")
        : "";

    let headings = "";
    let inner = "";
    let rest = "";
    for (const sp of filling) {
        const peeled = splitLeadingSectionHeadings(sp.replacement);
        headings += peeled.headings;
        // A splice that stops on the drop-cap paragraph is only the chapter
        // tail or the opening verse. A splice that continues past it carries
        // the rest of the chapter, which must stay in its own paragraphs.
        if (sp.absEnd <= boundaryEnd) {
            inner += extractParagraphStyleRangeInner(peeled.body);
            continue;
        }
        const split = firstParagraphAndRest(peeled.body);
        inner += extractParagraphStyleRangeInner(split.first);
        rest += split.rest;
    }
    const prefix = studyDropCapPrefix(studyStoryXml, boundaryStart);
    if (
        prefix &&
        !inner.includes("cv%3adc") &&
        !inner.includes("cv:dc")
    ) {
        inner = prefix + inner;
    }
    return (
        before +
        headings +
        wrapStudyParagraphReplacement(studyStoryXml, boundaryStart, inner) +
        rest
    );
}

/** The Bible drop-cap digit belongs on the study drop cap, not on the previous chapter. */
function stripBoundaryDropCapDigits(xml: string): string {
    return xml.replace(
        /<CharacterStyleRange\b[^>]*AppliedCharacterStyle="(?:CharacterStyle\/)?cv(?:%3a|:)dc(?:_sp)?"[^>]*>[\s\S]*?<\/CharacterStyleRange>/g,
        ""
    );
}

/**
 * The drop-cap paragraph that opens this range, when nothing but a section
 * heading stands in front of it. Later verses in the same range stay after it.
 */
function openingBoundaryParagraph(
    studyStoryXml: string,
    absStart: number,
    absEnd: number
): ReturnType<typeof findParagraphAt> {
    const paras = paragraphsIntersecting(studyStoryXml, absStart, absEnd);
    for (const para of paras) {
        if (isChapterBoundaryParagraphAt(studyStoryXml, para.fullStart)) {
            return para;
        }
        if (
            isSectionHeadingParagraphStyle(para.appliedParagraphStyle) ||
            isBlankSpacerParagraphStyle(para.appliedParagraphStyle)
        ) {
            continue;
        }
        return null;
    }
    return null;
}

function mergeCoalescedParagraphReplacements(
    studyStoryXml: string,
    paraStart: number,
    ordered: BlockSplice[]
): string {
    const inner = ordered
        .map((g) => extractParagraphStyleRangeInner(g.replacement))
        .join("");
    return wrapStudyParagraphReplacement(studyStoryXml, paraStart, inner);
}

function appendRemoveVerseSplices(
    studyStoryXml: string,
    plan: VersificationPlan,
    bibleVerseIndex: BibleVerseIndex,
    splices: BlockSplice[],
    coveredRanges: Set<string>
): void {
    let currentBook = "";
    let currentChapter = "";

    for (const para of getParagraphIndex(studyStoryXml)) {
        if (isBookMarkerParagraphStyle(para.appliedParagraphStyle)) {
            let bookRaw = "";
            for (const c of iterateContentAbs(studyStoryXml, para.bodyStart, para.bodyEnd)) {
                bookRaw += storyXmlSlice(studyStoryXml, c);
            }
            currentBook = extractBookCode(bookRaw) ?? "";
            currentChapter = "";
            continue;
        }

        const chapterInPara = readChapterTransitionFromParagraph(
            studyStoryXml,
            para.appliedParagraphStyle,
            para.bodyStart,
            para.bodyEnd,
            currentBook
        );
        if (chapterInPara) currentChapter = chapterInPara;

        if (!currentBook || !currentChapter) continue;

        const hasChapterMarker = [
            ...iterateChapterMarkersInParagraph(
                studyStoryXml,
                para.bodyStart,
                para.bodyEnd
            ),
        ].length > 0;
        if (hasChapterMarker) continue;

        const verseNums = getVerseNumbersInRegion(
            studyStoryXml,
            para.bodyStart,
            para.bodyEnd
        );
        if (verseNums.length === 0) continue;

        const bibleChapter =
            plan.chapterRemaps.get(currentBook)?.get(currentChapter) ??
            currentChapter;

        const allStudyOnly = verseNums.every((v) => {
            const studyKey = verseKey(currentBook, currentChapter, String(v));
            const planned = plan.verseMap.get(studyKey);
            if (planned?.action === "remove") return true;
            if (planned?.action === "replace") return false;
            return !bibleVerseIndex.has(
                verseKey(currentBook, bibleChapter, String(v))
            );
        });
        if (!allStudyOnly) continue;

        const rangeKey = `${para.fullStart}:${para.fullEnd}`;
        if (coveredRanges.has(rangeKey)) continue;

        splices.push({
            absStart: para.fullStart,
            absEnd: para.fullEnd,
            replacement: "",
        });
        coveredRanges.add(rangeKey);
    }
}

function storyXmlSlice(
    storyXml: string,
    c: { absInnerStart: number; absInnerEnd: number }
): string {
    return storyXml.slice(c.absInnerStart, c.absInnerEnd);
}

function markCoveredRanges(
    splices: BlockSplice[],
    coveredRanges: Set<string>
): void {
    for (const sp of splices) {
        if (sp.absStart !== sp.absEnd) {
            coveredRanges.add(`${sp.absStart}:${sp.absEnd}`);
        }
    }
}

function isChapterBoundaryParagraphAt(
    studyStoryXml: string,
    absStart: number
): boolean {
    const para = findParagraphAt(studyStoryXml, absStart);
    if (!para) return false;
    const styleMatch = studyStoryXml
        .slice(para.fullStart, Math.min(para.fullStart + 160, studyStoryXml.length))
        .match(/AppliedParagraphStyle="([^"]+)"/);
    const style = styleMatch?.[1] ?? "";
    return isDropCapParagraphStyle(style);
}

/** A chapter-opening drop cap. Footnote styles such as `p_dc1_fn` do not qualify. */
function isDropCapParagraphStyle(style: string): boolean {
    return /text(?:%3a|:)(?:lh_dc\d*|p_dc[12])(?![0-9A-Za-z_])/.test(style);
}

/**
 * Merge consecutive spans that share a duplicate verse at a junction (e.g.
 * boundary paragraph tail + poetry continuation) unless intro notes split them.
 */
export function mergeDuplicateVerseJunctionSpans(
    spans: ChapterTextSpan[],
    studyStoryXml: string
): ChapterTextSpan[] {
    if (spans.length <= 1) return spans;

    const merged: ChapterTextSpan[] = [];
    let i = 0;
    while (i < spans.length) {
        let current = spans[i];
        let j = i;
        while (
            j + 1 < spans.length &&
            current.lastVerse === spans[j + 1].firstVerse &&
            !hasIntroBetween(studyStoryXml, current.absEnd, spans[j + 1].absStart) &&
            !isChapterBoundaryParagraphAt(studyStoryXml, spans[j + 1].absStart)
        ) {
            j++;
            const next = spans[j];
            current = {
                book: current.book,
                chapter: current.chapter,
                absStart: current.absStart,
                absEnd: next.absEnd,
                blockXml: studyStoryXml.slice(current.absStart, next.absEnd),
                firstVerse: current.firstVerse,
                lastVerse: next.lastVerse,
            };
        }
        merged.push(current);
        i = j + 1;
    }
    return merged;
}

function sortBoundarySplicesForCoalesce(
    studyStoryXml: string,
    group: BlockSplice[],
    paraStart: number
): BlockSplice[] {
    const para = findParagraphAt(studyStoryXml, paraStart);
    if (!para || group.length <= 1) {
        return [...group].sort((a, b) => a.absStart - b.absStart);
    }

    const markers = [
        ...iterateChapterMarkersInParagraph(
            studyStoryXml,
            para.bodyStart,
            para.bodyEnd
        ),
    ];

    const chapterOrder = (sp: BlockSplice): number => {
        if (sp.studyChapter) {
            const n = parseInt(sp.studyChapter, 10);
            if (Number.isFinite(n)) return n;
        }
        return Number.MAX_SAFE_INTEGER;
    };

    return [...group].sort((a, b) => {
        const chA = chapterOrder(a);
        const chB = chapterOrder(b);
        if (chA !== chB) return chA - chB;
        if (markers.length >= 2 && chA === chB) {
            return a.absStart - b.absStart;
        }
        return a.absStart - b.absStart;
    });
}

/**
 * Inline chapter transitions can split one Study paragraph between two spans.
 * Replacing each span independently leaves orphan CSRs and breaks IDML. Merge
 * splices that touch the same paragraph into one full-paragraph replacement.
 */
export function coalesceParagraphSplices(
    studyStoryXml: string,
    splices: BlockSplice[]
): BlockSplice[] {
    const insertions: BlockSplice[] = [];
    const replacements: BlockSplice[] = [];
    for (const sp of splices) {
        if (sp.absStart === sp.absEnd) insertions.push(sp);
        else replacements.push(sp);
    }

    // A single physical paragraph can straddle a chapter boundary: study
    // `p_dc1` / `p_dc2` paragraphs hold the close of one chapter (e.g. 35:35)
    // AND the open of the next (36:1). buildChapterSpanIndex emits one span per
    // chapter over that same paragraph, so two splices target it. Merge them — in
    // document order — into ONE full-paragraph replacement; replacing each
    // independently would leave orphan CSRs / overlapping ranges and break the
    // IDML. Sort by study chapter number so the closing chapter precedes the next.
    const byPara = new Map<number, BlockSplice[]>();
    for (const sp of replacements) {
        const boundary = openingBoundaryParagraph(
            studyStoryXml,
            sp.absStart,
            sp.absEnd
        );
        const para = findParagraphAt(studyStoryXml, sp.absStart);
        const key = boundary?.fullStart ?? para?.fullStart ?? sp.absStart;
        const group = byPara.get(key) ?? [];
        group.push(sp);
        byPara.set(key, group);
    }

    const coalesced: BlockSplice[] = [];
    for (const group of byPara.values()) {
        const rangeStart = Math.min(...group.map((g) => g.absStart));
        const rangeEnd = Math.max(...group.map((g) => g.absEnd));
        const boundary = openingBoundaryParagraph(
            studyStoryXml,
            rangeStart,
            rangeEnd
        );
        if (boundary) {
            const ordered =
                group.length === 1
                    ? group
                    : sortBoundarySplicesForCoalesce(
                          studyStoryXml,
                          group,
                          boundary.fullStart
                      );
            coalesced.push({
                absStart: rangeStart,
                absEnd: rangeEnd,
                replacement: composeBoundaryParagraphReplacement(
                    studyStoryXml,
                    boundary.fullStart,
                    boundary.fullEnd,
                    ordered
                ),
                studyChapter: ordered[0]?.studyChapter,
            });
            continue;
        }
        if (group.length === 1) {
            coalesced.push({
                ...group[0],
                replacement: balanceParagraphStyleRanges(group[0].replacement),
            });
            continue;
        }

        const ordered = sortBoundarySplicesForCoalesce(
            studyStoryXml,
            group,
            group[0].absStart
        );
        const paraStart = Math.min(...group.map((g) => g.absStart));
        coalesced.push({
            absStart: paraStart,
            absEnd: Math.max(...group.map((g) => g.absEnd)),
            replacement: mergeCoalescedParagraphReplacements(
                studyStoryXml,
                paraStart,
                ordered
            ),
        });
    }

    return [...coalesced, ...insertions].sort((a, b) => a.absStart - b.absStart);
}

/**
 * Clip overlapping replacement ranges so later splices are not skipped during
 * application (`sp.absStart < cursor`). Coalesce can expand a splice's absEnd
 * to a paragraph boundary while a later splice starts mid-document before that
 * boundary in study coordinates.
 */
export function normalizeOverlappingSplices(
    splices: BlockSplice[]
): BlockSplice[] {
    const sorted = [...splices].sort((a, b) => a.absStart - b.absStart);
    const out: BlockSplice[] = [];

    for (const sp of sorted) {
        if (sp.absStart === sp.absEnd) {
            out.push(sp);
            continue;
        }

        if (out.length === 0) {
            out.push({ ...sp });
            continue;
        }

        const prev = out[out.length - 1];
        if (prev.absStart === prev.absEnd) {
            out.push({ ...sp });
            continue;
        }

        if (sp.absStart >= prev.absEnd) {
            out.push({ ...sp });
            continue;
        }

        if (sp.absEnd <= prev.absEnd) {
            // A prior-chapter splice must not swallow the next chapter's opening
            // span on a shared `p_dc1` / `p_dc2` boundary paragraph.
            if (
                sp.studyChapter &&
                prev.studyChapter &&
                sp.studyChapter !== prev.studyChapter
            ) {
                if (sp.absStart > prev.absStart) {
                    out[out.length - 1] = { ...prev, absEnd: sp.absStart };
                } else {
                    out.pop();
                }
                out.push({ ...sp });
            }
            continue;
        }

        // True partial overlap only: clip when the later splice starts strictly
        // inside the previous range, not at an adjacent paragraph boundary.
        if (sp.absStart > prev.absStart) {
            out[out.length - 1] = { ...prev, absEnd: sp.absStart };
        }
        out.push({ ...sp });
    }

    return out;
}

/** Drop zero-length duplicate splices when a non-empty splice covers the range. */
function dropSubsumedEmptySplices(splices: BlockSplice[]): BlockSplice[] {
    const filledRanges = new Set(
        splices
            .filter((s) => s.absStart !== s.absEnd && s.replacement.length > 0)
            .map((s) => `${s.absStart}:${s.absEnd}`)
    );
    return splices.filter((s) => {
        if (s.replacement.length > 0 || s.absStart === s.absEnd) return true;
        return !filledRanges.has(`${s.absStart}:${s.absEnd}`);
    });
}

export interface StructureSwapOptions {
    /** Full Bible story XML — builds verse index for insertions. */
    bibleStoryXml?: string;
    /** When set, Psalm (and other) alignment follows the Bible stream plan. */
    versificationPlan?: VersificationPlan;
    /** Pre-built Bible verse index; avoids re-walking `bibleStoryXml` per study story. */
    bibleVerseIndex?: BibleVerseIndex;
}

/**
 * Build a chapter block index from the Bible story XML (includes Bible
 * superscription paragraphs when present). Language strategies may override
 * the default retain/include flags via `options`.
 */
export function buildBibleChapterBlockIndex(
    bibleStoryXml: string,
    options?: BuildChapterBlockOptions
): ChapterBlockIndex {
    return buildChapterBlockIndex(bibleStoryXml, {
        retainSectionHeadings: true,
        retainSpeakerLabels: true,
        retainAcrosticHeadings: true,
        // Clip boundary paragraphs so closing-chapter blocks don't absorb the
        // next chapter's opening text (Portuguese NEH 7/8, 2CO 1/2, etc.).
        clipChapterBoundarySpans: true,
        // Carry Bible `meta:eot` (with its meta:c/meta:v pair) on the last
        // chapter so the external validator keys the final verse the same way
        // it does against the raw Bible (French 2CH 36 → EOT 6:23).
        retainEndOfTextMarkers: true,
        ...options,
    });
}

/** Apply ordered splices to study XML (original byte offsets for gaps). */
export function applyBlockSplices(
    studyStoryXml: string,
    mergedSplices: BlockSplice[]
): string {
    const sorted = normalizeOverlappingSplices(mergedSplices);
    const parts: string[] = [];
    let cursor = 0;
    for (const sp of sorted) {
        if (sp.absStart < cursor) continue;
        if (sp.absStart > cursor) {
            parts.push(studyStoryXml.slice(cursor, sp.absStart));
        }
        parts.push(sp.replacement);
        cursor = sp.absEnd;
    }
    if (cursor < studyStoryXml.length) {
        parts.push(studyStoryXml.slice(cursor));
    }
    return parts.join("");
}

/**
 * Keep verse 1 in a chapter span that starts there when the plan never mapped
 * it. That verse is the superscription that also holds `cv:dc` and `meta:c`
 * (Habakkuk 3). Dropping it leaves the chapter number and the first verse out
 * of the export, and every later verse stays keyed to the previous chapter.
 */
function withChapterOpeningVerse(
    slices: BibleVerseSlice[],
    book: string,
    chapter: string,
    spanFirstVerse: number,
    plan: VersificationPlan,
    bibleVerseIndex: BibleVerseIndex | null
): BibleVerseSlice[] {
    if (spanFirstVerse > 1) return slices;
    if (slices.some((slice) => slice.firstVerse <= 1 && slice.lastVerse >= 1)) {
        return slices;
    }
    const planned = plan.verseMap.get(verseKey(book, chapter, "1"));
    if (planned?.action === "remove") return slices;
    const bibleChapter =
        planned?.action === "replace" ? planned.bible.chapter : (slices[0]?.chapter ?? chapter);
    if (!bibleVerseIndex?.has(verseKey(book, bibleChapter, "1"))) return slices;
    return [{ chapter: bibleChapter, firstVerse: 1, lastVerse: 1 }, ...slices];
}

/**
 * Build structure-swap splices without applying them (for tests/diagnostics).
 */
export function buildStructureSwapSplices(
    studyStoryXml: string,
    bibleChapterIndex: ChapterBlockIndex,
    options?: StructureSwapOptions
): StructureSwapBuildResult {
    const stats: SwapStats = {
        replacedCount: 0,
        skippedPsa: 0,
        psalmSubheaderOffsets: 0,
        psalmVersesInserted: 0,
        missingFromBible: [],
        extraInBibleAppended: [],
        chaptersReplaced: 0,
        chaptersMissing: [],
    };

    const plan = options?.versificationPlan;
    const bibleVerseIndex =
        options?.bibleVerseIndex ??
        (options?.bibleStoryXml ? buildBibleVerseIndex(options.bibleStoryXml) : null);

    const studySpans = buildChapterSpanIndex(studyStoryXml);
    const splices: BlockSplice[] = [];
    const replacedChapters = new Set<string>();

    if (plan) {
        for (const [key, chPlan] of plan.structureChapters) {
            if (!chPlan.insertOnly) continue;
            if ((studySpans.get(key)?.length ?? 0) > 0) continue;

            const replacement = extractBibleXmlForSlices(
                bibleChapterIndex,
                chPlan.studyBook,
                chPlan.bibleSlices
            );
            if (!replacement) continue;

            const pos = findStudyChapterInsertPosition(
                studyStoryXml,
                chPlan.studyBook,
                chPlan.studyChapter
            );
            if (pos < 0) continue;

            splices.push({
                absStart: pos,
                absEnd: pos,
                replacement,
            });
            stats.replacedCount++;
            stats.chaptersReplaced = (stats.chaptersReplaced ?? 0) + 1;
        }
    }

    for (const [key, rawSpans] of studySpans) {
        const [book, chapter] = key.split("|");
        const spans = mergeDuplicateVerseJunctionSpans(rawSpans, studyStoryXml);
        const firstSpan = spans[0];
        const strippedSubheader = Boolean(
            firstSpan &&
                studyHasEnglishSubheaderBefore(studyStoryXml, firstSpan.absStart)
        );

        const stripSubheader = (ch: string) =>
            strippedSubheader &&
            book !== PSA_BOOK_CODE &&
            book !== "SNG" &&
            ch === chapter;

        if (plan) {
            const inserts = (plan.chapterInserts.get(key) ?? []).filter((ref) => {
                const entry = bibleVerseIndex?.get(
                    verseKey(ref.book, ref.chapter, ref.verse)
                );
                return !entry?.isSubheader;
            });

            const spanSlices = spans.map((span) =>
                bibleSlicesForStudyRange(
                    plan,
                    span.book,
                    span.chapter,
                    span.firstVerse,
                    span.lastVerse
                )
            );

            // A Bible-only verse that directly continues the last span's range
            // belongs inside that span's slice rather than after it. Extracted
            // on its own it either repeats the paragraph it shares with earlier
            // verses or, once clipped, loses the footnotes that paragraph
            // carries — and the reader counts those footnotes as part of the
            // verse (RUT 4:22, 2PE 3:18, HAB 3:19).
            const appendSlices: ReturnType<typeof buildInsertSlicesFromRefs> = [];
            for (const slice of buildInsertSlicesFromRefs(inserts)) {
                // A verse the study skips belongs to the span it falls after,
                // including a hole in front of a study note (Deuteronomy 14:22
                // sits between 14:4 and 14:28). Appending it to the last span
                // parks it after the note and, when the earlier span already
                // carries it, prints the heading twice.
                let host = -1;
                for (let i = 0; i < spans.length; i++) {
                    const tail = spanSlices[i][spanSlices[i].length - 1];
                    if (!tail || tail.chapter !== slice.chapter) continue;
                    const nextVerse = spans[i + 1]?.firstVerse ?? Number.POSITIVE_INFINITY;
                    if (slice.firstVerse > tail.lastVerse && slice.lastVerse < nextVerse) {
                        host = i;
                    }
                }
                if (host >= 0) {
                    const tail = spanSlices[host][spanSlices[host].length - 1];
                    tail.lastVerse = Math.max(tail.lastVerse, slice.lastVerse);
                } else {
                    appendSlices.push(slice);
                }
            }

            const insertXml =
                appendSlices.length > 0
                    ? extractBibleXmlForSlices(
                          bibleChapterIndex,
                          book,
                          appendSlices,
                          stripSubheader,
                          { clipStartAtFirstVerse: true }
                      )
                    : "";

            const placedMaxByChapter = new Map<string, number>();
            /** Index in `splices` of the last non-empty replacement for this chapter. */
            let lastContentSpliceIndex = -1;
            spans.forEach((span, idx) => {
                // Slices use Bible chapter numbers; do not filter against study chapter.
                // A numbered superscription (HAB 3:1) carries the visible chapter
                // drop cap. The study scan used to skip it, so the plan had no
                // replace entry and this span was rewritten from verse 2, deleting
                // the drop cap and verse 1.
                const slices = withChapterOpeningVerse(
                    spanSlices[idx],
                    book,
                    chapter,
                    span.firstVerse,
                    plan,
                    bibleVerseIndex
                );

                if (slices.length === 0) {
                    if (
                        isChapterBoundaryParagraphAt(studyStoryXml, span.absStart)
                    ) {
                        return;
                    }
                    splices.push({
                        absStart: span.absStart,
                        absEnd: span.absEnd,
                        replacement: "",
                        studyChapter: span.chapter,
                    });
                    return;
                }

                const trimmed: typeof slices = [];
                for (const sl of slices) {
                    const placed = placedMaxByChapter.get(sl.chapter) ?? 0;
                    if (sl.lastVerse <= placed) continue;
                    if (sl.firstVerse <= placed) {
                        trimmed.push({ ...sl, firstVerse: placed + 1 });
                    } else {
                        trimmed.push(sl);
                    }
                }

                if (trimmed.length === 0) {
                    const onBoundary = isChapterBoundaryParagraphAt(
                        studyStoryXml,
                        span.absStart
                    );
                    if (onBoundary) {
                        // This side of the boundary was already written by an
                        // earlier span. Leave the paragraph to the other
                        // chapter's splice so the verses are not repeated.
                        return;
                    }
                    const placed = placedMaxByChapter.get(chapter) ?? 0;
                    const isBoundaryDuplicate =
                        span.firstVerse === span.lastVerse &&
                        placed >= span.lastVerse &&
                        spans.length > 1 &&
                        !onBoundary;
                    if (isBoundaryDuplicate) {
                        return;
                    }
                    splices.push({
                        absStart: span.absStart,
                        absEnd: span.absEnd,
                        replacement: "",
                        studyChapter: span.chapter,
                    });
                    return;
                }

                const replacement = preserveStudyChapterMarker(
                    extractBibleXmlForSlices(
                        bibleChapterIndex,
                        span.book,
                        trimmed,
                        stripSubheader,
                        { clipStartAtFirstVerse: true }
                    ),
                    span.blockXml,
                    span.chapter
                );
                if (!replacement) {
                    stats.missingFromBible.push({
                        book: span.book,
                        chapter: span.chapter,
                        verse: String(span.firstVerse),
                    });
                    return;
                }

                lastContentSpliceIndex = splices.length;
                splices.push({
                    absStart: span.absStart,
                    absEnd: span.absEnd,
                    replacement,
                    studyChapter: span.chapter,
                });
                stats.replacedCount++;
                for (const sl of trimmed) {
                    placedMaxByChapter.set(
                        sl.chapter,
                        Math.max(
                            placedMaxByChapter.get(sl.chapter) ?? 0,
                            sl.lastVerse
                        )
                    );
                }
            });

            // Append bible-only trailing verses to the last *content* span for
            // this chapter. Study notes after the verse text create empty trailing
            // spans; inserting at those absEnds parks the verses after notes so
            // the indexer never attributes them to this chapter (PSA 8:10, 110:8-10).
            if (insertXml && spans.length > 0) {
                if (lastContentSpliceIndex >= 0) {
                    splices[lastContentSpliceIndex] = {
                        ...splices[lastContentSpliceIndex],
                        replacement:
                            splices[lastContentSpliceIndex].replacement + insertXml,
                    };
                } else {
                    const lastSpan = spans[spans.length - 1];
                    splices.push({
                        absStart: lastSpan.absEnd,
                        absEnd: lastSpan.absEnd,
                        replacement: insertXml,
                        studyChapter: chapter,
                    });
                }
                stats.replacedCount++;
            }

            if (inserts.length > 0 && spans.length > 0) {
                for (const ref of inserts) {
                    stats.psalmVersesInserted++;
                    stats.extraInBibleAppended.push({
                        book: ref.book,
                        chapter: ref.chapter,
                        verse: ref.verse,
                    });
                }
            }

            if (spans.length > 0 && !replacedChapters.has(key)) {
                replacedChapters.add(key);
                stats.chaptersReplaced = (stats.chaptersReplaced ?? 0) + 1;
            }
            continue;
        }

        const bibleBlock = bibleChapterIndex.get(key);
        if (!bibleBlock) {
            stats.chaptersMissing?.push({ book, chapter });
            continue;
        }

        let bibleChapterXml = bibleBlock.blockXml;
        if (strippedSubheader) {
            bibleChapterXml = stripLeadingBibleSubheaderPsr(bibleChapterXml);
        }

        for (const span of spans) {
            const rawReplacement = extractSliceByVerseRange(
                bibleChapterXml,
                span.firstVerse,
                span.lastVerse,
                { clipStartAtFirstVerse: true }
            );
            const replacement = rawReplacement
                ? collapseRedundantProseInBlockXml(rawReplacement)
                : "";
            if (!replacement) {
                stats.missingFromBible.push({
                    book: span.book,
                    chapter: span.chapter,
                    verse: String(span.firstVerse),
                });
                continue;
            }

            splices.push({
                absStart: span.absStart,
                absEnd: span.absEnd,
                replacement,
                studyChapter: span.chapter,
            });
            stats.replacedCount++;
        }

        if (spans.length > 0 && !replacedChapters.has(key)) {
            replacedChapters.add(key);
            stats.chaptersReplaced = (stats.chaptersReplaced ?? 0) + 1;
        }
    }

    if (plan) {
        for (const [key, refs] of plan.chapterInserts) {
            if (refs.length === 0) continue;
            if ((studySpans.get(key)?.length ?? 0) > 0) continue;

            const [book, chapter] = key.split("|");
            const filtered = refs.filter((ref) => {
                const entry = bibleVerseIndex?.get(
                    verseKey(ref.book, ref.chapter, ref.verse)
                );
                return !entry?.isSubheader;
            });
            const insertXml = extractBibleXmlForSlices(
                bibleChapterIndex,
                book,
                buildInsertSlicesFromRefs(filtered),
                undefined,
                { clipStartAtFirstVerse: true }
            );
            if (!insertXml) continue;

            const pos = findStudyChapterInsertPosition(
                studyStoryXml,
                book,
                chapter
            );
            if (pos < 0) continue;

            splices.push({
                absStart: pos,
                absEnd: pos,
                replacement: insertXml,
                studyChapter: chapter,
            });
            stats.replacedCount++;
            for (const ref of filtered) {
                stats.psalmVersesInserted++;
                stats.extraInBibleAppended.push({
                    book: ref.book,
                    chapter: ref.chapter,
                    verse: ref.verse,
                });
            }
            replacedChapters.add(key);
            stats.chaptersReplaced = (stats.chaptersReplaced ?? 0) + 1;
        }
    }

    if (replacedChapters.size > 0) {
        let currentBook = "";
        let currentChapter = "";
        for (const para of getParagraphIndex(studyStoryXml)) {
            if (isBookMarkerParagraphStyle(para.appliedParagraphStyle)) {
                const bookRaw = collectContentText(
                    studyStoryXml,
                    para.bodyStart,
                    para.bodyEnd
                );
                const code = extractBookCode(bookRaw);
                if (code) currentBook = code;
                continue;
            }
            const chapterInPara = readChapterTransitionFromParagraph(
                studyStoryXml,
                para.appliedParagraphStyle,
                para.bodyStart,
                para.bodyEnd,
                currentBook
            );
            if (chapterInPara) currentChapter = chapterInPara;

            if (
                !isSpeakerLabelParagraphStyle(para.appliedParagraphStyle) ||
                !currentBook ||
                !currentChapter
            ) {
                continue;
            }
            const chKey = `${currentBook}|${currentChapter}`;
            if (!replacedChapters.has(chKey)) continue;

            splices.push({
                absStart: para.fullStart,
                absEnd: para.fullEnd,
                replacement: "",
            });
        }

        // Swap English Psalm chapter labels (`head:cl`) for the Bible's label
        // when that chapter was structure-replaced (Russian PSA 62 → "Псалом 62").
        if (options?.bibleStoryXml) {
            const bibleLabels = collectPsalmChapterLabelXml(options.bibleStoryXml);
            const studyLabels = collectPsalmChapterLabelXml(studyStoryXml);
            for (const [chapter, studyLabel] of studyLabels) {
                if (!replacedChapters.has(`${PSA_BOOK_CODE}|${chapter}`)) continue;
                const bibleLabel = bibleLabels.get(chapter);
                if (!bibleLabel || bibleLabel.xml === studyLabel.xml) continue;
                splices.push({
                    absStart: studyLabel.absStart,
                    absEnd: studyLabel.absEnd,
                    replacement: bibleLabel.xml,
                    studyChapter: chapter,
                });
            }
        }
    }

    if (plan && bibleVerseIndex) {
        const coveredRanges = new Set<string>();
        markCoveredRanges(splices, coveredRanges);
        appendRemoveVerseSplices(
            studyStoryXml,
            plan,
            bibleVerseIndex,
            splices,
            coveredRanges
        );
    }

    const mergedSplices = normalizeOverlappingSplices(
        coalesceParagraphSplices(
            studyStoryXml,
            dropSubsumedEmptySplices(splices)
        )
    );
    mergedSplices.sort((a, b) => a.absStart - b.absStart);
    return { splices, mergedSplices, stats };
}

function markerStyleKind(style: string): "chapter" | "verse" | null {
    if (/(?:^|\/)meta%3ac$/.test(style) || /(?:^|\/)meta:c$/.test(style)) return "chapter";
    if (/(?:^|\/)meta%3av$/.test(style) || /(?:^|\/)meta:v$/.test(style)) return "verse";
    return null;
}

function characterRangeText(
    storyXml: string,
    bodyStart: number,
    bodyEnd: number
): string {
    let text = "";
    for (const content of iterateContentAbs(storyXml, bodyStart, bodyEnd)) {
        text += storyXml.slice(content.absInnerStart, content.absInnerEnd);
    }
    return text;
}

/**
 * Chapter number of a paragraph whose only text is a `meta:c` / `meta:v` pair.
 * Prose in the same paragraph means this is not a bare book-end marker.
 */
function bareClosingMarkerChapter(
    storyXml: string,
    para: IndexedParagraph
): string | null {
    let chapter: string | null = null;
    let sawMarker = false;
    for (const csr of iterateCsrAbs(storyXml, para.bodyStart, para.bodyEnd)) {
        const text = characterRangeText(storyXml, csr.absBodyStart, csr.absBodyEnd).trim();
        if (!text) continue;
        const kind = markerStyleKind(csr.appliedCharacterStyle);
        if (!kind) return null;
        sawMarker = true;
        if (kind === "chapter") {
            chapter = text.match(/\d+/)?.[0] ?? null;
        }
    }
    return sawMarker ? chapter : null;
}

/** Exodus 1 is `text:li4_dc1`, which is not one of the `p_dc` / `lh_dc` boundary styles. */
function isChapterOpeningDropCapStyle(style: string): boolean {
    return (
        isDropCapParagraphStyle(style) ||
        /text(?:%3a|:)li\d*_dc\d*(?![0-9A-Za-z_])/.test(style)
    );
}

function chapterOneDropCapDigit(
    storyXml: string,
    para: IndexedParagraph
): boolean {
    if (!isChapterOpeningDropCapStyle(para.appliedParagraphStyle)) {
        return false;
    }
    for (const csr of iterateCsrAbs(storyXml, para.bodyStart, para.bodyEnd)) {
        if (!/(?:^|\/)cv%3adc$/.test(csr.appliedCharacterStyle) && !/(?:^|\/)cv:dc$/.test(csr.appliedCharacterStyle)) {
            continue;
        }
        return characterRangeText(storyXml, csr.absBodyStart, csr.absBodyEnd).trim() === "1";
    }
    return false;
}

/** `intro:ie` is the Next Page break that starts each book's first text page. */
function isIntroEndParagraphStyle(style: string): boolean {
    const name = style.replace(/^ParagraphStyle\//, "");
    return /(?:^|\/)intro(?:%3a|:)ie$/.test(name);
}

/**
 * Page breaks that land on a folio-only master in the English file.
 * `meta:id` starts the book intro. `intro:ie` starts the first scripture page.
 * Portuguese reflow moves both onto `2-bible.text`, which draws a running head.
 */
function isBookOpeningPageBreak(style: string): boolean {
    const name = style.replace(/^ParagraphStyle\//, "");
    return /(?:^|\/)(?:intro(?:%3a|:)ie|meta(?:%3a|:)id)$/.test(name);
}

/**
 * Genesis's closing `50:` / `26` marker is not a verse, so the swap leaves it
 * in front of Exodus. Drop that pair when the next text paragraph is the
 * next book's chapter-1 drop cap. A marker whose chapter is already 1 stays.
 *
 * The markers often sit inside `intro:ie`. That paragraph's style starts the
 * next page, which is the folio-only book opening. Deleting the paragraph
 * deletes the page break, so the chapter starts on a running-head page.
 * Strip the marker runs and keep the paragraph.
 */
export function stripStaleBookEndMarkers(storyXml: string): string {
    const paras = getParagraphIndex(storyXml);
    const cuts: Array<{ start: number; end: number }> = [];
    for (let i = 0; i < paras.length; i++) {
        const chapter = bareClosingMarkerChapter(storyXml, paras[i]);
        if (!chapter || chapter === "1") continue;
        let next = i + 1;
        while (
            next < paras.length &&
            (isBlankSpacerParagraphStyle(paras[next].appliedParagraphStyle) ||
                isSectionHeadingParagraphStyle(paras[next].appliedParagraphStyle))
        ) {
            next++;
        }
        if (next >= paras.length) continue;
        if (!chapterOneDropCapDigit(storyXml, paras[next])) continue;
        if (isIntroEndParagraphStyle(paras[i].appliedParagraphStyle)) {
            for (const csr of iterateCsrAbs(storyXml, paras[i].bodyStart, paras[i].bodyEnd)) {
                const text = characterRangeText(storyXml, csr.absBodyStart, csr.absBodyEnd).trim();
                if (!text || !markerStyleKind(csr.appliedCharacterStyle)) continue;
                cuts.push({ start: csr.absFullStart, end: csr.absFullEnd });
            }
            continue;
        }
        cuts.push({ start: paras[i].fullStart, end: paras[i].fullEnd });
    }
    if (cuts.length === 0) return storyXml;
    let xml = storyXml;
    for (const cut of [...cuts].sort((a, b) => b.start - a.start)) {
        xml = xml.slice(0, cut.start) + xml.slice(cut.end);
    }
    return xml;
}

/**
 * Paper patches over both ends of the header band on a book-opening page.
 *
 * `2-bible.text` draws `{book} {chapter}:{verse}` at the outside of a 33pt
 * band and the folio on a center tab. `A-Parent` and `B-intro` draw the folio
 * only, and the English openings sit on those masters by page number.
 * Portuguese is longer, so the opening moves onto the text master. The patch
 * travels with the page break, so it follows the text.
 *
 * IDML calls this placement `Anchored`. `Custom` is not a value, and InDesign
 * then leaves the rectangle inline in the 0.1pt break, where it cannot cover
 * the margin. One band is not enough either: the opening can land on a left
 * or a right page, and the folio stays in the middle either way. `PinPosition`
 * stays off so the bands can sit in the margin, outside the text frame.
 */
function bookOpeningCoverXml(id: string): string {
    const point = (x: number, y: number): string =>
        `<PathPointType Anchor="${x} ${y}" LeftDirection="${x} ${y}" RightDirection="${x} ${y}" />`;
    const box = (x0: number, y0: number, x1: number, y1: number): string =>
        [point(x0, y0), point(x0, y1), point(x1, y1), point(x1, y0)].join("");
    const rect = (
        self: string,
        points: string,
        anchor: string,
        align: string
    ): string =>
        `<Rectangle Self="${self}" ContentType="GraphicType" StoryTitle="$ID/" AppliedObjectStyle="ObjectStyle/$ID/[None]" FillColor="Color/Paper" StrokeWeight="0" StrokeColor="Swatch/None" ItemTransform="1 0 0 1 0 0" Visible="true" Locked="false" Name="book-open-cover"><Properties><PathGeometry><GeometryPathType PathOpen="false"><PathPointArray>${points}</PathPointArray></GeometryPathType></PathGeometry></Properties><AnchoredObjectSetting AnchoredPosition="Anchored" SpineRelative="false" LockPosition="false" PinPosition="false" AnchorPoint="${anchor}" HorizontalAlignment="${align}" HorizontalReferencePoint="PageEdge" VerticalAlignment="TopAlign" VerticalReferencePoint="PageEdge" AnchorXoffset="0" AnchorYoffset="0" AnchorSpaceAbove="0" /><TextWrapPreference Inverse="false" ApplyToMasterPageOnly="false" TextWrapSide="BothSides" TextWrapMode="None"><Properties><TextWrapOffset Top="0" Left="0" Bottom="0" Right="0" /></Properties></TextWrapPreference></Rectangle>`;
    return `<CharacterStyleRange AppliedCharacterStyle="CharacterStyle/$ID/[No character style]">${rect(`${id}l`, box(0, 0, 150, 33), "TopLeftAnchor", "LeftAlign")}${rect(`${id}r`, box(-150, 0, 0, 33), "TopRightAnchor", "RightAlign")}</CharacterStyleRange>`;
}

export function coverBookOpeningRunningHeads(storyXml: string): string {
    if (storyXml.includes('Name="book-open-cover"')) return storyXml;
    const paras = getParagraphIndex(storyXml);
    const inserts: number[] = [];
    for (const para of paras) {
        if (!isBookOpeningPageBreak(para.appliedParagraphStyle)) continue;
        inserts.push(para.bodyStart);
    }
    if (inserts.length === 0) return storyXml;
    let xml = storyXml;
    for (let i = inserts.length - 1; i >= 0; i--) {
        xml = xml.slice(0, inserts[i]) + bookOpeningCoverXml(`boc${i + 1}`) + xml.slice(inserts[i]);
    }
    return xml;
}

/**
 * Replace Study chapter text spans with matching Bible verse-range slices.
 */
export function applyStructureSwapToStudyXml(
    studyStoryXml: string,
    bibleChapterIndex: ChapterBlockIndex,
    options?: StructureSwapOptions
): { xml: string; stats: SwapStats } {
    const { mergedSplices, stats } = buildStructureSwapSplices(
        studyStoryXml,
        bibleChapterIndex,
        options
    );
    let xml = applyBlockSplices(studyStoryXml, mergedSplices);
    const remaps = options?.versificationPlan?.chapterRemaps;
    if (remaps && remaps.size > 0) {
        xml = rewriteRemappedChapterMarkersInStory(xml, remaps);
    }
    xml = stripStaleBookEndMarkers(xml);
    xml = coverBookOpeningRunningHeads(xml);
    return {
        xml,
        stats,
    };
}
