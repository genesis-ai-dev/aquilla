/** How verse text is applied from the Bible IDML onto the Study IDML. */
export type BibleSwapMode = "surgical" | "structure";

export type VerseKey = `${string}|${string}|${string}`;
export type ChapterBlockKey = `${string}|${string}`;

export interface ParagraphChunkEntry {
    paragraphStyle: string;
    proseSegments: string[];
}

export interface VerseEntry {
    text: string;
    segments: string[];
    /**
     * Text of this verse's divine-name (`nd`) character runs, in reading
     * order — kept apart from `segments` so the small-caps runs map onto the
     * study's own small-caps runs rather than into plain prose (AQU-1959).
     */
    divineSegments: string[];
    paragraphSig: string;
    paragraphChunks: ParagraphChunkEntry[];
    verseSpanXml: string;
    isSubheader: boolean;
}

export type BibleVerseIndex = Map<VerseKey, VerseEntry>;

export interface ChapterTextBlock {
    book: string;
    chapter: string;
    absStart: number;
    absEnd: number;
    blockXml: string;
    /** Lowest verse number in this span (structure swap). */
    firstVerse?: number;
    /** Highest verse number in this span (structure swap). */
    lastVerse?: number;
}

/** One contiguous run of verse text; a chapter may have several (split by study notes). */
export interface ChapterTextSpan extends ChapterTextBlock {
    firstVerse: number;
    lastVerse: number;
}

export type ChapterBlockIndex = Map<ChapterBlockKey, ChapterTextBlock>;
export type ChapterSpanIndex = Map<ChapterBlockKey, ChapterTextSpan[]>;

export interface SwapStats {
    replacedCount: number;
    /** @deprecated Always 0 — Psalms are now swapped. */
    skippedPsa: number;
    psalmSubheaderOffsets: number;
    psalmVersesInserted: number;
    missingFromBible: Array<{ book: string; chapter: string; verse: string }>;
    extraInBibleAppended: Array<{ book: string; chapter: string; verse: string }>;
    /** Structure mode: chapter text blocks swapped from the Bible file. */
    chaptersReplaced?: number;
    chaptersMissing?: Array<{ book: string; chapter: string }>;
    /** AQU-1959: divine-name (`nd`) runs replaced with the Bible's own. */
    divineNamesReplaced?: number;
    /**
     * AQU-1959: verses where the study and the Bible disagree on how many
     * divine-name runs the verse has. Those runs are left untouched rather
     * than guessed at, and reported here so the export can say so (AQU-276's
     * structure honesty).
     */
    divineNamesUnmatched?: Array<{
        book: string;
        chapter: string;
        verse: string;
        studyRuns: number;
        bibleRuns: number;
    }>;
}

export function verseKey(book: string, chapter: string, verse: string): VerseKey {
    return `${book}|${chapter}|${verse}` as VerseKey;
}

export function chapterBlockKey(book: string, chapter: string): ChapterBlockKey {
    return `${book}|${chapter}` as ChapterBlockKey;
}
